/** Alerts panel. */
import { on } from "../bus";
import { S } from "../state";
import type { Alert } from "../types";
import { EL, esc, nowStr } from "../utils";
import { openAlert } from "./drawer";

const MAX_ROWS = 60;

const sevClass = (sev: string) => (sev === "critical" ? "sev-c" : sev === "high" ? "sev-h" : "sev-m");

function renderAlert(a: Alert, animate: boolean): void {
  const box = EL("alertList");
  const d = document.createElement("div");
  d.className = `alert ${a.sev}${animate ? " new" : ""}${a.ack ? " acked" : ""}`;
  d.dataset.alert = a.id;
  d.innerHTML = `<div class="top">
      <span class="rid">${a.rule}</span>
      <span class="rep">×1</span>
      <span class="sev ${sevClass(a.sev)}">${a.sev}</span>
      <span style="flex:1"></span><span class="rid">${nowStr(a.ts)}</span>
    </div>
    <div class="ttl">${esc(a.title)}</div>
    <div class="meta"><span class="ag">${esc(a.agent)}</span>${a.host ? `<span class="hs">${esc(a.host)}</span>` : ""}<span>${a.trail.length + 1} events in trace</span></div>`;
  d.addEventListener("click", () => openAlert(a));
  box.prepend(d);
  while (box.children.length > MAX_ROWS) box.lastElementChild?.remove();
  EL("alertCount").textContent = String(S.alerts.length);
}

function markAck(a: Alert): void {
  EL("alertList").querySelector<HTMLElement>(`[data-alert="${a.id}"]`)?.classList.toggle("acked", !!a.ack);
}

function markRepeat(a: Alert): void {
  const node = EL("alertList").querySelector<HTMLElement>(`[data-alert="${a.id}"] .rep`);
  if (node) { node.textContent = `×${a.repeat ?? 1}`; node.style.opacity = "1"; }
}

function clearAlerts(): void {
  S.alerts = [];
  EL("alertList").innerHTML = "";
  EL("alertCount").textContent = "0";
}

export function initAlerts(): void {
  EL("clearAlerts").addEventListener("click", clearAlerts);
  on("alert", (a) => renderAlert(a, true));
  on("alert:repeat", markRepeat);
  on("alert:ack", markAck);
}
