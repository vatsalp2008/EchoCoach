"use client";

import { useEffect, useState } from "react";
import { getDebrief, getSessions, SessionSummary } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import DebriefView from "@/components/DebriefView";

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const DOMAIN_LABEL: Record<string, string> = {
  technical: "Technical",
  behavioral: "Behavioral",
  full: "Full (tech + behavioral)",
};

export default function HistoryPage() {
  const { user, loading, openLogin } = useAuth();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [selected, setSelected] = useState<SessionSummary | null>(null);
  const [debrief, setDebrief] = useState("");
  const [debriefLoading, setDebriefLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;
    getSessions()
      .then(setSessions)
      .catch((e) => setError(String(e)));
  }, [user]);

  async function open(s: SessionSummary) {
    setSelected(s);
    setDebrief("");
    setError("");
    setDebriefLoading(true);
    try {
      setDebrief(await getDebrief(s.id));
    } catch (e) {
      setError(String(e));
    } finally {
      setDebriefLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center px-4 py-14">
      <div className="w-full max-w-2xl">
        <header className="mb-10">
          <h1 className="text-4xl font-bold tracking-tight text-foreground">
            Session history
          </h1>
          <p className="mt-2 text-lg text-muted">
            Every past interview, with its original debrief and full transcript.
          </p>
        </header>

        {error && (
          <div className="mb-6 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </div>
        )}

        {!loading && !user && (
          <div className="rounded-2xl border border-border bg-surface p-8 text-center shadow-sm">
            <p className="text-base text-muted">
              <button onClick={openLogin} className="font-semibold text-primary hover:underline">
                Log in
              </button>{" "}
              to see your past sessions.
            </p>
          </div>
        )}

        {/* Detail view */}
        {user && selected && (
          <div className="space-y-5">
            <button
              onClick={() => setSelected(null)}
              className="text-sm font-medium text-primary hover:underline"
            >
              ← All sessions
            </button>
            <div>
              <h2 className="text-2xl font-semibold text-foreground">
                {fmtWhen(selected.started_at)}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {DOMAIN_LABEL[selected.domain_focus] ?? selected.domain_focus}
                {selected.company ? ` · ${selected.company}` : ""} · {selected.n_questions} question
                {selected.n_questions === 1 ? "" : "s"}
              </p>
            </div>
            {debriefLoading ? (
              <p className="text-sm text-muted">Loading debrief…</p>
            ) : (
              <DebriefView debrief={debrief} sessionId={selected.id} />
            )}
          </div>
        )}

        {/* List view */}
        {user && !selected && (
          <div className="space-y-3">
            {sessions === null && <p className="text-sm text-muted">Loading…</p>}
            {sessions?.length === 0 && (
              <div className="rounded-2xl border border-border bg-surface p-8 text-center shadow-sm">
                <p className="text-base text-muted">
                  No sessions yet. Start one from the{" "}
                  <a href="/" className="font-semibold text-primary hover:underline">
                    interview page
                  </a>
                  .
                </p>
              </div>
            )}
            {sessions?.map((s) => (
              <button
                key={s.id}
                onClick={() => open(s)}
                className="flex w-full items-center justify-between gap-4 rounded-xl border border-border bg-surface px-5 py-4 text-left shadow-sm transition hover:border-primary/40 hover:bg-surface-2"
              >
                <div>
                  <p className="text-base font-semibold text-foreground">{fmtWhen(s.started_at)}</p>
                  <p className="mt-0.5 text-sm text-muted">
                    {DOMAIN_LABEL[s.domain_focus] ?? s.domain_focus}
                    {s.company ? ` · ${s.company}` : ""}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted">
                  {s.n_questions} Q
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
