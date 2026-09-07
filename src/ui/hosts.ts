/** Hosts-contacted panel, sorted worst reputation first. */
import { on } from "../bus";
import { S } from "../state";
import { EL, esc, repColor, repWord } from "../utils";
import { openHost } from "./drawer";
import { toast } from "./toasts";

const NEW_BADGE_MS = 12_000;

export function renderHosts(newKey?: string): void {
  const box = EL("hostList");
  const list = [...S.hosts.values()].sort((a, b) => a.rep - b.rep || b.count - a.count);
  EL("hostCount").textContent = String(list.length);
  list.forEach((h) => {
    let row = box.querySelector<HTMLElement>(`[data-host="${CSS.escape(h.h)}"]`);
    if (!row) {
      row = document.createElement("div");
      row.className = "host" + (h.h === newKey ? " new" : "");
      row.dataset.host = h.h;
      row.innerHTML = `<span class="nm"></span><span class="score"></span>
        <span class="bar"><i></i></span>
        <span class="sub"></span>`;
      row.addEventListener("click", () => openHost(h));
    }
    row.querySelector(".nm")!.innerHTML = `${esc(h.h)} ${Date.now() - h.first < NEW_BADGE_MS ? '<span class="badge-new">new</span>' : ""}`;
    const sc = row.querySelector<HTMLElement>(".score")!;
    sc.textContent = h.pending ? "…" : String(h.rep);
    sc.style.color = repColor(h.rep, h.pending);
    const bi = row.querySelector<HTMLElement>(".bar i")!;
    bi.style.background = repColor(h.rep, h.pending);
    requestAnimationFrame(() => { bi.style.width = h.rep + "%"; });
    row.querySelector(".sub")!.innerHTML =
      `<span>${esc(h.cat)}</span><span style="color:#3B4756">|</span><span>${h.count} req</span><span style="color:#3B4756">|</span><span>${h.agents.size} agent${h.agents.size === 1 ? "" : "s"}</span><span style="flex:1"></span><span style="color:${repColor(h.rep, h.pending)}">${repWord(h.rep, h.pending)}</span>`;
    box.appendChild(row);
  });
}

export function initHosts(): void {
  renderHosts();
  on("host:new", ({ host }) => {
    renderHosts(host.h);
    toast(`New host discovered · ${host.h}`, host.rep < 40 ? "risk" : "");
  });
  on("batch", () => renderHosts());
  on("host:rep", () => renderHosts());
}
