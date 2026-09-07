/** Tool-call histogram. */
import { on } from "../bus";
import { S } from "../state";
import { EL } from "../utils";

/** Tools whose use is always worth a second look. */
const FLAGGED = new Set(["send_email", "git_push", "secrets_read", "bash", "shell", "http_request"]);

const rowFor = (box: HTMLElement, n: string) => box.querySelector<HTMLElement>(`[data-tool="${CSS.escape(n)}"]`);

export function renderTools(): void {
  const box = EL("toolList");
  const entries = [...S.toolCounts.entries()].sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map((e) => e[1]));
  const total = entries.reduce((s, e) => s + e[1], 0);
  EL("toolCount").textContent = String(total);
  entries.forEach(([n, c]) => {
    let row = rowFor(box, n);
    if (!row) {
      row = document.createElement("div");
      row.className = "tool" + (FLAGGED.has(n.toLowerCase()) ? " flagged" : "");
      row.dataset.tool = n;
      row.innerHTML = `<span class="nm">${n}</span><span class="n">0</span><span class="bar"><i></i></span>`;
      box.appendChild(row);
    }
    row.querySelector(".n")!.textContent = String(c);
    row.querySelector<HTMLElement>(".bar i")!.style.width = (c / max) * 100 + "%";
  });
  // keep DOM order in sync with the sorted counts
  entries.forEach(([n]) => { const r = rowFor(box, n); if (r) box.appendChild(r); });
}

export function initTools(): void {
  renderTools();
  on("tool:bump", (n) => {
    const row = rowFor(EL("toolList"), n);
    if (row) { row.classList.remove("bump"); void row.offsetWidth; row.classList.add("bump"); }
    renderTools();
  });
}
