/** Top bar: collector status and clock. */
import { on } from "../bus";
import { live } from "../engine/live-source";
import { EL, nowStr } from "../utils";

const STATUS_POLL_MS = 2000;

function renderStatus(): void {
  const box = EL("srcStatus");
  const dot = EL("liveDot");
  const sub = EL("srcSub");
  if (live.connected) {
    dot.classList.remove("paused");
    sub.textContent = "connected";
    const st = live.status as { collector?: { port?: number; received?: number } } | null;
    box.title = `Collector running on port ${st?.collector?.port ?? 4318} · ${st?.collector?.received ?? 0} events received since start`;
  } else {
    dot.classList.add("paused");
    sub.textContent = "offline";
    box.title = "Collector unreachable. Start it with `npm run collector` (default port 4318); the page reconnects on its own. Agents keep running, their traces are just not recorded.";
  }
}

export function initControls(): void {
  const tickClock = () => { EL("clock").textContent = nowStr(new Date()); };
  tickClock();
  setInterval(tickClock, 1000);
  renderStatus();
  setInterval(renderStatus, STATUS_POLL_MS);
  on("batch", renderStatus);
}
