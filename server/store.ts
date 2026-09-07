/**
 * Durable event log. Every published event is appended to a daily JSONL file
 * under data/events/; at start the newest events are read back into the
 * replay buffer so a restart, or a page reload days later, still shows the
 * agents, hosts and sub-agents that were seen. Nothing is ever deleted
 * automatically; only "Clear collected events" in Settings removes files.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WireEvent } from "../shared/wire.ts";

const DIR = resolve(process.env.PIT_DATA ?? "data", "events");

let buffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

const fileFor = (ts: number) => join(DIR, `${new Date(ts).toISOString().slice(0, 10)}.jsonl`);

const HITS_FILE = () => join(DIR, "hits.jsonl");

/** Rule hits that arrived after the event was written (Nova is asynchronous). */
export function appendHits(eventId: string, hits: unknown[]): void {
  mkdirSync(DIR, { recursive: true });
  appendFileSync(HITS_FILE(), JSON.stringify({ eventId, hits }) + "\n");
}

export function appendEvents(events: WireEvent[]): void {
  for (const e of events) buffer.push(JSON.stringify(e));
  if (flushTimer === undefined) flushTimer = setTimeout(flush, 500);
}

function flush(): void {
  flushTimer = undefined;
  if (!buffer.length) return;
  mkdirSync(DIR, { recursive: true });
  // events in one flush share a day in practice; split defensively at midnight
  const byFile = new Map<string, string[]>();
  for (const line of buffer) {
    const ts = (JSON.parse(line) as WireEvent).ts;
    const f = fileFor(ts);
    (byFile.get(f) ?? byFile.set(f, []).get(f)!).push(line);
  }
  buffer = [];
  for (const [f, lines] of byFile) appendFileSync(f, lines.join("\n") + "\n");
}

/** Newest `max` events from disk, oldest first. */
export function loadRecent(max: number): WireEvent[] {
  if (!existsSync(DIR)) return [];
  const files = readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  const out: WireEvent[] = [];
  for (const f of files) {
    if (f === "hits.jsonl") continue;
    const lines = readFileSync(join(DIR, f), "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
      try { out.push(JSON.parse(lines[i])); } catch { /* skip a torn line */ }
    }
    if (out.length >= max) break;
  }
  out.reverse();
  // merge late rule hits back onto their events
  if (existsSync(HITS_FILE())) {
    const byId = new Map(out.map((e) => [e.id, e]));
    for (const line of readFileSync(HITS_FILE(), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const { eventId, hits } = JSON.parse(line) as { eventId: string; hits: WireEvent["rules"] };
        const e = byId.get(eventId);
        if (e && hits) { const have = new Set((e.rules ?? []).map((h) => h.id)); e.rules = [...(e.rules ?? []), ...hits.filter((h) => !have.has(h.id))]; }
      } catch { /* skip */ }
    }
  }
  return out;
}

export function clearEventLog(): void {
  buffer = [];
  if (!existsSync(DIR)) return;
  for (const f of readdirSync(DIR)) if (f.endsWith(".jsonl")) unlinkSync(join(DIR, f));
}

export function storeStatus(): unknown {
  let files = 0, bytes = 0;
  if (existsSync(DIR)) for (const f of readdirSync(DIR)) if (f.endsWith(".jsonl")) { files++; bytes += statSync(join(DIR, f)).size; }
  return { dir: DIR, files, bytes };
}

process.on("exit", flush);
