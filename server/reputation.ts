/**
 * Host reputation via the VirusTotal public API (v3).
 *
 * The free tier allows 4 requests / minute and 500 / day, one host per
 * request, and cannot be called from a browser. So the collector owns the
 * key, answers immediately with a cached or "pending" verdict, and drains a
 * deduplicated queue at the allowed pace. Verdicts are persisted to disk so
 * a restart never re-spends quota, and the daily counter is persisted too.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isIP } from "node:net";
import { getConfig } from "./config.ts";
import { publish } from "./hub.ts";
import type { WireReputation } from "../shared/wire.ts";

const FILE = resolve(process.env.PIT_DATA ?? "data", "reputation.json");
const VT = "https://www.virustotal.com/api/v3";
const NEGATIVE_TTL_MS = 3600_000;
const FLAGGED_TTL_DIVISOR = 4;
const SAVE_DEBOUNCE_MS = 1500;

interface CacheEntry { rep: WireReputation; expires: number }
interface Persisted { cache: Record<string, CacheEntry>; day: string; used: number }

const cache = new Map<string, CacheEntry>();
const queue: string[] = [];
const queued = new Set<string>();
let quota = { day: today(), used: 0 };
let minuteStamps: number[] = [];
let draining = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let lastError = "";

function today(): string { return new Date().toISOString().slice(0, 10); }

function load(): void {
  try {
    const p = JSON.parse(readFileSync(FILE, "utf8")) as Persisted;
    for (const [k, v] of Object.entries(p.cache ?? {})) cache.set(k, v);
    if (p.day === today()) quota = { day: p.day, used: p.used };
  } catch { /* first run */ }
}
load();

function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    const now = Date.now();
    const out: Persisted = { cache: {}, day: quota.day, used: quota.used };
    for (const [k, v] of cache) if (v.expires > now) out.cache[k] = v;
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE + ".tmp", JSON.stringify(out));
    renameSync(FILE + ".tmp", FILE);
  }, SAVE_DEBOUNCE_MS);
}

/* ---------- classification of hosts that never leave the box ---------- */

const PRIVATE_V4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function isInternal(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h) === 4) return PRIVATE_V4.test(h);
  if (isIP(h) === 6) return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
  return getConfig().reputation.skipSuffixes.some((s) => h.endsWith(s)) || !h.includes(".");
}

function internalVerdict(host: string): WireReputation {
  return {
    host, rep: 78, cat: "internal service", asn: "private range", geo: "—", provider: "internal", checkedAt: Date.now(),
    sources: [{ n: "Address space", v: "private / internal", ok: true }],
  };
}

function pendingVerdict(host: string): WireReputation {
  return { host, rep: 50, cat: "unclassified", asn: "—", geo: "—", provider: "pending", checkedAt: 0, sources: [] };
}

function unavailableVerdict(host: string, why: string): WireReputation {
  return {
    host, rep: 50, cat: "unclassified", asn: "—", geo: "—", provider: "unavailable", checkedAt: Date.now(),
    sources: [{ n: "VirusTotal", v: why, ok: false }],
  };
}

function allowListed(host: string): boolean {
  return getConfig().reputation.allowList.some((a) => { const s = a.trim().toLowerCase(); return s && (host === s || host.endsWith("." + s) || (s.startsWith(".") && host.endsWith(s))); });
}

function allowVerdict(host: string): WireReputation {
  return {
    host, rep: 92, cat: "allow-listed", asn: "—", geo: "—", provider: "allowlist", checkedAt: Date.now(),
    sources: [{ n: "Workspace allow list", v: "listed", ok: true }],
  };
}

/* ---------- public API ---------- */

/** Immediate answer; a network lookup is scheduled when needed. */
export function lookup(host: string): WireReputation {
  const key = host.toLowerCase();
  if (allowListed(key)) return allowVerdict(key);
  if (isInternal(key)) return internalVerdict(key);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.rep;
  const cfg = getConfig().reputation;
  if (!cfg.virustotalKey) return hit?.rep ?? unavailableVerdict(key, "no VirusTotal key configured");
  enqueue(key);
  return hit?.rep ?? pendingVerdict(key);
}

export function status(): unknown {
  rollDay();
  const now = Date.now();
  minuteStamps = minuteStamps.filter((t) => now - t < 60_000);
  const cfg = getConfig().reputation;
  return {
    keySet: Boolean(cfg.virustotalKey), provider: "virustotal",
    cached: cache.size, queued: queue.length,
    usedMinute: minuteStamps.length, perMinute: cfg.perMinute, usedDay: quota.used, perDay: cfg.perDay,
    lastError,
  };
}

export function invalidate(host?: string): void {
  if (host) cache.delete(host.toLowerCase()); else cache.clear();
  save();
}

/* ---------- queue + rate limiting ---------- */

function enqueue(host: string): void {
  if (queued.has(host)) return;
  queued.add(host);
  queue.push(host);
  void drain();
}

function rollDay(): void {
  if (quota.day !== today()) { quota = { day: today(), used: 0 }; save(); }
}

