/**
 * One principal, several sources. Claude Code's telemetry identifies itself
 * only as "claude-code" plus a user id; the hook knows machine and user. Both
 * carry the same session id, so the session is the join key: the first
 * endpoint-qualified identity ("tool@host") seen for a session becomes the
 * canonical one and every later event in that session adopts it.
 */
import { publish } from "./hub.ts";
import type { WireAgent, WireEvent } from "../shared/wire.ts";

const MAX_SESSIONS = 5000;
const bySession = new Map<string, WireAgent>();

const qualified = (a: WireAgent) => a.id.includes("@") && !a.id.includes("@user:");

function remember(session: string, a: WireAgent): void {
  if (bySession.size >= MAX_SESSIONS) bySession.delete(bySession.keys().next().value as string);
  bySession.set(session, a);
}

export function resolveIdentity(e: WireEvent): void {
  const session = e.agent.session;
  if (!session || session === "unknown" || session === "no-session") return;
  const known = bySession.get(session);
  if (e.agent.parent) {
    // a sub-agent: never canonicalised itself, but its parent must be the session's canonical agent
    if (known && qualified(known) && known.id !== e.agent.parent) {
      const suffix = e.agent.id.slice(e.agent.id.indexOf("/sub:"));
      e.agent = { ...e.agent, id: known.id + suffix, parent: known.id, role: e.agent.role?.replace(/of .*$/, `of ${known.name}`) };
    } else if (!known) {
      // learn the session's identity from the sub-agent's parent
      const parts = e.agent.parent.split("@");
      remember(session, { id: e.agent.parent, name: e.agent.parent.replace("@", " · "), role: parts.length > 1 ? "coding agent" : "agent", session });
    }
    return;
  }
  if (!known) { remember(session, e.agent); return; }
  if (known.id === e.agent.id) {
    if (e.agent.model && !known.model) known.model = e.agent.model;
    return;
  }
  if (qualified(e.agent) && !qualified(known)) {
    // richer identity arrived after a poorer one: re-key everything already published
    const merged: WireAgent = { ...e.agent, model: e.agent.model ?? known.model };
    remember(session, merged);
    publish({ t: "agent:merge", from: known.id, to: merged });
    return;
  }
  // poorer (or equal) identity for a known session: adopt the canonical one
  e.agent = { ...known, model: e.agent.model ?? known.model };
}
