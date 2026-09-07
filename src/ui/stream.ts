/** The event stream: live/history modes, search, kind filters. */
import { on } from "../bus";
import { CHIP_DEFS, KIND } from "../data/kinds";
import { MAX_EVENTS, S, agentById } from "../state";
import { renderAgents } from "./agents";
import { layoutMap } from "./map";
import type { StreamMode, TraceEvent } from "../types";
import { EL, esc, nowStr } from "../utils";
import { openEvent } from "./drawer";

const LIVE_ROW_CAP = 160;
const HISTORY_ROW_CAP = 220;

const streamEl = () => EL("stream");

export function matches(e: TraceEvent): boolean {
  if (S.filters.size && !S.filters.has(e.kind)) return false;
  if (S.focusAgent && e.agent !== S.focusAgent) return false;
  if (!S.query) return true;
  const q = S.query.toLowerCase();
  return [e.summary, e.command, e.host, e.tool, e.agentName, e.session, e.id, e.tag, JSON.stringify(e.detail ?? "")]
    .some((v) => v && String(v).toLowerCase().includes(q));
}

function rowHTML(e: TraceEvent): string {
  const k = KIND[e.kind] ?? KIND.tool;
  return `<span class="t">${nowStr(e.ts)}</span>
    <span class="ic" style="color:${e.sev === "low" ? k.color : ""}" title="${k.title}">${k.ic}</span>
    <span class="who">${esc(e.agentName)}</span>
    <span class="msg">${e.summary}</span>
    <span class="tag">${esc(e.tag ?? "")}</span>`;
}

function makeRow(e: TraceEvent, animate: boolean): HTMLDivElement {
  const d = document.createElement("div");
  d.className = `ev sev-${e.sev}${animate ? " new" : ""}`;
  d.dataset.id = e.id;
  d.innerHTML = rowHTML(e);
  d.addEventListener("click", () => openEvent(e));
  return d;
}

function renderStreamRow(e: TraceEvent): void {
  if (S.mode !== "live") { S.buffered++; updatePill(); return; }
  if (!matches(e)) return;
  const box = streamEl();
  box.prepend(makeRow(e, true));
  while (box.children.length > LIVE_ROW_CAP) box.lastElementChild?.remove();
  const count = EL("streamCount");
  count.textContent = String(S.events.length);
  count.title = `${S.events.length} events kept in memory (the newest ${MAX_EVENTS})`;
}

export function renderStreamAll(): void {
  const box = streamEl();
  const list = S.events.filter(matches).slice(0, HISTORY_ROW_CAP);
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = `<div class="empty"><b>Nothing matches this filter</b>Clear the search or pick another event type to see the trace again.</div>`;
  } else {
    const f = document.createDocumentFragment();
    list.forEach((e) => f.appendChild(makeRow(e, false)));
    box.appendChild(f);
  }
  const active = [S.query ? `search "${S.query}"` : "", S.filters.size ? `type filter (${[...S.filters].join(", ")})` : "", S.focusAgent ? `agent focus (${agentById(S.focusAgent)?.name ?? S.focusAgent})` : ""].filter(Boolean);
  const count = EL("streamCount");
  count.textContent = list.length + (active.length ? ` / ${S.events.length}` : "");
  count.title = active.length ? `${list.length} of ${S.events.length} events match: ${active.join(", ")}` : `${S.events.length} events kept in memory (the newest ${MAX_EVENTS})`;
}

function updatePill(): void {
  const p = EL("newPill");
  p.classList.toggle("on", S.mode !== "live" && S.buffered > 0);
  p.textContent = `${S.buffered} new event${S.buffered === 1 ? "" : "s"} — jump to live`;
}

export function setMode(m: StreamMode): void {
  S.mode = m;
  EL("modeLive").setAttribute("aria-pressed", String(m === "live"));
  EL("modeHist").setAttribute("aria-pressed", String(m === "history"));
  if (m === "live") { S.buffered = 0; updatePill(); }
  renderStreamAll();
}

/** A removable chip for the agent focus set from the agents panel or the map. */
export function renderFocusChip(): void {
  const box = EL("chips");
  box.querySelector(".chip.focus")?.remove();
  if (!S.focusAgent) return;
  const b = document.createElement("button");
  b.className = "chip focus";
  b.setAttribute("aria-pressed", "true");
  b.title = "Only this agent's events are shown. Click to clear.";
  b.innerHTML = `<i style="background:var(--agent)"></i>${esc(agentById(S.focusAgent)?.name ?? S.focusAgent)} ✕`;
  b.addEventListener("click", () => { S.focusAgent = null; EL("mapScope").textContent = "all agents"; renderFocusChip(); renderStreamAll(); layoutMap(); renderAgents(); });
  box.appendChild(b);
}

function buildChips(): void {
  const box = EL("chips");
  CHIP_DEFS.forEach((c) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.setAttribute("aria-pressed", "false");
    b.innerHTML = `<i style="background:${c.c}"></i>${c.l}`;
    b.title = KIND[c.k].title;
    b.addEventListener("click", () => {
      if (S.filters.has(c.k)) S.filters.delete(c.k); else S.filters.add(c.k);
      b.setAttribute("aria-pressed", String(S.filters.has(c.k)));
      renderStreamAll();
    });
    box.appendChild(b);
  });
}

export function initStream(): void {
  buildChips();
  EL("modeLive").addEventListener("click", () => setMode("live"));
  EL("modeHist").addEventListener("click", () => setMode("history"));
  EL("newPill").addEventListener("click", () => setMode("live"));

  const q = EL<HTMLInputElement>("q");
  let qt: ReturnType<typeof setTimeout> | undefined;
  q.addEventListener("input", () => {
    S.query = q.value.trim();
    if (S.query && S.mode === "live") setMode("history");
    clearTimeout(qt);
    qt = setTimeout(renderStreamAll, 110);
  });
  addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== q) { e.preventDefault(); q.focus(); }
  });

  on("event", renderStreamRow);
}
