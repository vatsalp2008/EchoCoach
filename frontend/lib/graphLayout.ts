import { GraphData, GraphNode } from "@/lib/api";

// Deterministic layered ("org chart") layout for the weakness graph. No
// physics, no randomness between renders — a topological rank per node
// (longest path from a root), computed independently per domain so technical
// and behavioral never share an axis (there's no cross-domain edge in the
// data, so mixing them would visually imply a relationship that isn't there).

export interface LayoutNode extends GraphNode {
  x: number;
  y: number;
  rank: number; // -1 for unranked/unlinked nodes
}

export interface LayoutEdge {
  source: LayoutNode;
  target: LayoutNode;
  // SVG path. Routed so it never runs behind a chip it doesn't connect: in a
  // layered graph that reads as an edge into (or out of) that chip.
  d: string;
}

export interface DomainLayout {
  domain: "technical" | "behavioral";
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  unranked: LayoutNode[];
  width: number;
  height: number;
}

const RANK_GAP = 150; // vertical space between ranks (rows)
const NODE_GAP = 40; // horizontal space between chips in the same rank
const WRAP_GAP = 24; // vertical space between the two rows of a wrapped rank
const CHIP_W = 160;
const CHIP_H = 52;
const STACKED_RANK_GAP = CHIP_H + 44; // rank-to-rank step in the one-column layout
const TOP_PAD = 30;
const SIDE_PAD = 20;
const CLEARANCE = 8; // closest an edge may pass to a chip it doesn't connect
const LANE_GAP = 6; // spacing between edges crossing a rank through the same gap

/** Longest-path-from-root rank per node id, within one domain's subgraph.
 * Nodes with no edges at all (in OR out) are omitted — callers put them in
 * an "unranked" bucket instead of misrepresenting them as roots. */
function computeRanks(
  nodeIds: string[],
  edges: { source: string; target: string }[]
): Map<string, number> {
  const idSet = new Set(nodeIds);
  const domainEdges = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const id of nodeIds) inDegree.set(id, 0);
  for (const e of domainEdges) {
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    if (!children.has(e.source)) children.set(e.source, []);
    children.get(e.source)!.push(e.target);
  }

  const connected = new Set<string>();
  for (const e of domainEdges) {
    connected.add(e.source);
    connected.add(e.target);
  }

  const rank = new Map<string, number>();
  let queue = nodeIds.filter((id) => connected.has(id) && inDegree.get(id) === 0);
  for (const id of queue) rank.set(id, 0);

  // BFS relaxation, bounded by node count so malformed/cyclic data can't loop forever.
  let guard = nodeIds.length + domainEdges.length + 1;
  while (queue.length && guard-- > 0) {
    const next: string[] = [];
    for (const id of queue) {
      const r = rank.get(id)!;
      for (const child of children.get(id) ?? []) {
        if ((rank.get(child) ?? -1) < r + 1) {
          rank.set(child, r + 1);
          next.push(child);
        }
      }
    }
    queue = next;
  }
  return rank;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const rowW = (count: number) => count * CHIP_W + Math.max(0, count - 1) * NODE_GAP;

