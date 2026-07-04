"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { getGraph, GraphData, GraphNode } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";

// react-force-graph-2d touches window/canvas - load client-only.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
});

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

export default function WeaknessGraph() {
  const { user, loading } = useAuth();
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;
    getGraph(user.id).then(setData).catch((e) => setError(String(e)));
  }, [user]);

  useEffect(() => {
    if (!wrapRef.current) return;
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: Math.max(420, el.clientHeight) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const graphData = data
    ? {
        nodes: data.nodes.map((n) => ({ ...n })),
        links: data.edges.map((e) => ({ ...e })),
      }
    : { nodes: [], links: [] };

  const labelColor = dark ? "#cbd5e1" : "#334155";
  const linkColor = dark ? "#1e293b" : "#e2e8f0";
  const bgColor = dark ? "#0f172a" : "#ffffff";

  return (
    <div className="space-y-3">
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

      <div
        ref={wrapRef}
        className="h-[560px] w-full overflow-hidden rounded-xl border border-border bg-surface"
      >
        {!loading && !user ? (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-muted">
            Log in to see your weakness graph.
          </div>
        ) : data && data.nodes.length > 0 ? (
          <ForceGraph2D
            width={size.w}
            height={size.h}
            graphData={graphData}
            backgroundColor={bgColor}
            linkColor={() => linkColor}
            linkWidth={1.5}
            nodeRelSize={5}
            nodeVal={(n: any) => 4 + (n.interactions ?? 0)}
            nodeLabel={(n: any) =>
              `${n.label} - ${n.archived ? "mastered (archived)" : n.signal}` +
              (n.interactions ? ` · ${n.interactions} answer(s)` : "")
            }
            nodeCanvasObject={(n: any, ctx, scale) => {
              const r = (4 + (n.interactions ?? 0)) ** 0.5 * 3;
              ctx.beginPath();
              ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
              ctx.fillStyle = colorFor(n);
              ctx.fill();
              const fs = Math.max(10 / scale, 3);
              ctx.font = `${fs}px sans-serif`;
              ctx.fillStyle = labelColor;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              ctx.fillText(n.label, n.x, n.y + r + 1);
            }}
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted">
            {data ? "No topics yet - run a session first." : "Loading graph…"}
          </div>
        )}
      </div>
    </div>
  );
}
