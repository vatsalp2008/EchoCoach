"use client";

import { useEffect, useRef, useState } from "react";

// A minimal "AI interviewer" avatar: a pulsing orb, driven by speaking state plus
// per-word bumps (spec 8.4). With the server voice, speech.ts derives the bumps
// from real loudness onsets; the browser voice exposes no audio stream, so its
// word-boundary events stand in. `bump` should be incremented on each one.
export default function Avatar({
  speaking,
  listening,
  bump,
  onReplay,
}: {
  speaking: boolean;
  listening: boolean;
  bump: number;
  // When provided, clicking the orb replays the current question aloud (TTS).
  onReplay?: () => void;
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
  const clickable = typeof onReplay === "function";

  return (
    <div className="flex flex-col items-center gap-2 py-2">
      <div
        className={
          "grid h-24 w-24 place-items-center rounded-full transition-colors" +
          (clickable ? " cursor-pointer" : "")
        }
        style={{
          background:
            "radial-gradient(circle at 35% 30%, #38bdf8, #0284c7 70%, #075985)",
          transform: `scale(${scale})`,
          boxShadow: `0 0 0 4px ${ring}33, 0 8px 30px ${ring}55`,
        }}
        onClick={onReplay}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-label={clickable ? "Replay the question aloud" : undefined}
        title={clickable ? "Click to hear the question again" : undefined}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onReplay!();
                }
              }
            : undefined
        }
      >
        <span className="text-white text-lg font-semibold tracking-wide">EC</span>
      </div>
      <span className="text-xs text-muted">
        {clickable && !speaking && !listening ? "Tap to replay" : label}
      </span>
    </div>
  );
}
