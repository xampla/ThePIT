/** Push the sample traces into a running collector: node scripts/send-sample.ts [collector-url] */
import { readFileSync } from "node:fs";

const base = (process.argv[2] ?? process.env.PIT_COLLECTOR ?? "http://127.0.0.1:4318").replace(/\/$/, "");
const token = process.env.NUMBAT_HTTP_TOKEN;
const headers = (ct: string) => ({ "content-type": ct, ...(token ? { authorization: `Bearer ${token}` } : {}) });

async function post(path: string, ct: string, body: string): Promise<void> {
  const r = await fetch(base + path, { method: "POST", headers: headers(ct), body });
  console.log(`${path} → ${r.status} ${await r.text()}`);
}

await post("/ingest/numbat", "application/x-ndjson", readFileSync(new URL("../samples/numbat-session.ndjson", import.meta.url), "utf8"));
await post("/v1/traces", "application/json", readFileSync(new URL("../samples/otlp-traces.json", import.meta.url), "utf8"));
