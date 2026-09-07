/** Process a batch of events: evaluate rules, store, notify the UI. */
import { emit } from "../bus";
import type { TraceEvent } from "../types";
import { evaluate } from "./rules";
import { pushEvent } from "./store";

export function ingest(events: TraceEvent[]): void {
  for (const e of events) {
    evaluate(e);
    pushEvent(e);
  }
  emit("batch", events);
}
