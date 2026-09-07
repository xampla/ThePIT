/** Rule evaluation: turns trace events into alerts. */
import { emit } from "../bus";
import { RULES } from "../data/rules";
import { MAX_ALERTS, S, sevRank } from "../state";
import type { Alert, RuleDef, RuleHit, Severity, TraceEvent } from "../types";
import { esc } from "../utils";
import { mkEvent } from "./events";
import { isAllowListed, isMuted } from "./live-source";
import { pushEvent } from "./store";

const DEDUPE_WINDOW_MS = 25_000;
const TRAIL_LENGTH = 4;


/** Evaluate every rule against an event; may raise its severity. */
export function evaluate(e: TraceEvent): void {
  const hits = new Map<string, RuleDef>();
  const add = (id: string, def?: RuleDef) => { const d = def ?? RULES[id]; if (d && !hits.has(id)) hits.set(id, d); };
  if (e.ruleHint) add(e.ruleHint);
  for (const h of e.hits ?? []) add(h.id, h);
  if (e.kind === "network") {
    const h = e.host ? S.hosts.get(e.host) : undefined;
    if (h && !h.pending && h.rep < 25) add("TW-001");
  }
  hits.forEach((def, id) => fireRule(id, e, def));
  if (hits.size) {
    const top = [...hits.values()].map((d) => d.sev).sort((a, b) => sevRank[b] - sevRank[a])[0] as Severity;
    if (sevRank[top] > sevRank[e.sev]) e.sev = top;
  }
}

/** Re-run the reputation rule for past events once a verdict arrives late. */
export function reevaluateHost(host: string): void {
  const h = S.hosts.get(host);
  if (!h || h.pending || h.rep >= 25) return;
  const recent = S.events.filter((e) => e.kind === "network" && e.host === host).slice(0, 3);
  recent.forEach((e) => { fireRule("TW-001", e); if (sevRank[e.sev] < sevRank.critical) e.sev = "critical"; });
}

function eventHost(e: TraceEvent): string | null {
  return e.host ?? (typeof e.detail?.destination === "string" ? e.detail.destination : null);
}

export function fireRule(id: string, trigger: TraceEvent, def?: RuleDef | RuleHit): void {
  const r = def ?? RULES[id];
  if (!r) return;
  if (isMuted(id, trigger.agent)) return;
  const host = eventHost(trigger);
  if (id === "TW-008" && host && isAllowListed(host)) return;

  const dupe = S.alerts.find(
    (a) => a.rule === id && a.agentId === trigger.agent && a.host === host && Date.now() - a.ts.getTime() < DEDUPE_WINDOW_MS,
  );
  if (dupe) {
    dupe.repeat = (dupe.repeat ?? 1) + 1;
    dupe.ts = new Date();
    emit("alert:repeat", dupe);
    return;
  }

  const trail = S.events.filter((x) => x.session === trigger.session && x.id !== trigger.id).slice(0, TRAIL_LENGTH).reverse();
  const alert: Alert = {
    id: "alr_" + (S.alerts.length + 1).toString().padStart(4, "0"),
    rule: id, title: r.t, sev: r.sev, why: r.why, fix: r.fix,
    ts: new Date(),
    agent: trigger.agentName, agentId: trigger.agent, session: trigger.session,
    host, trigger, trail,
  };
  S.alerts.unshift(alert);
  if (S.alerts.length > MAX_ALERTS) S.alerts.length = MAX_ALERTS;
  emit("alert", alert);
  emit("toast", { msg: `${id} · ${r.t}`, cls: "risk" });

  const ruleEv = mkEvent("rule", { id: trigger.agent, name: trigger.agentName, session: trigger.session, model: trigger.model }, {
    summary: `<b>${id}</b> ${esc(r.t)}`, sev: r.sev, tag: "alert", alertId: alert.id,
  });
  pushEvent(ruleEv, false);
}
