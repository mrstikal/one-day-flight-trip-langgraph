"use client";

import { useMemo } from "react";
import type { GraphDefinition, PublicInspectorNode } from "@odft/contracts";

/**
 * Phase 11 execution graph (08-frontend-ux.md section 10).
 *
 * Renders the ACTUAL node/edge topology the worker persisted via
 * `graph.initialized`, colored by the real node-event status. It is decorative:
 * the node table below carries the same facts as text, and the SVG is marked
 * `aria-hidden`.
 */

const COLUMN_WIDTH = 190;
const ROW_HEIGHT = 44;
const NODE_WIDTH = 150;
const NODE_HEIGHT = 30;

interface Positioned {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly status: PublicInspectorNode["status"];
}

interface Layout {
  readonly nodes: Positioned[];
  readonly edges: readonly { from: Positioned; to: Positioned; label: string | null }[];
  readonly width: number;
  readonly height: number;
}

/** Deterministic layered layout: BFS depth from the entry; rows per column. */
export function layoutGraph(
  definition: GraphDefinition,
  statusByName: ReadonlyMap<string, PublicInspectorNode["status"]>,
): Layout {
  const outgoing = new Map<string, string[]>();
  for (const edge of definition.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const depth = new Map<string, number>();
  const queue: string[] = ["__start__"];
  depth.set("__start__", 0);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of outgoing.get(current) ?? []) {
      if (next === "__end__" || depth.has(next)) {
        continue;
      }
      depth.set(next, (depth.get(current) ?? 0) + 1);
      queue.push(next);
    }
  }
  const columns = new Map<number, string[]>();
  for (const node of definition.nodes) {
    const column = depth.get(node.id) ?? 0;
    columns.set(column, [...(columns.get(column) ?? []), node.id]);
  }
  const positioned = new Map<string, Positioned>();
  let maxRows = 0;
  for (const [column, ids] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    ids.sort((a, b) => a.localeCompare(b));
    maxRows = Math.max(maxRows, ids.length);
    ids.forEach((id, rowIndex) => {
      const label = definition.nodes.find((node) => node.id === id)?.label ?? id;
      positioned.set(id, {
        id,
        label,
        x: 20 + column * COLUMN_WIDTH,
        y: 20 + rowIndex * ROW_HEIGHT,
        status: statusByName.get(id) ?? "pending",
      });
    });
  }
  const edges: { from: Positioned; to: Positioned; label: string | null }[] = [];
  for (const edge of definition.edges) {
    const from = positioned.get(edge.from);
    const to = positioned.get(edge.to);
    if (from && to) {
      edges.push({ from, to, label: edge.label });
    }
  }
  return {
    nodes: [...positioned.values()],
    edges,
    width: 40 + Math.max(1, columns.size) * COLUMN_WIDTH,
    height: 40 + Math.max(1, maxRows) * ROW_HEIGHT,
  };
}

const STATUS_FILL: Readonly<Record<PublicInspectorNode["status"], string>> = {
  pending: "#f5f0e6",
  active: "#fde68a",
  completed: "#ccfbf1",
  interrupted: "#fca5a5",
  failed: "#fecaca",
};

const STATUS_STROKE: Readonly<Record<PublicInspectorNode["status"], string>> = {
  pending: "#c9c2b4",
  active: "#b45309",
  completed: "#0f766e",
  interrupted: "#b91c1c",
  failed: "#b91c1c",
};

export function ExecutionGraph({
  definition,
  nodes,
}: {
  readonly definition: GraphDefinition;
  readonly nodes: readonly PublicInspectorNode[];
}): React.JSX.Element {
  const statusByName = useMemo(
    () => new Map(nodes.map((node) => [node.name, node.status])),
    [nodes],
  );
  const layout = useMemo(() => layoutGraph(definition, statusByName), [definition, statusByName]);
  return (
    <div className="overflow-x-auto rounded border border-border bg-cream p-2">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        role="img"
        aria-label={`Execution graph with ${layout.nodes.length} nodes`}
        data-testid="execution-graph"
      >
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="#8a8172" />
          </marker>
        </defs>
        {layout.edges.map((edge, index) => {
          const x1 = edge.from.x + NODE_WIDTH;
          const y1 = edge.from.y + NODE_HEIGHT / 2;
          const x2 = edge.to.x;
          const y2 = edge.to.y + NODE_HEIGHT / 2;
          const midX = (x1 + x2) / 2;
          return (
            <path
              key={`${edge.from.id}->${edge.to.id}-${index}`}
              d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke="#8a8172"
              strokeWidth="1"
              markerEnd="url(#arrow)"
            />
          );
        })}
        {layout.nodes.map((node) => (
          <g key={node.id}>
            <rect
              x={node.x}
              y={node.y}
              width={NODE_WIDTH}
              height={NODE_HEIGHT}
              rx={4}
              fill={STATUS_FILL[node.status]}
              stroke={STATUS_STROKE[node.status]}
              strokeWidth="1.5"
            />
            <text x={node.x + 8} y={node.y + 19} fontSize="11" fill="#1f2937">
              {node.label.length > 24 ? `${node.label.slice(0, 23)}…` : node.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
