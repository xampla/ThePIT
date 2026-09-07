/**
 * Numbat (github.com/perplexityai/numbat) NDJSON record -> WireEvent.
 * Numbat hooks into coding agents (Claude Code, Codex, Cursor, Gemini CLI…)
 * and ships `event` and `finding` records; schema v0.3.0.
 */
import { extractHosts, hostOfUrl } from "./hosts.ts";
import type { WireEvent, WireKind, WireRuleHit, WireSeverity } from "./wire.ts";

interface Endpoint { hostname?: string; username?: string; os?: string; device_id?: string }

export interface NumbatEvent {
  record_type: "event";
  event_id: string;
  run_id?: string;
  timestamp?: string;
  endpoint?: Endpoint;
  source_agent?: string;
  source_type?: string;
  session_id?: string;
  project_path?: string;
  actor?: string;
  event_type: string;
  tool_name?: string;
  command?: string;
  file_path?: string;
  decision?: string;
  tool_call_id?: string;
  exit_code?: number;
  duration_ms?: number;
  approval_decision?: string;
  mcp_server?: string;
  mcp_tool?: string;
  url?: string;
  model?: string;
  model_provider?: string;
  git_branch?: string;
  sub_agent?: string;
  content_preview?: string;
  content?: string;
  tags?: string[];
  confidence?: string;
}

export interface NumbatFinding {
  record_type: "finding";
  finding_id: string;
  run_id?: string;
  timestamp?: string;
  detected_at?: string;
  endpoint?: Endpoint;
  rule_id: string;
  rule_version?: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  source_agent?: string;
  session_id?: string;
  model?: string;
  sub_agent?: string;
  title: string;
  observed_event_type?: string;
  observed_command?: string;
  observed_file_path?: string;
  observed_url?: string;
  observed_mcp_server?: string;
  observed_mcp_tool?: string;
  observed_content_preview?: string;
  tags?: string[];
  cited_event_ids?: string[];
  confidence?: string;
}

export type NumbatRecord = NumbatEvent | NumbatFinding | { record_type: string };

const KIND_OF: Record<string, WireKind> = {
  "session.start": "llm", "session.end": "llm",
  "prompt.user": "llm", "message.assistant": "llm", "message.reasoning": "llm",
  "tool.call": "tool", "tool.result": "tool",
  "command.exec": "command", "command.result": "command",
  "file.read": "file", "file.write": "file", "file.delete": "file",
  "permission.requested": "tool", "permission.approved": "tool", "permission.denied": "tool",
  "config.agent": "file", "config.mcp": "file",
  "network.indicator": "network",
};

function agentOf(r: { source_agent?: string; endpoint?: Endpoint; session_id?: string; run_id?: string; model?: string; sub_agent?: string }) {
  const tool = r.source_agent ?? "agent";
  const host = r.endpoint?.hostname ?? "unknown-host";
  const user = r.endpoint?.username;
  const base = {
    id: `${tool}@${host}`,
    name: `${tool} · ${host}`,
    role: user ? `${user} on ${r.endpoint?.os ?? "endpoint"}` : "coding agent",
    session: short(r.session_id ?? r.run_id ?? "no-session"),
    model: r.model,
  };
  if (!r.sub_agent) return base;
  return { ...base, id: `${base.id}/sub:${r.sub_agent}`, name: `${r.sub_agent} · sub-agent`, role: `sub-agent of ${base.name}`, parent: base.id };
}

const short = (s: string) => (s.length > 18 ? s.slice(0, 8) + "…" + s.slice(-6) : s);
const ts = (s?: string) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : Date.now(); };
const trim = (s: string | undefined, n = 140) => (s ? (s.length > n ? s.slice(0, n - 1) + "…" : s) : "");

