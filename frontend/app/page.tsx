"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  AnswerResponse,
  Domain,
  getDebrief,
  getSessionQA,
  QAItem,
  SessionMode,
  startSession,
  sttStatus,
  submitAnswer,
  transcribeAudio,
} from "@/lib/api";
import {
  blobToBase64,
  cancelSpeak,
  mimeTypeToFormat,
  recordingSupported,
  speak,
  speechSupported,
  startListening,
  startRecording,
  stopListening,
  stopRecording,
} from "@/lib/speech";
import Avatar from "@/components/Avatar";
import CodeEditor from "@/components/CodeEditor";
import Whiteboard from "@/components/Whiteboard";
import { useProctor } from "@/lib/useProctor";
import { useAuth } from "@/components/AuthProvider";

type Phase = "setup" | "intro" | "interview" | "loading" | "debrief";

interface CurrentQ {
  questionId: string;
  topic: string;
  question: string;
  domain: Domain;
  isFollowUp: boolean;
  coding: boolean;
}

// mm:ss for the live session timer.
function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── shared control styles (design tokens) ──────────────────────────────────
const inputCls =
  "w-full rounded-lg border border-border bg-surface px-3.5 py-2.5 text-base text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/40 placeholder:text-muted/60";
const labelCls = "block text-[15px] font-medium text-foreground mb-1.5";
const primaryBtn =
  "rounded-xl bg-primary px-5 py-2.5 text-base font-semibold text-primary-foreground transition hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed";
const ghostBtn =
  "rounded-xl border border-border px-5 py-2.5 text-base font-medium text-foreground transition hover:bg-surface-2 disabled:opacity-50";
const card = "rounded-2xl border border-border bg-surface p-6 shadow-sm";

