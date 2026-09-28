// Thin wrapper over the browser's Web Speech API (STT + TTS). Kept behind this
// interface so a later swap to Whisper / ElevenLabs touches only this file
// (spec 8.3). Everything degrades to no-ops when unsupported, so the text loop
// underneath is never affected.

import { synthesizeSpeech, ttsStatus } from "./api";

export interface ListenHandlers {
  onInterim?: (text: string) => void; // live partial transcript
  onFinal?: (text: string) => void; // full transcript when listening stops
  onError?: (msg: string) => void;
  onEnd?: () => void;
}

export interface SpeakHandlers {
  onStart?: () => void;
  onBoundary?: () => void; // fires per word - used to pulse the avatar
  onEnd?: () => void;
}

function getSR(): any {
  if (typeof window === "undefined") return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

export function speechSupported(): boolean {
  return !!getSR() && typeof window !== "undefined" && "speechSynthesis" in window;
}

let _rec: any = null;

export function startListening(h: ListenHandlers): boolean {
  const SR = getSR();
  if (!SR) {
    h.onError?.("Speech recognition isn't supported in this browser (try Chrome).");
    return false;
  }
  stopListening();
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";
  let finalText = "";
  rec.onresult = (e: any) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript + " ";
      else interim += r[0].transcript;
    }
    h.onInterim?.((finalText + interim).trim());
  };
  rec.onerror = (e: any) => h.onError?.(String(e?.error ?? "speech error"));
  rec.onend = () => {
    h.onFinal?.(finalText.trim());
    h.onEnd?.();
    _rec = null;
  };
  _rec = rec;
  rec.start();
  return true;
}

export function stopListening(): void {
  try {
    _rec?.stop();
  } catch {
    /* ignore */
  }
}

/** Speak with the server's neural voice when it's available, otherwise the
 * browser's built-in one. Same handlers either way. */
export function speak(text: string, h: SpeakHandlers = {}): void {
  cancelSpeak();
  const token = _speakToken;
  speakServer(text, h, token).then((ok) => {
    if (!ok && token === _speakToken) speakBrowser(text, h);
  });
}

function speakBrowser(text: string, h: SpeakHandlers): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    h.onEnd?.();
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.0;
  u.pitch = 1.0;
  u.onstart = () => h.onStart?.();
  u.onboundary = () => h.onBoundary?.();
  u.onend = () => h.onEnd?.();
  window.speechSynthesis.cancel(); // never overlap utterances
  window.speechSynthesis.speak(u);
}

export function cancelSpeak(): void {
  _speakToken++; // drops any server audio still being fetched/decoded
  try {
    _source?.stop();
  } catch {
    /* already stopped */
  }
  _source = null;
  _analyser = null;
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

// ── Server-side TTS (local Kokoro voice) - preferred over the browser voice ──
// The browser's SpeechSynthesis sounds robotic, so the backend renders each
// question with a neural voice and we play it through Web Audio - which also
// gives us the real signal for the avatar's visualizer. Any failure (engine not
// installed, network, autoplay blocked) falls back to speakBrowser above.

let _ctx: AudioContext | null = null;
let _source: AudioBufferSourceNode | null = null;
let _analyser: AnalyserNode | null = null; // set only while server audio plays
let _speakToken = 0;
let _serverTts: Promise<boolean> | null = null;
let _lastAudio: { text: string; buffer: AudioBuffer } | null = null; // makes replay instant

function audioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC =
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  _ctx ??= new AC();
  return _ctx;
}

// Browsers (Safari especially) only let an AudioContext start from a user
// gesture, but questions are spoken after an async fetch. Resuming it on any
// click/keypress keeps it unlocked for later playback.
if (typeof window !== "undefined") {
  const unlock = () => {
    if (_ctx?.state !== "running") audioCtx()?.resume();
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}

function serverTtsAvailable(): Promise<boolean> {
  _serverTts ??= ttsStatus()
    .then((s) => s.available)
    .catch(() => false);
  return _serverTts;
}

async function speakServer(text: string, h: SpeakHandlers, token: number): Promise<boolean> {
  const ctx = audioCtx();
  if (!ctx || !(await serverTtsAvailable())) return false;
  try {
    let buffer = _lastAudio?.text === text ? _lastAudio.buffer : null;
    if (!buffer) {
      const wav = await synthesizeSpeech(text);
      if (token !== _speakToken) return true; // superseded - stay quiet
      buffer = await ctx.decodeAudioData(wav);
      _lastAudio = { text, buffer };
    }
    if (token !== _speakToken) return true;
    // resume() never settles while autoplay is blocked, so don't wait forever.
    if (ctx.state !== "running") {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
    }
    if (token !== _speakToken) return true;
    if (ctx.state !== "running") return false; // still blocked - use the browser voice

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024; // ~21ms window - about one syllable
    analyser.smoothingTimeConstant = 0.75; // the value the visualizer was tuned with
    src.connect(analyser);
    analyser.connect(ctx.destination);

    // Loudness onsets stand in for the browser engine's word boundaries. The
    // thresholds (with hysteresis) were tuned on Kokoro output to land near
    // the speaking rate, ~3 pulses per second.
    const samples = new Uint8Array(analyser.fftSize);
    let loud = false;
    let raf = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / samples.length);
      if (!loud && rms > 0.04) {
        loud = true;
        h.onBoundary?.();
      } else if (loud && rms < 0.02) {
        loud = false;
      }
      raf = requestAnimationFrame(tick);
    };

    src.onended = () => {
      cancelAnimationFrame(raf);
      if (_source === src) _source = null;
      if (_analyser === analyser) _analyser = null;
      h.onEnd?.();
    };
    _source = src;
    _analyser = analyser;
    h.onStart?.();
    src.start();
    raf = requestAnimationFrame(tick);
    return true;
  } catch {
    return false;
  }
}

