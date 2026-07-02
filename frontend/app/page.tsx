"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  AnswerResponse,
  Domain,
  getDebrief,
  startSession,
  submitAnswer,
} from "@/lib/api";

type Phase = "setup" | "intro" | "interview" | "loading" | "debrief";

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
  const [domain, setDomain] = useState<Domain>("technical");
  const [sessionId, setSessionId] = useState("");
  const [current, setCurrent] = useState<CurrentQ | null>(null);
  const [answer, setAnswer] = useState("");
  const [qNumber, setQNumber] = useState(0);
  const [debrief, setDebrief] = useState("");
  const [error, setError] = useState("");

  function beginIntro(e: React.FormEvent) {
    e.preventDefault();
    if (!role.trim()) return;
    setError("");
    setPhase("intro");
  }

  async function startInterview() {
    setError("");
    setPhase("loading");
    try {
      const res = await startSession({
        target_role: role.trim(),
        company: company.trim() || undefined,
        domain_focus: domain,
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
      setPhase("intro");
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

  const inputCls =
    "w-full rounded-lg bg-white border border-neutral-300 px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900";
  const primaryBtn =
    "rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <main className="min-h-screen bg-neutral-50 text-neutral-900 flex flex-col items-center px-4 py-12">
      <div className="w-full max-w-2xl">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">EchoCoach</h1>
          <p className="text-sm text-neutral-500">
            The interviewer that remembers what you struggled with.
          </p>
        </header>

        {error && (
          <div className="mb-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {phase === "setup" && (
          <form onSubmit={beginIntro} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">
                Target role <span className="text-red-500">*</span>
              </label>
              <input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="e.g. Senior Backend Engineer"
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">
                Target company{" "}
                <span className="text-neutral-400">(optional)</span>
              </label>
              <input
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="e.g. Stripe"
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">
                Interview type
              </label>
              <div className="inline-flex rounded-lg border border-neutral-300 p-0.5 bg-white">
                {(["technical", "behavioral"] as Domain[]).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDomain(d)}
                    className={
                      "rounded-md px-3 py-1.5 text-sm capitalize " +
                      (domain === d
                        ? "bg-neutral-900 text-white"
                        : "text-neutral-600 hover:text-neutral-900")
                    }
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <button type="submit" className={primaryBtn} disabled={!role.trim()}>
              Continue
            </button>
          </form>
        )}

        {phase === "intro" && (
          <div className="space-y-5">
            <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-3 mb-3">
                <div className="h-9 w-9 rounded-full bg-neutral-900 text-white grid place-items-center text-sm font-semibold">
                  EC
                </div>
                <div>
                  <p className="text-sm font-medium">Your EchoCoach interviewer</p>
                  <p className="text-xs text-neutral-500">{role}</p>
                </div>
              </div>
              <div className="space-y-2 text-sm leading-relaxed text-neutral-700">
                <p>
                  Hi — thanks for making the time today. I&apos;ll be your interviewer for
                  this <span className="font-medium">{role}</span> session.
                </p>
                <p>
                  Here&apos;s how this works: I&apos;ll ask you a few questions and dig in
                  with follow-ups, just like a real interview. Think out loud and answer
                  as you naturally would — I won&apos;t grade you as we go. At the end
                  you&apos;ll get a short debrief on how it went.
                </p>
                <p>Ready when you are.</p>
              </div>
            </div>
            <button onClick={startInterview} className={primaryBtn}>
              I&apos;m ready — begin
            </button>
          </div>
        )}

        {phase === "loading" && (
          <div className="flex items-center gap-3 text-neutral-500 text-sm">
            <span className="inline-flex gap-1">
              <span className="h-2 w-2 rounded-full bg-neutral-400 animate-bounce [animation-delay:-0.3s]" />
              <span className="h-2 w-2 rounded-full bg-neutral-400 animate-bounce [animation-delay:-0.15s]" />
              <span className="h-2 w-2 rounded-full bg-neutral-400 animate-bounce" />
            </span>
            The interviewer is thinking…
          </div>
        )}

        {phase === "interview" && current && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              <span className="rounded-full bg-neutral-200 px-2 py-0.5">
                Question {qNumber}
              </span>
              <span className="rounded-full bg-neutral-200 px-2 py-0.5">
                {current.topic.replace(/_/g, " ")}
              </span>
              {current.isFollowUp && (
                <span className="rounded-full bg-amber-100 text-amber-700 px-2 py-0.5">
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
              className={inputCls}
            />
            <button type="submit" className={primaryBtn} disabled={!answer.trim()}>
              Submit answer
            </button>
          </form>
        )}

        {phase === "debrief" && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Session debrief</h2>
            <article className="prose prose-sm prose-neutral max-w-none rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
              <ReactMarkdown>{debrief}</ReactMarkdown>
            </article>
            <button
              onClick={reset}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100"
            >
              New session
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
