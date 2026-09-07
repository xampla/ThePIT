/**
 * The PIT collector.
 *
 *   POST /ingest/numbat   Numbat NDJSON (event + finding records)
 *   POST /ingest/jsonl    The PIT WireEvent NDJSON (replay / tests)
 *   POST /v1/traces       OTLP/JSON traces (GenAI semantic conventions)
 *   POST /v1/logs         OTLP/JSON logs (Claude Code native telemetry)
 *   GET  /api/stream      Server-Sent Events to the browser
 *   GET/PUT /api/config   settings edited from the web UI
 *   GET  /api/status      quotas, queue depth, sidecar health
 *
 * Runs on Node 24 with native type stripping: `node server/index.ts`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { getConfig, publicConfig, updateConfig } from "./config.ts";
import { clearReplay, clientCount, publish, publishEvents, seedReplay, setReplayDecorator, subscribe } from "./hub.ts";
import { invalidate, lookup, status as repStatus } from "./reputation.ts";
import { applyBuiltin, applyNova, clearNovaCache, novaHealth, novaRules, novaUpdateRules, rulesStatus, unmuted, warmNova } from "./rules.ts";
import { numbatToWire, parseNdjson } from "../shared/numbat.ts";
import { otlpLogsToWire, otlpTracesToWire } from "../shared/otlp.ts";
import { extractHosts } from "../shared/hosts.ts";
import { appendEvents, clearEventLog, loadRecent, storeStatus } from "./store.ts";
import { resolveIdentity } from "./identity.ts";
import type { WireEvent } from "../shared/wire.ts";

const PORT = Number(process.env.PORT ?? 4318);
const HOST = process.env.HOST ?? "0.0.0.0";
const MAX_BODY = 16 * 1024 * 1024;
const STATIC_DIR = resolve("dist");
/** Serve the built UI from this port only when asked (npm start); in dev the UI lives on Vite's port. */
const SERVE_UI = process.env.SERVE_UI === "1" || process.argv.includes("--serve-ui");
const counters = { received: 0, batches: 0, rejected: 0, startedAt: Date.now(), bySource: {} as Record<string, number> };

/* ---------- ingest pipeline ---------- */

/** Any command or tool call that names a remote host also becomes a network event, whatever the source. */
const DERIVED_MAX = 5000;
/** Hops already derived, keyed by agent, host and tool call, so a call's pre and post events yield one hop. */
const derived = new Set<string>();
function rememberHop(key: string): boolean {
  if (derived.has(key)) return false;
  derived.add(key);
  if (derived.size > DERIVED_MAX) derived.delete(derived.values().next().value as string);
  return true;
}

function deriveNetwork(events: WireEvent[]): WireEvent[] {
  const out: WireEvent[] = [];
  const known = new Set(events.filter((e) => e.kind === "network").map((e) => `${e.agent.id}|${e.host}|${e.detail?.tool_call_id ?? e.detail?.tool_use_id ?? ""}`));
  for (const e of events) {
    out.push(e);
    if (e.kind === "network" || e.id.includes("_net")) continue;
    if (e.kind !== "command" && e.kind !== "tool" && e.kind !== "file") continue;
    // Hops come from an explicit destination (a url/host field) or from a shell command line.
    // Free text (prompts, tool output, arguments without a url field) is never mined: a URL mentioned
    // in text is not a connection; if a tool later uses it, that call yields the hop.
    const hosts = e.host ? [e.host] : e.kind === "command" ? extractHosts(e.command) : [];
    hosts.forEach((h, i) => {
      const callId = e.detail?.tool_call_id ?? e.detail?.tool_use_id ?? "";
      const key = `${e.agent.id}|${h}|${callId}`;
      if (known.has(key)) return;
      known.add(key);
      if (callId && !rememberHop(key)) return;
      const url = typeof e.detail?.url === "string" ? e.detail.url : undefined;
      out.push({ id: `${e.id}_net${i}`, ts: e.ts, kind: "network", agent: e.agent, host: h, source: e.source, label: url ?? `${e.tool ?? e.kind} → ${h}`, tag: "derived", detail: { via: e.kind, tool: e.tool, command: e.command, url } });
    });
  }
  return out;
}

