/** Domain types shared by the engine and the UI. */

export type Kind = "llm" | "tool" | "command" | "network" | "file" | "rule";
export type Severity = "low" | "medium" | "high" | "critical";
export type StreamMode = "live" | "history";

export interface Agent {
  id: string;
  name: string;
  role: string;
  session: string;
  model: string;
  /** Sub-agents point at the session agent that spawned them. */
  parent?: string;
}

/** Static description of a remote host as it appears in the reputation feed. */
export interface HostDef {
  h: string;
  rep: number;
  cat: string;
  asn: string;
  geo: string;
}

export interface ReputationSource {
  n: string;
  v: string;
  ok: boolean;
}

/** A host that has actually been contacted during this session. */
export interface HostRecord extends HostDef {
  /** True until the collector has answered with a reputation verdict. */
  pending?: boolean;
  provider?: string;
  checkedAt?: number;
  first: number;
  count: number;
  agents: Set<string>;
  sources: ReputationSource[];
}

export interface RuleDef {
  t: string;
  sev: Severity;
  why: string;
  fix: string;
}

export interface RuleHit extends RuleDef {
  id: string;
  engine: string;
  meta?: Record<string, unknown>;
}

export interface TraceEvent {
  id: string;
  ts: Date;
  kind: Kind;
  agent: string;
  agentName: string;
  session: string;
  model: string;
  sev: Severity;
  /** Trusted HTML fragment rendered in the stream row. */
  summary: string;
  tag?: string;
  tool?: string;
  command?: string;
  cwd?: string;
  host?: string;
  ruleHint?: string | null;
  /** Rule matches computed upstream (collector built-ins, Nova). */
  hits?: RuleHit[];
  /** Free text the content rules looked at (prompt, output). */
  text?: string;
  fresh?: boolean;
  alertId?: string;
  detail?: Record<string, unknown>;
}

export interface Alert {
  id: string;
  rule: string;
  title: string;
  sev: Severity;
  why: string;
  fix: string;
  ts: Date;
  agent: string;
  agentId: string;
  session: string;
  host: string | null;
  trigger: TraceEvent;
  trail: TraceEvent[];
  repeat?: number;
  /** Operator has seen it; it no longer counts as needing review. */
  ack?: boolean;
}

export interface Link {
  count: number;
  agent: string;
  host: string;
  last: number;
}

export interface AgentStats {
  calls: number;
  risk: number;
  last: number;
}
