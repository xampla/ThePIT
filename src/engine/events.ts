/** Primitives for building browser events and host records from any source. */
import { emit } from "../bus";
import { S } from "../state";
import type { Agent, HostDef, HostRecord, Kind, TraceEvent } from "../types";

type AgentRef = Pick<Agent, "id" | "name" | "session" | "model">;
type EventFields = Partial<Omit<TraceEvent, "id" | "ts" | "kind" | "agent" | "agentName" | "session" | "model">> & { summary: string };

export function ensureHost(h: HostDef): { host: HostRecord; fresh: boolean } {
  const existing = S.hosts.get(h.h);
  if (existing) return { host: existing, fresh: false };
  const rec: HostRecord = { ...h, pending: true, first: Date.now(), count: 0, agents: new Set(), sources: [] };
  S.hosts.set(h.h, rec);
  return { host: rec, fresh: true };
}

export function mkEvent(kind: Kind, agent: AgentRef, fields: EventFields): TraceEvent {
  return {
    id: "ev_" + (++S.eventSeq).toString(36).padStart(5, "0"),
    ts: new Date(),
    kind,
    agent: agent.id,
    agentName: agent.name,
    session: agent.session,
    model: agent.model,
    sev: "low",
    ...fields,
  };
}

export function bumpTool(n: string): void {
  S.toolCounts.set(n, (S.toolCounts.get(n) ?? 0) + 1);
  emit("tool:bump", n);
}
