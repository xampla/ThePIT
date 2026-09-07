/**
 * Talks to the Nova sidecar through one of two transports:
 *   managed  the collector spawns `pit-nova --stdio` and speaks JSON lines
 *            over stdin/stdout; restarts it with backoff if it dies; kills it on exit.
 *   remote   an HTTP URL, for a Nova running elsewhere.
 * Callers see the same four operations either way.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { getConfig } from "./config.ts";

const SIDECAR_DIR = resolve(process.env.PIT_NOVA_DIR ?? "nova-service");
const STARTUP_TIMEOUT_MS = 180_000; // first run downloads the embedding model
const BACKOFF_MS = [2000, 5000, 15_000, 60_000];

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

let child: ChildProcessWithoutNullStreams | undefined;
let ready = false;
let readyInfo: unknown = null;
let starting: Promise<void> | undefined;
let restarts = 0;
let lastExit = "";
let seq = 0;
const pending = new Map<number, Pending>();
let stopped = false;

export function managedStatus(): unknown {
  return { mode: "managed", running: !!child && ready, pid: child?.pid ?? null, restarts, lastExit, dir: SIDECAR_DIR };
}

function start(): Promise<void> {
  if (starting) return starting;
  starting = new Promise<void>((done, fail) => {
    ready = false;
    const proc = spawn("uv", ["run", "--directory", SIDECAR_DIR, "pit-nova", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" } });
    child = proc;
    const startTimer = setTimeout(() => { fail(new Error("nova sidecar did not become ready in time")); proc.kill(); }, STARTUP_TIMEOUT_MS);
    createInterface({ input: proc.stdout }).on("line", (line) => {
      let msg: { ready?: boolean; id?: number; result?: unknown; error?: string } & Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { console.error("[nova] non-json line on stdout:", line.slice(0, 200)); return; }
      if (msg.ready) { ready = true; readyInfo = msg; clearTimeout(startTimer); restarts = 0; console.log(`[nova] ready · ${msg.rules} rules (pid ${proc.pid})`); done(); return; }
      const p = msg.id != null ? pending.get(msg.id) : undefined;
      if (!p) return;
      pending.delete(msg.id!);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result);
    });
    createInterface({ input: proc.stderr }).on("line", (line) => { if (!/INFO|Batches:/.test(line)) console.error("[nova]", line.slice(0, 300)); });
    proc.on("error", (err) => { lastExit = err.message; clearTimeout(startTimer); fail(err); });
    proc.on("exit", (code, signal) => {
      lastExit = `exit ${code ?? signal}`;
      ready = false; child = undefined; starting = undefined;
      for (const [id, p] of pending) { pending.delete(id); clearTimeout(p.timer); p.reject(new Error("nova sidecar exited")); }
      if (stopped) return;
      const wait = BACKOFF_MS[Math.min(restarts, BACKOFF_MS.length - 1)];
      restarts++;
      console.error(`[nova] sidecar ${lastExit}; restarting in ${wait / 1000}s`);
      setTimeout(() => { if (getConfig().rules.nova.enabled && getConfig().rules.nova.mode === "managed") void start().catch(() => {}); }, wait);
    });
  }).catch((err) => { starting = undefined; throw err; });
  return starting;
}

export async function ensureManaged(): Promise<void> {
  if (ready) return;
  await start();
}

export function stopManaged(): void {
  stopped = true;
  child?.kill();
}

async function callManaged(op: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  await ensureManaged();
  const id = ++seq;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`nova ${op} timed out`)); }, timeoutMs);
    pending.set(id, { resolve: res, reject: rej, timer });
    child!.stdin.write(JSON.stringify({ id, op, ...body }) + "\n");
  });
}

async function callRemote(op: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const base = getConfig().rules.nova.url.replace(/\/$/, "");
  const routes: Record<string, [string, string]> = { scan: ["POST", "/scan"], health: ["GET", "/health"], rules: ["GET", "/rules"], reload: ["POST", "/reload"], update: ["POST", "/rules/update"] };
  const [method, path] = routes[op];
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: method === "POST" && op === "scan" ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`nova ${res.status}`);
  return res.json();
}

/** One entry point; the transport follows the config. */
export function novaCall(op: "scan" | "health" | "rules" | "reload" | "update", body: Record<string, unknown> = {}, timeoutMs = 4000): Promise<unknown> {
  return getConfig().rules.nova.mode === "remote" ? callRemote(op, body, timeoutMs) : callManaged(op, body, timeoutMs);
}

export const managedReadyInfo = () => readyInfo;
export const managedReady = () => ready;
/** Kick off the sidecar without waiting for it. */
export function startManagedInBackground(): void { if (!ready && !starting) void start().catch((err) => console.error("[nova]", err.message)); }

process.on("SIGINT", () => { stopManaged(); process.exit(0); });
process.on("SIGTERM", () => { stopManaged(); process.exit(0); });
