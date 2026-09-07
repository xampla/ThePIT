/** Right-hand detail drawer for events, alerts, hosts and agents. */
import { KIND } from "../data/kinds";
import { emit } from "../bus";
import { allowHost, isAllowListed, isMuted, muteRule, unmuteRule } from "../engine/live-source";
import { S, agentById } from "../state";
import type { Agent, Alert, HostRecord, TraceEvent } from "../types";
import { EL, esc, json, nowStr, repColor, repWord, sevColor, stripTags } from "../utils";
import { toast } from "./toasts";

const drawer = () => EL("drawer");
const scrim = () => EL("scrim");

export function openDrawer(title: string, sub: string, html: string): void {
  EL("dTitle").textContent = title;
  EL("dSub").textContent = sub;
  EL("dBody").innerHTML = html;
  drawer().classList.add("on");
  scrim().classList.add("on");
  drawer().setAttribute("aria-hidden", "false");
  EL("dClose").focus();
}

export function closeDrawer(): void {
  drawer().classList.remove("on");
  scrim().classList.remove("on");
  drawer().setAttribute("aria-hidden", "true");
}

const trailRow = (t: TraceEvent, cls = "") =>
  `<div class="tr ${cls}"><span class="tt">${nowStr(t.ts)}</span><span class="td">${stripTags(t.summary)}</span></div>`;

export function openEvent(e: TraceEvent): void {
  document.querySelectorAll(".ev.selected").forEach((n) => n.classList.remove("selected"));
  const row = document.querySelector(`#stream [data-id="${e.id}"]`);
  if (row) row.classList.add("selected");
  if (e.kind === "rule" && e.alertId) {
    const a = S.alerts.find((x) => x.id === e.alertId);
    if (a) return openAlert(a);
  }
  const k = KIND[e.kind];
  const trail = S.events.filter((x) => x.session === e.session && x.ts <= e.ts && x.id !== e.id).slice(0, 4).reverse();
  openDrawer(`${k.label} event`, `${e.id} · ${e.session} · ${nowStr(e.ts)}`, `
    <div class="sec">
      <dl class="kv">
        <dt>Agent</dt><dd style="color:var(--agent)">${esc(e.agentName)} <span style="color:var(--ink-3)">${esc(e.agent)}</span></dd>
        <dt>Model</dt><dd>${esc(e.model)}</dd>
        <dt>Session</dt><dd>${esc(e.session)}</dd>
        <dt>Severity</dt><dd style="color:${sevColor(e.sev)}">${e.sev}</dd>
        ${e.host ? `<dt>Destination</dt><dd style="color:var(--host)">${esc(e.host)}</dd>` : ""}
        ${e.command ? `<dt>Command</dt><dd>${esc(e.command)}</dd>` : ""}
        ${e.tool ? `<dt>Tool</dt><dd>${esc(e.tool)}</dd>` : ""}
      </dl>
    </div>
    ${e.detail ? `<div class="sec"><h4>Raw record</h4>${json({ event_id: e.id, ts: e.ts.toISOString(), kind: e.kind, agent: e.agent, session: e.session, ...e.detail })}</div>` : ""}
    <div class="sec"><h4>What happened just before</h4><div class="trail">
      ${trail.map((t) => trailRow(t)).join("") || '<div class="tr"><span class="td">Start of session.</span></div>'}
      ${trailRow(e, "trigger")}
    </div></div>`);
}

export function openAlert(a: Alert): void {
  const h = a.host ? S.hosts.get(a.host) : undefined;
  openDrawer(a.title, `${a.rule} · ${a.id} · ${nowStr(a.ts)}`, `
    <div class="sec">
      <dl class="kv">
        <dt>Severity</dt><dd style="color:${sevColor(a.sev)};font-weight:600">${a.sev}</dd>
        <dt>Agent</dt><dd style="color:var(--agent)">${esc(a.agent)}</dd>
        <dt>Session</dt><dd>${esc(a.session)}</dd>
        ${a.host ? `<dt>Host</dt><dd style="color:var(--host)">${esc(a.host)}${h ? ` <span style="color:${repColor(h.rep)}">rep ${h.rep}</span>` : ""}</dd>` : ""}
        <dt>Rule</dt><dd>${a.rule}</dd>
      </dl>
    </div>
    <div class="sec"><h4>Why this fired</h4><p class="why">${esc(a.why)}</p></div>
    <div class="sec"><h4>Trace that triggered it</h4>
      <div class="trail">
        ${a.trail.map((t) => trailRow(t)).join("")}
        ${trailRow(a.trigger, "trigger")}
      </div>
    </div>
    <div class="sec"><h4>Trigger record</h4>${json({
      event_id: a.trigger.id, rule: a.rule, ts: a.trigger.ts.toISOString(), kind: a.trigger.kind,
      agent: a.trigger.agent, session: a.trigger.session,
      ...(a.trigger.detail ?? {}),
      ...(a.trigger.command ? { command: a.trigger.command } : {}),
    })}</div>
    <div class="sec"><h4>Recommended action</h4><div class="rec"><span>${esc(a.fix)}</span></div>
      <div class="acts" id="alertActs">
        <button class="btn" data-act="ack">${a.ack ? "Un-acknowledge" : "Acknowledge"}</button>
        <button class="btn" data-act="mute">${isMuted(a.rule, a.agentId) ? "Unmute" : "Mute"} ${esc(a.rule)} for ${esc(a.agent)}</button>
        <button class="btn" data-act="mute-all">${isMuted(a.rule, "*") ? "Unmute" : "Mute"} ${esc(a.rule)} everywhere</button>
      </div>
    </div>`);
  EL("alertActs").addEventListener("click", async (ev) => {
    const act = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (!act) return;
    try {
      if (act === "ack") { a.ack = !a.ack; emit("alert:ack", a); toast(a.ack ? `${a.id} acknowledged` : `${a.id} reopened`); }
      if (act === "mute") { if (isMuted(a.rule, a.agentId)) await unmuteRule(a.rule, a.agentId); else await muteRule(a.rule, a.agentId); toast(`${a.rule} ${isMuted(a.rule, a.agentId) ? "muted" : "unmuted"} for ${a.agent}`); }
      if (act === "mute-all") { if (isMuted(a.rule, "*")) await unmuteRule(a.rule, "*"); else await muteRule(a.rule, "*"); toast(`${a.rule} ${isMuted(a.rule, "*") ? "muted" : "unmuted"} everywhere`); }
      openAlert(a);
    } catch (err) { toast((err as Error).message, "risk"); }
  });
}