export default function Home() {
  const { user, openLogin } = useAuth();

  const [phase, setPhase] = useState<Phase>("setup");
  const [role, setRole] = useState("");
  const [company, setCompany] = useState("");
  const [domain, setDomain] = useState<SessionMode>("technical");
  const [sessionId, setSessionId] = useState("");
  const [current, setCurrent] = useState<CurrentQ | null>(null);
  const [mainQuestion, setMainQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [qNumber, setQNumber] = useState(0);
  const [debrief, setDebrief] = useState("");
  const [error, setError] = useState("");

  // Debrief "Questions & Answers" view (fetched on demand).
  const [qa, setQa] = useState<QAItem[] | null>(null);
  const [showQA, setShowQA] = useState(false);
  const [qaLoading, setQaLoading] = useState(false);

  // Live session timer (client-only).
  const [elapsedMs, setElapsedMs] = useState(0);
  const sessionStartRef = useRef<number | null>(null);

  // Voice layer (additive; text stays the fallback).
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceAvail, setVoiceAvail] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [bump, setBump] = useState(0);
  const spokenFor = useRef<string>("");
  const proctor = useProctor();

  const [sttEngine, setSttEngine] = useState<"browser" | "whisper">("browser");
  const [whisperAvail, setWhisperAvail] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  const [showBoard, setShowBoard] = useState(false);
  const [imageB64, setImageB64] = useState("");
  const [groundingNote, setGroundingNote] = useState<string | null>(null);

  // Feature-detect speech engines once.
  useEffect(() => {
    const browserOk = speechSupported();
    setVoiceAvail(browserOk || recordingSupported());
    sttStatus()
      .then((s) => {
        setWhisperAvail(s.available);
        if (!browserOk && s.available) setSttEngine("whisper");
      })
      .catch(() => setWhisperAvail(false));
  }, []);

  // In voice mode, speak each new question exactly once.
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

  // Tick the session timer while a session is in progress.
  useEffect(() => {
    if (phase !== "interview" && phase !== "loading") return;
    if (sessionStartRef.current == null) return;
    const id = setInterval(() => {
      if (sessionStartRef.current != null) {
        setElapsedMs(Date.now() - sessionStartRef.current);
      }
    }, 500);
    return () => clearInterval(id);
  }, [phase]);

  function toggleMic() {
    if (sttEngine === "whisper") {
      toggleWhisperRecording();
      return;
    }
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

  function toggleWhisperRecording() {
    if (listening) {
      stopRecording();
      setListening(false);
      return;
    }
    cancelSpeak();
    setSpeaking(false);
    setError("");
    startRecording({
      onStop: async (blob, mimeType) => {
        setListening(false);
        setTranscribing(true);
        try {
          const b64 = await blobToBase64(blob);
          const res = await transcribeAudio(b64, mimeTypeToFormat(mimeType));
          if (res.transcript) setAnswer(res.transcript);
          else setError("Didn't catch that - try again, or switch to Browser mode or typing.");
        } catch (err) {
          setError(
            "Server transcription failed (" + String(err) + "). Try Browser mode or type your answer."
          );
        } finally {
          setTranscribing(false);
        }
      },
      onError: (m) => {
        setError(m);
        setListening(false);
      },
    }).then((ok) => setListening(ok));
  }

  function beginIntro(e: React.FormEvent) {
    e.preventDefault();
    if (!role.trim()) return;
    if (!user) {
      openLogin();
      return;
    }
    setError("");
    setPhase("intro");
  }

  async function startInterview() {
    if (!user) {
      openLogin();
      return;
    }
    setError("");
    setPhase("loading");
    try {
      const res = await startSession({
        target_role: role.trim(),
        company: company.trim() || undefined,
        domain_focus: domain,
      });
      setSessionId(res.session_id);
      sessionStartRef.current = Date.now();
      setElapsedMs(0);
      setCurrent({
        questionId: res.question_id,
        topic: res.topic,
        question: res.question,
        domain: res.domain,
        isFollowUp: false,
        coding: res.coding,
      });
      setMainQuestion(res.question);
      setGroundingNote(res.grounding_note);
      setQNumber(1);
      setPhase("interview");
      proctor.start();
    } catch (err) {
      setError(String(err));
      setPhase("intro");
    }
  }

  async function processAnswer(payload: {
    session_id: string;
    question_id: string;
    transcript: string;
    image_b64?: string;
    skipped?: boolean;
  }) {
    stopListening();
    stopRecording();
    setListening(false);
    cancelSpeak();
    setSpeaking(false);
    setError("");
    setPhase("loading");
    try {
      const res: AnswerResponse = await submitAnswer(payload);
      setAnswer("");
      setImageB64("");
      setShowBoard(false);
      if (res.done) {
        proctor.stop();
        if (sessionStartRef.current != null) {
          setElapsedMs(Date.now() - sessionStartRef.current);
        }
        const report = await getDebrief(sessionId);
        setDebrief(report);
        setPhase("debrief");
        return;
      }
      setCurrent({
        questionId: res.next_question_id!,
        topic: res.topic!,
        question: res.question!,
        domain: res.domain,
        isFollowUp: res.is_follow_up,
        coding: res.coding,
      });
      setGroundingNote(res.grounding_note);
      if (!res.is_follow_up) {
        setQNumber((n) => n + 1);
        setMainQuestion(res.question!);
      }
      setPhase("interview");
    } catch (err) {
      setError(String(err));
      setPhase("interview");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!current || (!answer.trim() && !imageB64)) return;
    await processAnswer({
      session_id: sessionId,
      question_id: current.questionId,
      transcript: answer.trim(),
      image_b64: imageB64 || undefined,
    });
  }

  async function handleSkip() {
    if (!current) return;
    await processAnswer({
      session_id: sessionId,
      question_id: current.questionId,
      transcript: "",
      skipped: true,
    });
  }

  function reset() {
    cancelSpeak();
    stopListening();
    stopRecording();
    proctor.stop();
    setSpeaking(false);
    setListening(false);
    setTranscribing(false);
    setShowBoard(false);
    setImageB64("");
    spokenFor.current = "";
    setPhase("setup");
    setRole("");
    setCompany("");
    setCurrent(null);
    setMainQuestion("");
    setDebrief("");
    setQNumber(0);
    setGroundingNote(null);
    sessionStartRef.current = null;
    setElapsedMs(0);
    setQa(null);
    setShowQA(false);
  }

  async function toggleQA() {
    const next = !showQA;
    setShowQA(next);
    if (next && qa === null) {
      setQaLoading(true);
      try {
        setQa(await getSessionQA(sessionId));
      } catch (err) {
        setError(String(err));
      } finally {
        setQaLoading(false);
      }
    }
  }

  const sessionActive =
    phase === "interview" || phase === "loading" || phase === "debrief";

  return (
    <main className="flex min-h-screen flex-col items-center px-4 py-12">
      <div className="w-full max-w-2xl">
        <header className="mb-10 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-4xl font-bold tracking-tight text-foreground">
              EchoCoach
            </h1>
            <p className="mt-1.5 text-lg text-muted">
              The interviewer that remembers what you struggled with.
            </p>
          </div>
          {sessionStartRef.current !== null && sessionActive && (
            <div className="shrink-0 text-right" aria-label="Session timer">
              <div className="font-mono text-xl tabular-nums text-foreground">
                ⏱ {fmtDuration(elapsedMs)}
              </div>
              <div className="text-[11px] uppercase tracking-wide text-muted">
                {phase === "debrief" ? "total time" : "session time"}
              </div>
            </div>
          )}
        </header>

        {error && (
          <div className="mb-6 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </div>
        )}

        {phase === "setup" && (
          <form onSubmit={beginIntro} className="space-y-8">
            <div>
              <h2 className="text-2xl font-semibold text-foreground">
                {user ? `Welcome back, ${user.display_name.split(" ")[0]}.` : "Start a mock interview"}
              </h2>
              <p className="mt-1 text-base text-muted">
                Tell me the role you&apos;re targeting and I&apos;ll tailor the session.
              </p>
            </div>

            {!user && (
              <div className="rounded-xl border border-primary/30 bg-primary-subtle px-4 py-3 text-sm text-foreground">
                <button type="button" onClick={openLogin} className="font-semibold text-primary hover:underline">
                  Log in or sign up
                </button>{" "}
                to start a session — your weakness graph is saved to your account.
              </div>
            )}

            <div className="space-y-6">
              <div>
                <label className={labelCls}>
                  Target role <span className="text-primary">*</span>
                </label>
                <input
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="e.g. Senior Backend Engineer"
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>
                  Target company <span className="font-normal text-muted">(optional)</span>
                </label>
                <input
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="e.g. Stripe"
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>Interview type</label>
                <div className="inline-flex rounded-xl border border-border bg-surface p-1">
                  {(
                    [
                      ["technical", "Technical"],
                      ["behavioral", "Behavioral"],
                      ["full", "Full"],
                    ] as [SessionMode, string][]
                  ).map(([d, lbl]) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDomain(d)}
                      className={
                        "rounded-lg px-4 py-2 text-sm font-medium transition-colors " +
                        (domain === d
                          ? "bg-primary text-primary-foreground"
                          : "text-muted hover:text-foreground")
                      }
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <button type="submit" className={primaryBtn} disabled={!role.trim()}>
              Continue
            </button>
          </form>
        )}

        {phase === "intro" && (
          <div className="space-y-6">
            <div className={card}>
              <div className="mb-4 flex items-center gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                  EC
                </div>
                <div>
                  <p className="text-base font-semibold text-foreground">Your EchoCoach interviewer</p>
                  <p className="text-sm text-muted">{role}</p>
                </div>
              </div>
              <div className="space-y-3 text-base leading-relaxed text-foreground/90">
                <p>
                  Hi — thanks for making the time today. I&apos;ll be your interviewer for this{" "}
                  <span className="font-medium text-foreground">{role}</span> session.
                </p>
                <p>
                  I&apos;ll ask a few questions and dig in with follow-ups, just like a real interview.
                  Think out loud and answer as you naturally would — I won&apos;t grade you as we go.
                  At the end you&apos;ll get a short debrief on how it went.
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
          <div className="flex items-center gap-3 text-base text-muted">
            <span className="inline-flex gap-1">
              <span className="h-2.5 w-2.5 rounded-full bg-primary/60 animate-bounce [animation-delay:-0.3s]" />
              <span className="h-2.5 w-2.5 rounded-full bg-primary/60 animate-bounce [animation-delay:-0.15s]" />
              <span className="h-2.5 w-2.5 rounded-full bg-primary/60 animate-bounce" />
            </span>
            The interviewer is thinking…
          </div>
        )}

        {phase === "interview" && current && (
          <form onSubmit={handleSubmit} className="space-y-5">
            {proctor.warning && (
              <div className="flex items-start justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                <span>
                  ⚠️ {proctor.warning}{" "}
                  <span className="opacity-70">(focus warnings: {proctor.violations})</span>
                </span>
                <button type="button" onClick={proctor.dismiss} className="opacity-70 hover:opacity-100">
                  dismiss
                </button>
              </div>
            )}
            {groundingNote && (
              <p className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
                🔎 {groundingNote}
              </p>
            )}

            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full bg-surface-2 px-2.5 py-1 font-medium text-muted">
                  Question {qNumber}
                </span>
                <span className="rounded-full bg-surface-2 px-2.5 py-1 font-medium text-muted">
                  {current.topic.replace(/_/g, " ")}
                </span>
                {current.isFollowUp && (
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                    follow-up
                  </span>
                )}
              </div>
              {voiceAvail && (
                <div className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-xs">
                  {[
                    ["text", "Text"],
                    ["voice", "Voice"],
                  ].map(([m, lbl]) => {
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
                            stopRecording();
                            setSpeaking(false);
                            setListening(false);
                          } else {
                            spokenFor.current = "";
                          }
                        }}
                        className={
                          "rounded-md px-3 py-1.5 font-medium transition-colors " +
                          (active ? "bg-primary text-primary-foreground" : "text-muted hover:text-foreground")
                        }
                      >
                        {lbl}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {voiceMode && (speechSupported() || whisperAvail) && (
              <div className="flex justify-end">
                <div className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-xs">
                  {(
                    [
                      ["browser", "Browser", speechSupported()],
                      ["whisper", "Whisper", whisperAvail && recordingSupported()],
                    ] as [typeof sttEngine, string, boolean][]
                  ).map(([eng, lbl, avail]) => (
                    <button
                      key={eng}
                      type="button"
                      disabled={!avail}
                      onClick={() => setSttEngine(eng)}
                      title={avail ? undefined : `${lbl} isn't available in this browser`}
                      className={
                        "rounded-md px-3 py-1.5 font-medium transition-colors " +
                        (sttEngine === eng
                          ? "bg-primary text-primary-foreground"
                          : avail
                            ? "text-muted hover:text-foreground"
                            : "text-muted/40 cursor-not-allowed")
                      }
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {voiceMode && (
              <Avatar
                speaking={speaking}
                listening={listening}
                bump={bump}
                onReplay={() =>
                  current &&
                  speak(current.question, {
                    onStart: () => setSpeaking(true),
                    onBoundary: () => setBump((b) => b + 1),
                    onEnd: () => setSpeaking(false),
                  })
                }
              />
            )}

            {current.isFollowUp && mainQuestion && (
              <div className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-muted">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted/80">
                  Original question
                </span>
                {mainQuestion}
              </div>
            )}
            <p className="text-2xl leading-relaxed text-foreground">{current.question}</p>

            {current.coding ? (
              <CodeEditor value={answer} onChange={setAnswer} />
            ) : (
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                rows={voiceMode ? 5 : 8}
                placeholder={voiceMode ? "Your spoken answer appears here…" : "Type your answer…"}
                className={inputCls}
              />
            )}

            {showBoard && current.domain === "technical" && !current.coding && (
              <Whiteboard onChange={setImageB64} />
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" className={primaryBtn} disabled={!answer.trim() && !imageB64}>
                Submit answer
              </button>
              <button
                type="button"
                onClick={handleSkip}
                title="Skip this question — recorded as not attempted"
                className="rounded-xl border border-border px-5 py-2.5 text-base font-medium text-muted transition hover:bg-surface-2 hover:text-foreground"
              >
                Skip Question
              </button>
              {current.domain === "technical" && !current.coding && (
                <button
                  type="button"
                  onClick={() => setShowBoard((s) => !s)}
                  className={
                    "rounded-xl border px-5 py-2.5 text-base font-medium transition " +
                    (showBoard
                      ? "border-primary/40 bg-primary-subtle text-primary"
                      : "border-border text-foreground hover:bg-surface-2")
                  }
                >
                  🖊 {showBoard ? "Hide whiteboard" : "Whiteboard"}
                </button>
              )}
              {voiceMode && !current.coding && (
                <button
                  type="button"
                  onClick={toggleMic}
                  disabled={transcribing}
                  className={
                    "rounded-xl border px-5 py-2.5 text-base font-medium transition disabled:opacity-50 " +
                    (listening
                      ? "border-red-300 bg-red-50 text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300"
                      : "border-border text-foreground hover:bg-surface-2")
                  }
                >
                  {transcribing ? "Transcribing…" : listening ? "◼ Stop" : "🎤 Speak"}
                </button>
              )}
            </div>
          </form>
        )}

        {phase === "debrief" && (
          <div className="space-y-5">
            <h2 className="text-2xl font-semibold text-foreground">Session debrief</h2>

            {proctor.violations > 0 && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                Integrity note: you left the interview window{" "}
                <span className="font-medium">{proctor.violations}</span> time(s) during this session.
              </div>
            )}

            <div className={card}>
              <div className="mb-4 flex items-center justify-between gap-3">
                <h3 className="text-lg font-semibold text-foreground">
                  {showQA ? "Questions & Answers" : "Summary"}
                </h3>
                <button
                  type="button"
                  onClick={toggleQA}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-surface-2"
                >
                  {showQA ? "← Back to summary" : "Questions & Answers"}
                </button>
              </div>

              {showQA ? (
                <div className="space-y-3">
                  {qaLoading && <p className="text-sm text-muted">Loading…</p>}
                  {!qaLoading && qa && qa.length === 0 && (
                    <p className="text-sm text-muted">No questions were recorded.</p>
                  )}
                  {!qaLoading &&
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

            <button onClick={reset} className={ghostBtn}>
              New session
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
