/** Agent-to-host activity map (SVG). */
import { on } from "../bus";
import { S, agentList } from "../state";
import type { Agent, HostRecord, Severity } from "../types";
import { EL, esc, repColor, svgKey } from "../utils";
import { openAgent, openHost } from "./drawer";
import { sugiyama, type LEdge, type LNode, type LayoutResult } from "./layout";

const SVG = "http://www.w3.org/2000/svg";
const MAX_HOSTS = 24;
/** Vertical room a node needs including its labels. */
const ROW_PX = 46;
const TOP = 40, BOTTOM = 40;
const SUB_COLOR = "#F2A7FF";
const RING_MS = 1700;
const PACKET_MS = 1100;
const RELAYOUT_MS = 2500;

type NodePos = { x: number; y: number } & ({ type: "agent"; ref: Agent } | { type: "host"; ref: HostRecord });

let W = 960, H = 420;
const nodePos = new Map<string, NodePos>();
/** Fullscreen view state: pan offset and zoom applied through the viewBox. */
const view = { on: false, x: 0, y: 0, z: 1 };

const mapSvg = () => EL<HTMLElement>("map") as unknown as SVGSVGElement;
const gLinks = () => EL("gLinks") as unknown as SVGGElement;
const gNodes = () => EL("gNodes") as unknown as SVGGElement;
const gPackets = () => EL("gPackets") as unknown as SVGGElement;

const linkId = (agentId: string, hostKey: string) => "lk_" + svgKey(agentId) + "__" + svgKey(hostKey);
const nodeId = (key: string) => "nd_" + svgKey(key);
const packetColor = (sev: Severity) => (sev === "critical" ? "#FF5C57" : sev === "high" ? "#FFB020" : "#4DA3FF");

function applyViewBox(): void {
  mapSvg().setAttribute("viewBox", view.on ? `${view.x} ${view.y} ${W / view.z} ${H / view.z}` : `0 0 ${W} ${H}`);
}

function resizeMap(): void {
  const svg = mapSvg();
  const box = svg.parentElement!.getBoundingClientRect();
  const w = Math.max(560, Math.round(box.width)), h = Math.max(220, Math.round(box.height));
  if (w === W && h === H) return;
  W = w; H = h;
  applyViewBox();
  layoutMap();
}

function visibleHosts(): HostRecord[] {
  let hs = [...S.hosts.values()];
  if (S.focusAgent) hs = hs.filter((h) => h.agents.has(S.focusAgent!));
  return hs.sort((a, b) => b.count - a.count).slice(0, Math.min(MAX_HOSTS, layoutRows()));
}

/** Rows the layout was computed for: the panel's, so fullscreen only scales the same picture. */
let panelH = 0;
const layoutRows = () => Math.max(3, Math.floor(((view.on && panelH ? panelH : H) - TOP - BOTTOM) / ROW_PX) + 1);

interface Cached { sig: string; result: LayoutResult; hasSubs: boolean }
let cached: Cached | null = null;
/** Waypoint y (px) for agent→host edges that were routed through the sub-agent column. */
const viaY = new Map<string, number>();

export function layoutMap(): void {
  if (!view.on) panelH = H;
  const all = agentList();
  const ags = S.focusAgent ? all.filter((a) => a.id === S.focusAgent || a.parent === S.focusAgent) : all;
  const hs = visibleHosts();
  const roots = ags.filter((a) => !a.parent || !ags.some((p) => p.id === a.parent));
  const subs = ags.filter((a) => !roots.includes(a));
  const hostSet = new Set(hs.map((h) => h.h));

  const nodes: LNode[] = [...roots.map((a) => ({ id: a.id, layer: 0 as const })), ...subs.map((a) => ({ id: a.id, layer: 1 as const, w: 1.25 })), ...hs.map((h) => ({ id: h.h, layer: 2 as const }))];
  const edges: LEdge[] = subs.filter((s) => s.parent && roots.some((r) => r.id === s.parent)).map((s) => ({ from: s.parent!, to: s.id }));
  for (const l of S.links.values()) if (hostSet.has(l.host) && ags.some((a) => a.id === l.agent)) edges.push({ from: l.agent, to: l.host });
  const sig = "v3|" + nodes.map((n) => n.id).join("|") + "#" + edges.map((e) => e.from + ">" + e.to).sort().join("|");

  // the layout is computed for the panel size and reused in fullscreen (only scaled), unless the graph changed
  if (!cached || cached.sig !== sig) {
    const spanForRows = (view.on && panelH ? panelH : H) - TOP - BOTTOM;
    cached = { sig, result: sugiyama(nodes, edges, ROW_PX / Math.max(spanForRows, ROW_PX * 3)), hasSubs: subs.length > 0 };
  }
  const { result } = cached;
  const span = H - TOP - BOTTOM;
  const px = (f: number) => TOP + f * span;
  const rootX = Math.round(W * (cached.hasSubs ? 0.2 : 0.27)), subX = Math.round(W * 0.42), hostX = Math.round(W * (cached.hasSubs ? 0.66 : 0.6));

  nodePos.clear();
  roots.forEach((a) => nodePos.set(a.id, { x: rootX, y: px(result.y.get(a.id) ?? 0.5), type: "agent", ref: a }));
  subs.forEach((a) => nodePos.set(a.id, { x: subX, y: px(result.y.get(a.id) ?? 0.5), type: "agent", ref: a }));
  hs.forEach((h) => nodePos.set(h.h, { x: hostX, y: px(result.y.get(h.h) ?? 0.5), type: "host", ref: h }));
  viaY.clear();
  for (const [k, f] of result.via) viaY.set(k, px(f));
  drawMap(ags, hs);
}

