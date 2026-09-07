/**
 * Minimal typed event bus. The engine publishes here and never imports UI
 * modules; UI modules subscribe. Any trace source only needs to publish the
 * same messages.
 */
import type { Agent, Alert, HostRecord, Severity, TraceEvent } from "./types";

export interface BusEvents {
  /** An event was appended to the store. */
  event: TraceEvent;
  /** A batch of events finished processing (rules evaluated, store updated). */
  batch: TraceEvent[];
  alert: Alert;
  "alert:repeat": Alert;
  "alert:ack": Alert;
  "host:new": { host: HostRecord; agent: Agent };
  "agent:new": Agent;
  /** A host's reputation verdict changed (e.g. VirusTotal answered). */
  "host:rep": HostRecord;
  "tool:bump": string;
  packet: { agentId: string; hostKey: string; sev: Severity };
  toast: { msg: string; cls?: string };
}

type Handler<T> = (payload: T) => void;
const handlers = new Map<keyof BusEvents, Handler<never>[]>();

export function on<K extends keyof BusEvents>(name: K, fn: Handler<BusEvents[K]>): () => void {
  const list = handlers.get(name) ?? [];
  list.push(fn as Handler<never>);
  handlers.set(name, list);
  return () => {
    const cur = handlers.get(name) ?? [];
    handlers.set(name, cur.filter((h) => h !== (fn as Handler<never>)));
  };
}

export function emit<K extends keyof BusEvents>(name: K, payload: BusEvents[K]): void {
  const list = handlers.get(name);
  if (!list) return;
  for (const fn of list) (fn as Handler<BusEvents[K]>)(payload);
}
