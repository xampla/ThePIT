/**
 * Layered graph layout (Sugiyama method) for the activity map.
 *
 *   layer 0  session agents      layer 1  sub-agents      layer 2  hosts
 *
 * 1. Layer assignment is given by node type. An agent→host edge skips layer 1,
 *    so it gets a dummy node there: the edge is routed through that point,
 *    between sub-agents instead of across them.
 * 2. Crossing minimisation: barycenter sweeps down and up the layers; the
 *    ordering with the fewest crossings is kept. Layer 0 keeps its given order
 *    so the map stays stable as agents come and go.
 * 3. Coordinate assignment: nodes are placed in order with a minimum gap, then
 *    relaxed toward the median of their neighbours while keeping order and gap,
 *    so a host ends up level with its only caller.
 *
 * All coordinates are fractions of the drawable height, so the same result can
 * be drawn at any size without re-arranging.
 */
export interface LNode { id: string; layer: 0 | 1 | 2; /** row height multiplier (labels above and below need more) */ w?: number }
export interface LEdge { from: string; to: string }
export interface LayoutResult {
  /** y as a fraction 0..1 of the drawable height, for real nodes */
  y: Map<string, number>;
  /** for edges that skipped layer 1: the waypoint's y fraction, keyed "from>to" */
  via: Map<string, number>;
}

interface Internal { id: string; layer: number; dummy: boolean; w: number }

/**
 * Gap rules, in rows: real↔real = mean of their heights; a routed edge (dummy) must stay
 * `LABEL_CLEAR` rows from a real node so it never runs across its labels; two routed edges
 * may run close together.
 */
const LABEL_CLEAR = 0.8;
const EDGE_GAP = 0.14;