export function openHost(h: HostRecord): void {
  const linked = [...S.links.values()].filter((l) => l.host === h.h);
  openDrawer(h.h, `${h.cat} · ${h.asn} · ${h.geo}`, `
    <div class="sec">
      <div class="rep-hero">
        <div class="score" style="color:${repColor(h.rep, h.pending)}">${h.pending ? "…" : h.rep}</div>
        <div><div class="word" style="color:${repColor(h.rep, h.pending)}">${repWord(h.rep, h.pending)}</div>
        <div class="note">${h.pending ? "waiting for the reputation service" : `${esc(h.provider ?? "demo feed")} · ${h.sources.length} signals${h.checkedAt ? ` · checked ${nowStr(new Date(h.checkedAt))}` : ""}`}</div></div>
      </div>
      <dl class="kv">
        <dt>Requests</dt><dd>${h.count}</dd>
        <dt>Agents</dt><dd>${[...h.agents].map((id) => agentById(id)?.name).filter(Boolean).join(", ") || "—"}</dd>
        <dt>First seen</dt><dd>${nowStr(new Date(h.first))}</dd>
        <dt>Network</dt><dd>${esc(h.asn)} · ${esc(h.geo)}</dd>
      </dl>
    </div>
    <div class="sec"><h4>Reputation sources</h4><div class="srcs">
      ${h.sources.map((s) => `<div class="src"><span class="nm">${esc(s.n)}</span><span class="vd" style="color:${s.ok ? "var(--good)" : "var(--coral)"}">${esc(s.v)}</span></div>`).join("")}
    </div></div>
    <div class="sec"><h4>Who talked to it</h4><div class="trail">
      ${linked.map((l) => `<div class="tr"><span class="tt">${l.count}×</span><span class="td" style="color:var(--agent)">${esc(agentById(l.agent)?.name ?? l.agent)}</span></div>`).join("") || '<div class="tr"><span class="td">No connections recorded.</span></div>'}
    </div></div>
    <div class="sec"><h4>Recent events</h4><div class="trail">
      ${S.events.filter((e) => e.host === h.h).slice(0, 6).map((e) => trailRow(e)).join("") || '<div class="tr"><span class="td">Nothing yet.</span></div>'}
    </div></div>
    <div class="acts" id="hostActs">${isAllowListed(h.h) ? '<span class="fh">On the workspace allow list.</span>' : '<button class="btn" data-act="allow">Add to allow list</button>'}</div>`);
  EL("hostActs").addEventListener("click", async (ev) => {
    if ((ev.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act !== "allow") return;
    try { await allowHost(h.h); toast(`${h.h} added to the allow list`); openHost(h); } catch (err) { toast((err as Error).message, "risk"); }
  });
}

export function openAgent(a: Agent): void {
  const st = S.agentState.get(a.id) ?? { calls: 0, risk: 0, last: 0 };
  const hosts = [...S.hosts.values()].filter((h) => h.agents.has(a.id));
  openDrawer(a.name, `${a.id} · ${a.session} · ${a.model}`, `
    <div class="sec"><dl class="kv">
      <dt>Role</dt><dd>${esc(a.role)}</dd>
      <dt>Events</dt><dd>${st.calls}</dd>
      <dt>Risk signals</dt><dd style="color:${st.risk ? "var(--amber)" : "var(--good)"}">${st.risk}</dd>
      <dt>Hosts</dt><dd>${hosts.length}</dd>
      <dt>Alerts</dt><dd>${S.alerts.filter((x) => x.agentId === a.id).length}</dd>
    </dl></div>
    <div class="sec"><h4>Hosts reached</h4><div class="trail">
      ${hosts.sort((x, y) => x.rep - y.rep).map((h) => `<div class="tr ${h.rep < 30 ? "trigger" : ""}"><span class="tt" style="color:${repColor(h.rep)}">${h.rep}</span><span class="td" style="color:var(--host)">${esc(h.h)}</span></div>`).join("") || '<div class="tr"><span class="td">None yet.</span></div>'}
    </div></div>
    <div class="sec"><h4>Last steps</h4><div class="trail">
      ${S.events.filter((e) => e.agent === a.id).slice(0, 8).map((e) => trailRow(e)).join("")}
    </div></div>`);
}

export function initDrawer(): void {
  EL("dClose").addEventListener("click", closeDrawer);
  scrim().addEventListener("click", closeDrawer);
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
}
