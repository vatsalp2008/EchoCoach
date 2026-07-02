"use client";

import { useState } from "react";
import {
  AnswerResponse,
  getDebrief,
  startSession,
  submitAnswer,
} from "@/lib/api";

type Phase = "setup" | "interview" | "loading" | "debrief";

interface CurrentQ {
  questionId: string;
  topic: string;
  question: string;
  isFollowUp: boolean;
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>("setup");
  const [role, setRole] = useState("");
  const [company, setCompany] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [current, setCurrent] = useState<CurrentQ | null>(null);
  const [answer, setAnswer] = useState("");
  const [qNumber, setQNumber] = useState(0);
  const [debrief, setDebrief] = useState("");
  const [error, setError] = useState("");

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    if (!role.trim()) return;
    setError("");
    setPhase("loading");
    try {
      const res = await startSession({
        target_role: role.trim(),
        company: company.trim() || undefined,
      });
      setSessionId(res.session_id);
      setCurrent({
        questionId: res.question_id,
        topic: res.topic,
        question: res.question,
        isFollowUp: false,
      });
      setQNumber(1);
      setPhase("interview");
    } catch (err) {
      setError(String(err));
      setPhase("setup");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!current || !answer.trim()) return;
    setError("");
    setPhase("loading");
    try {
      const res: AnswerResponse = await submitAnswer({
        session_id: sessionId,
        question_id: current.questionId,
        transcript: answer.trim(),
      });
      setAnswer("");
      if (res.done) {
        const report = await getDebrief(sessionId);
        setDebrief(report);
        setPhase("debrief");
        return;
      }
      setCurrent({
        questionId: res.next_question_id!,
        topic: res.topic!,
        question: res.question!,
        isFollowUp: res.is_follow_up,
      });
      if (!res.is_follow_up) setQNumber((n) => n + 1);
      setPhase("interview");
    } catch (err) {
      setError(String(err));
      setPhase("interview");
    }
  }

  function reset() {
    setPhase("setup");
    setRole("");
    setCompany("");
    setCurrent(null);
    setDebrief("");
    setQNumber(0);
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center px-4 py-10">
      <div className="w-full max-w-2xl">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">EchoCoach</h1>
          <p className="text-sm text-neutral-400">
            The interviewer that remembers what you struggled with.
          </p>
        </header>

        {error && (
          <div className="mb-4 rounded-md border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {phase === "setup" && (
          <form onSubmit={handleStart} className="space-y-4">
            <div>
              <label className="block text-sm text-neutral-300 mb-1">
                Target role <span className="text-red-400">*</span>
              </label>
              <input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="e.g. Senior Backend Engineer"
                className="w-full rounded-md bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm outline-none focus:border-neutral-500"
              />
            </div>
            <div>
              <label className="block text-sm text-neutral-300 mb-1">
                Target company{" "}
                <span className="text-neutral-500">(optional)</span>
              </label>
              <input
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="e.g. Stripe"
                className="w-full rounded-md bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm outline-none focus:border-neutral-500"
              />
            </div>
            <button
              type="submit"
              className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
              disabled={!role.trim()}
            >
              Start interview
            </button>
          </form>
        )}

        {phase === "loading" && (
          <div className="text-neutral-400 text-sm animate-pulse">Thinking…</div>
        )}

        {phase === "interview" && current && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              <span className="rounded-full bg-neutral-800 px-2 py-0.5">
                Question {qNumber}
              </span>
              <span className="rounded-full bg-neutral-800 px-2 py-0.5">
                {current.topic.replace(/_/g, " ")}
              </span>
              {current.isFollowUp && (
                <span className="rounded-full bg-amber-900/60 text-amber-300 px-2 py-0.5">
                  follow-up
                </span>
              )}
            </div>
            <p className="text-lg leading-relaxed">{current.question}</p>
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={8}
              placeholder="Type your answer…"
              className="w-full rounded-md bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm outline-none focus:border-neutral-500"
            />
            <button
              type="submit"
              className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
              disabled={!answer.trim()}
            >
              Submit answer
            </button>
          </form>
        )}

        {phase === "debrief" && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Session debrief</h2>
            <article className="whitespace-pre-wrap rounded-md border border-neutral-800 bg-neutral-900/50 p-4 text-sm leading-relaxed">
              {debrief}
            </article>
            <button
              onClick={reset}
              className="rounded-md border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-900"
            >
              New session
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