/* ---------- fullscreen view: pan, zoom ---------- */

let home: HTMLElement | null = null;

export function openFullscreenMap(): void {
  if (view.on) return;
  const svg = mapSvg();
  home = svg.parentElement;
  const modal = document.createElement("div");
  modal.className = "mapmodal";
  modal.id = "mapModal";
  modal.innerHTML = `<div class="mhead"><h2>Agent to host activity</h2><span class="hint">drag to pan · wheel to zoom · double-click to reset · Esc to close</span><span style="flex:1"></span><button class="btn" id="mapClose" aria-label="Close">✕ Close</button></div><div class="mbody" id="mapBody"></div>`;
  document.body.appendChild(modal);
  const body = modal.querySelector<HTMLElement>("#mapBody")!;
  body.appendChild(svg);
  view.on = true; view.x = 0; view.y = 0; view.z = 1;
  W = 0; H = 0; // force a relayout for the new size
  resizeMap();

  const close = () => closeFullscreenMap();
  modal.querySelector("#mapClose")!.addEventListener("click", close);
  addEventListener("keydown", escClose);

  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
  body.addEventListener("mousedown", (e) => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; body.classList.add("dragging"); });
  addEventListener("mousemove", (e) => {
    if (!drag) return;
    const box = body.getBoundingClientRect();
    const dx = (e.clientX - drag.x) * (W / view.z) / box.width, dy = (e.clientY - drag.y) * (H / view.z) / box.height;
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
    view.x = drag.vx - dx; view.y = drag.vy - dy;
    applyViewBox();
  });
  addEventListener("mouseup", () => { if (drag?.moved) suppressClick = true; drag = null; body.classList.remove("dragging"); });
  body.addEventListener("wheel", (e) => {
    e.preventDefault();
    const box = body.getBoundingClientRect();
    const px = view.x + ((e.clientX - box.left) / box.width) * (W / view.z);
    const py = view.y + ((e.clientY - box.top) / box.height) * (H / view.z);
    const z = Math.min(6, Math.max(0.4, view.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    view.x = px - ((e.clientX - box.left) / box.width) * (W / z);
    view.y = py - ((e.clientY - box.top) / box.height) * (H / z);
    view.z = z;
    applyViewBox();
  }, { passive: false });
  body.addEventListener("dblclick", () => { view.x = 0; view.y = 0; view.z = 1; applyViewBox(); });
}

let suppressClick = false;
function escClose(e: KeyboardEvent): void { if (e.key === "Escape") closeFullscreenMap(); }

export function closeFullscreenMap(): void {
  if (!view.on) return;
  const svg = mapSvg();
  home?.appendChild(svg);
  document.getElementById("mapModal")?.remove();
  removeEventListener("keydown", escClose);
  view.on = false; view.x = 0; view.y = 0; view.z = 1;
  W = 0; H = 0;
  resizeMap();
}

/* ---------- splitter between map and stream ---------- */

function initSplitter(): void {
  const bar = document.getElementById("splitter");
  const col = bar?.parentElement;
  if (!bar || !col) return;
  const KEY = "pit.mapHeight";
  try { const saved = localStorage.getItem(KEY); if (saved) col.style.setProperty("--map-h", saved); } catch { /* storage unavailable */ }
  bar.addEventListener("mousedown", (e) => {
    e.preventDefault();
    bar.classList.add("active");
    const top = col.getBoundingClientRect().top;
    const move = (ev: MouseEvent) => {
      const h = Math.max(160, Math.min(col.clientHeight - 140, ev.clientY - top));
      col.style.setProperty("--map-h", h + "px");
    };
    const up = () => {
      bar.classList.remove("active");
      removeEventListener("mousemove", move); removeEventListener("mouseup", up);
      try { localStorage.setItem(KEY, col.style.getPropertyValue("--map-h")); } catch { /* ignore */ }
      resizeMap();
    };
    addEventListener("mousemove", move); addEventListener("mouseup", up);
  });
}

function drawMap(ags: Agent[], hs: HostRecord[]): void {
  const links = gLinks();
  const wanted = new Set<string>();
  for (const l of S.links.values()) {
    const a = nodePos.get(l.agent), b = nodePos.get(l.host);
    if (!a || !b || b.type !== "host") continue;
    const id = linkId(l.agent, l.host);
    wanted.add(id);
    const vy = viaY.get(`${l.agent}>${l.host}`);
    const vx = Math.round(W * 0.42);
    const d = vy === undefined
      ? `M${a.x},${a.y} C${(a.x + b.x) / 2},${a.y} ${(a.x + b.x) / 2},${b.y} ${b.x},${b.y}`
      : `M${a.x},${a.y} C${(a.x + vx) / 2},${a.y} ${(a.x + vx) / 2},${vy} ${vx},${vy} C${(vx + b.x) / 2},${vy} ${(vx + b.x) / 2},${b.y} ${b.x},${b.y}`;
    let p = links.querySelector<SVGPathElement>("#" + id);
    if (!p) {
      p = document.createElementNS(SVG, "path");
      p.id = id;
      p.setAttribute("stroke-width", "1");
      links.appendChild(p);
    }
    p.setAttribute("d", d);
    p.setAttribute("stroke", b.ref.rep < 25 ? "rgba(255,92,87,.32)" : b.ref.rep < 45 ? "rgba(255,176,32,.24)" : "rgba(255,255,255,.09)");
  }
  // parent -> sub-agent spawn links
  for (const a of ags) {
    if (!a.parent) continue;
    const p = nodePos.get(a.parent), c = nodePos.get(a.id);
    if (!p || !c) continue;
    const id = linkId(a.parent, "sub_" + a.id);
    wanted.add(id);
    let path = links.querySelector<SVGPathElement>("#" + id);
    if (!path) {
      path = document.createElementNS(SVG, "path");
      path.id = id;
      path.setAttribute("stroke-width", "1");
      path.setAttribute("stroke-dasharray", "4 3");
      links.appendChild(path);
    }
    path.setAttribute("d", `M${p.x},${p.y} C${(p.x + c.x) / 2},${p.y} ${(p.x + c.x) / 2},${c.y} ${c.x},${c.y}`);
    path.setAttribute("stroke", "rgba(242,167,255,.35)");
  }
  [...links.children].forEach((c) => { if (!wanted.has(c.id)) c.remove(); });
  EL("linkCount").textContent = `${wanted.size} link${wanted.size === 1 ? "" : "s"}`;

  const nodes = gNodes();
  const want = new Set<string>();
  ags.forEach((a) => { want.add(nodeId(a.id)); upsertNode(a.id); });
  hs.forEach((h) => { want.add(nodeId(h.h)); upsertNode(h.h); });
  [...nodes.children].forEach((c) => { if (!want.has(c.id)) c.remove(); });
}

function upsertNode(key: string): void {
  const pos = nodePos.get(key);
  if (!pos) return;
  const nid = nodeId(key);
  const nodes = gNodes();
  let g = nodes.querySelector<SVGGElement>("#" + CSS.escape(nid));
  if (!g) {
    g = document.createElementNS(SVG, "g");
    g.id = nid;
    g.setAttribute("class", "gnode");
    g.style.transition = "transform .5s cubic-bezier(.2,.8,.2,1)";
    const inner = document.createElementNS(SVG, "g");
    inner.setAttribute("class", "appear");
    g.appendChild(inner);
    if (pos.type === "agent") {
      const a = pos.ref;
      const col = a.parent ? SUB_COLOR : "#8E7CFF";
      // "tool · machine" names get two lines so long hostnames are not clipped at the edge
      const [rawTool, ...rest] = a.name.split(" · ");
      const tool = rawTool.trim() || (a.parent ? "sub-agent" : "agent");
      const machine = rest.join(" · ");
      const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
      inner.innerHTML = a.parent
        ? `<circle r="12" fill="${col}1f" stroke="${col}" stroke-width="1.2"/>
           <circle r="3.5" fill="${col}" filter="url(#glow)"/>
           <text class="n-label" x="0" y="-18" text-anchor="middle">${esc(clip(tool, 22))}</text>
           <text class="n-sub" x="0" y="26" text-anchor="middle">${esc(clip(machine || a.session, 22))}</text>`
        : `<circle r="16" fill="${col}1f" stroke="${col}" stroke-width="1.2"/>
           <circle r="4.5" fill="${col}" filter="url(#glow)"/>
           <text class="n-label" x="-24" y="${machine ? -9 : -4}" text-anchor="end">${esc(tool)}</text>
           ${machine ? `<text class="n-sub" x="-24" y="3" text-anchor="end">${esc(clip(machine, 30))}</text>` : ""}
           <text class="n-sub" x="-24" y="${machine ? 15 : 8}" text-anchor="end">${esc(a.session)}</text>`;
      g.addEventListener("click", () => { if (suppressClick) { suppressClick = false; return; } openAgent(a); });
    } else {
      const h = pos.ref;
      const c = repColor(h.rep);
      inner.innerHTML = `
        <rect x="-6" y="-6" width="12" height="12" rx="2" fill="${c}22" stroke="${c}" stroke-width="1.2"/>
        <circle class="rep" r="2.2" fill="${c}"/>
        <text class="n-label" x="14" y="0" dominant-baseline="middle">${esc(h.h.length > 22 ? h.h.slice(0, 21) + "…" : h.h)}</text>
        <text class="n-sub" x="14" y="11" dominant-baseline="middle">${h.pending ? "checking reputation" : `rep ${h.rep} · ${esc(h.cat.length > 26 ? h.cat.slice(0, 25) + "…" : h.cat)}`}</text>`;
      g.addEventListener("click", () => { if (suppressClick) { suppressClick = false; return; } openHost(h); });
    }
    nodes.appendChild(g);
    ring(pos.x, pos.y, pos.type === "agent" ? (pos.ref.parent ? SUB_COLOR : "#8E7CFF") : repColor(pos.ref.rep));
  }
  g.style.transform = `translate(${pos.x}px,${pos.y}px)`;
}

function ring(x: number, y: number, color: string): void {
  const r = document.createElementNS(SVG, "circle");
  r.setAttribute("class", "ring");
  r.setAttribute("fill", "none");
  r.setAttribute("stroke", color);
  r.setAttribute("cx", String(x));
  r.setAttribute("cy", String(y));
  gPackets().appendChild(r);
  setTimeout(() => r.remove(), RING_MS);
}

function firePacket(agentId: string, hostKey: string, sev: Severity): void {
  let path = gLinks().querySelector<SVGPathElement>("#" + linkId(agentId, hostKey));
  if (!path) {
    // link is new since the last layout; lay out now so the packet has a path
    layoutMap();
    path = gLinks().querySelector<SVGPathElement>("#" + linkId(agentId, hostKey));
    if (!path) return;
  }
  const len = path.getTotalLength();
  const col = packetColor(sev);
  const c = document.createElementNS(SVG, "circle");
  c.setAttribute("r", "3.2"); c.setAttribute("fill", col); c.setAttribute("filter", "url(#glow)");
  const trail = document.createElementNS(SVG, "circle");
  trail.setAttribute("r", "6"); trail.setAttribute("fill", col); trail.setAttribute("opacity", ".18");
  const packets = gPackets();
  packets.appendChild(trail);
  packets.appendChild(c);
  const dur = PACKET_MS, t0 = performance.now();
  const step = (t: number) => {
    const p = (t - t0) / dur;
    if (p >= 1) {
      c.remove(); trail.remove();
      const pos = nodePos.get(hostKey);
      if (pos) ring(pos.x, pos.y, col);
      return;
    }
    const pt = path!.getPointAtLength(len * p);
    c.setAttribute("cx", String(pt.x)); c.setAttribute("cy", String(pt.y));
    trail.setAttribute("cx", String(pt.x)); trail.setAttribute("cy", String(pt.y));
    trail.setAttribute("opacity", String(0.2 * (1 - p) + 0.04));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function initMap(): void {
  initSplitter();
  document.getElementById("mapExpand")?.addEventListener("click", openFullscreenMap);
  resizeMap();
  layoutMap();
  on("host:new", () => layoutMap());
  on("agent:new", () => layoutMap());
  on("host:rep", (h) => { gNodes().querySelector("#" + CSS.escape(nodeId(h.h)))?.remove(); layoutMap(); });
  on("packet", ({ agentId, hostKey, sev }) => requestAnimationFrame(() => firePacket(agentId, hostKey, sev)));
  setInterval(layoutMap, RELAYOUT_MS);
  let rz: ReturnType<typeof setTimeout> | undefined;
  addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(resizeMap, 140); });
  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(() => resizeMap());
    ro.observe(mapSvg().parentElement!);
    // the svg moves between the panel and the fullscreen modal; watch whichever holds it
    new MutationObserver(() => { const p = mapSvg().parentElement; if (p) ro.observe(p); }).observe(document.body, { childList: true });
  }
  setTimeout(() => { resizeMap(); layoutMap(); }, 400);
}
