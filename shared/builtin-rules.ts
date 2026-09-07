/**
 * Built-in The PIT rules. These run in the collector (and again in the
 * browser for replayed files) and are cheap regular expressions over the
 * structured fields of an event. Content rules (prompt injection, jailbreaks,
 * exfiltration phrasing) are delegated to Nova.
 */
import type { WireEvent, WireRuleHit, WireSeverity } from "./wire.ts";

export interface BuiltinRule {
  id: string;
  title: string;
  sev: WireSeverity;
  why: string;
  fix: string;
  test: (e: WireEvent) => boolean;
}

const cmd = (e: WireEvent) => e.command ?? (e.kind === "command" ? e.label : "") ?? "";

const SECRET_PATH = /(\.aws\/credentials|id_ed25519|id_rsa|\.env\b|\.netrc|\.npmrc|\.pypirc|\/run\/secrets\/|\.kube\/config|\.docker\/config\.json|\.git-credentials)/;
const PIPE_TO_SHELL = /(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/;
const ENCODE_ENV = /\b(base64|xxd|openssl\s+enc)\b.*\$[A-Z_]{4,}|\$[A-Z_]{4,}.*\|\s*(base64|xxd)/;
const TMP_EXEC = /chmod\s+\+x\s+\/(tmp|dev\/shm|var\/tmp)\/|\/(tmp|dev\/shm|var\/tmp)\/\S+\s*(&&|;)\s*\/(tmp|dev\/shm|var\/tmp)\//;
const BULK_OUT = /\b(tar|zip|7z)\b.*\|\s*(curl|nc|ncat)\b|\bcurl\b.*(-T|--upload-file|-d\s*@|--data-binary\s*@)/;
const DESTRUCTIVE = /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/|~|\$HOME|\.)(\s|$)|\bmkfs\b|\bdd\s+if=.*of=\/dev\/(sd|nvme|disk)/;
const REVERSE_SHELL = /\b(nc|ncat|bash|sh)\b.*(-e\s*\/bin\/(ba)?sh|\/dev\/tcp\/)/;

export const BUILTIN_RULES: readonly BuiltinRule[] = [
  { id: "TW-002", title: "Credential material read by agent", sev: "critical",
    why: "A tool call read a file matching a known secret path (cloud credentials, SSH keys, .env).",
    fix: "Rotate the exposed credential and add the path to the agent's deny list.",
    test: (e) => (e.kind === "command" && SECRET_PATH.test(cmd(e))) || (e.kind === "file" && SECRET_PATH.test(e.label)) },
  { id: "TW-004", title: "Remote script piped to a shell", sev: "critical",
    why: "A command downloaded a remote payload and executed it directly through an interpreter.",
    fix: "Terminate the session. Treat the host as compromised until proven otherwise.",
    test: (e) => e.kind === "command" && PIPE_TO_SHELL.test(cmd(e)) },
  { id: "TW-005", title: "Bulk data egress", sev: "high",
    why: "A command packaged local data and streamed it to a remote endpoint.",
    fix: "Hold the transfer and confirm the destination is an approved data processor.",
    test: (e) => e.kind === "command" && BULK_OUT.test(cmd(e)) },
  { id: "TW-006", title: "Encoded payload in command", sev: "medium",
    why: "A command encoded environment content, a common step before exfiltration.",
    fix: "Review what was encoded and whether it left the host.",
    test: (e) => e.kind === "command" && ENCODE_ENV.test(cmd(e)) },
  { id: "TW-007", title: "Execution from a temporary path", sev: "high",
    why: "A binary was made executable and run from a world-writable directory.",
    fix: "Capture the file for analysis and revoke the agent's shell tool.",
    test: (e) => e.kind === "command" && TMP_EXEC.test(cmd(e)) },
  { id: "TW-011", title: "Destructive filesystem command", sev: "critical",
    why: "A command would recursively delete or overwrite a root, home, or device path.",
    fix: "Stop the session and check the working tree and backups before resuming.",
    test: (e) => e.kind === "command" && DESTRUCTIVE.test(cmd(e)) },
  { id: "TW-012", title: "Reverse shell pattern", sev: "critical",
    why: "A command wires a shell to a network socket, the classic remote-control primitive.",
    fix: "Kill the process, isolate the host and rotate anything the agent could reach.",
    test: (e) => e.kind === "command" && REVERSE_SHELL.test(cmd(e)) },
];

export function evaluateBuiltin(e: WireEvent): WireRuleHit[] {
  const hits: WireRuleHit[] = [];
  for (const r of BUILTIN_RULES) {
    if (!r.test(e)) continue;
    hits.push({ id: r.id, title: r.title, sev: r.sev, why: r.why, fix: r.fix, engine: "builtin" });
  }
  return hits;
}