export function sugiyama(nodes: LNode[], edges: LEdge[], rowMin: number): LayoutResult {
  const byId = new Map<string, Internal>();
  const layers: Internal[][] = [[], [], []];
  for (const n of nodes) { const it = { id: n.id, layer: n.layer, dummy: false, w: n.w ?? 1 }; byId.set(n.id, it); layers[n.layer].push(it); }

  // edges, with dummies for layer-skipping ones
  const adjDown = new Map<string, string[]>(); // from lower layer index to higher
  const adjUp = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    (adjDown.get(a) ?? adjDown.set(a, []).get(a)!).push(b);
    (adjUp.get(b) ?? adjUp.set(b, []).get(b)!).push(a);
  };
  const viaKey = new Map<string, string>();
  for (const e of edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b || a.layer >= b.layer) continue;
    if (b.layer - a.layer === 1) { link(a.id, b.id); continue; }
    const d: Internal = { id: `~${e.from}>${e.to}`, layer: 1, dummy: true, w: EDGE_GAP };
    byId.set(d.id, d); layers[1].push(d);
    link(a.id, d.id); link(d.id, b.id);
    viaKey.set(`${e.from}>${e.to}`, d.id);
  }

  // ---- crossing minimisation
  const pos = new Map<string, number>();
  const index = () => layers.forEach((L) => L.forEach((n, i) => pos.set(n.id, i)));
  index();
  const bary = (n: Internal, nbrs: Map<string, string[]>) => {
    const ns = nbrs.get(n.id) ?? [];
    return ns.length ? ns.reduce((s, m) => s + (pos.get(m) ?? 0), 0) / ns.length : pos.get(n.id) ?? 0;
  };
  const reorder = (li: number, nbrs: Map<string, string[]>) => {
    const L = layers[li];
    const keyed = L.map((n) => ({ n, b: bary(n, nbrs), i: pos.get(n.id) ?? 0 }));
    keyed.sort((x, y) => x.b - y.b || x.i - y.i);
    layers[li] = keyed.map((k) => k.n);
    index();
  };
  const crossings = (li: number) => {
    // count pairs of edges between layer li and li+1 that cross
    const es: [number, number][] = [];
    for (const n of layers[li]) for (const m of adjDown.get(n.id) ?? []) es.push([pos.get(n.id)!, pos.get(m)!]);
    let c = 0;
    for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) {
      const [a1, b1] = es[i], [a2, b2] = es[j];
      if ((a1 - a2) * (b1 - b2) < 0) c++;
    }
    return c;
  };
  let best = layers.map((L) => [...L]), bestC = crossings(0) + crossings(1);
  for (let it = 0; it < 12; it++) {
    reorder(1, adjUp); reorder(2, adjUp);   // down sweep
    reorder(1, adjDown);                     // up sweep (layer 0 stays fixed)
    const c = crossings(0) + crossings(1);
    if (c < bestC) { bestC = c; best = layers.map((L) => [...L]); }
    if (c === 0) break;
  }
  for (let i = 0; i < 3; i++) layers[i] = best[i];
  index();

  // ---- coordinate assignment (two tiers: real nodes first, routed edges in the gaps between them)
  const y = new Map<string, number>();
  const median = (vals: number[]) => { const v = [...vals].sort((p, q) => p - q); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : undefined; };
  const reals = layers.map((L) => L.filter((n) => !n.dummy));
  // dummies between two consecutive real nodes (from the final order) need room of their own
  const between = new Map<string, number>();
  layers.forEach((L) => { let prev: Internal | null = null, k = 0; for (const n of L) { if (n.dummy) k++; else { if (prev) between.set(prev.id + "|" + n.id, k); prev = n; k = 0; } } });
  const realGap = (a: Internal, b: Internal) => {
    const k = between.get(a.id + "|" + b.id) ?? 0;
    const forEdges = k ? (2 * LABEL_CLEAR + (k - 1) * EDGE_GAP) * rowMin : 0;
    return Math.max(((a.w + b.w) / 2) * rowMin, forEdges);
  };
  // if a layer's real nodes cannot fit at minimum spacing, that spacing shrinks uniformly (unavoidable)
  const fitScale = reals.map((R) => { const need = R.slice(1).reduce((s, n, i) => s + realGap(R[i], n), 0); return need > 1 ? 1 / need : 1; });
  const gapReal = (li: number) => (a: Internal, b: Internal) => realGap(a, b) * fitScale[li];

  reals.forEach((R, li) => {
    const gap = gapReal(li);
    let cur = 0;
    R.forEach((n, i) => { if (i) cur += gap(R[i - 1], n); y.set(n.id, cur); });
    const offset = cur < 1 ? (1 - cur) / 2 : 0;
    R.forEach((n) => y.set(n.id, y.get(n.id)! + offset));
  });
  const placeDummies = () => {
    layers.forEach((L) => {
      // walk the ordered layer; group dummies between consecutive real nodes
      let prevReal: Internal | null = null, run: Internal[] = [];
      const flush = (nextReal: Internal | null) => {
        if (!run.length) return;
        const clear = LABEL_CLEAR * rowMin, edge = EDGE_GAP * rowMin;
        if (prevReal && nextReal) {
          const lo = y.get(prevReal.id)!, hi = y.get(nextReal.id)!;
          const room = hi - lo;
          const needed = 2 * clear + (run.length - 1) * edge;
          const start = needed <= room ? lo + clear + (room - needed) / 2 : lo + room * (1 / (run.length + 1));
          const step = needed <= room ? edge : room / (run.length + 1);
          run.forEach((d, k) => y.set(d.id, start + k * step));
        } else if (prevReal) {
          run.forEach((d, k) => y.set(d.id, y.get(prevReal!.id)! + clear + k * edge));
        } else if (nextReal) {
          run.forEach((d, k) => y.set(d.id, y.get(nextReal.id)! - clear - (run.length - 1 - k) * edge));
        }
        run = [];
      };
      for (const n of L) { if (n.dummy) run.push(n); else { flush(n); prevReal = n; } }
      flush(null);
    });
  };
  placeDummies();

  /** Fit a layer into 0..1: remove slack above the minimum gaps first, never the minimums. */
  const compact = (R: Internal[], gap: (a: Internal, b: Internal) => number) => {
    if (!R.length) return;
    const lo = y.get(R[0].id)!, hi = y.get(R[R.length - 1].id)!;
    const extent = hi - lo;
    if (extent <= 1) {
      const shift = lo < 0 ? -lo : hi > 1 ? 1 - hi : 0;
      if (shift) R.forEach((n) => y.set(n.id, y.get(n.id)! + shift));
      return;
    }
    const gaps = R.slice(1).map((n, i) => y.get(n.id)! - y.get(R[i].id)!);
    const mins = R.slice(1).map((n, i) => gap(R[i], n));
    const slack = gaps.map((g, i) => Math.max(0, g - mins[i]));
    const slackTotal = slack.reduce((a, b) => a + b, 0);
    const excess = extent - 1;
    const take = slackTotal > 0 ? Math.min(1, excess / slackTotal) : 0;
    let cur = 0;
    R.forEach((n, i) => { if (i) cur += gaps[i - 1] - slack[i - 1] * take; y.set(n.id, cur); });
    if (cur > 1) { const sc = 1 / cur; R.forEach((n) => y.set(n.id, y.get(n.id)! * sc)); } // only when minimums themselves overflow
  };

  const neighbourY = (n: Internal) => [...(adjDown.get(n.id) ?? []), ...(adjUp.get(n.id) ?? [])].map((m) => y.get(m)!);
  for (let it = 0; it < 24; it++) {
    reals.forEach((R, li) => {
      const gap = gapReal(li);
      for (const n of R) {
        const t = median(neighbourY(n));
        if (t === undefined) continue;
        y.set(n.id, y.get(n.id)! + (t - y.get(n.id)!) * (li === 0 ? 0.25 : 0.5));
      }
      // keep order and minimum spacing among real nodes, and stay inside 0..1
      for (let i = 1; i < R.length; i++) y.set(R[i].id, Math.max(y.get(R[i].id)!, y.get(R[i - 1].id)! + gap(R[i - 1], R[i])));
      for (let i = R.length - 2; i >= 0; i--) y.set(R[i].id, Math.min(y.get(R[i].id)!, y.get(R[i + 1].id)! - gap(R[i], R[i + 1])));
      compact(R, gap);
    });
    placeDummies();
  }

  // use the whole height: stretch the finished picture over the real nodes (alignment is kept,
  // gaps only grow); waypoints outside the range are clamped to the edge
  const realYs = nodes.map((n) => y.get(n.id)!);
  const lo = Math.min(...realYs), hi = Math.max(...realYs);
  const stretch = (v: number) => Math.max(0, Math.min(1, hi - lo > 1e-6 ? (v - lo) / (hi - lo) : 0.5));
  const out: LayoutResult = { y: new Map(), via: new Map() };
  for (const n of nodes) out.y.set(n.id, stretch(y.get(n.id)!));
  for (const [k, d] of viaKey) out.via.set(k, stretch(y.get(d)!));
  return out;
}
