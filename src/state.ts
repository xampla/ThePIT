import { emit } from "./bus";
import type { Agent, AgentStats, Alert, HostRecord, Kind, Link, Severity, StreamMode, TraceEvent } from "./types";

export const sevRank: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

export interface AppState {
  mode: StreamMode;
  agents: Map<string, Agent>;
  events: TraceEvent[];
  eventSeq: number;
  hosts: Map<string, HostRecord>;
  /** keyed by "agentId|host" */
  links: Map<string, Link>;
  alerts: Alert[];
  toolCounts: Map<string, number>;
  agentState: Map<string, AgentStats>;
  filters: Set<Kind>;
  query: string;
  buffered: number;
  totals: { events: number; commands: number; net: number };
  focusAgent: string | null;
}

export const S: AppState = {
  mode: "live",
  agents: new Map(),
  events: [],
  eventSeq: 0,
  hosts: new Map(),
  links: new Map(),
  alerts: [],
  toolCounts: new Map(),
  agentState: new Map(),
  filters: new Set(),
  query: "",
  buffered: 0,
  totals: { events: 0, commands: 0, net: 0 },
  focusAgent: null,
};

/** Register an agent the first time it is seen (demo corpus or live trace). */
export function registerAgent(a: Agent): Agent {
  const cur = S.agents.get(a.id);
  if (cur) {
    if (a.session && a.session !== cur.session) cur.session = a.session;
    if (a.model && a.model !== cur.model) cur.model = a.model;
    return cur;
  }
  const rec = { ...a };
  S.agents.set(a.id, rec);
  S.agentState.set(a.id, { calls: 0, risk: 0, last: 0 });
  emit("agent:new", rec);
  return rec;
}

export const agentById = (id: string): Agent | undefined => S.agents.get(id);
/** Session agents first, each followed by its sub-agents. */
export const agentList = (): Agent[] => {
  const all = [...S.agents.values()];
  const out: Agent[] = [];
  for (const a of all) if (!a.parent) { out.push(a); out.push(...all.filter((c) => c.parent === a.id)); }
  for (const a of all) if (a.parent && !out.includes(a)) out.push(a); // orphaned sub-agents (parent unknown)
  return out;
};

export const MAX_EVENTS = 1500;
export const MAX_ALERTS = 200;
