/**
 * Persistent settings for the collector. Everything the UI can configure
 * lives here; the file is written atomically and secrets are masked when
 * the config is sent to the browser.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface Config {
  ingest: {
    /** Bearer token expected on ingest endpoints (NUMBAT_HTTP_TOKEN on the agent side). Empty = open. */
    token: string;
    /** HMAC key matching Numbat's --http-auth hmac-sha256 (NUMBAT_HTTP_HMAC_KEY). */
    hmacKey: string;
  };
  reputation: {
    /** Lookups run whenever a key is stored. */
    virustotalKey: string;
    /** Free public tier: 4 requests / minute, 500 / day. */
    perMinute: number;
    perDay: number;
    /** Seconds a verdict is kept before re-querying. */
    cacheTtlSec: number;
    /** Hosts that are never sent to VirusTotal (RFC1918 is always skipped). */
    skipSuffixes: string[];
    /** Trusted hosts (exact or suffix): scored as allow-listed, never raise the unlisted-host rule. */
    allowList: string[];
  };
  rules: {
    /** Built-in The PIT rules (regex on commands / hosts). */
    builtin: boolean;
    /** Silenced rule/agent pairs ("*" agent = everywhere). */
    mutes: { rule: string; agent: string }[];
    nova: {
      enabled: boolean;
      /** "managed": the collector spawns the sidecar and talks over stdio; "remote": call `url` over HTTP. */
      mode: "managed" | "remote";
      /** URL of a remote Nova sidecar, e.g. http://127.0.0.1:8765 (remote mode only). */
      url: string;
      /** Only these event kinds carry free text worth scanning. */
      kinds: string[];
      /** Skip semantic/LLM evaluators and use keyword rules only (fastest). */
      keywordsOnly: boolean;
      timeoutMs: number;
      /** Scan what the user typed, not only what the agent read. */
      scanUserPrompts: boolean;
      /** Rule names switched off (unticked in Settings). Nova's verdict on the rest is final. */
      disabled: string[];
    };
  };
}

export const DEFAULTS: Config = {
  ingest: { token: "", hmacKey: "" },
  reputation: {
    virustotalKey: "",
    perMinute: 4,
    perDay: 500,
    cacheTtlSec: 6 * 3600,
    skipSuffixes: [".internal", ".local", ".corp", ".lan"],
    allowList: [],
  },
  rules: {
    builtin: true,
    mutes: [],
    nova: {
      // the Docker image ships the rules and the Python environment, so Nova is on there by default;
      // a local install needs nova-service/setup.sh first, so it starts off
      enabled: process.env.PIT_NOVA_ENABLED === "1",
      mode: "managed",
      url: "http://127.0.0.1:8765",
      kinds: ["llm", "tool"],
      keywordsOnly: false,
      timeoutMs: 4000,
      scanUserPrompts: false,
      disabled: [],
    },
  },
};

const FILE = resolve(process.env.PIT_DATA ?? "data", "config.json");
const SECRET_KEYS = new Set(["virustotalKey", "token", "hmacKey"]);
const MASK = "••••••••";

let current: Config = load();

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in out)) continue; // unknown keys are dropped
    const cur = out[k];
    if (cur && typeof cur === "object" && !Array.isArray(cur)) out[k] = deepMerge(cur, v);
    else if (typeof v === typeof cur) out[k] = v;
  }
  return out as T;
}

function load(): Config {
  try {
    return deepMerge(DEFAULTS, JSON.parse(readFileSync(FILE, "utf8")));
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function getConfig(): Config {
  return current;
}

/** Apply a partial update. Masked secrets in the patch keep the stored value. */
export function updateConfig(patch: unknown): Config {
  const cleaned = unmask(patch, current);
  current = deepMerge(current, cleaned);
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(current, null, 2));
  renameSync(tmp, FILE);
  return current;
}

function unmask(patch: unknown, base: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const b = (base as Record<string, unknown> | undefined)?.[k];
    if (SECRET_KEYS.has(k) && v === MASK) out[k] = b;
    else out[k] = unmask(v, b);
  }
  return out;
}

/** Config as sent to the browser: secrets replaced by a mask plus a "set" flag. */
export function publicConfig(): unknown {
  const walk = (o: unknown): unknown => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return o;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.has(k) ? (v ? MASK : "") : walk(v);
    }
    return out;
  };
  return walk(current);
}
