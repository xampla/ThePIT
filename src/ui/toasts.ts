import { on } from "../bus";
import { EL, esc } from "../utils";

const TOAST_MS = 3400;
const MAX_VISIBLE = 3;

export function toast(msg: string, cls = ""): void {
  const box = EL("toasts");
  const d = document.createElement("div");
  d.className = "toast " + cls;
  d.innerHTML = `<span class="tm">${esc(msg)}</span>`;
  box.appendChild(d);
  setTimeout(() => { d.classList.add("out"); setTimeout(() => d.remove(), 320); }, TOAST_MS);
  while (box.children.length > MAX_VISIBLE) box.firstElementChild?.remove();
}

export function initToasts(): void {
  on("toast", ({ msg, cls }) => toast(msg, cls));
}
