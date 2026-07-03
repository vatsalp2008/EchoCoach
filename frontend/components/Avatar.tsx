"use client";

import { useEffect, useRef, useState } from "react";

// A minimal "AI interviewer" avatar: a pulsing orb. The Web Speech synthesis API
// exposes no audio stream to analyze, so we drive motion from speaking state plus
// per-word boundary bumps - volume-driven-looking movement that reads as intentional
// (spec 8.4). `bump` should be incremented by the caller on each speech boundary.
export default function Avatar({
  speaking,
  listening,
  bump,
}: {
  speaking: boolean;
  listening: boolean;
  bump: number;
}) {
  const [scale, setScale] = useState(1);
  const target = useRef(1);
  const raf = useRef<number | null>(null);

  // Word boundary -> quick pulse.
  useEffect(() => {
    if (speaking) target.current = 1.18 + Math.min(0.12, (bump % 3) * 0.05);
  }, [bump, speaking]);

  useEffect(() => {
    if (!speaking) target.current = 1;
    const tick = () => {
      setScale((s) => {
        const next = s + (target.current - s) * 0.25;
        // gentle idle breathing while speaking, between boundary bumps
        if (speaking) target.current = 1.06 + (target.current - 1.06) * 0.7;
        return next;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [speaking]);

  const ring = listening ? "#dc2626" : speaking ? "#0ea5e9" : "#cbd5e1";
  const label = listening ? "Listening…" : speaking ? "Speaking…" : "Ready";

  return (
    <div className="flex flex-col items-center gap-2 py-2">
      <div
        className="grid h-24 w-24 place-items-center rounded-full transition-colors"
        style={{
          background:
            "radial-gradient(circle at 35% 30%, #38bdf8, #0284c7 70%, #075985)",
          transform: `scale(${scale})`,
          boxShadow: `0 0 0 4px ${ring}33, 0 8px 30px ${ring}55`,
        }}
      >
        <span className="text-white text-lg font-semibold tracking-wide">EC</span>
      </div>
      <span className="text-xs text-neutral-500">{label}</span>
    </div>
  );
}
