"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { motion, MotionConfig, useReducedMotion } from "framer-motion";
import { Activity, Check, Mic, RefreshCcw } from "lucide-react";
import LandingBackground from "./LandingBackground";
import LogoLoop, { type LogoItem } from "./LogoLoop";
import { fadeUp, Reveal, staggerContainer, useGlare } from "./motion";

// Respect the OS "reduce motion" setting for the interval-driven bits below
// (active-node cycling, label rotation) that aren't framer-motion animations
// and so aren't covered by the <MotionConfig reducedMotion="user"> wrapper.
function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(m.matches);
    const onChange = () => setReduce(m.matches);
    m.addEventListener?.("change", onChange);
    return () => m.removeEventListener?.("change", onChange);
  }, []);
  return reduce;
}

const cta =
  "inline-flex items-center justify-center rounded-xl bg-primary px-7 py-3.5 text-base font-semibold text-primary-foreground shadow-sm transition hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const MotionLink = motion(Link);

function AnimatedCta({ children }: { children: React.ReactNode }) {
  const { glare, onMouseEnter, onMouseLeave } = useGlare<HTMLSpanElement>();

  return (
    <MotionLink
      href="/login"
      className={`${cta} relative overflow-hidden`}
      whileHover={{ scale: 1.04 }}
      whileTap={{ scale: 0.97 }}
      transition={{ duration: 0.15 }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {glare}
      <span className="relative">{children}</span>
    </MotionLink>
  );
}

// ── Illustrative node graph (fake sample data, no backend) ──────────────────
const NODES = [
  { x: 15, y: 22 },
  { x: 50, y: 12 },
  { x: 85, y: 24 },
  { x: 20, y: 80 },
  { x: 50, y: 88 },
  { x: 82, y: 78 },
];
const EDGES: [number, number][] = [
  [0, 1],
  [1, 2],
  [0, 3],
  [1, 4],
  [2, 5],
  [3, 4],
  [4, 5],
  [0, 4],
  [2, 4],
];
const LABEL_SETS = [
  ["Behavioral", "SQL joins", "API design", "System design", "Concurrency", "Testing"],
  ["Conflict story", "Indexing", "Rate limiting", "Consistency", "Deadlocks", "Mocking"],
  ["Ownership", "Query plans", "Idempotency", "Sharding", "Race conditions", "Coverage"],
];

function NodeGraph() {
  const reduce = usePrefersReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState(1);
  const [setIdx, setSetIdx] = useState(0);

  // Re-trigger the entrance animation whenever the section scrolls into view.
  useEffect(() => {
    if (reduce) {
      setVisible(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => setVisible(e.isIntersecting)),
      { threshold: 0.35 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduce]);

  // Cycle the highlighted weak spot + rotate the sample labels over "sessions".
  useEffect(() => {
    if (reduce) return;
    const id = setInterval(() => {
      setActive((a) => {
        const next = (a + 1) % NODES.length;
        if (next === 0) setSetIdx((s) => (s + 1) % LABEL_SETS.length);
        return next;
      });
    }, 2600);
    return () => clearInterval(id);
  }, [reduce]);

  const labels = LABEL_SETS[setIdx];

  return (
    // Square on phones: at 16:10 the bottom row's labels nearly touch.
    <div ref={ref} className="relative mx-auto aspect-square w-full max-w-2xl sm:aspect-[16/10]">
      {/* No viewBox: percentage coordinates resolve against the box's own pixels,
          so the stroke stays 1px without vector-effect="non-scaling-stroke" —
          which breaks the pathLength draw-in (its dash pattern shows as dashes). */}
      <svg className="absolute inset-0 h-full w-full">
        {EDGES.map(([a, b], i) => (
          <motion.line
            key={i}
            x1={`${NODES[a].x}%`}
            y1={`${NODES[a].y}%`}
            x2={`${NODES[b].x}%`}
            y2={`${NODES[b].y}%`}
            stroke="var(--primary)"
            strokeWidth={1}
            strokeOpacity={0.35}
            initial={{ pathLength: 0 }}
            animate={{ pathLength: visible ? 1 : 0 }}
            transition={{ duration: 0.8, delay: 0.3 + i * 0.08, ease: "easeOut" }}
          />
        ))}
      </svg>

      {NODES.map((n, i) => {
        const isActive = i === active;
        return (
          // Anchored on the dot's center (half its 20px height), not the
          // dot+label stack's, so the edges meet the dots; labels hang below.
          <div
            key={i}
            className="absolute -translate-x-1/2 -translate-y-2.5"
            style={{ left: `${n.x}%`, top: `${n.y}%` }}
          >
            <motion.div
              animate={
                visible
                  ? { opacity: 1, scale: 1, x: [0, 3, -3, 0], y: [0, -3, 3, 0] }
                  : { opacity: 0, scale: 0.7, x: 0, y: 0 }
              }
              transition={
                visible
                  ? {
                      opacity: { duration: 0.5, delay: i * 0.08 },
                      scale: { duration: 0.5, delay: i * 0.08 },
                      x: { duration: 6 + i, repeat: Infinity, ease: "easeInOut" },
                      y: { duration: 7 + i, repeat: Infinity, ease: "easeInOut" },
                    }
                  : { duration: 0.3 }
              }
            >
              <div className="flex flex-col items-center gap-2">
                <span className="relative grid place-items-center">
                  {isActive && !reduce && (
                    <span className="absolute inset-0 -m-2 rounded-full bg-primary/30 animate-ping" />
                  )}
                  <span
                    className={
                      "relative h-5 w-5 rounded-full ring-2 transition-all duration-500 " +
                      (isActive
                        ? "bg-primary ring-primary/40 shadow-[0_0_20px] shadow-primary/50"
                        : "bg-foreground/25 ring-border")
                    }
                  />
                </span>
                <span
                  className={
                    "whitespace-nowrap text-xs font-medium transition-colors duration-500 " +
                    (isActive ? "text-primary" : "text-muted")
                  }
                >
                  {labels[i]}
                </span>
              </div>
            </motion.div>
          </div>
        );
      })}
    </div>
  );
}

// ── sections ────────────────────────────────────────────────────────────────
const STEPS = [
  { icon: Mic, title: "Practice", line: "Run a mock interview by voice or text." },
  { icon: Activity, title: "We track patterns", line: "Every answer updates your personal weakness graph." },
  { icon: RefreshCcw, title: "Next session adapts", line: "New questions route straight to your weak spots." },
];

// Illustrative examples only — grounding works against whatever company name
// you type in, not just this list (it's a live GitHub-backed lookup, not a
// fixed partner roster). Plain wordmark text, not real logo assets.
const EXAMPLE_COMPANIES = ["Stripe", "Datadog", "Google", "Netflix", "Airbnb", "Uber", "Meta", "Amazon"];
const COMPANY_LOGOS: LogoItem[] = EXAMPLE_COMPANIES.map((name) => ({
  node: <span className="text-lg font-semibold tracking-tight text-muted">{name}</span>,
  ariaLabel: name,
}));

const CONTRAST = [
  {
    generic: "Generic tools ask the same canned questions every time.",
    echo: "EchoCoach remembers across sessions and presses where you struggled.",
  },
  {
    generic: "You review answers; the tool forgets you by tomorrow.",
    echo: "Your weakness graph persists and routes each new session.",
  },
  {
    generic: "Practice happens in a vacuum.",
    echo: "Questions are grounded in real company scenarios — like Datadog and Stripe.",
  },
];

const HERO_WORDS = "The interviewer that remembers what trips you up".split(" ");

// Cursor-tracked spotlight on hover (React Bits' SpotlightCard technique,
// re-themed off our --primary token via color-mix instead of a hardcoded
// rgba — zero extra dependency, plain refs + a radial-gradient overlay).
function StepCard({
  icon: Icon,
  title,
  line,
}: {
  icon: React.ElementType;
  title: string;
  line: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [opacity, setOpacity] = useState(0);

  return (
    <motion.div
      ref={ref}
      variants={fadeUp}
      whileHover={{ y: -6 }}
      transition={{ duration: 0.25 }}
      onMouseMove={(e) => {
        const rect = ref.current?.getBoundingClientRect();
        if (rect) setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      }}
      onMouseEnter={() => setOpacity(1)}
      onMouseLeave={() => setOpacity(0)}
      className="group relative overflow-hidden rounded-2xl border border-border bg-surface p-6 text-center shadow-sm transition-shadow hover:border-primary/40 hover:shadow-lg hover:shadow-primary/10"
    >
      <div
        className="pointer-events-none absolute inset-0 transition-opacity duration-500"
        style={{
          opacity,
          background: `radial-gradient(circle at ${pos.x}px ${pos.y}px, color-mix(in srgb, var(--primary) 22%, transparent), transparent 70%)`,
        }}
      />
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl bg-primary-subtle text-primary transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3">
        <Icon size={22} />
      </div>
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <p className="mt-1.5 text-sm text-muted">{line}</p>
    </motion.div>
  );
}

function Hero() {
  const reduceMotion = useReducedMotion();
  return (
    <section className="relative mx-auto max-w-3xl px-6 pb-16 pt-20 text-center sm:pt-28">
      <LandingBackground />
      <motion.div initial="hidden" animate="show">
        <motion.h1
          variants={reduceMotion ? undefined : staggerContainer}
          className="text-balance text-4xl font-bold tracking-tight text-foreground sm:text-5xl md:text-6xl"
        >
          {HERO_WORDS.map((word, i) => (
            <motion.span key={i} variants={fadeUp} className="mr-[0.25em] inline-block last:mr-0">
              {word}
            </motion.span>
          ))}
        </motion.h1>
        <motion.p
          variants={fadeUp}
          transition={{ duration: 0.6, delay: 0.5, ease: "easeOut" }}
          className="mx-auto mt-6 max-w-xl text-balance text-lg text-muted sm:text-xl"
        >
          EchoCoach tracks your weak spots across sessions and adapts each new
          interview to press exactly where you struggle.
        </motion.p>
        <motion.div
          variants={fadeUp}
          transition={{ duration: 0.6, delay: 0.65, ease: "easeOut" }}
          className="mt-10"
        >
          <AnimatedCta>Start practicing</AnimatedCta>
        </motion.div>
      </motion.div>
    </section>
  );
}

export default function Landing() {
  return (
    <MotionConfig reducedMotion="user">
      <main className="w-full">
        <Hero />

        {/* Animated node graph */}
        <Reveal as="section" className="mx-auto max-w-4xl px-6 pb-24">
          <motion.div
            variants={fadeUp}
            className="rounded-3xl border border-border bg-surface/60 px-6 py-12 shadow-sm"
          >
            <NodeGraph />
            <p className="mx-auto mt-8 max-w-md text-center text-sm text-muted">
              Your topics, connected. The highlighted node is a tracked weak spot —
              it shifts as you practice.
            </p>
          </motion.div>
        </Reveal>

        {/* How it works */}
        <Reveal as="section" className="mx-auto max-w-4xl px-6 pb-24">
          <motion.h2
            variants={fadeUp}
            className="mb-10 text-center text-2xl font-semibold tracking-tight text-foreground"
          >
            How it works
          </motion.h2>
          <div className="grid gap-6 sm:grid-cols-3">
            {STEPS.map((step, i) => (
              <StepCard key={i} {...step} />
            ))}
          </div>
        </Reveal>

        {/* Grounded in real companies */}
        <Reveal as="section" className="mx-auto max-w-4xl px-6 pb-24 text-center">
          <motion.h2
            variants={fadeUp}
            className="mb-3 text-2xl font-semibold tracking-tight text-foreground"
          >
            Grounded in real companies
          </motion.h2>
          <motion.p variants={fadeUp} className="mx-auto mb-10 max-w-lg text-sm text-muted">
            Tell it where you&apos;re interviewing and new questions adapt to real, current
            engineering context, not a canned bank. Works for any company, these are just examples.
          </motion.p>
          <motion.div variants={fadeUp}>
            <LogoLoop
              logos={COMPANY_LOGOS}
              speed={40}
              gap={56}
              fadeOut
              fadeOutColor="var(--background)"
              pauseOnHover
              ariaLabel="Example companies EchoCoach can ground interview questions against"
            />
          </motion.div>
        </Reveal>

        {/* Why it's different */}
        <Reveal as="section" className="mx-auto max-w-3xl px-6 pb-24">
          <motion.h2
            variants={fadeUp}
            className="mb-8 text-center text-2xl font-semibold tracking-tight text-foreground"
          >
            Why it&apos;s different
          </motion.h2>
          <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
            {CONTRAST.map((row, i) => (
              <motion.div
                key={i}
                variants={fadeUp}
                whileHover={{ scale: 1.01 }}
                transition={{ duration: 0.2 }}
                className="grid gap-3 border-b border-border p-5 transition-colors last:border-0 hover:bg-surface-2 sm:grid-cols-2 sm:gap-6"
              >
                <p className="text-sm text-muted line-through decoration-muted/40">
                  {row.generic}
                </p>
                <p className="flex items-start gap-2 text-sm font-medium text-foreground">
                  <motion.span
                    variants={{
                      hidden: { scale: 0, opacity: 0 },
                      show: { scale: 1, opacity: 1, transition: { delay: 0.15, type: "spring", stiffness: 300, damping: 20 } },
                    }}
                    className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
                  >
                    <Check size={11} strokeWidth={3} />
                  </motion.span>
                  {row.echo}
                </p>
              </motion.div>
            ))}
          </div>
        </Reveal>

        {/* Footer CTA */}
        <Reveal as="section" className="mx-auto max-w-3xl px-6 pb-28 text-center">
          <motion.h2
            variants={fadeUp}
            className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl"
          >
            Ready when you are.
          </motion.h2>
          <motion.div variants={fadeUp} className="mt-8">
            <AnimatedCta>Start practicing</AnimatedCta>
          </motion.div>
        </Reveal>
      </main>
    </MotionConfig>
  );
}