function ingest(incoming: WireEvent[], source: string): void {
  if (!incoming.length) return;
  incoming.forEach(resolveIdentity);
  const events = deriveNetwork(incoming);
  for (const e of events) {
    e.source ??= source;
    if (e.host) e.reputation = lookup(e.host);
    if (e.rules?.length) e.rules = unmuted(e.agent.id, e.rules);
    applyBuiltin(e);
  }
  counters.received += events.length;
  counters.batches++;
  counters.bySource[source] = (counters.bySource[source] ?? 0) + events.length;
  publishEvents(events);
  appendEvents(events);
  void applyNova(events);
}

/* ---------- helpers ---------- */

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) { rej(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      let buf = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") { try { buf = gunzipSync(buf); } catch { return rej(new Error("bad gzip")); } }
      res(buf.toString("utf8"));
    });
    req.on("error", rej);
  });
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s), "access-control-allow-origin": "*" });
  res.end(s);
}

/** Optional bearer / HMAC check on ingest endpoints, matching Numbat's `--http-auth` modes. */
function authorised(req: IncomingMessage, body: string): boolean {
  const { token, hmacKey } = getConfig().ingest;
  if (!token && !hmacKey) return true;
  const auth = req.headers.authorization ?? "";
  if (token && auth === `Bearer ${token}`) return true;
  if (hmacKey) {
    const sig = String(req.headers["x-numbat-signature"] ?? "").replace(/^sha256=/, "");
    const ts = String(req.headers["x-numbat-timestamp"] ?? "");
    if (sig && ts) {
      const want = createHmac("sha256", hmacKey).update(`${ts}.${body}`).digest("hex");
      if (sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return true;
    }
  }
  return false;
}

const isProtobuf = (req: IncomingMessage) => /protobuf/.test(String(req.headers["content-type"] ?? ""));

function serveStatic(res: ServerResponse, path: string): boolean {
  if (!SERVE_UI || !existsSync(STATIC_DIR)) return false;
  let file = normalize(join(STATIC_DIR, path === "/" ? "index.html" : path));
  if (!file.startsWith(STATIC_DIR)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(STATIC_DIR, "index.html");
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".map": "application/json", ".json": "application/json" };
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
  return true;
}

async function statusPayload(): Promise<unknown> {
  return {
    collector: { port: PORT, clients: clientCount(), uptimeSec: Math.floor((Date.now() - counters.startedAt) / 1000), ...counters, store: storeStatus() },
    reputation: repStatus(),
    rules: await rulesStatus(),
  };
}

/* ---------- router ---------- */

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, x-numbat-signature, x-numbat-timestamp", "access-control-allow-methods": "GET, POST, PUT, OPTIONS" });
    res.end();
    return;
  }

  if (path === "/api/stream" && method === "GET") {
    return subscribe(res, [{ t: "config", config: publicConfig() }, { t: "status", status: await statusPayload() }]);
  }
  if (path === "/api/health") return send(res, 200, { ok: true, received: counters.received });
  if (path === "/api/status") return send(res, 200, await statusPayload());
  if (path === "/api/config" && method === "GET") return send(res, 200, publicConfig());
  if (path === "/api/config" && method === "PUT") {
    let patch: unknown;
    try { patch = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "invalid json" }); }
    updateConfig(patch);
    warmNova();
    publish({ t: "config", config: publicConfig() });
    publish({ t: "status", status: await statusPayload() });
    return send(res, 200, publicConfig());
  }
  if (path === "/api/events/clear" && method === "POST") { clearReplay(); clearEventLog(); return send(res, 200, { ok: true }); }
  if (path === "/api/reputation/clear" && method === "POST") { invalidate(url.searchParams.get("host") ?? undefined); return send(res, 200, { ok: true }); }
  if (path.startsWith("/api/reputation/") && method === "GET") return send(res, 200, lookup(decodeURIComponent(path.slice(16))));
  if (path === "/api/rules/nova/health") return send(res, 200, await novaHealth(true));
  if (path === "/api/rules/nova/update" && method === "POST") { try { return send(res, 200, await novaUpdateRules()); } catch (err) { return send(res, 502, { error: (err as Error).message }); } }
  if (path === "/api/rules/nova/rules") { try { return send(res, 200, await novaRules()); } catch (err) { return send(res, 502, { error: (err as Error).message }); } }
  if (path === "/api/rules/nova/clear" && method === "POST") { clearNovaCache(); return send(res, 200, { ok: true }); }

  if (method === "POST" && (path.startsWith("/ingest/") || path.startsWith("/v1/"))) {
    if (isProtobuf(req)) return send(res, 415, { error: "protobuf not supported; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json" });
    let body: string;
    try { body = await readBody(req); } catch (err) { return send(res, 413, { error: (err as Error).message }); }
    if (!authorised(req, body)) { counters.rejected++; return send(res, 401, { error: "unauthorised" }); }
    try {
      if (path === "/ingest/numbat") {
        const { records, bad } = parseNdjson(body);
        ingest(records.flatMap(numbatToWire), "numbat");
        return send(res, 200, { accepted: records.length, rejected: bad });
      }
      if (path === "/ingest/jsonl") {
        const { records, bad } = parseNdjson(body);
        const events = (records as unknown as WireEvent[]).filter((e) => e && typeof e.id === "string" && e.kind && e.agent);
        ingest(events, "jsonl");
        return send(res, 200, { accepted: events.length, rejected: bad + records.length - events.length });
      }
      if (path === "/v1/traces") { const ev = otlpTracesToWire(JSON.parse(body)); ingest(ev, "otlp"); return send(res, 200, { partialSuccess: {} }); }
      if (path === "/v1/logs") { const ev = otlpLogsToWire(JSON.parse(body)); ingest(ev, "otlp"); return send(res, 200, { partialSuccess: {} }); }
      if (path === "/v1/metrics") return send(res, 200, { partialSuccess: {} }); // accepted and ignored
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  }

  if (method === "GET" && serveStatic(res, path)) return;
  if (path === "/" && method === "GET") {
    return send(res, 200, {
      service: "pit-collector", ui: SERVE_UI ? "served here" : "run `npm run dev` (Vite) or `npm start` to serve the built UI from this port",
      ingest: { numbat: "POST /ingest/numbat", jsonl: "POST /ingest/jsonl", otlp: ["POST /v1/traces", "POST /v1/logs"] },
      api: ["GET /api/stream", "GET /api/status", "GET|PUT /api/config", "GET /api/health"],
    });
  }
  send(res, 404, { error: "not found" });
}

// a replayed event may predate its host's verdict; hand out the current one
setReplayDecorator((e) => { const ev = e as WireEvent; return ev.host ? { ...ev, reputation: lookup(ev.host) } : ev; });
const restored = loadRecent(1500);
seedReplay(restored);
if (restored.length) console.log(`restored ${restored.length} events from ${storeStatus() && (storeStatus() as { files: number }).files} day file(s)`);

createServer((req, res) => { handle(req, res).catch((err) => { console.error(err); if (!res.headersSent) send(res, 500, { error: "internal" }); }); })
  .listen(PORT, HOST, () => {
    console.log(`The PIT collector on http://${HOST}:${PORT}${SERVE_UI ? " (serving dist/)" : ""}`);
    warmNova();
    console.log(`  numbat  → POST /ingest/numbat   otlp/json → POST /v1/traces, /v1/logs   ui stream → GET /api/stream`);
  });
