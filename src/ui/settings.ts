/**
 * Settings drawer: everything that needs configuring (trace source, host
 * reputation, rule engines) is edited here and saved to the collector.
 */
import { config, fetchStatus, live, saveConfig } from "../engine/live-source";
import { EL, esc } from "../utils";
import { openDrawer } from "./drawer";
import { toast } from "./toasts";

type Cfg = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const field = (label: string, input: string, hint = "") =>
  `<label class="f"><span class="fl">${label}</span>${input}${hint ? `<span class="fh">${hint}</span>` : ""}</label>`;
const text = (name: string, value: unknown, attrs = "") => `<input name="${name}" value="${esc(value ?? "")}" ${attrs}>`;
const num = (name: string, value: unknown, attrs = "") => `<input type="number" name="${name}" value="${esc(value ?? "")}" ${attrs}>`;
const check = (name: string, on: unknown, label: string) => `<label class="f ck"><input type="checkbox" name="${name}" ${on ? "checked" : ""}><span>${label}</span></label>`;
const ok = (v: boolean, yes: string, no: string) => `<span style="color:${v ? "var(--good)" : "var(--coral)"}">${v ? yes : no}</span>`;

function statusHTML(st: Cfg | null): string {
  if (!st) return `<p class="fh">Collector not reachable. Start it with <code>npm run collector</code>; the page reconnects on its own.</p>`;
  const c = st.collector ?? {}, r = st.reputation ?? {}, n = st.rules?.nova ?? {};
  const origin = collectorOrigin(c.port);
  return `
    <dl class="kv">
      <dt>Collector</dt><dd>${ok(true, "up", "down")} · ${c.received ?? 0} events · ${c.clients ?? 0} viewer${c.clients === 1 ? "" : "s"}</dd>
      <dt>Numbat sink</dt><dd>POST ${origin}/ingest/numbat</dd>
      <dt>OTLP/JSON</dt><dd>POST ${origin}/v1/traces · /v1/logs</dd>
      <dt>UI proxy</dt><dd>${location.origin} forwards /api, /ingest and /v1 to the collector</dd>
      <dt>VirusTotal</dt><dd>${ok(r.keySet, "active", "no key")} · ${r.usedMinute ?? 0}/${r.perMinute ?? 4} this minute · ${r.usedDay ?? 0}/${r.perDay ?? 500} today · ${r.cached ?? 0} cached · ${r.queued ?? 0} queued${r.lastError ? ` · <span style="color:var(--amber)">${esc(r.lastError)}</span>` : ""}</dd>
      <dt>Nova</dt><dd>${ok(n.reachable, `${n.info?.rules ?? 0} rules${n.info?.semantic ? ", semantic" : ""}${n.info?.llm ? ", llm " + esc(n.info.llm) : ""}`, n.enabled ? `${n.mode === "managed" ? "not running" : "unreachable"} (${esc(n.error ?? "")})` : "off")}${n.reachable ? ` · ${n.mode === "managed" ? `managed, pid ${n.process?.pid ?? "?"}${n.process?.restarts ? `, ${n.process.restarts} restarts` : ""}` : "remote"} · ${n.scanned ?? 0} scanned · ${n.hits ?? 0} hits · ${n.lastLatencyMs ?? 0} ms` : ""}</dd>
      ${n.info?.revision?.git ? `<dt>Nova rules</dt><dd>${esc(n.info.revision.commit)} · ${esc(String(n.info.revision.date).slice(0, 10))} · ${esc(n.info.revision.message)}</dd>` : ""}
    </dl>`;
}

/** Address agents should post to: the collector itself, not the Vite dev server in front of it. */
function collectorOrigin(port?: number): string {
  const p = port ?? 4318;
  return `${location.protocol}//${location.hostname}:${p}`;
}

