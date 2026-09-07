/**
 * OTLP/JSON (traces and logs) -> WireEvent, following the OpenTelemetry
 * GenAI semantic conventions (gen_ai.* attributes) plus the Claude Code
 * native telemetry log event names. Protobuf is not decoded; point exporters
 * at this collector with OTEL_EXPORTER_OTLP_PROTOCOL=http/json.
 */
import { extractHosts, hostOfUrl } from "./hosts.ts";
import type { WireEvent, WireKind } from "./wire.ts";

interface AnyValue { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean; arrayValue?: { values: AnyValue[] }; kvlistValue?: { values: KeyValue[] } }
interface KeyValue { key: string; value: AnyValue }
interface Span { traceId: string; spanId: string; parentSpanId?: string; name: string; kind?: number; startTimeUnixNano: string | number; endTimeUnixNano?: string | number; attributes?: KeyValue[]; status?: { code?: number; message?: string }; events?: { name: string; attributes?: KeyValue[] }[] }
interface LogRecord { timeUnixNano?: string | number; observedTimeUnixNano?: string | number; severityText?: string; body?: AnyValue; attributes?: KeyValue[]; traceId?: string; spanId?: string }
interface Scope { name?: string; version?: string }
export interface OtlpTraces { resourceSpans?: { resource?: { attributes?: KeyValue[] }; scopeSpans?: { scope?: Scope; spans?: Span[] }[] }[] }
export interface OtlpLogs { resourceLogs?: { resource?: { attributes?: KeyValue[] }; scopeLogs?: { scope?: Scope; logRecords?: LogRecord[] }[] }[] }

type Attrs = Record<string, unknown>;

function val(v: AnyValue | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return v.arrayValue.values.map(val);
  if (v.kvlistValue) return attrs(v.kvlistValue.values);
  return undefined;
}
function attrs(list: KeyValue[] | undefined): Attrs {
  const o: Attrs = {};
  for (const kv of list ?? []) o[kv.key] = val(kv.value);
  return o;
}
const str = (a: Attrs, ...keys: string[]): string | undefined => {
  for (const k of keys) { const v = a[k]; if (typeof v === "string" && v) return v; if (typeof v === "number") return String(v); }
  return undefined;
};
const num = (a: Attrs, ...keys: string[]): number | undefined => {
  for (const k of keys) { const v = a[k]; if (typeof v === "number") return v; }
  return undefined;
};
const nanoToMs = (n: string | number | undefined) => (n ? Math.floor(Number(n) / 1e6) : Date.now());
const trim = (s: string | undefined, n = 120) => (s ? (s.length > n ? s.slice(0, n - 1) + "…" : s) : "");
const short = (s: string) => (s.length > 18 ? s.slice(0, 8) + "…" + s.slice(-6) : s);

function messagesText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join("\n");
  if (v && typeof v === "object") return JSON.stringify(v);
  return undefined;
}

function agentOf(res: Attrs, a: Attrs, fallbackSession: string) {
  const service = str(res, "service.name") ?? "otel-service";
  const name = str(a, "gen_ai.agent.name") ?? service;
  const user = str(a, "user.email", "user.id");
  return {
    id: name === service ? (user ? `${service}@user:${user}` : service) : `${service}/${name}`,
    name: user && name === service ? `${service} · ${user}` : name,
    role: str(res, "deployment.environment.name", "deployment.environment") ?? (user && name === service ? "telemetry only · endpoint unknown" : "instrumented agent"),
    session: short(str(a, "gen_ai.conversation.id", "session.id") ?? str(res, "session.id") ?? fallbackSession),
    model: str(a, "gen_ai.response.model", "gen_ai.request.model"),
  };
}

function classify(a: Attrs, name: string): WireKind {
  const op = str(a, "gen_ai.operation.name") ?? "";
  if (/^(chat|text_completion|generate_content|embeddings|invoke_agent|invoke_workflow|create_agent)$/.test(op)) return "llm";
  if (op === "execute_tool") return str(a, "process.command_line", "process.command") ? "command" : "tool";
  if (str(a, "url.full", "http.url", "server.address", "net.peer.name", "http.request.method")) return "network";
  if (str(a, "file.path")) return "file";
  if (/^(chat|llm|completion|generate)/i.test(name)) return "llm";
  return "tool";
}

