"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { getSessionQA, QAItem } from "@/lib/api";

// The debrief card with the Summary ↔ Questions & Answers toggle. Shared by the
// live interview debrief and the History detail view so they render identically.
export default function DebriefView({
  debrief,
  sessionId,
}: {
  debrief: string;
  sessionId: string;
}) {
  const [qa, setQa] = useState<QAItem[] | null>(null);
  const [showQA, setShowQA] = useState(false);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    const next = !showQA;
    setShowQA(next);
    if (next && qa === null) {
      setLoading(true);
      try {
        setQa(await getSessionQA(sessionId));
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-foreground">
          {showQA ? "Questions & Answers" : "Summary"}
        </h3>
        <button
          type="button"
          onClick={toggle}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-surface-2"
        >
          {showQA ? "← Back to summary" : "Questions & Answers"}
        </button>
      </div>

      {showQA ? (
        <div className="space-y-3">
          {loading && <p className="text-sm text-muted">Loading…</p>}
          {!loading && qa && qa.length === 0 && (
            <p className="text-sm text-muted">No questions were recorded.</p>
          )}
          {!loading &&
            qa?.map((item, i) => (
              <div key={i} className="border-b border-border pb-3 last:border-0 last:pb-0">
                <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted">
                  <span>{item.topic.replace(/_/g, " ")}</span>
                  {item.is_follow_up && (
                    <span className="rounded-full bg-amber-100 px-1.5 py-0.5 normal-case text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                      follow-up
                    </span>
                  )}
                </div>
                <p className="text-sm font-medium text-foreground">{item.question}</p>
                {item.skipped ? (
                  <p className="mt-1 text-sm font-medium text-amber-600 dark:text-amber-400">⤼ Skipped</p>
                ) : (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted">
                    {item.answer || <span className="italic text-muted/60">(no answer)</span>}
                  </p>
                )}
              </div>
            ))}
        </div>
      ) : (
        <article className="prose prose-sm max-w-none dark:prose-invert prose-headings:text-foreground prose-strong:text-foreground">
          <ReactMarkdown>{debrief.replace(/^\s*##\s*Summary\s*\n/i, "")}</ReactMarkdown>
        </article>
      )}
    </div>
  );
}
