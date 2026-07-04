"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Activity, Mic, RefreshCcw } from "lucide-react";

// Respect the OS "reduce motion" setting — animations become instant/off.
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
  "inline-flex items-center justify-center rounded-xl bg-primary px-7 py-3.5 text-base font-semibold text-primary-foreground shadow-sm transition hover:bg-primary-hover";

// ── Illustrative node graph (fake sample data, no backend) ──────────────────
const NODES = [
  { x: 20, y: 28 },
  { x: 80, y: 30 },
  { x: 27, y: 78 },
  { x: 73, y: 74 },
];
const EDGES: [number, number][] = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 3],
  [0, 3],
];
const LABEL_SETS = [
  ["Behavioral", "SQL joins", "API design", "System design"],
  ["Conflict story", "Indexing", "Rate limiting", "Consistency"],
  ["Ownership", "Query plans", "Idempotency", "Sharding"],
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
    <div ref={ref} className="relative mx-auto aspect-[16/10] w-full max-w-2xl">
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
      >
        {EDGES.map(([a, b], i) => (
          <line
            key={i}
            x1={NODES[a].x}
            y1={NODES[a].y}
            x2={NODES[b].x}
            y2={NODES[b].y}
            stroke="var(--muted)"
            strokeWidth={1}
            strokeOpacity={0.4}
            vectorEffect="non-scaling-stroke"
            style={{
              opacity: visible ? 1 : 0,
              transition: reduce ? "none" : "opacity 600ms ease",
              transitionDelay: `${500 + i * 80}ms`,
            }}
          />
        ))}
      </svg>

      {NODES.map((n, i) => {
        const isActive = i === active;
        return (
          <div
            key={i}
            className="absolute"
            style={{
              left: `${n.x}%`,
              top: `${n.y}%`,
              opacity: visible ? 1 : 0,
              transform: `translate(-50%, -50%) scale(${visible ? 1 : 0.7})`,
              transition: reduce ? "none" : "opacity 500ms ease, transform 500ms ease",
              transitionDelay: `${i * 130}ms`,
            }}
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

export default function Landing() {
  return (
    <main className="w-full">
      {/* Hero */}
      <section className="mx-auto max-w-3xl px-6 pb-16 pt-20 text-center sm:pt-28">
        <h1 className="text-balance text-4xl font-bold tracking-tight text-foreground sm:text-5xl md:text-6xl">
          The interviewer that remembers what trips you up
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-balance text-lg text-muted sm:text-xl">
          EchoCoach tracks your weak spots across sessions and adapts each new
          interview to press exactly where you struggle.
        </p>
        <div className="mt-10">
          <Link href="/login" className={cta}>
            Start practicing
          </Link>
        </div>
      </section>

      {/* Animated node graph */}
      <section className="mx-auto max-w-4xl px-6 pb-24">
        <div className="rounded-3xl border border-border bg-surface/60 px-6 py-12 shadow-sm">
          <NodeGraph />
          <p className="mx-auto mt-8 max-w-md text-center text-sm text-muted">
            Your topics, connected. The highlighted node is a tracked weak spot —
            it shifts as you practice.
          </p>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-4xl px-6 pb-24">
        <h2 className="mb-10 text-center text-2xl font-semibold tracking-tight text-foreground">
          How it works
        </h2>
        <div className="grid gap-6 sm:grid-cols-3">
          {STEPS.map(({ icon: Icon, title, line }, i) => (
            <div key={i} className="rounded-2xl border border-border bg-surface p-6 text-center shadow-sm">
              <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl bg-primary-subtle text-primary">
                <Icon size={22} />
              </div>
              <h3 className="text-base font-semibold text-foreground">{title}</h3>
              <p className="mt-1.5 text-sm text-muted">{line}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Why it's different */}
      <section className="mx-auto max-w-3xl px-6 pb-24">
        <h2 className="mb-8 text-center text-2xl font-semibold tracking-tight text-foreground">
          Why it&apos;s different
        </h2>
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
          {CONTRAST.map((row, i) => (
            <div
              key={i}
              className="grid gap-3 border-b border-border p-5 last:border-0 sm:grid-cols-2 sm:gap-6"
            >
              <p className="text-sm text-muted line-through decoration-muted/40">
                {row.generic}
              </p>
              <p className="text-sm font-medium text-foreground">
                <span className="mr-2 text-primary">✓</span>
                {row.echo}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer CTA */}
      <section className="mx-auto max-w-3xl px-6 pb-28 text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          Ready when you are.
        </h2>
        <div className="mt-8">
          <Link href="/login" className={cta}>
            Start practicing
          </Link>
        </div>
      </section>
    </main>
  );
}