/** Vertical-tangent curve, top to bottom: the classic org-chart connector. */
const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const midY = (y1 + y2) / 2;
  return `C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
};

interface Band {
  rank: number;
  top: number;
  bottom: number;
  chipXs: number[]; // left edge of every chip in the rank, across its rows
}

function layoutDomain(
  domain: "technical" | "behavioral",
  allNodes: GraphNode[],
  allEdges: { source: string; target: string }[],
  maxWidth?: number
): DomainLayout {
  const domainNodes = allNodes.filter((n) => n.domain === domain);
  const nodeIds = domainNodes.map((n) => n.id);
  const rankOf = computeRanks(nodeIds, allEdges);
  const byId = new Map(domainNodes.map((n) => [n.id, n]));

  const ranked: LayoutNode[] = [];
  const unranked: LayoutNode[] = [];
  const rankRows = new Map<number, string[]>();
  for (const n of domainNodes) {
    const r = rankOf.get(n.id);
    if (r === undefined) continue; // handled below as unranked
    if (!rankRows.has(r)) rankRows.set(r, []);
    rankRows.get(r)!.push(n.id);
  }
  // Stable, deterministic order within a rank: alphabetical by id.
  for (const ids of rankRows.values()) ids.sort();
  const unrankedIds = nodeIds.filter((id) => !rankOf.has(id)).sort();

  // Chips per row: unlimited (one row per rank) unless that's wider than the
  // space available. Then a rank may wrap onto a second row inside its band —
  // but no further, and the second row must be partial, or edges couldn't get
  // through it without passing behind chips. If that doesn't fit, the domain
  // becomes one column ("stacked", a phone) with edges drawn as arcs beside it.
  const rankSizes = [...rankRows.values()].map((ids) => ids.length);
  const maxRow = Math.max(0, ...rankSizes);
  const widest = Math.max(maxRow, unrankedIds.length);
  const fits = Math.max(1, Math.floor(((maxWidth ?? 0) - SIDE_PAD * 2 + NODE_GAP) / (CHIP_W + NODE_GAP)));
  const constrained = !!maxWidth && rowW(widest) + SIDE_PAD * 2 > maxWidth;
  const canWrap = fits >= 2 && rankSizes.every((n) => n < 2 * fits);
  const perRow = !constrained ? Math.max(1, widest) : canWrap ? fits : 1;
  const stacked = constrained && perRow === 1;
  const rankGap = stacked ? STACKED_RANK_GAP : RANK_GAP;
  const padX = stacked ? 0 : SIDE_PAD; // one column: chips flush left, arcs get the room
  const rankedWidth = rowW(Math.min(maxRow, perRow));
  const unrankedWidth = rowW(Math.min(unrankedIds.length, perRow));
  const outerWidth = Math.max(rankedWidth, unrankedWidth);

  const bands: Band[] = [];
  let y = TOP_PAD;
  for (const [r, ids] of [...rankRows.entries()].sort((a, b) => a[0] - b[0])) {
    const band: Band = { rank: r, top: y, bottom: y, chipXs: [] };
    const rows = chunk(ids, perRow);
    rows.forEach((row, wrap) => {
      let startX = padX + (rankedWidth - rowW(row.length)) / 2; // center each row
      if (wrap > 0 && !stacked) {
        // A wrapped second row sits half a column over from the first (off
        // center by half a column if it must), so edges leaving the first row
        // drop straight down between its chips, and edges into it come down
        // between the chips above.
        const halfCols = rows[0].length - row.length;
        startX =
          padX +
          (rankedWidth - rowW(rows[0].length)) / 2 +
          ((halfCols % 2 ? halfCols : halfCols - 1) * (CHIP_W + NODE_GAP)) / 2;
      }
      const rowY = y + wrap * (CHIP_H + WRAP_GAP);
      row.forEach((id, i) => {
        const x = startX + i * (CHIP_W + NODE_GAP);
        ranked.push({ ...byId.get(id)!, rank: r, x, y: rowY });
        band.chipXs.push(x);
      });
      band.bottom = rowY + CHIP_H;
    });
    bands.push(band);
    y = band.bottom - CHIP_H + rankGap;
  }

  // Unlinked nodes (e.g. project_depth): their own row(s) below the ranked
  // ones, clearly separated rather than implied to be a root prerequisite.
  const unrankedRowY = y;
  chunk(unrankedIds, perRow).forEach((row, wrap) => {
    const startX = padX + (outerWidth - rowW(row.length)) / 2;
    row.forEach((id, i) => {
      unranked.push({
        ...byId.get(id)!,
        rank: -1,
        x: startX + i * (CHIP_W + NODE_GAP),
        y: unrankedRowY + wrap * (CHIP_H + WRAP_GAP),
      });
    });
  });

  const allPositioned = [...ranked, ...unranked];

  // Natural width keeps its extra CHIP_W of slack; with a maxWidth it's clamped
  // to the space available, but never below what the (wrapped) rows need.
  const natural = outerWidth + padX * 2 + CHIP_W;
  const width = maxWidth
    ? Math.max(outerWidth + padX * 2, Math.min(natural, maxWidth))
    : natural;
  const height = Math.max(TOP_PAD, ...allPositioned.map((n) => n.y + CHIP_H)) + TOP_PAD;

  // Where an edge crosses a rank it doesn't stop at: as close as possible to
  // the straight line it would take, but through a gap between that rank's
  // chips. Edges sharing a gap are fanned out a few px so they stay distinct.
  const lanes = new Map<string, number>();
  const crossAt = (band: Band, ideal: number, toward: number) => {
    const isFree = (x: number) =>
      x >= 0 &&
      x <= width &&
      band.chipXs.every((cx) => x <= cx - CLEARANCE || x >= cx + CHIP_W + CLEARANCE);
    const free = [ideal, ...band.chipXs.flatMap((cx) => [cx - NODE_GAP / 2, cx + CHIP_W + NODE_GAP / 2])]
      .filter(isFree)
      .sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal) || Math.abs(a - toward) - Math.abs(b - toward));
    const x = free[0] ?? ideal; // never empty: the space beside a rank's ends is free
    const key = `${band.rank}:${Math.round(x)}`;
    const n = lanes.get(key) ?? 0;
    lanes.set(key, n + 1);
    const fanned = x + (n % 2 ? -1 : 1) * Math.ceil(n / 2) * LANE_GAP;
    return isFree(fanned) ? fanned : x; // a crowded gap: share its line rather than graze a chip
  };

  const route = (s: LayoutNode, t: LayoutNode): string => {
    if (stacked) {
      // One column: arc out to the right, leaving the source's lower half and
      // landing on the target's upper half. Longer spans bulge further, so
      // nested arcs stay apart instead of merging into one line.
      const x1 = s.x + CHIP_W;
      const y1 = s.y + CHIP_H * 0.65;
      const x2 = t.x + CHIP_W;
      const y2 = t.y + CHIP_H * 0.35;
      const bulge = Math.max(12, Math.min(width - Math.max(x1, x2) - 8, 18 + Math.abs(y2 - y1) * 0.2));
      return `M ${x1} ${y1} C ${x1 + bulge} ${y1}, ${x2 + bulge} ${y2}, ${x2} ${y2}`;
    }
    const sx = s.x + CHIP_W / 2;
    const tx = t.x + CHIP_W / 2;
    const from = bands.find((b) => b.rank === s.rank);
    const to = bands.find((b) => b.rank === t.rank);
    if (!from || !to || t.rank <= s.rank) {
      return `M ${sx} ${s.y + CHIP_H} ${curve(sx, s.y + CHIP_H, tx, t.y)}`; // malformed (cyclic) data
    }
    // Straight vertical runs, top to bottom, as [x, top, bottom]: out past the
    // rest of the source's rank, through each rank in between, then down into
    // the target's rank to the target. Joined by curves in the gaps between ranks.
    const runs: [number, number, number][] = [[sx, s.y + CHIP_H, from.bottom]];
    for (const band of bands) {
      if (band.rank <= s.rank || band.rank >= t.rank) continue;
      const f = ((band.top + band.bottom) / 2 - from.bottom) / (to.top - from.bottom);
      runs.push([crossAt(band, sx + (tx - sx) * f, tx), band.top, band.bottom]);
    }
    runs.push([tx, to.top, t.y]);
    let d = `M ${sx} ${s.y + CHIP_H}`;
    runs.forEach(([x, top, bottom], i) => {
      if (i > 0) d += ` ${curve(runs[i - 1][0], runs[i - 1][2], x, top)}`;
      if (bottom > top) d += ` L ${x} ${bottom}`;
    });
    return d;
  };

  const nodeById = new Map(allPositioned.map((n) => [n.id, n]));
  const edges: LayoutEdge[] = allEdges
    .filter((e) => nodeById.has(e.source) && nodeById.has(e.target))
    .map((e) => {
      const source = nodeById.get(e.source)!;
      const target = nodeById.get(e.target)!;
      return { source, target, d: route(source, target) };
    });

  return { domain, nodes: allPositioned, edges, unranked, width, height };
}

/** maxWidth: the space available (px). Omit it for the natural one-row-per-rank
 * layout; pass it and the layout wraps or stacks to fit. */
export function computeLayout(data: GraphData, maxWidth?: number): {
  technical: DomainLayout;
  behavioral: DomainLayout;
} {
  return {
    technical: layoutDomain("technical", data.nodes, data.edges, maxWidth),
    behavioral: layoutDomain("behavioral", data.nodes, data.edges, maxWidth),
  };
}

export const LAYOUT_CONSTANTS = { RANK_GAP, NODE_GAP, CHIP_W, CHIP_H, TOP_PAD, SIDE_PAD };
