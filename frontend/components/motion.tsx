"use client";

// Shared animation primitives used across the marketing landing page and the
// logged-in app, so every page picks up the same motion language instead of
// each one hand-rolling its own variants.
import { useRef, type ButtonHTMLAttributes } from "react";
import { motion, type Variants } from "framer-motion";

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: "easeOut" } },
};

export const staggerContainer: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.12 } },
};

/** Fades/slides a section's children up as it scrolls into view, staggered.
 * `once` so it doesn't re-fire every time you scroll past it. */
export function Reveal({
  as: As = "div",
  className,
  children,
}: {
  as?: "div" | "section";
  className?: string;
  children: React.ReactNode;
}) {
  const MotionAs = motion[As];
  return (
    <MotionAs
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.3 }}
      variants={staggerContainer}
    >
      {children}
    </MotionAs>
  );
}

/** Diagonal glare sweep on hover (React Bits' GlareHover technique, ported
 * rather than installed — plain refs/CSS, zero extra dependency). Spread the
 * returned handlers onto a `relative overflow-hidden` element, render
 * `{glare}` as its first child, and wrap the element's real content in a
 * `relative` span so it paints above the glare overlay. */
export function useGlare<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  const onMouseEnter = () => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = "none";
    el.style.backgroundPosition = "-100% -100%";
    el.style.transition = "650ms ease";
    el.style.backgroundPosition = "100% 100%";
  };
  const onMouseLeave = () => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = "650ms ease";
    el.style.backgroundPosition = "-100% -100%";
  };

  const glare = (
    <span
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{
        background:
          "linear-gradient(-45deg, hsla(0,0%,100%,0) 60%, hsla(0,0%,100%,0.35) 70%, hsla(0,0%,100%,0) 100%)",
        backgroundSize: "250% 250%",
        backgroundPosition: "-100% -100%",
      }}
    />
  );

  return { glare, onMouseEnter, onMouseLeave };
}

/** A plain <button> with the glare-on-hover treatment built in. Drop-in
 * replacement anywhere a primary action button needs the same polish
 * (form submits, "start"/"continue" actions) without re-wiring useGlare by
 * hand at every call site. */
export function GlareButton({
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { glare, onMouseEnter, onMouseLeave } = useGlare<HTMLSpanElement>();
  return (
    <button
      {...props}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={`relative overflow-hidden ${className ?? ""}`}
    >
      {glare}
      <span className="relative">{children}</span>
    </button>
  );
}
