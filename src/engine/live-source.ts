/**
 * Live trace source: subscribes to the collector's Server-Sent Events stream
 * and feeds normalised WireEvents through the same ingest() path the mock
 * uses. Also applies late-arriving reputation verdicts and Nova rule hits.
 */
import { emit } from "../bus";
import { S, registerAgent } from "../state";
import type { Agent, HostRecord, RuleHit, Severity, TraceEvent } from "../types";
import { esc } from "../utils";
import type { WireEvent, WireReputation } from "../../shared/wire";
import { bumpTool, ensureHost, mkEvent } from "./events";
import { ingest } from "./ingest";
import { evaluate, reevaluateHost } from "./rules";

export interface LiveStatus {
  connected: boolean;
  lastMessage: number;
  status: unknown;
}

export const live: LiveStatus = { connected: false, lastMessage: 0, status: null };
export let config: Record<string, unknown> | null = null;

let es: EventSource | undefined;
let onConfig: ((c: Record<string, unknown>) => void) | undefined;
let onStatus: ((s: unknown) => void) | undefined;

const SEEN_MAX = 5000;

/** Ids already ingested; the collector replays its buffer on every (re)connect. */
const seen = new Set<string>();
function isNew(id: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
  return true;
}

function agentFromWire(a: WireEvent["agent"]): Agent {
  if (a.parent && !S.agents.has(a.parent)) {
    registerAgent({ id: a.parent, name: a.parent.replace("@", " · "), role: "coding agent", session: a.session, model: "—" });
  }
  return registerAgent({ id: a.id, name: a.name, role: a.role ?? "agent", session: a.session, model: a.model ?? "—", parent: a.parent });
}

function applyReputation(host: HostRecord, r: WireReputation): void {
  host.rep = r.rep; host.cat = r.cat; host.asn = r.asn; host.geo = r.geo;
  host.provider = r.provider; host.checkedAt = r.checkedAt; host.sources = r.sources;
  host.pending = r.provider === "pending";
}

const SEV_OF_REP = (h: HostRecord): Severity => (h.pending ? "low" : h.rep < 25 ? "critical" : h.rep < 45 ? "high" : "low");

/** Build a browser TraceEvent (with summary HTML) from a WireEvent. */
export function toTraceEvent(w: WireEvent): TraceEvent {
  const agent = agentFromWire(w.agent);
  const hits: RuleHit[] = (w.rules ?? []).map((r) => ({ id: r.id, t: r.title, sev: r.sev, why: r.why, fix: r.fix ?? "Review the trace.", engine: r.engine, meta: r.meta }));
  const base = { ts: new Date(w.ts), sev: w.sev ?? "low", tag: w.tag, tool: w.tool, command: w.command, cwd: w.cwd, host: w.host, text: w.text, hits, detail: { ...(w.detail ?? {}), source: w.source } };
  let e: TraceEvent;

  if (w.kind === "network" && w.host) {
    const rep = w.reputation ?? { host: w.host, rep: 50, cat: "unclassified", asn: "—", geo: "—", provider: "pending", checkedAt: 0, sources: [] };
    const { host, fresh } = ensureHost({ h: w.host, rep: rep.rep, cat: rep.cat, asn: rep.asn, geo: rep.geo });
    if (fresh || host.pending) applyReputation(host, rep);
    host.count++; host.agents.add(agent.id); S.totals.net++;
    const key = agent.id + "|" + host.h;
    const link = S.links.get(key) ?? { count: 0, agent: agent.id, host: host.h, last: 0 };
    link.count++; link.last = Date.now(); S.links.set(key, link);
    const sev = SEV_OF_REP(host);
    e = mkEvent("network", agent, {
      ...base, host: host.h, sev, fresh,
      summary: `${esc(w.label)} → <span class="h">${esc(host.h)}</span>`,
      tag: w.tag ?? (host.pending ? "rep …" : `rep ${host.rep}`),
      ruleHint: !host.pending && host.rep < 25 ? "TW-001" : fresh && !host.pending && host.rep < 80 ? "TW-008" : null,
      detail: { ...base.detail, destination: host.h, reputation: host.pending ? null : host.rep, provider: host.provider },
    });
    if (fresh) emit("host:new", { host, agent });
    emit("packet", { agentId: agent.id, hostKey: host.h, sev });
  } else if (w.kind === "tool") {
    if (w.tool) bumpTool(w.tool);
    const [head, ...rest] = w.label.split(" · ");
    e = mkEvent("tool", agent, { ...base, summary: rest.length ? `${esc(head)} · <b>${esc(rest.join(" · "))}</b>` : esc(w.label) });
  } else if (w.kind === "command") {
    S.totals.commands++;
    e = mkEvent("command", agent, { ...base, summary: `<b>${esc(w.label)}</b>`, tag: w.tag ?? "exec", cwd: w.cwd ?? (typeof w.detail?.project_path === "string" ? w.detail.project_path : undefined) });
  } else if (w.kind === "llm") {
    const [head, ...rest] = w.label.split(" · ");
    e = mkEvent("llm", agent, { ...base, summary: rest.length ? `${esc(head)} · <b>${esc(rest.join(" · "))}</b>` : esc(w.label), tag: w.tag ?? agent.model });
  } else {
    const [head, ...rest] = w.label.split(" · ");
    e = mkEvent("file", agent, { ...base, summary: rest.length ? `${esc(head)} · <b>${esc(rest.join(" · "))}</b>` : esc(w.label) });
  }
  e.id = w.id; // keep the collector's id so late rule hits can find the event
  return e;
}

