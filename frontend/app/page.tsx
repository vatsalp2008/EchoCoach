"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  AnswerResponse,
  getDebrief,
  SessionMode,
  startSession,
  submitAnswer,
} from "@/lib/api";
import {
  cancelSpeak,
  speak,
  speechSupported,
  startListening,
  stopListening,
} from "@/lib/speech";
import Avatar from "@/components/Avatar";

type Phase = "setup" | "intro" | "interview" | "loading" | "debrief";

interface CurrentQ {
  questionId: string;
  topic: string;
  question: string;
  isFollowUp: boolean;
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>("setup");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState("");
  const [company, setCompany] = useState("");
  const [domain, setDomain] = useState<SessionMode>("technical");
  const [sessionId, setSessionId] = useState("");
  const [current, setCurrent] = useState<CurrentQ | null>(null);
  const [answer, setAnswer] = useState("");
  const [qNumber, setQNumber] = useState(0);
  const [debrief, setDebrief] = useState("");
  const [error, setError] = useState("");

  // Voice layer (additive; text stays the fallback).
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceAvail, setVoiceAvail] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [bump, setBump] = useState(0);
  const spokenFor = useRef<string>("");

  // Load the saved profile name + feature-detect speech on the client.
  useEffect(() => {
    const saved = localStorage.getItem("echocoach_user");
    if (saved) setUsername(saved);
    setVoiceAvail(speechSupported());
  }, []);

  // In voice mode, the interviewer speaks each new question exactly once.
  useEffect(() => {
    if (phase !== "interview" || !voiceMode || !current) return;
    if (spokenFor.current === current.questionId) return;
    spokenFor.current = current.questionId;
    speak(current.question, {
      onStart: () => setSpeaking(true),
      onBoundary: () => setBump((b) => b + 1),
      onEnd: () => setSpeaking(false),
    });
  }, [phase, voiceMode, current]);

  function toggleMic() {
    if (listening) {
      stopListening();
      setListening(false);
      return;
    }
    cancelSpeak();
    setSpeaking(false);
    const ok = startListening({
      onInterim: (t) => setAnswer(t),
      onFinal: (t) => t && setAnswer(t),
      onError: (m) => setError(m),
      onEnd: () => setListening(false),
    });
    setListening(ok);
  }

  function beginIntro(e: React.FormEvent) {
    e.preventDefault();
    if (!role.trim()) return;
    setError("");
    setPhase("intro");
  }

  async function startInterview() {
    setError("");
    setPhase("loading");
    const uid = username.trim() || "guest";
    localStorage.setItem("echocoach_user", uid);
    try {
      const res = await startSession({
        target_role: role.trim(),
        company: company.trim() || undefined,
        domain_focus: domain,
        user_id: uid,
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
    stopListening();
    setListening(false);
    cancelSpeak();
    setSpeaking(false);
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
    cancelSpeak();
    stopListening();
    setSpeaking(false);
    setListening(false);
    spokenFor.current = "";
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
                Your name <span className="text-neutral-400">(so EchoCoach remembers you)</span>
              </label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. vatsal"
                className={inputCls}
              />
            </div>
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
                {(
                  [
                    ["technical", "Technical"],
                    ["behavioral", "Behavioral"],
                    ["full", "Full (tech + behavioral)"],
                  ] as [SessionMode, string][]
                ).map(([d, label]) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDomain(d)}
                    className={
                      "rounded-md px-3 py-1.5 text-sm " +
                      (domain === d
                        ? "bg-neutral-900 text-white"
                        : "text-neutral-600 hover:text-neutral-900")
                    }
                  >
                    {label}
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
            <div className="flex items-center justify-between">
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
              {voiceAvail && (
                <div className="inline-flex rounded-lg border border-neutral-300 p-0.5 bg-white text-xs">
                  {[
                    ["text", "Text"],
                    ["voice", "Voice"],
                  ].map(([m, label]) => {
                    const active = (m === "voice") === voiceMode;
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          const v = m === "voice";
                          setVoiceMode(v);
                          if (!v) {
                            cancelSpeak();
                            stopListening();
                            setSpeaking(false);
                            setListening(false);
                          } else {
                            // let the effect speak the current question
                            spokenFor.current = "";
                          }
                        }}
                        className={
                          "rounded-md px-2.5 py-1 " +
                          (active
                            ? "bg-neutral-900 text-white"
                            : "text-neutral-600 hover:text-neutral-900")
                        }
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {voiceMode && (
              <Avatar speaking={speaking} listening={listening} bump={bump} />
            )}

            <p className="text-lg leading-relaxed">{current.question}</p>
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={voiceMode ? 5 : 8}
              placeholder={voiceMode ? "Your spoken answer appears here…" : "Type your answer…"}
              className={inputCls}
            />
            <div className="flex items-center gap-3">
              <button type="submit" className={primaryBtn} disabled={!answer.trim()}>
                Submit answer
              </button>
              {voiceMode && (
                <button
                  type="button"
                  onClick={toggleMic}
                  className={
                    "rounded-lg px-4 py-2 text-sm font-medium border " +
                    (listening
                      ? "border-red-300 bg-red-50 text-red-700"
                      : "border-neutral-300 text-neutral-700 hover:bg-neutral-100")
                  }
                >
                  {listening ? "◼ Stop" : "🎤 Speak"}
                </button>
              )}
              {voiceMode && current && (
                <button
                  type="button"
                  onClick={() =>
                    speak(current.question, {
                      onStart: () => setSpeaking(true),
                      onBoundary: () => setBump((b) => b + 1),
                      onEnd: () => setSpeaking(false),
                    })
                  }
                  className="text-xs text-neutral-500 hover:text-neutral-800"
                >
                  replay question
                </button>
              )}
            </div>
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