function formHTML(c: Cfg): string {
  const kinds = new Set<string>(c.rules.nova.kinds);
  const origin = collectorOrigin((live.status as Cfg | null)?.collector?.port);
  return `
  <form id="settingsForm">
    <div class="sec"><h4>Status</h4><div id="settingsStatus">${statusHTML(live.status as Cfg | null)}</div></div>

    <div class="sec"><h4>Trace source</h4>
      ${check("ui.ingestAuth", c.ingest.token || c.ingest.hmacKey, "Require authentication on the ingest endpoints")}
      <div data-show="ui.ingestAuth">
        ${field("Bearer token", text("ingest.token", c.ingest.token, 'type="password" autocomplete="off"'), "Numbat: <code>--http-auth bearer</code> with <code>NUMBAT_HTTP_TOKEN</code>; the hook: <code>PIT_TOKEN</code>.")}
        ${field("HMAC key", text("ingest.hmacKey", c.ingest.hmacKey, 'type="password" autocomplete="off"'), "Numbat: <code>--http-auth hmac-sha256</code> with <code>NUMBAT_HTTP_HMAC_KEY</code>.")}
      </div>
      <div class="acts"><button type="button" class="btn" data-act="events-clear">Clear collected events</button></div>
      <p class="fh">Connect an agent: <code>numbat hook install --agent claude-code</code> then <code>numbat ship --input-file ~/.numbat/live.ndjson --http-url ${origin}/ingest/numbat</code>. Any OpenTelemetry exporter works with <code>OTEL_EXPORTER_OTLP_ENDPOINT=${origin} OTEL_EXPORTER_OTLP_PROTOCOL=http/json</code>.</p>
    </div>

    <div class="sec"><h4>Host reputation · VirusTotal</h4>
      ${field("API key", text("reputation.virustotalKey", c.reputation.virustotalKey, 'type="password" autocomplete="off" placeholder="from virustotal.com/gui/my-apikey"'), c.reputation.virustotalKey ? "A key is stored on the collector and lookups are on. The browser only ever sees this mask; clear the field to switch lookups off." : "Free public API, 4 lookups a minute and 500 a day. Stored on the collector; lookups start as soon as a key is saved.")}
      <div data-show="reputation.virustotalKey">
        <div class="grid3">
          ${field("Per minute", num("reputation.perMinute", c.reputation.perMinute, 'min="1" max="60"'))}
          ${field("Per day", num("reputation.perDay", c.reputation.perDay, 'min="1" max="100000"'))}
          ${field("Cache hours", num("reputation.cacheTtlSec", c.reputation.cacheTtlSec / 3600, 'min="1" max="720" step="1"'))}
        </div>
        ${field("Never look up", text("reputation.skipSuffixes", c.reputation.skipSuffixes.join(", ")), "Comma-separated host suffixes. Private IP ranges and localhost are always skipped.")}
        <div class="acts"><button type="button" class="btn" data-act="rep-clear">Clear reputation cache</button></div>
      </div>
      <label class="f"><span class="fl">Allow list</span><textarea class="ta" name="reputation.allowList" placeholder="one host or suffix per line, e.g. github.com or .acme.dev">${esc((c.reputation.allowList ?? []).join("\n"))}</textarea><span class="fh">Trusted hosts: scored as allow-listed and exempt from the unlisted-host rule. The host drawer adds entries here.</span></label>
    </div>

    <div class="sec"><h4>Rules</h4>
      ${check("rules.builtin", c.rules.builtin, "Built-in The PIT rules (secret paths, pipe-to-shell, bulk egress, temp exec…)")}
      ${check("rules.nova.enabled", c.rules.nova.enabled, "Nova content rules (prompt injection, jailbreaks, exfiltration phrasing)")}
      <div data-show="rules.nova.enabled">
      <div class="f radios">
        <label><input type="radio" name="rules.nova.mode" value="managed" ${c.rules.nova.mode !== "remote" ? "checked" : ""}> Managed by the collector</label>
        <label><input type="radio" name="rules.nova.mode" value="remote" ${c.rules.nova.mode === "remote" ? "checked" : ""}> Remote service</label>
      </div>
      <div data-show="rules.nova.mode=remote">${field("Remote URL", text("rules.nova.url", c.rules.nova.url, 'placeholder="http://127.0.0.1:8765"'), "A Nova you run elsewhere with <code>npm run nova</code>.")}</div>
      <div data-show="rules.nova.mode=managed"><p class="fh">The collector starts and supervises the sidecar itself. One-time setup: <code>nova-service/setup.sh</code>.</p></div>
      <div class="f"><span class="fl">Scan event kinds</span><div class="radios">
        ${["llm", "tool", "command", "file"].map((k) => `<label><input type="checkbox" name="nova.kind" value="${k}" ${kinds.has(k) ? "checked" : ""}> ${k}</label>`).join("")}
      </div></div>
      <div class="grid3">
        ${check("rules.nova.keywordsOnly", c.rules.nova.keywordsOnly, "Keywords only (fastest)")}
        ${field("Timeout ms", num("rules.nova.timeoutMs", c.rules.nova.timeoutMs, 'min="200" max="60000" step="100"'))}
        ${check("rules.nova.scanUserPrompts", c.rules.nova.scanUserPrompts, "Also scan what the user types")}
      </div>
      <div class="f"><span class="fl">Rules</span><div class="rulelist" id="novaRules"><span class="fh">loading…</span></div><span class="fh">Untick to disable a rule. Nova's verdict on every ticked rule is used as is; the threshold shown is the rule's own.</span></div>
      <div class="acts"><button type="button" class="btn" data-act="nova-check">Check Nova</button><button type="button" class="btn" data-act="nova-update">Update rules from GitHub</button><button type="button" class="btn" data-act="nova-clear">Clear Nova cache</button></div>
      </div>
    </div>

    <div class="sec" ${(c.rules.mutes ?? []).length ? "" : "hidden"}><h4>Muted alerts</h4>
      <p class="fh">Different from disabling a Nova rule: a mute keeps evaluating the rule but hides its alerts for one agent or for everyone. It works for every rule engine (built-in, reputation, Nova, Numbat). Add mutes from the buttons in an alert.</p>
      <div class="mutes" id="muteList">${(c.rules.mutes ?? []).map((m: { rule: string; agent: string }, i: number) => `<div><span>${esc(m.rule)}</span><span style="color:var(--ink-3)">for</span><span style="color:var(--agent)">${m.agent === "*" ? "everyone" : esc(m.agent)}</span><span style="flex:1"></span><button type="button" data-unmute="${i}" title="Remove">✕</button></div>`).join("") || '<span class="fh">Nothing muted.</span>'}</div>
    </div>

    <div class="acts sticky"><button type="submit" class="btn primary">Save settings</button><span class="fh" id="settingsMsg"></span></div>
  </form>`;
}

