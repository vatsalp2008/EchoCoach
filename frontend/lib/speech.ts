// Thin wrapper over the browser's Web Speech API (STT + TTS). Kept behind this
// interface so a later swap to Whisper / ElevenLabs touches only this file
// (spec 8.3). Everything degrades to no-ops when unsupported, so the text loop
// underneath is never affected.

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

export function speak(text: string, h: SpeakHandlers = {}): void {
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
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
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