function spanToWire(res: Attrs, s: Span): WireEvent[] {
  const a = attrs(s.attributes);
  const kind = classify(a, s.name);
  const agent = agentOf(res, a, s.traceId);
  const tokensIn = num(a, "gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens");
  const tokensOut = num(a, "gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens");
  const start = nanoToMs(s.startTimeUnixNano), end = s.endTimeUnixNano ? nanoToMs(s.endTimeUnixNano) : start;
  const e: WireEvent = {
    id: "ot_" + s.spanId, ts: start, kind, agent, label: s.name, source: "otlp",
    detail: { trace_id: s.traceId, span_id: s.spanId, parent_span_id: s.parentSpanId, duration_ms: end - start, status: s.status?.code === 2 ? "error" : "ok", ...a },
  };
  const out: WireEvent[] = [e];
  if (kind === "llm") {
    const prompt = messagesText(a["gen_ai.input.messages"] ?? a["gen_ai.prompt"]);
    const completion = messagesText(a["gen_ai.output.messages"] ?? a["gen_ai.completion"]);
    e.text = [prompt, completion].filter(Boolean).join("\n---\n") || undefined;
    e.label = `${str(a, "gen_ai.operation.name") ?? "model"} · ${trim(completion ?? prompt ?? s.name, 110)}`;
    e.tag = agent.model ?? (tokensIn != null ? `${tokensIn}→${tokensOut ?? 0} tok` : undefined);
    if (tokensIn != null) e.detail!.tokens_in = tokensIn;
    if (tokensOut != null) e.detail!.tokens_out = tokensOut;
  } else if (kind === "command") {
    e.command = str(a, "process.command_line", "process.command");
    e.label = e.command ?? s.name; e.cwd = str(a, "process.working_directory");
    e.tag = a["process.exit_code"] != null ? `exit ${a["process.exit_code"]}` : "exec";
  } else if (kind === "tool") {
    const args = messagesText(a["gen_ai.tool.call.arguments"]);
    e.tool = str(a, "gen_ai.tool.name") ?? s.name.replace(/^execute_tool\s+/, "");
    e.label = `${e.tool} · ${trim(args ?? "", 100)}`; e.text = messagesText(a["gen_ai.tool.call.result"]) ?? args;
    e.tag = `${((end - start) / 1000).toFixed(2)}s`;
    const url = str(a, "url.full");
    for (const h of url ? [hostOfUrl(url)].filter(Boolean) as string[] : []) {
      out.push({ id: `${e.id}_net`, ts: start, kind: "network", agent, host: h, label: url ?? `${e.tool} → ${h}`, tag: "derived", source: "otlp", detail: { via: "tool", tool: e.tool } });
    }
  } else if (kind === "network") {
    const url = str(a, "url.full", "http.url");
    e.host = (url ? hostOfUrl(url) : undefined) ?? str(a, "server.address", "net.peer.name");
    e.label = `${str(a, "http.request.method", "http.method") ?? "request"} ${url ?? e.host ?? ""}`;
    e.tag = a["http.response.status_code"] != null ? `HTTP ${a["http.response.status_code"]}` : undefined;
  } else if (kind === "file") {
    e.label = `${s.name} · ${str(a, "file.path")}`;
  }
  return out;
}

export function otlpTracesToWire(body: OtlpTraces): WireEvent[] {
  const out: WireEvent[] = [];
  for (const rs of body.resourceSpans ?? []) {
    const res = attrs(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? []) out.push(...spanToWire(res, s));
  }
  return out.sort((x, y) => x.ts - y.ts);
}

/* ---------- logs (Claude Code native telemetry and GenAI log events) ---------- */

/** Telemetry records that describe the exporter's own plumbing rather than agent activity. */
const NOISE = /^(claude_code\.)?hook_execution_(start|complete)$/;

