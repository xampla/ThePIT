export const EL = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

export const stripTags = (html: string): string => html.replace(/<[^>]+>/g, "");

export const nowStr = (d: Date): string => d.toLocaleTimeString("en-GB", { hour12: false });

export const repColor = (r: number, pending = false): string => (pending ? "#657486" : r >= 75 ? "#3FD68C" : r >= 50 ? "#8FCF6B" : r >= 30 ? "#FFB020" : "#FF5C57");
export const repWord = (r: number, pending = false): string => (pending ? "checking" : r >= 75 ? "trusted" : r >= 50 ? "acceptable" : r >= 30 ? "unverified" : "low reputation");

export const sevColor = (sev: string): string =>
  sev === "critical" ? "var(--coral)" : sev === "high" ? "#FF8A62" : sev === "medium" ? "var(--amber)" : "var(--good)";

/** Pretty-printed, escaped JSON block with highlighted keys. */
export function json(obj: unknown): string {
  const s = JSON.stringify(obj, null, 2)
    .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string)
    .replace(/^(\s*)"([^"]+)":/gm, '$1<span class="k">"$2"</span>:');
  return `<pre>${s}</pre>`;
}

/** Sanitise a string for use as an SVG element id. */
export const svgKey = (s: string): string => s.replace(/[^a-zA-Z0-9]/g, "_");
