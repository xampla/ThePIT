/**
 * Claude Code hook that forwards tool calls to The PIT collector.
 * Claude Code's native telemetry never includes tool input, so this hook
 * supplies the command text, file paths and tool output that rules need.
 *
 * Install with `npm run hooks:install` (project) or `npm run hooks:install -- --global`, or add by hand to
 * .claude/settings.json (project) or ~/.claude/settings.json:
 * {
 *   "hooks": {
 *     "SessionStart": [...same...], "SessionEnd": [...same...], "UserPromptSubmit": [...same...],
 *     "PreToolUse":  [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /abs/path/scripts/claude-code-hook.ts" }] }],
 *     "PostToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /abs/path/scripts/claude-code-hook.ts" }] }]
 *   }
 * }
 * Env: PIT_COLLECTOR (default http://127.0.0.1:4318), PIT_TOKEN (bearer).
 * Always exits 0 and never blocks the agent for more than ~1.5 s.
 */
import { hostname, userInfo } from "node:os";

interface HookInput {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  /** UserPromptSubmit */
  prompt?: string;
  /** SessionStart */
  source?: string;
  model?: string;
  /** Present when the hook fired inside a sub-agent. */
  agent_id?: string;
  agent_type?: string;
  /** SubagentStop */
  last_assistant_message?: string;
}

const COLLECTOR = (process.env.PIT_COLLECTOR ?? "http://127.0.0.1:4318").replace(/\/$/, "");
const TOKEN = process.env.PIT_TOKEN;
const MAX_TEXT = 12_000;

const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", () => { void main(Buffer.concat(chunks).toString("utf8")); });

function asText(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v.slice(0, MAX_TEXT);
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : typeof x === "object" && x && "text" in x ? String((x as { text: unknown }).text) : JSON.stringify(x))).join("\n").slice(0, MAX_TEXT);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const inner = o.stdout ?? o.output ?? o.content ?? o.result ?? o.text ?? o.file?.toString();
    return (typeof inner === "string" ? inner : JSON.stringify(v)).slice(0, MAX_TEXT);
  }
  return String(v);
}

async function main(raw: string): Promise<void> {
  let h: HookInput;
  try { h = JSON.parse(raw); } catch { return process.exit(0); }
  if (h.hook_event_name === "SubagentStart" || h.hook_event_name === "SubagentStop") {
    const start = h.hook_event_name === "SubagentStart";
    const who = agent(h.session_id, h.agent_id, h.agent_type);
    return send({
      id: `cch_sub_${start ? "start" : "stop"}_${h.agent_id ?? Date.now().toString(36)}`, ts: Date.now(), kind: "llm", agent: who,
      label: start ? `sub-agent started · ${h.agent_type?.trim() || "internal"}` : `sub-agent finished · ${(h.last_assistant_message ?? "").slice(0, 120)}`,
      tag: start ? "spawn" : "done", text: start ? undefined : (h.last_assistant_message ?? "").slice(0, MAX_TEXT), cwd: h.cwd,
      detail: { hook: h.hook_event_name, agent_id: h.agent_id, agent_type: h.agent_type }, source: "claude-code-hook",
    });
  }
  if (h.hook_event_name === "SessionStart" || h.hook_event_name === "SessionEnd") {
    const start = h.hook_event_name === "SessionStart";
    return send({
      id: `cch_session_${start ? "start" : "end"}_${Date.now().toString(36)}`, ts: Date.now(), kind: "llm", agent: { ...agent(h.session_id), model: h.model },
      label: start ? `session started${h.source ? ` (${h.source})` : ""}` : "session ended", tag: h.model ?? "session", cwd: h.cwd,
      detail: { hook: h.hook_event_name, source: h.source, cwd: h.cwd }, source: "claude-code-hook",
    });
  }
  if (h.hook_event_name === "UserPromptSubmit") {
    const prompt = (h.prompt ?? "").slice(0, MAX_TEXT);
    return send({
      id: `cch_prompt_${Date.now().toString(36)}`, ts: Date.now(), kind: "llm", agent: agent(h.session_id, h.agent_id, h.agent_type),
      label: `user prompt · ${prompt.slice(0, 140)}`, tag: "prompt", text: prompt, cwd: h.cwd,
      detail: { hook: h.hook_event_name, role: "user" }, source: "claude-code-hook",
    });
  }
  const post = h.hook_event_name === "PostToolUse";
  const tool = h.tool_name ?? "tool";
  const input = h.tool_input ?? {};
  const command = typeof input.command === "string" ? input.command : undefined;
  const filePath = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined;
  const url = typeof input.url === "string" ? input.url : undefined;
  const isFile = /^(Read|Write|Edit|MultiEdit|NotebookEdit)$/.test(tool) && filePath;
  const kind = command ? "command" : isFile ? "file" : "tool";
  const argText = command ?? filePath ?? url ?? (typeof input.query === "string" ? input.query : typeof input.pattern === "string" ? input.pattern : typeof input.prompt === "string" ? input.prompt : JSON.stringify(input));
  const output = post ? asText(h.tool_response) : undefined;
  const label = kind === "command" ? command! : kind === "file" ? `${tool.toLowerCase()} · ${filePath}` : `${tool} · ${argText.slice(0, 140)}`;

  return send({
    id: `cch_${h.tool_use_id ?? Date.now().toString(36)}_${post ? "post" : "pre"}`,
    ts: Date.now(),
    kind,
    agent: agent(h.session_id, h.agent_id, h.agent_type),
    label: post && kind !== "command" ? `${label} → ${(output ?? "").slice(0, 60)}` : label,
    tag: post ? "result" : "call",
    tool,
    command,
    cwd: h.cwd,
    host: url ? new URL(url).hostname : undefined,
    text: post ? output : kind === "command" ? undefined : argText,
    detail: { hook: h.hook_event_name, tool_use_id: h.tool_use_id, input: post ? undefined : input, url, file_path: filePath },
    source: "claude-code-hook",
  });
}

const short = (s: string) => (s.length > 18 ? s.slice(0, 8) + "…" + s.slice(-6) : s);
/** The session agent, or a sub-agent under it when the hook fired inside one. */
function agent(session?: string, agentId?: string, agentType?: string) {
  const base = {
    id: `claude-code@${hostname()}`, name: `claude-code · ${hostname()}`,
    role: `${userInfo().username} on ${process.platform}`, session: short(session ?? "unknown"),
  };
  if (!agentId) return base;
  const type = agentType?.trim() || "sub-agent"; // Claude Code sends an empty type for its internal helpers
  return {
    id: `${base.id}/sub:${agentId}`, name: `${type} · ${short(agentId)}`,
    role: `sub-agent (${agentType?.trim() || "internal, untyped"}) of ${base.name}`, session: base.session, parent: base.id,
  };
}

async function send(event: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${COLLECTOR}/ingest/jsonl`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
      body: JSON.stringify(event) + "\n",
      signal: AbortSignal.timeout(1500),
    });
  } catch { /* the collector being down must never break the agent */ }
  process.exit(0);
}
