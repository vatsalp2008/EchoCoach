"use client";

import { motion } from "framer-motion";

const BLOBS = [
  { className: "left-[-10%] top-[-15%] h-[420px] w-[420px] bg-primary/25", duration: 22, delay: 0 },
  { className: "right-[-12%] top-[8%] h-[380px] w-[380px] bg-primary-subtle", duration: 26, delay: 2 },
  { className: "bottom-[-22%] left-[18%] h-[320px] w-[320px] bg-primary/15", duration: 30, delay: 4 },
];

/** Slow-drifting gradient blobs behind the hero. Pure decoration: sits behind
 * content (pointer-events disabled, low opacity, blurred) so it never fights
 * the headline. Colors ride the --primary tokens so it adapts in dark mode,
 * and MotionConfig (set by the caller) collapses the drift under
 * prefers-reduced-motion. */
export default function LandingBackground() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {BLOBS.map((b, i) => (
        <motion.div
          key={i}
          className={`absolute rounded-full blur-3xl ${b.className}`}
          animate={{ x: [0, 40, -20, 0], y: [0, 30, -15, 0] }}
          transition={{ duration: b.duration, delay: b.delay, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}