/**
 * Progressive disclosure: a block with data-show="name" is visible while the control `name`
 * is on (checkbox checked / field non-empty); data-show="name=value" while the radio `name`
 * equals `value`. Re-evaluated on every input.
 */
function applyDisclosure(form: HTMLFormElement): void {
  const fd = new FormData(form);
  form.querySelectorAll<HTMLElement>("[data-show]").forEach((el) => {
    const rule = el.dataset.show!;
    const [name, want] = rule.split("=");
    const v = fd.get(name);
    const on = want !== undefined ? String(v ?? "") === want : v !== null && v !== "" && v !== "off";
    el.hidden = !on;
  });
}

function readForm(form: HTMLFormElement): Cfg {
  const fd = new FormData(form);
  const kinds = fd.getAll("nova.kind").map(String);
  const s = (k: string) => String(fd.get(k) ?? "");
  const n = (k: string) => Number(fd.get(k));
  return {
    ingest: fd.has("ui.ingestAuth") ? { token: s("ingest.token"), hmacKey: s("ingest.hmacKey") } : { token: "", hmacKey: "" },
    reputation: {
      virustotalKey: s("reputation.virustotalKey").trim(),
      perMinute: n("reputation.perMinute"), perDay: n("reputation.perDay"), cacheTtlSec: Math.round(n("reputation.cacheTtlSec") * 3600),
      skipSuffixes: s("reputation.skipSuffixes").split(",").map((x) => x.trim()).filter(Boolean),
      allowList: s("reputation.allowList").split(/\n|,/).map((x) => x.trim()).filter(Boolean),
    },
    rules: {
      builtin: fd.has("rules.builtin"),
      mutes: (config?.rules as { mutes?: unknown[] } | undefined)?.mutes ?? [],
      nova: {
        enabled: fd.has("rules.nova.enabled"), mode: s("rules.nova.mode") || "managed", url: s("rules.nova.url"), kinds, keywordsOnly: fd.has("rules.nova.keywordsOnly"), timeoutMs: n("rules.nova.timeoutMs"),
        scanUserPrompts: fd.has("rules.nova.scanUserPrompts"),
        disabled: allRules.filter((name) => !fd.getAll("nova.rule").includes(name)),
      },
    },
  };
}

let allRules: string[] = [];

