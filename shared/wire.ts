/**
 * The normalised event the collector emits and the browser consumes. It is
 * deliberately free of presentation: the browser builds the summary HTML.
 * Any trace source (OTLP, JSONL, mock) is mapped into this shape.
 */
export type WireKind = "llm" | "tool" | "command" | "network" | "file";
export type WireSeverity = "low" | "medium" | "high" | "critical";

export interface WireAgent {
  id: string;
  name: string;
  role?: string;
  session: string;
  model?: string;
  /** Set for sub-agents: id of the session agent that spawned them. */
  parent?: string;
}

export interface WireEvent {
  id: string;
  /** Unix epoch milliseconds. */
  ts: number;
  kind: WireKind;
  agent: WireAgent;
  sev?: WireSeverity;
  /** Short human label of what happened (tool name + argument, command, prompt). */
  label: string;
  tag?: string;
  tool?: string;
  command?: string;
  cwd?: string;
  /** Remote host contacted, for network events and tools that reach the network. */
  host?: string;
  /** Free text worth scanning with content rules (prompt, completion, tool output). */
  text?: string;
  /** Rule ids the source or collector already matched. */
  rules?: WireRuleHit[];
  /** Verdict attached by the collector when `host` is set (may be pending). */
  reputation?: WireReputation;
  detail?: Record<string, unknown>;
  /** Where the event came from: "otlp", "jsonl", "mock". */
  source?: string;
}

export interface WireRuleHit {
  id: string;
  title: string;
  sev: WireSeverity;
  why: string;
  fix?: string;
  /** "builtin" | "nova" */
  engine: string;
  meta?: Record<string, unknown>;
}

/** Reputation verdict for a host as computed by the collector. */
export interface WireReputation {
  host: string;
  /** 0..100, higher is better. */
  rep: number;
  cat: string;
  asn: string;
  geo: string;
  /** "virustotal" | "internal" | "pending" | "unavailable" */
  provider: string;
  checkedAt: number;
  sources: { n: string; v: string; ok: boolean }[];
}
