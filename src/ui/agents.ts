/** Agents panel: per-agent activity meter and focus toggle. */
import { on } from "../bus";
import { S, agentById, agentList } from "../state";
import { EL } from "../utils";
import { layoutMap } from "./map";
import { renderFocusChip, renderStreamAll } from "./stream";

const HOT_RISK = 2;
const ACTIVE_FLASH_MS = 1400;
const flashTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

const maxCalls = () => Math.max(1, ...[...S.agentState.values()].map((s) => s.calls));

function sidHTML(id: string): string {
  const st = S.agentState.get(id);
  const a = agentById(id);
  if (!st || !a) return "";
  const hot = st.risk > HOT_RISK;
  return `${a.session}<span style="color:#3B4756">·</span>${st.calls} events${hot ? ` <span style="color:var(--amber)">${st.risk} risk</span>` : ""}`;
}

export function renderAgents(): void {
  const box = EL("agentList");
  box.innerHTML = "";
  const max = maxCalls();
  const list = agentList();
  list.forEach((a) => {
    const st = S.agentState.get(a.id)!;
    const hot = st.risk > HOT_RISK;
    const b = document.createElement("button");
    b.className = `agent${hot ? " hot" : ""}${a.parent ? " sub" : ""}`;
    b.dataset.agent = a.id;
    b.setAttribute("aria-pressed", String(S.focusAgent === a.id));
    b.innerHTML = `<span class="top"><span class="pulse"></span><span class="nm">${a.name.startsWith(" · ") ? "sub-agent" + a.name : a.name}</span>
        <span class="spacer" style="flex:1"></span><span class="role">${a.role}</span></span>
      <span class="sid">${sidHTML(a.id)}</span>
      <span class="meter"><i style="width:${Math.round((st.calls / max) * 100)}%"></i></span>`;
    b.addEventListener("click", () => {
      S.focusAgent = S.focusAgent === a.id ? null : a.id;
      EL("mapScope").textContent = S.focusAgent ? `${a.name} only` : "all agents";
      renderAgents();
      renderFocusChip();
      renderStreamAll();
      layoutMap();
    });
    box.appendChild(b);
  });
  EL("agentCount").textContent = String(list.length);
}

function markAgentActive(id: string): void {
  const el = document.querySelector<HTMLElement>(`[data-agent="${id}"]`);
  const st = S.agentState.get(id);
  if (!el || !st) return;
  el.classList.add("active");
  const prev = flashTimers.get(el);
  if (prev) clearTimeout(prev);
  flashTimers.set(el, setTimeout(() => el.classList.remove("active"), ACTIVE_FLASH_MS));
  const bar = el.querySelector<HTMLElement>(".meter i");
  if (bar) bar.style.width = Math.round((st.calls / maxCalls()) * 100) + "%";
  const sid = el.querySelector(".sid");
  if (sid) sid.innerHTML = sidHTML(id);
  el.classList.toggle("hot", st.risk > HOT_RISK);
}

export function initAgents(): void {
  renderAgents();
  on("agent:new", () => renderAgents());
  on("batch", (b) => { if (!b.length) renderAgents(); });
  on("event", (e) => markAgentActive(e.agent));
}
