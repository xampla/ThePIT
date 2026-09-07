/**
 * Rule pipeline for the collector.
 *
 *  1. Built-in rules: regexes on structured fields, synchronous, free.
 *  2. Nova (github.com/Nova-Hunting/nova-framework): content rules over the
 *     free text of prompts, completions and tool output. Nova is Python, so it
 *     runs as a sidecar (see nova-service/) and is called over HTTP. Results
 *     are cached by text hash, requests are batched per ingest, and hits are
 *     published after the events so the stream is never held back.
 */
import { createHash } from "node:crypto";
import { getConfig } from "./config.ts";
import { publish } from "./hub.ts";
import { managedReady, managedStatus, novaCall, startManagedInBackground } from "./nova-client.ts";
import { appendHits } from "./store.ts";
import { evaluateBuiltin } from "../shared/builtin-rules.ts";
import type { WireEvent, WireRuleHit, WireSeverity } from "../shared/wire.ts";

const CACHE_MAX = 4000;
const MIN_TEXT = 12;
const MAX_TEXT = 16_000;
const HEALTH_TTL_MS = 10_000;
const BATCH_MAX = 32;

interface NovaMatch {
  rule: string;
  semantic_score?: number;
  severity?: string;
  category?: string;
  description?: string;
  keywords?: string[];
  semantics?: string[];
  llm?: string[];
  meta?: Record<string, unknown>;
}
interface NovaScanResponse { results: { matches: NovaMatch[]; warnings?: string[] }[] }
interface NovaHealth { ok: boolean; rules: number; semantic: boolean; llm: string | null; rules_dir?: string; version?: string; revision?: Record<string, unknown> }

const cache = new Map<string, WireRuleHit[]>();
let health: { at: number; value: NovaHealth | null; error: string } = { at: 0, value: null, error: "" };
let stats = { scanned: 0, cached: 0, hits: 0, errors: 0, lastLatencyMs: 0 };
/** Hits per rule since the collector started; the data behind "which rules misbehave". */
const byRule: Record<string, number> = {};

const SEV: Record<string, WireSeverity> = { info: "low", low: "low", medium: "medium", high: "high", critical: "critical" };

function remember(key: string, hits: WireRuleHit[]): void {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, hits);
}

function toHit(m: NovaMatch): WireRuleHit {
  const score = m.semantic_score ? ` (similarity ${m.semantic_score.toFixed(2)})` : "";
  const via = [m.keywords?.length ? `keywords ${m.keywords.join(", ")}` : "", m.semantics?.length ? `semantics ${m.semantics.join(", ")}${score}` : "", m.llm?.length ? `llm ${m.llm.join(", ")}` : ""].filter(Boolean).join("; ");
  return {
    id: `NOVA:${m.rule}`, title: m.description ?? m.rule, sev: SEV[m.severity ?? ""] ?? "medium", engine: "nova",
    why: `Nova rule ${m.rule}${m.category ? ` (${m.category})` : ""} matched${via ? ` via ${via}` : ""}.`,
    fix: "Review the matched text in the trace; if the content is untrusted tool output, discard it and re-run the step with it wrapped.",
    meta: { category: m.category, keywords: m.keywords, semantics: m.semantics, llm: m.llm, ...(m.meta ?? {}) },
  };
}

const policyKey = (c: NovaCfg) => `|${c.keywordsOnly}|${[...c.disabled].sort().join(",")}`;

/** Drop hits the operator silenced for this agent (or everywhere). */
export function unmuted(agentId: string, hits: WireRuleHit[]): WireRuleHit[] {
  const mutes = getConfig().rules.mutes;
  if (!mutes.length) return hits;
  return hits.filter((h) => !mutes.some((m) => m.rule === h.id && (m.agent === "*" || m.agent === agentId)));
}

/** Synchronous: built-in hits are attached to the event before it is published. */
export function applyBuiltin(e: WireEvent): void {
  if (!getConfig().rules.builtin) return;
  const hits = unmuted(e.agent.id, evaluateBuiltin(e));
  if (hits.length) e.rules = [...(e.rules ?? []), ...hits];
}