function onHostRep(host: string, rep: WireReputation): void {
  const h = S.hosts.get(host);
  if (!h) return;
  const wasPending = h.pending;
  applyReputation(h, rep);
  emit("host:rep", h);
  if (wasPending && !h.pending) {
    reevaluateHost(host);
    if (h.rep < 40) emit("toast", { msg: `${host} scored ${h.rep} on ${rep.provider}`, cls: "risk" });
  }
}

/** Re-key everything recorded under a provisional agent id onto the canonical one. */
function onAgentMerge(from: string, to: WireEvent["agent"]): void {
  const target = agentFromWire(to);
  if (from === target.id) return;
  const old = S.agentState.get(from);
  if (old) {
    const cur = S.agentState.get(target.id)!;
    cur.calls += old.calls; cur.risk += old.risk; cur.last = Math.max(cur.last, old.last);
  }
  S.agents.delete(from); S.agentState.delete(from);
  for (const e of S.events) if (e.agent === from) { e.agent = target.id; e.agentName = target.name; }
  for (const a of S.alerts) if (a.agentId === from) { a.agentId = target.id; a.agent = target.name; }
  for (const h of S.hosts.values()) if (h.agents.delete(from)) h.agents.add(target.id);
  for (const [key, l] of [...S.links]) if (l.agent === from) {
    S.links.delete(key);
    const nk = target.id + "|" + l.host;
    const cur = S.links.get(nk);
    if (cur) { cur.count += l.count; cur.last = Math.max(cur.last, l.last); } else S.links.set(nk, { ...l, agent: target.id });
  }
  if (S.focusAgent === from) S.focusAgent = target.id;
  emit("agent:new", target);
  emit("batch", []);
}

function onHits(eventId: string, hits: RuleHit[]): void {
  const e = S.events.find((x) => x.id === eventId);
  if (!e) return;
  e.hits = hits;
  e.ruleHint = null;
  evaluate(e);
}

interface WireHit { id: string; title: string; sev: Severity; why: string; fix?: string; engine: string; meta?: Record<string, unknown> }