export function numbatEventToWire(r: NumbatEvent): WireEvent[] {
  const kind = KIND_OF[r.event_type] ?? "tool";
  const agent = agentOf(r);
  const base: WireEvent = {
    id: "nb_" + r.event_id, ts: ts(r.timestamp), kind, agent, label: r.event_type, source: "numbat",
    detail: {
      event_type: r.event_type, actor: r.actor, tool_call_id: r.tool_call_id, project_path: r.project_path,
      git_branch: r.git_branch, model_provider: r.model_provider, sub_agent: r.sub_agent, tags: r.tags,
      confidence: r.confidence, source_type: r.source_type,
    },
  };
  const text = r.content ?? r.content_preview;
  const out: WireEvent[] = [base];

  switch (r.event_type) {
    case "session.start": base.label = "session started"; base.tag = r.model; break;
    case "session.end": base.label = "session ended"; break;
    case "prompt.user": base.label = `user prompt · ${trim(text)}`; base.text = text; base.tag = "prompt"; base.detail!.role = "user"; break;
    case "message.assistant": base.label = `assistant · ${trim(text)}`; base.text = text; base.tag = r.model; break;
    case "message.reasoning": base.label = `reasoning · ${trim(text)}`; base.text = text; base.tag = "reasoning"; break;
    case "tool.call": {
      const name = r.mcp_tool ? `${r.mcp_server}/${r.mcp_tool}` : r.tool_name ?? "tool";
      base.tool = name; base.label = `${name} · ${trim(text ?? r.file_path ?? r.url ?? r.command, 100)}`;
      base.tag = r.mcp_server ? "mcp" : "call"; base.text = text;
      break;
    }
    case "tool.result": {
      const name = r.mcp_tool ? `${r.mcp_server}/${r.mcp_tool}` : r.tool_name ?? "tool";
      base.tool = name; base.label = `${name} result · ${trim(text, 100)}`;
      base.tag = r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(2)}s` : "result"; base.text = text;
      break;
    }
    case "command.exec":
      base.command = r.command; base.label = r.command ?? "command"; base.tag = r.decision ?? "exec"; base.tool = r.tool_name;
      break;
    case "command.result":
      base.command = r.command; base.label = r.command ? r.command : "command output";
      base.tag = r.exit_code != null ? `exit ${r.exit_code}` : "result"; base.text = text;
      if (r.exit_code) base.sev = "low";
      break;
    case "file.read": case "file.write": case "file.delete":
      base.label = `${r.event_type.slice(5)} · ${r.file_path ?? "?"}`; base.tool = r.tool_name; base.tag = r.event_type.slice(5);
      if (r.event_type === "file.delete") base.sev = "medium";
      break;
    case "permission.requested": case "permission.approved": case "permission.denied":
      base.tool = r.tool_name; base.label = `${r.event_type.slice(11)} · ${r.tool_name ?? ""} ${trim(r.command ?? r.file_path ?? text, 80)}`;
      base.tag = r.approval_decision ?? r.event_type.slice(11);
      if (r.event_type === "permission.denied") base.sev = "medium";
      break;
    case "config.agent": case "config.mcp":
      base.label = `${r.event_type} · ${r.file_path ?? trim(text, 80)}`; base.tag = "config"; base.sev = "medium"; base.text = text;
      break;
    case "network.indicator":
      base.host = r.url ? hostOfUrl(r.url) : undefined; base.label = r.url ?? "network"; base.tag = r.tool_name ?? "indicator";
      break;
    default:
      base.label = `${r.event_type} · ${trim(text ?? r.command ?? r.file_path, 100)}`; base.text = text;
  }

  // Derive network events from anything that names a remote host.
  if (kind !== "network") {
    const seen = new Set<string>();
    const hosts = r.url ? [hostOfUrl(r.url)].filter(Boolean) as string[] : extractHosts(r.command);
    hosts.forEach((h, i) => {
      if (seen.has(h)) return;
      seen.add(h);
      out.push({
        id: `${base.id}_net${i}`, ts: base.ts, kind: "network", agent, host: h, source: "numbat",
        label: r.url ?? `${r.tool_name ?? "command"} → ${h}`, tag: "derived",
        detail: { via: r.event_type, tool: r.tool_name, command: r.command, url: r.url, tool_call_id: r.tool_call_id },
      });
    });
  }
  return out;
}

const SEV: Record<string, WireSeverity> = { info: "low", low: "low", medium: "medium", high: "high", critical: "critical" };

export function numbatFindingToWire(f: NumbatFinding): WireEvent {
  const agent = agentOf(f);
  const kind = KIND_OF[f.observed_event_type ?? ""] ?? "tool";
  const hit: WireRuleHit = {
    id: f.rule_id, title: f.title, sev: SEV[f.severity] ?? "medium", engine: "numbat",
    why: `Numbat rule ${f.rule_id}${f.rule_version ? ` v${f.rule_version}` : ""} matched ${f.observed_event_type ?? "activity"} with ${f.confidence ?? "unknown"} confidence.`,
    fix: "Open the cited events in the trace and confirm whether the activity was expected.",
    meta: { tags: f.tags, cited_event_ids: f.cited_event_ids, confidence: f.confidence },
  };
  const subject = f.observed_command ?? f.observed_url ?? f.observed_file_path ?? f.observed_content_preview ?? "";
  return {
    id: "nbf_" + f.finding_id, ts: ts(f.timestamp ?? f.detected_at), kind, agent, source: "numbat",
    label: `${f.title} · ${trim(subject, 90)}`, tag: f.severity, sev: hit.sev,
    command: f.observed_command, host: f.observed_url ? hostOfUrl(f.observed_url) : undefined,
    tool: f.observed_mcp_tool ? `${f.observed_mcp_server}/${f.observed_mcp_tool}` : undefined,
    rules: [hit],
    detail: { finding_id: f.finding_id, rule_id: f.rule_id, observed_event_type: f.observed_event_type, url: f.observed_url, file_path: f.observed_file_path, content_preview: f.observed_content_preview, cited_event_ids: f.cited_event_ids },
  };
}

export function numbatToWire(rec: NumbatRecord): WireEvent[] {
  if (rec.record_type === "event") return numbatEventToWire(rec as NumbatEvent);
  if (rec.record_type === "finding") return [numbatFindingToWire(rec as NumbatFinding)];
  return []; // indicator, enforcement, scan-summary: derived data we don't need
}

/** Parse an NDJSON body; malformed lines are skipped and counted. */
export function parseNdjson(body: string): { records: NumbatRecord[]; bad: number } {
  const records: NumbatRecord[] = [];
  let bad = 0;
  for (const line of body.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { records.push(JSON.parse(s)); } catch { bad++; }
  }
  return { records, bad };
}
