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
  onBoundary?: () => void; // fires per word — used to pulse the avatar
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
