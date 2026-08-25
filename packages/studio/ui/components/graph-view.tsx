'use client';

/**
 * The wire topology as a layered SVG, lit up live: the executing node
 * pulses, completed nodes tint, failures go red — driven by the run stream
 * through the `marks` prop. Subgraph nodes expand their child topology
 * inline on click.
 */

import { useMemo, useState } from 'react';
import {
  edgePath,
  layout,
  GLYPH,
  NODE_H,
  NODE_W,
  type WireGraph,
} from '../lib/graph-layout';
import { cn } from '../lib/utils';

export type NodeMark = 'executing' | 'visited' | 'failed';

function Svg({
  graph,
  marks,
  onExpand,
}: {
  graph: WireGraph;
  marks?: ReadonlyMap<string, NodeMark>;
  onExpand?: (nodeId: string, childId: string) => void;
}) {
  const l = useMemo(() => layout(graph), [graph]);
  const byId = useMemo(() => new Map(l.nodes.map((n) => [n.id, n])), [l]);
  const pad = 16;
  const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  return (
    <svg
      viewBox={`${-pad} ${-pad - 30} ${l.width + pad * 2} ${l.height + pad * 2 + 30}`}
      className="w-full"
      style={{ maxWidth: l.width + pad * 2 }}
    >
      <defs>
        <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" className="fill-dim" />
        </marker>
      </defs>
      {l.forward.map((edge, i) => {
        const a = byId.get(edge.source);
        const b = byId.get(edge.target);
        if (!a || !b) return null;
        return (
          <g key={`f${i}`}>
            <path
              d={edgePath(a, b)}
              markerEnd="url(#arr)"
              className={cn('fill-none stroke-dim/60', edge.label && 'stroke-dasharray-2 [stroke-dasharray:4_3]')}
            />
            {edge.label && (
              <text x={(a.x + NODE_W + b.x) / 2} y={(a.y + b.y + NODE_H) / 2 - 6}
                textAnchor="middle" className="fill-dim text-[9px]">
                {trim(edge.label, 34)}
              </text>
            )}
          </g>
        );
      })}
      {l.back.map((edge, i) => {
        const a = byId.get(edge.source);
        const b = byId.get(edge.target);
        if (!a || !b) return null;
        return (
          <path key={`b${i}`} d={edgePath(a, b, i + 1)} markerEnd="url(#arr)"
            className="fill-none stroke-warn/70 [stroke-dasharray:4_3]" />
        );
      })}
      {l.implicit.map((edge, i) => {
        const a = byId.get(edge.source);
        const b = byId.get(edge.target);
        if (!a || !b) return null;
        return (
          <g key={`i${i}`}>
            <path d={edgePath(a, b)} markerEnd="url(#arr)" className="fill-none stroke-dim/40 [stroke-dasharray:2_3]" />
            <text x={(a.x + NODE_W + b.x) / 2} y={(a.y + b.y + NODE_H) / 2 - 6}
              textAnchor="middle" className="fill-dim/70 text-[9px]">{edge.label}</text>
          </g>
        );
      })}
      {l.nodes.map((n) => {
        const mark = marks?.get(n.id);
        return (
          <g
            key={n.id}
            transform={`translate(${n.x},${n.y})`}
            className={cn(n.childId && 'cursor-pointer', mark === 'executing' && 'node-executing')}
            onClick={n.childId && onExpand ? () => onExpand(n.id, n.childId!) : undefined}
          >
            <rect
              width={NODE_W}
              height={NODE_H}
              rx={6}
              className={cn(
                'fill-panel stroke-border',
                graph.startNode === n.id && 'stroke-accent',
                graph.endNodes?.includes(n.id) && 'stroke-ok/70',
                mark === 'executing' && 'stroke-accent fill-accent/10',
                mark === 'visited' && 'stroke-ok fill-ok-bg',
                mark === 'failed' && 'stroke-bad fill-bad-bg',
              )}
            />
            <text x={10} y={17} className="fill-text text-[11px]">
              {GLYPH[n.type] ?? '·'} {trim(n.id, 15)}
            </text>
            <text x={10} y={31} className="fill-dim text-[9px]">
              {n.type}{n.childId ? ' ▾' : ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function GraphView({
  graph,
  children,
  marks,
}: {
  graph: WireGraph;
  children?: Record<string, WireGraph>;
  marks?: ReadonlyMap<string, NodeMark>;
}) {
  const [openChild, setOpenChild] = useState<{ node: string; child: string } | undefined>();
  const child = openChild ? children?.[openChild.child] : undefined;

  return (
    <div>
      <div className="overflow-x-auto rounded-md bg-muted/40 p-3">
        <Svg
          graph={graph}
          marks={marks}
          onExpand={(node, childId) =>
            setOpenChild((current) => (current?.child === childId ? undefined : { node, child: childId }))}
        />
      </div>
      {child && (
        <div className="mt-2 overflow-x-auto rounded-md bg-muted/40 p-3">
          <p className="mb-2 text-[11px] text-muted-foreground">inside {openChild!.node}:</p>
          <Svg graph={child} marks={marks} />
        </div>
      )}
    </div>
  );
}
