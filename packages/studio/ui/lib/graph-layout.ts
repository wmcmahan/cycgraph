/**
 * Graph layout, pure geometry: longest-path ranks from the start node with
 * back-edges set aside, composition references (a map's worker, a
 * supervisor's team) as dotted implicit edges, unreachable nodes parked in
 * the final rank. The React graph view renders one of these.
 */

export const NODE_W = 148;
export const NODE_H = 40;
const COL_GAP = 70;
const ROW_GAP = 26;

export const GLYPH: Record<string, string> = {
  agent: '◉', supervisor: '♛', tool: '⚙', router: '⇶', approval: '⏸',
  subgraph: '▣', map: '⫛', verifier: '✓', synthesizer: '∑', reflection: '☲',
  evolution: '⚘', voting: '☰', swarm: '∴', a2a: '⇄', annealing: '△',
};

export interface WireNode {
  id: string;
  type: string;
  childId?: string;
  worker?: string;
  managed?: string[];
}

export interface WireEdge {
  source: string;
  target: string;
  label?: string;
}

export interface WireGraph {
  id: string;
  name?: string;
  startNode?: string;
  endNodes?: string[];
  nodes: WireNode[];
  edges: WireEdge[];
}

export interface PlacedNode extends WireNode {
  x: number;
  y: number;
}

export interface GraphLayout {
  nodes: PlacedNode[];
  forward: WireEdge[];
  back: WireEdge[];
  implicit: Array<WireEdge & { label: string }>;
  width: number;
  height: number;
}

export function layout(graph: WireGraph): GraphLayout {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const forward: WireEdge[] = [];
  const back: WireEdge[] = [];

  // Longest-path ranks by DFS from the start; an edge into a node already
  // on the current stack is a cycle's return and ranks nothing.
  const rank = new Map<string, number>();
  const stack = new Set<string>();
  const visit = (id: string, depth: number): void => {
    if (!byId.has(id) || stack.has(id)) return;
    if ((rank.get(id) ?? -1) >= depth) return;
    rank.set(id, depth);
    stack.add(id);
    for (const edge of graph.edges) {
      if (edge.source !== id) continue;
      if (stack.has(edge.target)) continue;
      visit(edge.target, depth + 1);
    }
    stack.delete(id);
  };
  if (graph.startNode) visit(graph.startNode, 0);

  for (const edge of graph.edges) {
    const isBack = (rank.get(edge.target) ?? Infinity) <= (rank.get(edge.source) ?? -1);
    (isBack ? back : forward).push(edge);
  }

  // Composition references the edge list cannot show.
  const implicit: GraphLayout['implicit'] = [];
  for (const node of graph.nodes) {
    if (node.worker && byId.has(node.worker)) {
      implicit.push({ source: node.id, target: node.worker, label: 'fans out' });
    }
    for (const managed of node.managed ?? []) {
      if (byId.has(managed)) implicit.push({ source: node.id, target: managed, label: 'routes' });
    }
  }

  // Anything unranked (a map worker, a rejection handler) parks one rank
  // past what it hangs off, or the end.
  const maxRank = Math.max(0, ...rank.values());
  for (const node of graph.nodes) {
    if (rank.has(node.id)) continue;
    const anchor = implicit.find((e) => e.target === node.id);
    rank.set(node.id, anchor ? (rank.get(anchor.source) ?? maxRank) + 1 : maxRank + 1);
  }

  const columns = new Map<number, WireNode[]>();
  for (const node of graph.nodes) {
    const r = rank.get(node.id)!;
    const column = columns.get(r) ?? [];
    column.push(node);
    columns.set(r, column);
  }

  const placed = new Map<string, PlacedNode>();
  const tallest = Math.max(...[...columns.values()].map((c) => c.length));
  for (const [r, column] of columns) {
    column.forEach((node, i) => {
      const offset = ((tallest - column.length) / 2) * (NODE_H + ROW_GAP);
      placed.set(node.id, {
        ...node,
        x: r * (NODE_W + COL_GAP),
        y: offset + i * (NODE_H + ROW_GAP),
      });
    });
  }

  return {
    nodes: [...placed.values()],
    forward,
    back,
    implicit,
    width: (Math.max(...[...columns.keys()]) + 1) * (NODE_W + COL_GAP) - COL_GAP,
    height: tallest * (NODE_H + ROW_GAP) - ROW_GAP,
  };
}

/** The bezier between two placed nodes; `bend > 0` arches a cycle's return. */
export function edgePath(a: PlacedNode, b: PlacedNode, bend = 0): string {
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  if (bend) {
    const top = Math.min(a.y, b.y) - 24 - bend * 10;
    return `M ${a.x + NODE_W / 2} ${a.y} C ${a.x + NODE_W / 2} ${top}, ${b.x + NODE_W / 2} ${top}, ${b.x + NODE_W / 2} ${b.y}`;
  }
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}
