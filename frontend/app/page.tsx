"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  AnswerResponse,
  Domain,
  getDebrief,
  getProfiles,
  getSessionQA,
  login,
  Profile,
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

type Phase = "login" | "setup" | "intro" | "interview" | "loading" | "debrief";

// mm:ss for the live session timer.
function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface CurrentQ {
  questionId: string;
  topic: string;
  question: string;
  domain: Domain;
  isFollowUp: boolean;
  coding: boolean;
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>("login");

  // Login (ID + PIN, 2 known users - see backend/app/auth.py).
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [userId, setUserId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [selectedProfile, setSelectedProfile] = useState<string>("");
  const [pin, setPin] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  const [role, setRole] = useState("");
  const [company, setCompany] = useState("");
  const [domain, setDomain] = useState<SessionMode>("technical");
  const [sessionId, setSessionId] = useState("");
  const [current, setCurrent] = useState<CurrentQ | null>(null);
  // The last main (non-follow-up) question, kept so it can be shown as context
  // while the interviewer probes it with follow-ups.
  const [mainQuestion, setMainQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [qNumber, setQNumber] = useState(0);
  const [debrief, setDebrief] = useState("");
  const [error, setError] = useState("");

  // Debrief "Questions & Answers" view (fetched on demand).
  const [qa, setQa] = useState<QAItem[] | null>(null);
  const [showQA, setShowQA] = useState(false);
  const [qaLoading, setQaLoading] = useState(false);

  // Live session timer (client-only; no backend involvement).
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

  // STT engine choice: browser (Web Speech, live transcript) vs whisper
  // (record -> upload -> server transcribes). Browser stays the default -
  // least risk to the already-working path (spec-style: additive, not a swap).
  const [sttEngine, setSttEngine] = useState<"browser" | "whisper">("browser");
  const [whisperAvail, setWhisperAvail] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  // Whiteboard sketch (optional, non-coding questions).
  const [showBoard, setShowBoard] = useState(false);
  const [imageB64, setImageB64] = useState("");

  // Phase 3: unobtrusive note once company-specific grounding kicks in (spec 7.8).
  const [groundingNote, setGroundingNote] = useState<string | null>(null);

  // Restore a saved login (client-only) + feature-detect speech.
  useEffect(() => {
    const savedId = localStorage.getItem("echocoach_user");
    const savedName = localStorage.getItem("echocoach_display_name");
    if (savedId && savedName) {
      setUserId(savedId);
      setDisplayName(savedName);
      setPhase("setup");
    } else {
      getProfiles()
        .then(setProfiles)
        .catch(() => setLoginError("Could not reach the server. Is the backend running?"));
    }
    const browserOk = speechSupported();
    setVoiceAvail(browserOk || recordingSupported());
    sttStatus()
      .then((s) => {
        setWhisperAvail(s.available);
        // Default to whichever works; prefer Browser when both do (least risk).
        if (!browserOk && s.available) setSttEngine("whisper");
      })
      .catch(() => setWhisperAvail(false));
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProfile || !pin.trim()) return;
    setLoginError("");
    setLoggingIn(true);
    try {
      const res = await login(selectedProfile, pin.trim());
      localStorage.setItem("echocoach_user", res.user_id);
      localStorage.setItem("echocoach_display_name", res.display_name);
      setUserId(res.user_id);
      setDisplayName(res.display_name);
      setPin("");
      setPhase("setup");
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoggingIn(false);
    }
  }

  function logout() {
    localStorage.removeItem("echocoach_user");
    localStorage.removeItem("echocoach_display_name");
    setUserId("");
    setDisplayName("");
    setSelectedProfile("");
    setPin("");
    getProfiles().then(setProfiles).catch(() => {});
    setPhase("login");
  }

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

  // Tick the session timer live while a session is in progress (interview turns
  // and the brief "thinking" loads between them).
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
            "Server transcription failed (" +
              String(err) +
              "). Try Browser mode or type your answer."
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
        user_id: userId,
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
      setMainQuestion(res.question); // first question is always a main question
      setGroundingNote(res.grounding_note);
      setQNumber(1);
      setPhase("interview");
      proctor.start(); // begin focus monitoring for the session
    } catch (err) {
      setError(String(err));
      setPhase("intro");
    }
  }

  // Shared submit path for both a real answer and a Skip. Keeps the response
  // handling (follow-up vs next vs done) in one place.
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
          setElapsedMs(Date.now() - sessionStartRef.current); // freeze final time
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
        setMainQuestion(res.question!); // new topic -> this becomes the context
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

  // "Skip / Don't know": no answer needed; backend records it as 'avoided'.
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

  const inputCls =
    "w-full rounded-lg bg-white border border-neutral-300 px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900";
  const primaryBtn =
    "rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <main className="min-h-screen bg-neutral-50 text-neutral-900 flex flex-col items-center px-4 py-12">
      <div className="w-full max-w-2xl">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">EchoCoach</h1>
            <p className="text-sm text-neutral-500">
              The interviewer that remembers what you struggled with.
            </p>
          </div>
          {sessionStartRef.current !== null &&
            (phase === "interview" || phase === "loading" || phase === "debrief") && (
              <div className="shrink-0 text-right" aria-label="Session timer">
                <div className="font-mono text-lg tabular-nums text-neutral-900">
                  ⏱ {fmtDuration(elapsedMs)}
                </div>
                <div className="text-[11px] uppercase tracking-wide text-neutral-500">
                  {phase === "debrief" ? "total time" : "session time"}
                </div>
              </div>
            )}
        </header>

        {error && (
          <div className="mb-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {phase === "login" && (
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-2">
                Who&apos;s interviewing?
              </label>
              <div className="grid grid-cols-2 gap-3">
                {profiles.map((p) => (
                  <button
                    key={p.user_id}
                    type="button"
                    onClick={() => setSelectedProfile(p.user_id)}
                    className={
                      "rounded-lg border px-4 py-3 text-sm font-medium " +
                      (selectedProfile === p.user_id
                        ? "border-neutral-900 bg-neutral-900 text-white"
                        : "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100")
                    }
                  >
                    {p.display_name}
                  </button>
                ))}
              </div>
            </div>
            {selectedProfile && (
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">
                  PIN
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder="••••"
                  className={inputCls}
                  autoFocus
                />
              </div>
            )}
            {loginError && (
              <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
                {loginError}
              </div>
            )}
            <button
              type="submit"
              className={primaryBtn}
              disabled={!selectedProfile || !pin.trim() || loggingIn}
            >
              {loggingIn ? "Checking…" : "Log in"}
            </button>
          </form>
        )}

        {phase === "setup" && (
          <form onSubmit={beginIntro} className="space-y-4">
            <div className="flex items-center justify-between text-sm text-neutral-600">
              <span>
                Signed in as <span className="font-medium text-neutral-900">{displayName}</span>
              </span>
              <button
                type="button"
                onClick={logout}
                className="text-neutral-500 hover:text-neutral-900 underline"
              >
                not you?
              </button>
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
                  Hi - thanks for making the time today. I&apos;ll be your interviewer for
                  this <span className="font-medium">{role}</span> session.
                </p>
                <p>
                  Here&apos;s how this works: I&apos;ll ask you a few questions and dig in
                  with follow-ups, just like a real interview. Think out loud and answer
                  as you naturally would - I won&apos;t grade you as we go. At the end
                  you&apos;ll get a short debrief on how it went.
                </p>
                <p>Ready when you are.</p>
              </div>
            </div>
            <button onClick={startInterview} className={primaryBtn}>
              I&apos;m ready - begin
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
            {proctor.warning && (
              <div className="flex items-start justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <span>
                  ⚠️ {proctor.warning}{" "}
                  <span className="text-amber-600">
                    (focus warnings: {proctor.violations})
                  </span>
                </span>
                <button
                  type="button"
                  onClick={proctor.dismiss}
                  className="text-amber-600 hover:text-amber-900"
                >
                  dismiss
                </button>
              </div>
            )}
            {groundingNote && (
              <p className="text-xs text-sky-700 bg-sky-50 border border-sky-200 rounded-lg px-3 py-1.5">
                🔎 {groundingNote}
              </p>
            )}
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
                            stopRecording();
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

            {voiceMode && (speechSupported() || whisperAvail) && (
              <div className="flex justify-end">
                <div className="inline-flex rounded-lg border border-neutral-200 p-0.5 bg-white text-xs">
                  {(
                    [
                      ["browser", "Browser", speechSupported()],
                      ["whisper", "Whisper", whisperAvail && recordingSupported()],
                    ] as [typeof sttEngine, string, boolean][]
                  ).map(([eng, label, avail]) => (
                    <button
                      key={eng}
                      type="button"
                      disabled={!avail}
                      onClick={() => setSttEngine(eng)}
                      title={avail ? undefined : `${label} isn't available in this browser`}
                      className={
                        "rounded-md px-2.5 py-1 " +
                        (sttEngine === eng
                          ? "bg-neutral-900 text-white"
                          : avail
                            ? "text-neutral-600 hover:text-neutral-900"
                            : "text-neutral-300 cursor-not-allowed")
                      }
                    >
                      {label}
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
              <div className="rounded-lg border border-neutral-200 bg-neutral-100 px-3 py-2 text-sm text-neutral-600">
                <span className="mb-0.5 block text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                  Original question
                </span>
                {mainQuestion}
              </div>
            )}
            <p className="text-lg leading-relaxed">{current.question}</p>

            {current.coding ? (
              <CodeEditor value={answer} onChange={setAnswer} />
            ) : (
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                rows={voiceMode ? 5 : 8}
                placeholder={
                  voiceMode ? "Your spoken answer appears here…" : "Type your answer…"
                }
                className={inputCls}
              />
            )}

            {showBoard && current.domain === "technical" && !current.coding && (
              <Whiteboard onChange={setImageB64} />
            )}

            <div className="flex items-center gap-3">
              <button
                type="submit"
                className={primaryBtn}
                disabled={!answer.trim() && !imageB64}
              >
                Submit answer
              </button>
              <button
                type="button"
                onClick={handleSkip}
                title="Skip this question — recorded as not attempted"
                className="rounded-lg px-4 py-2 text-sm font-medium border border-neutral-300 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
              >
                Skip Question
              </button>
              {current.domain === "technical" && !current.coding && (
                <button
                  type="button"
                  onClick={() => setShowBoard((s) => !s)}
                  className={
                    "rounded-lg px-4 py-2 text-sm font-medium border " +
                    (showBoard
                      ? "border-sky-300 bg-sky-50 text-sky-700"
                      : "border-neutral-300 text-neutral-700 hover:bg-neutral-100")
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
                    "rounded-lg px-4 py-2 text-sm font-medium border disabled:opacity-50 " +
                    (listening
                      ? "border-red-300 bg-red-50 text-red-700"
                      : "border-neutral-300 text-neutral-700 hover:bg-neutral-100")
                  }
                >
                  {transcribing ? "Transcribing…" : listening ? "◼ Stop" : "🎤 Speak"}
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

            {proctor.violations > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Integrity note: you left the interview window{" "}
                <span className="font-medium">{proctor.violations}</span> time(s)
                during this session.
              </div>
            )}

            <div className="relative rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
              {/* Toggle sits beside the section heading; it swaps the whole
                  card between the summary and the full Q&A transcript. */}
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-lg font-semibold">
                  {showQA ? "Questions & Answers" : "Summary"}
                </h3>
                <button
                  type="button"
                  onClick={toggleQA}
                  className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100"
                >
                  {showQA ? "← Back to summary" : "Questions & Answers"}
                </button>
              </div>

              {showQA ? (
                <div className="space-y-3">
                  {qaLoading && <p className="text-sm text-neutral-500">Loading…</p>}
                  {!qaLoading && qa && qa.length === 0 && (
                    <p className="text-sm text-neutral-500">No questions were recorded.</p>
                  )}
                  {!qaLoading &&
                    qa?.map((item, i) => (
                      <div
                        key={i}
                        className="border-b border-neutral-100 pb-3 last:border-0 last:pb-0"
                      >
                        <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-neutral-400">
                          <span>{item.topic.replace(/_/g, " ")}</span>
                          {item.is_follow_up && (
                            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-amber-700 normal-case">
                              follow-up
                            </span>
                          )}
                        </div>
                        <p className="text-sm font-medium text-neutral-900">{item.question}</p>
                        {item.skipped ? (
                          <p className="mt-1 text-sm font-medium text-amber-700">⤼ Skipped</p>
                        ) : (
                          <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-600">
                            {item.answer || <span className="italic text-neutral-400">(no answer)</span>}
                          </p>
                        )}
                      </div>
                    ))}
                </div>
              ) : (
                // Strip the debrief's own leading "## Summary" — the card supplies it.
                <article className="prose prose-sm prose-neutral max-w-none">
                  <ReactMarkdown>{debrief.replace(/^\s*##\s*Summary\s*\n/i, "")}</ReactMarkdown>
                </article>
              )}
            </div>
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
