import { emit } from "../bus";
import { MAX_EVENTS, S, sevRank } from "../state";
import type { TraceEvent } from "../types";

/**
 * Append an event to the in-memory store and notify the UI.
 * `countForAgent` is false for synthetic rule events so they don't inflate
 * the agent's step counter.
 */
export function pushEvent(e: TraceEvent, countForAgent = true): void {
  S.events.unshift(e);
  if (S.events.length > MAX_EVENTS) S.events.length = MAX_EVENTS;
  S.totals.events++;
  if (countForAgent) {
    const st = S.agentState.get(e.agent);
    if (st) {
      st.calls++;
      st.last = Date.now();
      if (sevRank[e.sev] > 0) st.risk++;
    }
  }
  emit("event", e);
}
