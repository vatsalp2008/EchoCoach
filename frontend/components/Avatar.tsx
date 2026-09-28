"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";
import { useTheme } from "next-themes";
import { AudioLines, Mic, RotateCcw } from "lucide-react";
import { getSpeechLevels } from "@/lib/speech";

// The AI interviewer (spec 8.4): a glossy orb ringed by a live audio visualizer.
// While the server voice plays, the ring shows its real spectrum (log-spaced
// bands from speech.ts); the browser voice exposes no audio stream, so its
// per-word `bump`s drive a procedural stand-in. Motion is drawn on a canvas
// from refs - React re-renders on state changes only, never per frame - and the
// loop sleeps once everything settles, so an idle orb costs nothing.

type RGB = [number, number, number];

const SIZE = 216; // canvas box, CSS px
const C = SIZE / 2;
const CORE_R = 44; // the orb itself (a DOM button, so it gets real focus/hover states)
const RING_R = 58; // where the bars start
const BAR_MAX = 34; // longest bar
const BANDS = 16; // shown once per quarter of the ring, mirrored, so the shape
const BARS = BANDS * 4; // stays symmetric (lows at top/bottom, highs at the sides)
const RECORDING: RGB = [239, 68, 68]; // red-500, the mic button's recording red
const FALLBACK_ACCENT: RGB = [99, 102, 241]; // indigo-500, if --ring can't be read

// Bar angles, starting at 12 o'clock and going clockwise.
const COS = Float32Array.from({ length: BARS }, (_, i) => Math.cos(-Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / BARS));
const SIN = Float32Array.from({ length: BARS }, (_, i) => Math.sin(-Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / BARS));
// Which band each bar shows: 0..15 then 15..0, twice around.
const BAND_OF = Uint8Array.from({ length: BARS }, (_, i) => {
  const q = i % (BANDS * 2);
  return q < BANDS ? q : BANDS * 2 - 1 - q;
});

function readAccent(): RGB {
  const hex = getComputedStyle(document.documentElement).getPropertyValue("--ring").trim();
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : FALLBACK_ACCENT;
}

const rgba = ([r, g, b]: RGB, a: number) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