function onMessage(raw: string): void {
  const msg = JSON.parse(raw) as { t: string } & Record<string, unknown>;
  live.lastMessage = Date.now();
  switch (msg.t) {
    case "events": {
      const events = (msg.events as WireEvent[]).filter((w) => isNew(w.id)).map(toTraceEvent);
      if (events.length) ingest(events);
      break;
    }
    case "host:rep": onHostRep(msg.host as string, msg.rep as WireReputation); break;
    case "hits": onHits(msg.eventId as string, (msg.hits as WireHit[]).map((r) => ({ id: r.id, t: r.title, sev: r.sev, why: r.why, fix: r.fix ?? "Review the trace.", engine: r.engine, meta: r.meta }))); break;
    case "agent:merge": onAgentMerge(msg.from as string, msg.to as WireEvent["agent"]); break;
    case "config": config = msg.config as Record<string, unknown>; onConfig?.(config); break;
    case "status": live.status = msg.status; onStatus?.(msg.status); break;
  }
}

export function startLiveSource(handlers: { onConfig?: (c: Record<string, unknown>) => void; onStatus?: (s: unknown) => void } = {}): void {
  onConfig = handlers.onConfig; onStatus = handlers.onStatus;
  if (es) return;
  es = new EventSource("/api/stream");
  let lostSince = 0;
  es.onopen = () => {
    if (!live.connected && lostSince) emit("toast", { msg: "Collector reconnected" });
    live.connected = true; lostSince = 0;
  };
  es.onmessage = (ev) => { try { onMessage(ev.data); } catch (err) { console.error("bad stream message", err); } };
  es.onerror = () => {
    if (live.connected) { lostSince = Date.now(); emit("toast", { msg: "Collector connection lost — retrying", cls: "risk" }); }
    live.connected = false;
  };
}

/** Fetch the collector config once (also tells us whether a collector exists at all). */
export async function fetchConfig(): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch("/api/config", { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    config = (await r.json()) as Record<string, unknown>;
    return config;
  } catch {
    return null;
  }
}

export async function saveConfig(patch: unknown): Promise<Record<string, unknown>> {
  const r = await fetch("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  if (!r.ok) throw new Error(`save failed (${r.status})`);
  config = (await r.json()) as Record<string, unknown>;
  return config;
}

interface Mute { rule: string; agent: string }
const cfgRules = () => (config?.rules as { mutes?: Mute[] } | undefined);
const cfgRep = () => (config?.reputation as { allowList?: string[] } | undefined);

export function isMuted(rule: string, agentId: string): boolean {
  return (cfgRules()?.mutes ?? []).some((m) => m.rule === rule && (m.agent === "*" || m.agent === agentId));
}

export async function muteRule(rule: string, agent: string): Promise<void> {
  const mutes = [...(cfgRules()?.mutes ?? [])];
  if (!mutes.some((m) => m.rule === rule && m.agent === agent)) mutes.push({ rule, agent });
  await saveConfig({ rules: { mutes } });
}

export async function unmuteRule(rule: string, agent: string): Promise<void> {
  await saveConfig({ rules: { mutes: (cfgRules()?.mutes ?? []).filter((m) => !(m.rule === rule && m.agent === agent)) } });
}

export function isAllowListed(host: string): boolean {
  const h = host.toLowerCase();
  return (cfgRep()?.allowList ?? []).some((a) => { const s = a.toLowerCase(); return h === s || h.endsWith("." + s) || (s.startsWith(".") && h.endsWith(s)); });
}

export async function allowHost(host: string): Promise<void> {
  const list = [...(cfgRep()?.allowList ?? [])];
  if (!list.includes(host)) list.push(host);
  await saveConfig({ reputation: { allowList: list } });
  await fetch("/api/reputation/clear?host=" + encodeURIComponent(host), { method: "POST" });
  const rec = S.hosts.get(host);
  if (rec) { rec.rep = 92; rec.cat = "allow-listed"; rec.provider = "allowlist"; rec.pending = false; rec.sources = [{ n: "Workspace allow list", v: "listed", ok: true }]; emit("host:rep", rec); }
}

export async function fetchStatus(): Promise<unknown> {
  const r = await fetch("/api/status", { signal: AbortSignal.timeout(4000) });
  live.status = await r.json();
  return live.status;
}
