"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { getGraph, GraphData, GraphNode } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import { computeLayout, DomainLayout, LAYOUT_CONSTANTS, LayoutNode } from "@/lib/graphLayout";

const SIGNAL_COLOR: Record<string, string> = {
  mastered: "#16a34a", // green
  partial: "#d97706", // amber
  struggled: "#dc2626", // red
  avoided: "#7f1d1d", // dark red
  unassessed: "#cbd5e1", // gray
};
const ARCHIVED_COLOR = "#0ea5e9"; // sky - mastered & archived via forget()

function colorFor(n: GraphNode): string {
  if (n.archived) return ARCHIVED_COLOR;
  return SIGNAL_COLOR[n.signal] ?? SIGNAL_COLOR.unassessed;
}

const LEGEND: { label: string; color: string }[] = [
  { label: "struggled", color: SIGNAL_COLOR.struggled },
  { label: "avoided", color: SIGNAL_COLOR.avoided },
  { label: "partial", color: SIGNAL_COLOR.partial },
  { label: "mastered", color: SIGNAL_COLOR.mastered },
  { label: "mastered (archived)", color: ARCHIVED_COLOR },
  { label: "not yet assessed", color: SIGNAL_COLOR.unassessed },
];

const { CHIP_W, CHIP_H } = LAYOUT_CONSTANTS;

function tooltipFor(n: GraphNode): string {
  return (
    `${n.label} - ${n.archived ? "mastered (archived)" : n.signal}` +
    (n.interactions ? ` · ${n.interactions} answer(s)` : "")
  );
}

/** One domain's deterministic layered layout: an SVG edge overlay plus
 * absolutely-positioned chip divs. No physics, no randomness between renders. */
function DomainSection({ title, layout }: { title: string; layout: DomainLayout }) {
  if (layout.nodes.length === 0) return null;
  const hasUnranked = layout.unranked.length > 0;
  const unrankedY = hasUnranked ? layout.unranked[0].y : null;

  return (
    <div className="mb-8 last:mb-0">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">
          {title}
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <div
        className="relative"
        style={{ width: layout.width, height: layout.height, minWidth: "100%" }}
      >
        <svg
          className="absolute inset-0"
          width={layout.width}
          height={layout.height}
          style={{ overflow: "visible" }}
        >
          <defs>
            <marker
              id={`arrow-${title}`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: "var(--muted)" }} />
            </marker>
          </defs>
          {layout.edges.map((e, i) => {
            const x1 = e.source.x + CHIP_W / 2;
            const y1 = e.source.y + CHIP_H;
            const x2 = e.target.x + CHIP_W / 2;
            const y2 = e.target.y;
            const midY = (y1 + y2) / 2;
            return (
              <path
                key={i}
                d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                fill="none"
                style={{ stroke: "var(--muted)", strokeOpacity: 0.5 }}
                strokeWidth={1.5}
                markerEnd={`url(#arrow-${title})`}
              />
            );
          })}
        </svg>
        {hasUnranked && (
          <span
            className="absolute text-[10px] uppercase tracking-wide text-muted"
            style={{ left: 0, top: (unrankedY ?? 0) - 18 }}
          >
            Not yet linked
          </span>
        )}
        {layout.nodes.map((n: LayoutNode) => (
          <motion.div
            key={n.id}
            title={tooltipFor(n)}
            whileHover={{ scale: 1.05 }}
            transition={{ duration: 0.15 }}
            className="absolute flex items-center gap-1.5 rounded-lg border-2 bg-surface-2 px-2.5 shadow-sm"
            style={{
              left: n.x,
              top: n.y,
              width: CHIP_W,
              height: CHIP_H,
              borderColor: colorFor(n),
            }}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: colorFor(n) }}
            />
            <span className="truncate text-xs font-medium text-foreground">{n.label}</span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

export default function WeaknessGraph() {
  const { user, loading } = useAuth();
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;
    getGraph(user.id).then(setData).catch((e) => setError(String(e)));
  }, [user]);

  const layout = data ? computeLayout(data) : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="space-y-3"
    >
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {LEGEND.map((l) => (
          <span key={l.label} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-3 rounded-full"
              style={{ backgroundColor: l.color }}
            />
            {l.label}
          </span>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="min-h-[420px] w-full overflow-auto rounded-xl border border-border bg-surface p-5">
        {!loading && !user ? (
          <div className="grid h-full min-h-[380px] place-items-center px-6 text-center text-sm text-muted">
            Log in to see your weakness graph.
          </div>
        ) : layout && data && data.nodes.length > 0 ? (
          <>
            <DomainSection title="Technical" layout={layout.technical} />
            <DomainSection title="Behavioral" layout={layout.behavioral} />
          </>
        ) : (
          <div className="grid h-full min-h-[380px] place-items-center text-sm text-muted">
            {data ? "No topics yet - run a session first." : "Loading graph…"}
          </div>
        )}
      </div>
    </motion.div>
  );
}