export default function Avatar({
  speaking,
  listening,
  bump,
  onReplay,
}: {
  speaking: boolean;
  listening: boolean;
  // Incremented by the caller on each speech boundary; only drives the
  // procedural fallback (the real spectrum needs no help).
  bump: number;
  // When provided, clicking the orb replays the current question aloud (TTS).
  onReplay?: () => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const { resolvedTheme } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pulseRef = useRef<HTMLDivElement>(null);
  const props = useRef({ speaking, listening, bump, reduce });
  const accent = useRef<RGB>(FALLBACK_ACCENT);
  const wakeRef = useRef<() => void>(() => {});

  // The render loop. Lives for the component's lifetime, reads everything from
  // refs, and stops scheduling frames once idle and settled; wakeRef restarts it.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";

    accent.current = readAccent();
    const target = new Float32Array(BANDS);
    const bars = new Float32Array(BANDS); // eased values - what's drawn
    const color: RGB = [...accent.current];
    let level = 0; // eased overall loudness: orb pulse + glow
    let activity = 0; // eases 0 -> 1 while speaking or listening
    let kick = 0; // procedural envelope, re-triggered per word boundary
    let lastBump = props.current.bump;
    let raf = 0;
    let running = false;

    const frame = (now: number) => {
      const { speaking, listening, bump, reduce } = props.current;
      const t = now / 1000;

      if (speaking && reduce) {
        target.fill(0.3); // a calm, static "speaking" ring - no audio-driven motion
      } else if (speaking && !getSpeechLevels(target)) {
        // Browser voice: no signal to analyze, so fake a speech-like spectrum
        // (strong lows, weaker highs) that jumps on each word boundary.
        if (bump !== lastBump) {
          kick = 1;
          lastBump = bump;
        }
        kick *= 0.92;
        for (let b = 0; b < BANDS; b++) {
          const shape = 1 - 0.35 * (b / BANDS);
          const wobble = 0.5 + 0.5 * Math.sin(t * (5.3 + b * 0.9) + b * 2.1) * Math.sin(t * (2.2 + b * 0.35));
          // Levels roughly match real speech through getSpeechLevels (median
          // ~0.45, peaks near 1), so both voices look alike on the ring.
          target[b] = shape * (0.55 + 0.45 * kick) * (0.55 + 0.45 * wobble);
        }
      } else if (!speaking) {
        target.fill(0);
      }

      // Ease toward the targets: fast attack, slower release, so bars snap up
      // with each syllable and fall back smoothly. Reduced motion just snaps.
      let settled = true;
      let sum = 0;
      for (let b = 0; b < BANDS; b++) {
        const d = target[b] - bars[b];
        bars[b] = reduce ? target[b] : bars[b] + d * (d > 0 ? 0.45 : 0.14);
        if (Math.abs(target[b] - bars[b]) > 0.002) settled = false;
        sum += bars[b];
      }
      const lvl = speaking && !reduce ? sum / BANDS : 0;
      level = reduce ? lvl : level + (lvl - level) * 0.2;
      const act = speaking || listening ? 1 : 0;
      activity = reduce ? act : activity + (act - activity) * 0.12;
      const want = listening ? RECORDING : accent.current;
      for (let i = 0; i < 3; i++) {
        color[i] = reduce ? want[i] : color[i] + (want[i] - color[i]) * 0.15;
        if (Math.abs(want[i] - color[i]) > 0.5) settled = false;
      }
      if (Math.abs(level - lvl) > 0.002 || Math.abs(activity - act) > 0.002) settled = false;

      ctx.clearRect(0, 0, SIZE, SIZE);

      // Soft halo that swells with loudness.
      const glow = 0.1 + 0.08 * activity + 0.45 * level;
      const halo = ctx.createRadialGradient(C, C, CORE_R * 0.8, C, C, C);
      halo.addColorStop(0, rgba(color, glow));
      halo.addColorStop(0.45, rgba(color, glow * 0.35)); // ease out, no hard edge
      halo.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, SIZE, SIZE);

      // Listening: ripples radiating out, like sound coming in.
      if (listening && !reduce) {
        ctx.lineWidth = 1.5;
        for (let k = 0; k < 2; k++) {
          const p = (t / 1.8 + k / 2) % 1;
          ctx.strokeStyle = rgba(color, 0.5 * (1 - p) ** 1.5);
          ctx.beginPath();
          ctx.arc(C, C, CORE_R + 2 + p * (RING_R + BAR_MAX * 0.7 - CORE_R), 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // The visualizer: bars fading toward the tips, louder ones brighter. The
      // curve keeps mid-level bands short so peaks stand out - vowels bulge the
      // top and bottom (lows), "s"/"sh" flare the sides (highs). At rest they
      // shrink to a quiet ring of dots.
      const fade = ctx.createRadialGradient(C, C, RING_R, C, C, RING_R + BAR_MAX);
      fade.addColorStop(0, rgba(color, 0.95));
      fade.addColorStop(1, rgba(color, 0.3));
      ctx.strokeStyle = fade;
      ctx.lineWidth = 3;
      for (let i = 0; i < BARS; i++) {
        const v = bars[BAND_OF[i]];
        const len = 0.5 + v ** 1.7 * BAR_MAX;
        ctx.globalAlpha = (0.3 + 0.7 * activity) * (0.55 + 0.45 * v);
        ctx.beginPath();
        ctx.moveTo(C + COS[i] * RING_R, C + SIN[i] * RING_R);
        ctx.lineTo(C + COS[i] * (RING_R + len), C + SIN[i] * (RING_R + len));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      if (pulseRef.current) pulseRef.current.style.transform = `scale(${1 + 0.08 * level})`;

      if (!reduce && (speaking || listening || !settled)) {
        raf = requestAnimationFrame(frame);
      } else {
        running = false;
      }
    };

    wakeRef.current = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };
    wakeRef.current();
    return () => {
      cancelAnimationFrame(raf);
      wakeRef.current = () => {};
    };
  }, []);

  // Hand the latest props to the loop and wake it up.
  useEffect(() => {
    props.current = { speaking, listening, bump, reduce };
    wakeRef.current();
  }, [speaking, listening, bump, reduce]);

  // Re-read the accent color when the theme flips (canvas can't use CSS vars).
  useEffect(() => {
    accent.current = readAccent();
    wakeRef.current();
  }, [resolvedTheme]);

  const clickable = typeof onReplay === "function";
  const idle = !speaking && !listening;
  const status = listening ? "Listening" : speaking ? "Speaking" : clickable ? "Tap to replay" : "Ready";

  const orbInner = (
    <>
      {/* recording tint, cross-faded over the indigo base */}
      <span
        aria-hidden="true"
        className={
          "absolute inset-0 rounded-full bg-radial-[at_32%_26%] from-red-400 via-red-500 to-red-700 transition-opacity duration-300 " +
          (listening ? "opacity-100" : "opacity-0")
        }
      />
      {/* specular highlight - what makes it read as a sphere */}
      <span
        aria-hidden="true"
        className="absolute inset-0 rounded-full bg-radial-[at_30%_20%] from-white/55 via-white/0 via-45% to-transparent"
      />
      {listening ? (
        <Mic className="relative size-8" strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <>
          <AudioLines
            className={
              "relative size-8 transition-opacity duration-200" +
              (clickable && idle ? " group-hover:opacity-0 group-focus-visible:opacity-0" : "")
            }
            strokeWidth={1.75}
            aria-hidden="true"
          />
          {clickable && idle && (
            <RotateCcw
              className="absolute size-7 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
              strokeWidth={2}
              aria-hidden="true"
            />
          )}
        </>
      )}
    </>
  );

  const orbCls =
    "group relative grid size-[88px] place-items-center rounded-full text-white " +
    "bg-radial-[at_32%_26%] from-ring via-primary via-60% to-[color-mix(in_srgb,var(--primary)_55%,black)] " +
    "shadow-[inset_0_-10px_18px_rgb(0_0_0/0.28),inset_0_6px_12px_rgb(255_255_255/0.18),0_16px_32px_-12px_var(--primary)]";

  return (
    <div className="flex flex-col items-center">
      <div className="relative grid place-items-center" style={{ width: SIZE, height: SIZE }}>
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{ width: SIZE, height: SIZE }}
        />
        <div ref={pulseRef} className="relative will-change-transform">
          {clickable ? (
            <button
              type="button" // it sits inside the answer <form> - never submit it
              onClick={onReplay}
              aria-label="Replay the question aloud"
              title="Hear the question again"
              className={
                orbCls +
                " cursor-pointer transition-transform duration-150 hover:brightness-110 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
              }
            >
              {orbInner}
            </button>
          ) : (
            <div className={orbCls}>{orbInner}</div>
          )}
        </div>
      </div>
      <p className="-mt-4 inline-flex items-center gap-2 rounded-full bg-surface-2 px-3 py-1 text-xs font-medium text-muted">
        <span
          aria-hidden="true"
          className={
            "size-1.5 rounded-full transition-colors duration-300 " +
            (listening ? "bg-red-500" : speaking ? "bg-primary" : "bg-muted/50")
          }
        />
        {status}
      </p>
    </div>
  );
}
