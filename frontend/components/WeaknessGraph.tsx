"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { getGraph, GraphData, GraphNode } from "@/lib/api";

// react-force-graph-2d touches window/canvas — load client-only.
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
const ARCHIVED_COLOR = "#0ea5e9"; // sky — mastered & archived via forget()

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
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const user = localStorage.getItem("echocoach_user") || "default_user";
    getGraph(user).then(setData).catch((e) => setError(String(e)));
  }, []);

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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-600">
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
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div
        ref={wrapRef}
        className="h-[560px] w-full overflow-hidden rounded-xl border border-neutral-200 bg-white"
      >
        {data && data.nodes.length > 0 ? (
          <ForceGraph2D
            width={size.w}
            height={size.h}
            graphData={graphData}
            backgroundColor="#ffffff"
            linkColor={() => "#e2e8f0"}
            linkWidth={1.5}
            nodeRelSize={5}
            nodeVal={(n: any) => 4 + (n.interactions ?? 0)}
            nodeLabel={(n: any) =>
              `${n.label} — ${n.archived ? "mastered (archived)" : n.signal}` +
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
              ctx.fillStyle = "#334155";
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              ctx.fillText(n.label, n.x, n.y + r + 1);
            }}
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-neutral-400">
            {data ? "No topics yet — run a session first." : "Loading graph…"}
          </div>
        )}
      </div>
    </div>
  );
}