/** Milliseconds to wait before the next request is within both quotas, or -1 if the day is spent. */
function waitFor(): number {
  rollDay();
  const cfg = getConfig().reputation;
  if (quota.used >= cfg.perDay) return -1;
  const now = Date.now();
  minuteStamps = minuteStamps.filter((t) => now - t < 60_000);
  if (minuteStamps.length < cfg.perMinute) return 0;
  return 60_000 - (now - minuteStamps[0]) + 250;
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const cfg = getConfig().reputation;
      if (!cfg.virustotalKey) { queue.length = 0; queued.clear(); break; }
      const wait = waitFor();
      if (wait < 0) {
        // day is spent: resolve everything as unavailable so the UI stops waiting
        lastError = "daily quota exhausted";
        for (const h of queue.splice(0)) { queued.delete(h); resolve_(h, unavailableVerdict(h, "daily quota exhausted"), NEGATIVE_TTL_MS); }
        break;
      }
      if (wait > 0) await sleep(wait);
      const host = queue.shift()!;
      queued.delete(host);
      minuteStamps.push(Date.now());
      quota.used++;
      try {
        const v = await fetchVerdict(host, cfg.virustotalKey);
        const flagged = v.rep < 50;
        resolve_(host, v, flagged ? (cfg.cacheTtlSec * 1000) / FLAGGED_TTL_DIVISOR : cfg.cacheTtlSec * 1000);
        lastError = "";
      } catch (err) {
        const msg = (err as Error).message;
        lastError = msg;
        if (msg.startsWith("429")) {
          // quota answer from the API: back off and retry this host once
          queue.unshift(host); queued.add(host);
          await sleep(60_000);
          continue;
        }
        resolve_(host, unavailableVerdict(host, msg), NEGATIVE_TTL_MS);
      }
    }
  } finally {
    draining = false;
  }
}

function resolve_(host: string, rep: WireReputation, ttl: number): void {
  cache.set(host, { rep, expires: Date.now() + ttl });
  save();
  publish({ t: "host:rep", host, rep });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- VirusTotal ---------- */

interface Stats { harmless: number; malicious: number; suspicious: number; undetected: number; timeout: number }
interface VtAttrs {
  last_analysis_stats?: Stats;
  reputation?: number;
  last_analysis_date?: number;
  categories?: Record<string, string>;
  asn?: number;
  as_owner?: string;
  country?: string;
  network?: string;
  creation_date?: number;
  registrar?: string;
  popularity_ranks?: Record<string, { rank: number; timestamp: number }>;
}

async function fetchVerdict(host: string, key: string): Promise<WireReputation> {
  const kind = isIP(host) ? "ip_addresses" : "domains";
  const res = await fetch(`${VT}/${kind}/${encodeURIComponent(host)}`, {
    headers: { "x-apikey": key, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return unavailableVerdict(host, "unknown to VirusTotal");
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    throw new Error(`${res.status} ${body?.error?.code ?? res.statusText}`);
  }
  const attrs = ((await res.json()) as { data?: { attributes?: VtAttrs } }).data?.attributes ?? {};
  return score(host, attrs);
}

/** Map VirusTotal attributes onto The PIT's 0..100 scale (higher is better). */
export function score(host: string, a: VtAttrs): WireReputation {
  const st = a.last_analysis_stats ?? { harmless: 0, malicious: 0, suspicious: 0, undetected: 0, timeout: 0 };
  const engines = st.harmless + st.malicious + st.suspicious + st.undetected;
  const sources: WireReputation["sources"] = [];
  let rep: number;

  if (engines === 0) {
    rep = 55;
    sources.push({ n: "Engine verdicts", v: "no analysis on record", ok: false });
  } else if (st.malicious + st.suspicious === 0) {
    rep = st.harmless > 0 ? 88 : 70;
    sources.push({ n: "Engine verdicts", v: `0 of ${engines} flagged`, ok: true });
  } else {
    rep = Math.max(3, 80 - st.malicious * 10 - st.suspicious * 4);
    sources.push({ n: "Engine verdicts", v: `${st.malicious} malicious, ${st.suspicious} suspicious of ${engines}`, ok: false });
  }

  const community = a.reputation ?? 0;
  if (community < -5) rep -= 15; else if (community > 5) rep += 5;
  sources.push({ n: "Community score", v: String(community), ok: community >= 0 });

  const ranks = Object.values(a.popularity_ranks ?? {}).map((r) => r.rank).filter((r) => r > 0);
  if (ranks.length) {
    const best = Math.min(...ranks);
    if (best <= 100_000) rep += 8;
    sources.push({ n: "Popularity rank", v: `#${best.toLocaleString()}`, ok: best <= 1_000_000 });
  }

  if (a.creation_date) {
    const days = Math.floor((Date.now() / 1000 - a.creation_date) / 86_400);
    if (days < 30) rep -= 15;
    sources.push({ n: "Domain age", v: days < 365 ? `${days} days` : `${Math.floor(days / 365)} years`, ok: days >= 30 });
  }

  if (a.last_analysis_date) {
    const ageDays = Math.floor((Date.now() / 1000 - a.last_analysis_date) / 86_400);
    sources.push({ n: "Last analysis", v: ageDays === 0 ? "today" : `${ageDays} days ago`, ok: ageDays <= 30 });
  }

  rep = Math.max(2, Math.min(97, Math.round(rep)));
  const cats = Object.values(a.categories ?? {});
  return {
    host, rep,
    cat: cats[0]?.toLowerCase() ?? (isIP(host) ? "ip address" : "domain"),
    asn: a.asn ? `AS${a.asn} ${a.as_owner ?? ""}`.trim() : a.registrar ?? "—",
    geo: a.country ?? "—",
    provider: "virustotal",
    checkedAt: Date.now(),
    sources,
  };
}
