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
const CHIP_W = 160;
const CHIP_H = 52;
const TOP_PAD = 30;
const SIDE_PAD = 20;

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

function layoutDomain(
  domain: "technical" | "behavioral",
  allNodes: GraphNode[],
  allEdges: { source: string; target: string }[]
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

  const maxRow = Math.max(0, ...[...rankRows.values()].map((ids) => ids.length));
  const rowWidth = maxRow * CHIP_W + Math.max(0, maxRow - 1) * NODE_GAP;

  for (const [r, ids] of [...rankRows.entries()].sort((a, b) => a[0] - b[0])) {
    const rowW = ids.length * CHIP_W + Math.max(0, ids.length - 1) * NODE_GAP;
    const startX = SIDE_PAD + (rowWidth - rowW) / 2; // center each row
    ids.forEach((id, i) => {
      const n = byId.get(id)!;
      ranked.push({
        ...n,
        rank: r,
        x: startX + i * (CHIP_W + NODE_GAP),
        y: TOP_PAD + r * RANK_GAP,
      });
    });
  }

  // Unlinked nodes (e.g. project_depth): their own row below the ranked ones,
  // clearly separated rather than implied to be a root prerequisite.
  const unrankedIds = nodeIds.filter((id) => !rankOf.has(id)).sort();
  const unrankedRowY = TOP_PAD + (rankRows.size ? rankRows.size * RANK_GAP : 0);
  const unrankedRowW =
    unrankedIds.length * CHIP_W + Math.max(0, unrankedIds.length - 1) * NODE_GAP;
  const unrankedStartX = SIDE_PAD + (Math.max(rowWidth, unrankedRowW) - unrankedRowW) / 2;
  unrankedIds.forEach((id, i) => {
    const n = byId.get(id)!;
    unranked.push({
      ...n,
      rank: -1,
      x: unrankedStartX + i * (CHIP_W + NODE_GAP),
      y: unrankedRowY,
    });
  });

  const allPositioned = [...ranked, ...unranked];
  const nodeById = new Map(allPositioned.map((n) => [n.id, n]));
  const edges: LayoutEdge[] = allEdges
    .filter((e) => nodeById.has(e.source) && nodeById.has(e.target))
    .map((e) => ({ source: nodeById.get(e.source)!, target: nodeById.get(e.target)! }));

  const width = Math.max(rowWidth, unrankedRowW) + SIDE_PAD * 2 + CHIP_W;
  const height = unrankedRowY + (unranked.length ? RANK_GAP : CHIP_H + TOP_PAD);

  return { domain, nodes: allPositioned, edges, unranked, width, height };
}

export function computeLayout(data: GraphData): {
  technical: DomainLayout;
  behavioral: DomainLayout;
} {
  return {
    technical: layoutDomain("technical", data.nodes, data.edges),
    behavioral: layoutDomain("behavioral", data.nodes, data.edges),
  };
}

export const LAYOUT_CONSTANTS = { RANK_GAP, NODE_GAP, CHIP_W, CHIP_H, TOP_PAD, SIDE_PAD };
