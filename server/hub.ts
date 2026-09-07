/**
 * Fan-out of collector messages to connected browsers over Server-Sent
 * Events. Messages are coalesced into ~80 ms batches so a burst of spans
 * costs one write per client instead of one per span, and a bounded replay
 * buffer lets a page that (re)connects catch up without a database.
 */
import type { ServerResponse } from "node:http";

export type HubMessage =
  | { t: "events"; events: unknown[] }
  | { t: "host:rep"; host: string; rep: unknown }
  | { t: "hits"; eventId: string; hits: unknown[] }
  /** A poorer agent identity turned out to be the same principal as a richer one. */
  | { t: "agent:merge"; from: string; to: unknown }
  | { t: "config"; config: unknown }
  | { t: "status"; status: unknown };

const FLUSH_MS = 80;
const REPLAY_MAX = 1500;
const KEEPALIVE_MS = 20_000;

const clients = new Set<ServerResponse>();
/** Applied to every replayed event right before it is sent (used to refresh reputation verdicts). */
let decorate: (e: unknown) => unknown = (e) => e;
export function setReplayDecorator(fn: (e: unknown) => unknown): void { decorate = fn; }
const replay: unknown[] = [];
let pendingEvents: unknown[] = [];
let pendingOther: HubMessage[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;

function write(res: ServerResponse, msg: HubMessage): void {
  res.write(`id: ${++seq}\ndata: ${JSON.stringify(msg)}\n\n`);
}

function flush(): void {
  flushTimer = undefined;
  const out: HubMessage[] = [...pendingOther];
  if (pendingEvents.length) out.push({ t: "events", events: pendingEvents });
  pendingEvents = [];
  pendingOther = [];
  for (const msg of out) for (const c of clients) write(c, msg);
}

function schedule(): void {
  if (flushTimer === undefined) flushTimer = setTimeout(flush, FLUSH_MS);
}

export function publishEvents(events: unknown[]): void {
  if (!events.length) return;
  replay.push(...events);
  if (replay.length > REPLAY_MAX) replay.splice(0, replay.length - REPLAY_MAX);
  pendingEvents.push(...events);
  schedule();
}

export function publish(msg: Exclude<HubMessage, { t: "events" }>): void {
  pendingOther.push(msg);
  schedule();
}

/** Drop the replay buffer so a reconnecting page starts clean. */
export function clearReplay(): void {
  replay.length = 0;
}

/** Pre-fill the replay buffer (from the on-disk log) without publishing. */
export function seedReplay(events: unknown[]): void {
  replay.push(...events);
  if (replay.length > REPLAY_MAX) replay.splice(0, replay.length - REPLAY_MAX);
}

export function clientCount(): number {
  return clients.size;
}

export function subscribe(res: ServerResponse, hello: HubMessage[]): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": pit\n\n");
  for (const m of hello) write(res, m);
  if (replay.length) write(res, { t: "events", events: replay.map(decorate) });
  clients.add(res);
  const ka = setInterval(() => res.write(": ka\n\n"), KEEPALIVE_MS);
  res.on("close", () => { clearInterval(ka); clients.delete(res); });
}