function logToWire(res: Attrs, l: LogRecord, i: number): WireEvent[] {
  const a = attrs(l.attributes);
  const body = val(l.body);
  const bodyText = typeof body === "string" ? body : body ? JSON.stringify(body) : "";
  const name = str(a, "event.name") ?? (typeof body === "string" && /^[a-z_]+\.[a-z_]+$/.test(body) ? body : "") ?? "";
  if (NOISE.test(name)) return [];
  const agent = agentOf(res, a, l.traceId ?? "log");
  const ts = nanoToMs(l.timeUnixNano ?? l.observedTimeUnixNano);
  const id = `ol_${ts.toString(36)}_${i}`;
  const e: WireEvent = { id, ts, kind: "tool", agent, label: name || trim(bodyText), source: "otlp", detail: { event_name: name, body: trim(bodyText, 400), ...a, resource: res } };
  const out: WireEvent[] = [e];
  const tool = str(a, "tool_name", "gen_ai.tool.name");
  const cmd = str(a, "command", "process.command_line");

  if (/user_prompt|gen_ai\.user\.message|gen_ai\.system\.message/.test(name)) {
    e.kind = "llm"; e.text = str(a, "prompt", "gen_ai.prompt", "content") ?? (bodyText || undefined);
    e.label = `user prompt · ${trim(e.text ?? `${num(a, "prompt_length") ?? "?"} chars (content redacted)`, 110)}`; e.tag = "prompt"; e.detail!.role = "user";
  } else if (/assistant|api_response|gen_ai\.choice|gen_ai\.assistant\.message/.test(name)) {
    e.kind = "llm"; e.text = str(a, "content", "gen_ai.completion", "response") ?? (bodyText || undefined);
    e.label = `assistant · ${trim(e.text ?? name, 110)}`; e.tag = str(a, "model", "gen_ai.request.model");
  } else if (/api_request|api_error/.test(name)) {
    e.kind = "llm"; e.label = `${name.replace(/^.*\./, "")} · ${str(a, "model") ?? ""}`;
    e.tag = num(a, "input_tokens") != null ? `${num(a, "input_tokens")}→${num(a, "output_tokens") ?? 0} tok` : str(a, "model");
    if (num(a, "cost_usd") != null) e.detail!.cost_usd = num(a, "cost_usd");
  } else if (/tool_decision|permission/.test(name)) {
    e.kind = "tool"; e.tool = tool; e.label = `${str(a, "decision") ?? "decision"} · ${tool ?? ""} ${trim(cmd ?? str(a, "tool_input", "tool_parameters"), 80)}`;
    e.tag = str(a, "decision", "source"); if (str(a, "decision") === "reject") e.sev = "medium";
  } else if (/tool_result|tool_call|gen_ai\.tool\.message/.test(name)) {
    e.kind = cmd ? "command" : "tool"; e.tool = tool; e.command = cmd;
    e.text = str(a, "tool_output", "result", "content", "tool_input", "tool_parameters", "gen_ai.tool.call.arguments");
    // Claude Code telemetry carries only sizes, never the tool input; hooks (scripts/claude-code-hook.ts) add the text.
    const sizes = num(a, "tool_input_size_bytes") != null ? `${num(a, "tool_input_size_bytes")} B in, ${num(a, "tool_result_size_bytes") ?? 0} B out` : "";
    e.label = cmd ?? `${tool ?? "tool"} · ${trim(e.text, 100) || sizes || "result"}`;
    const failed = a.success === false || a.success === "false";
    e.tag = failed ? "failed" : num(a, "duration_ms") != null ? `${((num(a, "duration_ms") ?? 0) / 1000).toFixed(2)}s` : "result";
    if (failed) e.sev = "low";
    const hosts = extractHosts(cmd);
    hosts.forEach((h, k) => out.push({ id: `${id}_net${k}`, ts, kind: "network", agent, host: h, label: `${tool ?? "tool"} → ${h}`, tag: "derived", source: "otlp", detail: { via: name, tool } }));
  } else if (/hook_registered/.test(name)) {
    e.kind = "file"; e.tag = "hook";
    e.label = `hook registered · ${str(a, "hook_event", "event_name", "hook.event") ?? ""} ${str(a, "hook_type", "hook.type") ?? ""}`.trim();
  } else if (/plugin_loaded|skill_loaded/.test(name)) {
    e.kind = "file"; e.tag = "plugin";
    e.label = `plugin loaded · ${str(a, "plugin.name", "skill.name") ?? "?"} ${str(a, "plugin.version") ?? ""} (${str(a, "marketplace.name", "plugin.scope") ?? "local"})`;
  } else if (/mcp_server_connection|mcp_/.test(name)) {
    e.kind = "tool"; e.tag = "mcp";
    e.label = `mcp ${str(a, "status") ?? "event"} · ${str(a, "server_name", "transport_type") ?? ""} ${str(a, "server_scope") ?? ""}`.trim();
    if (str(a, "status") === "failed") e.sev = "medium";
  } else if (name) {
    e.label = `${name} · ${trim(bodyText, 100)}`;
  }
  return out;
}

export function otlpLogsToWire(body: OtlpLogs): WireEvent[] {
  const out: WireEvent[] = [];
  let i = 0;
  for (const rl of body.resourceLogs ?? []) {
    const res = attrs(rl.resource?.attributes);
    for (const sl of rl.scopeLogs ?? []) for (const l of sl.logRecords ?? []) out.push(...logToWire(res, l, i++));
  }
  return out.sort((x, y) => x.ts - y.ts);
}