// Visualizer tuning, calibrated on Kokoro output through this exact analyser
// setup: speech loses ~7 dB/octave, so without the tilt the treble bands would
// never move; -70..-30 dB then lands typical speech mid-range, peaks near 1.
const LEVEL_F_LO = 120; // Hz
const LEVEL_F_HI = 7500;
const LEVEL_TILT_DB_PER_OCT = 6; // applied above 250 Hz
const LEVEL_DB_FLOOR = -70;
const LEVEL_DB_CEIL = -30;
let _spectrum: Float32Array<ArrayBuffer> | null = null;

/** While the server voice plays, fills `out` with per-band loudness (0..1,
 * log-spaced from low to high pitch) for the avatar's visualizer. Returns
 * false when there's no real audio to analyze (browser voice, or not speaking). */
export function getSpeechLevels(out: Float32Array): boolean {
  const a = _analyser;
  if (!a) return false;
  if (_spectrum?.length !== a.frequencyBinCount) _spectrum = new Float32Array(a.frequencyBinCount);
  a.getFloatFrequencyData(_spectrum);
  const binHz = a.context.sampleRate / a.fftSize;
  const n = out.length;
  for (let b = 0; b < n; b++) {
    const f0 = LEVEL_F_LO * (LEVEL_F_HI / LEVEL_F_LO) ** (b / n);
    const f1 = LEVEL_F_LO * (LEVEL_F_HI / LEVEL_F_LO) ** ((b + 1) / n);
    const lo = Math.max(1, Math.floor(f0 / binHz));
    const hi = Math.max(lo + 1, Math.floor(f1 / binHz));
    let sum = 0;
    for (let k = lo; k < hi; k++) sum += _spectrum[k];
    const tilt = LEVEL_TILT_DB_PER_OCT * Math.max(0, Math.log2(Math.sqrt(f0 * f1) / 250));
    const db = sum / (hi - lo) + tilt;
    out[b] = Math.min(1, Math.max(0, (db - LEVEL_DB_FLOOR) / (LEVEL_DB_CEIL - LEVEL_DB_FLOOR)));
  }
  return true;
}

// ── Server-side STT (Whisper) recording - a second, opt-in engine ───────────
// Records raw audio for the backend to transcribe, instead of the browser
// transcribing it live. Fully additive: nothing above this line is touched.

export interface RecordHandlers {
  onStop?: (blob: Blob, mimeType: string) => void;
  onError?: (msg: string) => void;
}

export function recordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window.MediaRecorder !== "undefined"
  );
}

let _recorder: MediaRecorder | null = null;

function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const t of candidates) {
    if (window.MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return ""; // let the browser pick its default
}

export async function startRecording(h: RecordHandlers): Promise<boolean> {
  if (!recordingSupported()) {
    h.onError?.("Microphone recording isn't supported in this browser.");
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickMimeType();
    const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop()); // release the mic
      const blob = new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" });
      h.onStop?.(blob, rec.mimeType || mimeType || "audio/webm");
      _recorder = null;
    };
    rec.onerror = () => h.onError?.("Recording failed.");
    _recorder = rec;
    rec.start();
    return true;
  } catch {
    h.onError?.("Microphone permission was denied or unavailable.");
    return false;
  }
}

export function stopRecording(): void {
  try {
    _recorder?.stop();
  } catch {
    /* ignore */
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < buf.length; i += chunkSize) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** "audio/webm;codecs=opus" -> "webm" - the container-format hint the backend
 * uses as a temp-file suffix so mlx_whisper's decoder gets the right extension. */
export function mimeTypeToFormat(mimeType: string): string {
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}
