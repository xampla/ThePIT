/** Pull remote hostnames out of free text (commands, tool arguments, URLs). */

const URL_RE = /\bhttps?:\/\/([^\s/'"`<>()\[\]|;,]+)/gi;
const IPV4_RE = /\b((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?::\d{1,5})?\b/g;
/** host argument after tools that dial out: ssh user@host, nc host 443, scp host:path */
const NET_TOOL_RE = /\b(?:ssh|scp|sftp|nc|ncat|netcat|telnet|dig|nslookup|ping)\s+(?:-\S+\s+)*(?:[\w.-]+@)?([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\b/gi;

function stripPort(h: string): string {
  const s = h.replace(/^[^@]*@/, "").toLowerCase();
  if (s.startsWith("[")) return s.slice(1, s.indexOf("]"));
  return s.replace(/:\d+$/, "");
}

export function hostOfUrl(url: string): string | undefined {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url.trim());
  return m ? stripPort(m[1]) : undefined;
}

/** scp-like remotes: git@github.com:org/repo, user@host:/path */
const SCP_LIKE_RE = /\b[\w.-]+@([a-z0-9][a-z0-9.-]*\.[a-z]{2,}):/gi;

export function extractHosts(text: string | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(URL_RE)) out.add(stripPort(m[1]));
  for (const m of text.matchAll(SCP_LIKE_RE)) out.add(m[1].toLowerCase());
  for (const m of text.matchAll(IPV4_RE)) out.add(m[1]);
  for (const m of text.matchAll(NET_TOOL_RE)) out.add(m[1].toLowerCase());
  out.delete("localhost");
  return [...out].filter((h) => h.length > 2 && h.length < 254);
}