interface NovaRuleInfo { name: string; category?: string; severity?: string; matchers: string[]; thresholds?: Record<string, number> }

async function loadRuleList(disabled: string[]): Promise<void> {
  const box = document.getElementById("novaRules");
  if (!box) return;
  try {
    const rules = (await (await fetch("/api/rules/nova/rules")).json()) as NovaRuleInfo[];
    allRules = rules.map((r) => r.name);
    const off = new Set(disabled);
    box.innerHTML = rules.sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name)).map((r) => {
      const th = Object.values(r.thresholds ?? {});
      const sev = (r.severity ?? "medium").toLowerCase();
      return `<label title="${esc(r.category ?? "")}"><input type="checkbox" name="nova.rule" value="${esc(r.name)}" ${off.has(r.name) ? "" : "checked"}><span>${esc(r.name)}</span><span>${esc(r.matchers.join("+"))}${th.length ? ` · ≥${Math.min(...th)}` : ""}</span><span class="sev-${sev[0]}">${esc(sev)}</span></label>`;
    }).join("");
  } catch {
    allRules = disabled;
    box.innerHTML = '<span class="fh">Nova unreachable; rule list unavailable. Disabled rules are kept as they are.</span>';
  }
}

async function refreshStatus(): Promise<void> {
  const box = document.getElementById("settingsStatus");
  if (!box) return;
  try { box.innerHTML = statusHTML((await fetchStatus()) as Cfg); } catch { box.innerHTML = statusHTML(null); }
}

export function openSettings(): void {
  const c = config;
  if (!c) {
    openDrawer("Settings", "collector offline", `<div class="sec">${statusHTML(null)}<p class="fh">Settings live on the collector so API keys never reach the browser. Run <code>npm run collector</code> (default port 4318) and reopen this panel.</p></div>`);
    return;
  }
  openDrawer("Settings", "saved on the collector · data/config.json", formHTML(c));
  void refreshStatus();
  void loadRuleList(((c as Cfg).rules.nova.disabled ?? []) as string[]);
  const form = EL<HTMLFormElement>("settingsForm");
  applyDisclosure(form);
  form.addEventListener("input", () => applyDisclosure(form));
  form.addEventListener("change", () => applyDisclosure(form));
  form.addEventListener("click", async (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-unmute]");
    if (!b) return;
    const mutes = [...((config?.rules as { mutes?: unknown[] })?.mutes ?? [])];
    mutes.splice(Number(b.dataset.unmute), 1);
    await saveConfig({ rules: { mutes } });
    openSettings();
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const patch = readForm(form);
    const msg = EL("settingsMsg");
    try {
      await saveConfig(patch);
      msg.textContent = "Saved";
      toast("Settings saved");
      void refreshStatus();
    } catch (err) {
      msg.textContent = (err as Error).message;
    }
  });
  form.addEventListener("click", async (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "events-clear") { await fetch("/api/events/clear", { method: "POST" }); location.reload(); return; }
    if (act === "rep-clear") await fetch("/api/reputation/clear", { method: "POST" });
    if (act === "nova-clear") await fetch("/api/rules/nova/clear", { method: "POST" });
    if (act === "nova-update") {
      b.setAttribute("disabled", "true"); b.textContent = "Updating…";
      try {
        const r = await (await fetch("/api/rules/nova/update", { method: "POST" })).json();
        toast(r.ok ? (r.changed ? `Rules updated to ${r.revision.commit} · ${r.rules} rules` : `Rules already current (${r.revision?.commit ?? "?"})`) : `Update failed: ${r.error}`, r.ok ? "" : "risk");
        void loadRuleList(((config as Cfg)?.rules?.nova?.disabled ?? []) as string[]);
      } catch (err) { toast((err as Error).message, "risk"); }
      b.removeAttribute("disabled"); b.textContent = "Update rules from GitHub";
    }
    if (act === "nova-check") {
      const r = await (await fetch("/api/rules/nova/health")).json();
      toast(r.reachable ? `Nova up · ${r.info.rules} rules` : `Nova unreachable · ${r.error}`, r.reachable ? "" : "risk");
    }
    void refreshStatus();
  });
}

export function initSettings(): void {
  EL("settingsBtn").addEventListener("click", openSettings);
  addEventListener("keydown", (e) => { if (e.key === "," && (e.metaKey || e.ctrlKey)) { e.preventDefault(); openSettings(); } });
}
