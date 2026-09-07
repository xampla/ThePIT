/** Top KPI row with sparklines. */
import { S } from "../state";
import { EL } from "../utils";

interface Measure {
  k: string;
  lab: string;
  get: () => number;
  sub: () => string;
  cls?: () => string;
}

const SPARK_POINTS = 26;
const TWEEN_MS = 420;

const criticalCount = () => S.alerts.filter((a) => a.sev === "critical" && !a.ack).length;

const MEAS: Measure[] = [
  { k: "events", lab: "Trace events",    get: () => S.totals.events,   sub: () => `${S.events.length} buffered` },
  { k: "agents", lab: "Active sessions", get: () => S.agents.size,     sub: () => `${S.agents.size} agents` },
  { k: "hosts",  lab: "Hosts contacted", get: () => S.hosts.size,      sub: () => `${[...S.hosts.values()].filter((h) => h.rep < 40).length} below 40` },
  { k: "cmds",   lab: "Commands run",    get: () => S.totals.commands, sub: () => `across ${S.agents.size} sessions` },
  { k: "alerts", lab: "Alerts",          get: () => S.alerts.length,   sub: () => `${criticalCount()} critical`, cls: () => (S.alerts.length ? "warn" : "") },
  { k: "crit",   lab: "Needs review",    get: criticalCount,           sub: () => "critical, not acknowledged", cls: () => (criticalCount() ? "alarm" : "") },
];

const sparkData: Record<string, number[]> = {};

function buildMeasures(): void {
  EL("measures").innerHTML = MEAS.map((m) => `
    <div class="m" data-m="${m.k}">
      <div><div class="lab">${m.lab}</div><div class="val">0</div><div class="sub"></div></div>
      <svg class="spark" width="52" height="22" viewBox="0 0 52 22" aria-hidden="true"><polyline fill="none" stroke="rgba(255,255,255,.22)" stroke-width="1.2" points=""/></svg>
    </div>`).join("");
}

export function renderMeasures(): void {
  MEAS.forEach((m) => {
    const el = document.querySelector<HTMLElement>(`[data-m="${m.k}"]`);
    if (!el) return;
    const v = m.get();
    const valEl = el.querySelector<HTMLElement>(".val")!;
    const cur = parseInt(valEl.textContent ?? "0", 10) || 0;
    if (cur !== v) tween(valEl, cur, v);
    el.querySelector(".sub")!.textContent = m.sub();
    el.className = "m " + (m.cls?.() ?? "");
    const arr = (sparkData[m.k] ??= []);
    arr.push(v);
    if (arr.length > SPARK_POINTS) arr.shift();
    const mx = Math.max(1, ...arr), mn = Math.min(...arr);
    const pts = arr.map((y, i) => `${(i / Math.max(1, arr.length - 1)) * 50 + 1},${20 - ((y - mn) / Math.max(1, mx - mn)) * 17}`).join(" ");
    el.querySelector("polyline")!.setAttribute("points", pts);
  });
}

function tween(node: HTMLElement, from: number, to: number): void {
  const t0 = performance.now();
  const step = (t: number) => {
    const p = Math.max(0, Math.min(1, (t - t0) / TWEEN_MS));
    node.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(step);
  };
  step(t0);
}

export function initMeasures(): void {
  buildMeasures();
  renderMeasures();
  setInterval(renderMeasures, 900);
}