/** Asynchronous: Nova hits are published later as a "hits" message. */
export async function applyNova(events: WireEvent[]): Promise<void> {
  const cfg = getConfig().rules.nova;
  if (!cfg.enabled || !cfg.url) return;
  const kinds = new Set(cfg.kinds);
  const pending: { e: WireEvent; key: string; text: string }[] = [];
  for (const e of events) {
    if (!kinds.has(e.kind) || !e.text || e.text.length < MIN_TEXT) continue;
    if (!cfg.scanUserPrompts && e.detail?.role === "user") continue;
    const text = e.text.length > MAX_TEXT ? e.text.slice(0, MAX_TEXT) : e.text;
    const key = createHash("sha1").update(text).update(policyKey(cfg)).digest("hex");
    const hit = cache.get(key);
    if (hit) { stats.cached++; const live = unmuted(e.agent.id, hit); if (live.length) publish({ t: "hits", eventId: e.id, hits: live }); continue; }
    pending.push({ e, key, text });
  }
  for (let i = 0; i < pending.length; i += BATCH_MAX) await scanBatch(pending.slice(i, i + BATCH_MAX), cfg);
}

type NovaCfg = ReturnType<typeof getConfig>["rules"]["nova"];

async function scanBatch(batch: { e: WireEvent; key: string; text: string }[], cfg: NovaCfg): Promise<void> {
  const t0 = Date.now();
  try {
    const data = (await novaCall("scan", {
      texts: batch.map((b) => b.text), skip_llm: cfg.keywordsOnly, skip_semantics: cfg.keywordsOnly, disabled_rules: cfg.disabled,
    }, cfg.timeoutMs)) as NovaScanResponse;
    stats.lastLatencyMs = Date.now() - t0;
    batch.forEach((b, i) => {
      const hits = (data.results[i]?.matches ?? []).map(toHit);
      stats.scanned++; stats.hits += hits.length;
      for (const h of hits) byRule[h.id] = (byRule[h.id] ?? 0) + 1;
      remember(b.key, hits);
      const live = unmuted(b.e.agent.id, hits);
      if (live.length) { publish({ t: "hits", eventId: b.e.id, hits: live }); b.e.rules = [...(b.e.rules ?? []), ...live]; appendHits(b.e.id, live); }
    });
  } catch (err) {
    stats.errors++;
    health = { at: Date.now(), value: null, error: (err as Error).message };
  }
}

export async function novaHealth(force = false): Promise<{ reachable: boolean; info: NovaHealth | null; error: string }> {
  const cfg = getConfig().rules.nova;
  if (cfg.mode === "remote" && !cfg.url) return { reachable: false, info: null, error: "no url" };
  if (!force && Date.now() - health.at < HEALTH_TTL_MS) return { reachable: !!health.value, info: health.value, error: health.error };
  if (cfg.mode === "managed" && !managedReady()) {
    // never block a status call on the sidecar's start-up (model load can take a while)
    startManagedInBackground();
    return { reachable: false, info: null, error: "starting" };
  }
  try {
    const info = (await novaCall("health", {}, 5000)) as NovaHealth;
    health = { at: Date.now(), value: info, error: "" };
  } catch (err) {
    health = { at: Date.now(), value: null, error: (err as Error).message };
  }
  return { reachable: !!health.value, info: health.value, error: health.error };
}

export async function rulesStatus(): Promise<unknown> {
  const cfg = getConfig().rules;
  const nova = cfg.nova.enabled ? await novaHealth() : { reachable: false, info: null, error: "" };
  return { builtin: cfg.builtin, nova: { enabled: cfg.nova.enabled, mode: cfg.nova.mode, url: cfg.nova.url, ...nova, process: cfg.nova.mode === "managed" ? managedStatus() : null, cache: cache.size, ...stats, byRule } };
}

export function clearNovaCache(): void { cache.clear(); }

export async function novaUpdateRules(): Promise<unknown> {
  const out = await novaCall("update", {}, 120_000);
  health.at = 0; // next status call re-reads the sidecar
  clearNovaCache();
  return out;
}

export function novaRules(): Promise<unknown> {
  return novaCall("rules", {}, 200_000);
}

/** Start the managed sidecar at boot when it is enabled, so the first scan is not the one paying the model load. */
export function warmNova(): void {
  const cfg = getConfig().rules.nova;
  if (cfg.enabled && cfg.mode === "managed") startManagedInBackground();
}
