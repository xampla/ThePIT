import "./styles.css";
import { fetchConfig, startLiveSource } from "./engine/live-source";
import { initAgents } from "./ui/agents";
import { initAlerts } from "./ui/alerts";
import { initControls } from "./ui/controls";
import { initDrawer } from "./ui/drawer";
import { initHosts } from "./ui/hosts";
import { initMap } from "./ui/map";
import { initMeasures } from "./ui/measures";
import { initSettings } from "./ui/settings";
import { initStream } from "./ui/stream";
import { initToasts, toast } from "./ui/toasts";
import { initTools } from "./ui/tools";

async function boot(): Promise<void> {
  // UI subscribes to the bus first so nothing emitted by the engine is missed.
  initToasts();
  initDrawer();
  initMeasures();
  initStream();
  initAgents();
  initTools();
  initAlerts();
  initHosts();
  initMap();
  initControls();
  initSettings();

  const cfg = await fetchConfig();
  if (!cfg) toast("No collector found — run `npm run collector`; the page reconnects on its own", "risk");
  // The stream reconnects on its own once the collector comes up.
  startLiveSource();
}

void boot();
