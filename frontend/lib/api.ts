// Thin client for the EchoCoach backend. Base URL is overridable via
// NEXT_PUBLIC_API_BASE; defaults to the local FastAPI dev server.
// Every call sends credentials so the HttpOnly session cookie flows.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export type Domain = "technical" | "behavioral";
export type SessionMode = "technical" | "behavioral" | "full";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.detail ?? "";
    } catch {
      /* ignore */
    }
    throw new Error(detail || `${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: "include" });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

// ── auth ──────────────────────────────────────────────────────────────────
export interface User {
  id: string;
  email: string;
  display_name: string;
}

export function signup(display_name: string, email: string, password: string) {
  return post<User>("/api/signup", { display_name, email, password });
}

export function login(email: string, password: string) {
  return post<User>("/api/login", { email, password });
}

/** Exchange a Google ID token (from the GIS button) for a session. */
export function googleSignin(credential: string) {
  return post<User>("/api/auth/google", { credential });
}

export function logout() {
  return post<{ ok: boolean }>("/api/logout", {});
}

/** Current user from the session cookie, or null if logged out (401). */
export async function getMe(): Promise<User | null> {
  const res = await fetch(`${API_BASE}/api/me`, { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`me failed: ${res.status}`);
  return res.json() as Promise<User>;
}

// ── session / interview ─────────────────────────────────────────────────────
export interface StartSessionResponse {
  session_id: string;
  question_id: string;
  topic: string;
  question: string;
  domain: Domain;
  coding: boolean;
  grounding_note: string | null;
}

export interface AnswerResponse {
  next_question_id: string | null;
  topic: string | null;
  question: string | null;
  domain: Domain;
  is_follow_up: boolean;
  coding: boolean;
  grounding_note: string | null;
  done: boolean;
}

export function startSession(input: {
  target_role: string;
  company?: string;
  domain_focus?: SessionMode;
}) {
  return post<StartSessionResponse>("/api/session", input);
}

export function submitAnswer(input: {
  session_id: string;
  question_id: string;
  transcript: string;
  image_b64?: string;
  skipped?: boolean;
}) {
  return post<AnswerResponse>("/api/answer", input);
}

// ── weakness graph ──────────────────────────────────────────────────────────
export interface GraphNode {
  id: string;
  label: string;
  domain: Domain;
  signal: "mastered" | "partial" | "struggled" | "avoided" | "unassessed";
  interactions: number;
  last_seen: string | null;
  archived: boolean;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: { source: string; target: string }[];
}

export function getGraph(user: string): Promise<GraphData> {
  return getJson<GraphData>(`/api/graph?user=${encodeURIComponent(user)}`);
}

// ── debrief + Q&A ─────────────────────────────────────────────────────────
export async function getDebrief(sessionId: string): Promise<string> {
  const data = await getJson<{ debrief: string }>(`/api/session/${sessionId}/debrief`);
  return data.debrief;
}

export interface QAItem {
  topic: string;
  is_follow_up: boolean;
  question: string;
  answer: string;
  skipped: boolean;
}

export async function getSessionQA(sessionId: string): Promise<QAItem[]> {
  const data = await getJson<{ qa: QAItem[] }>(`/api/session/${sessionId}/qa`);
  return data.qa;
}

export interface SessionSummary {
  id: string;
  started_at: string;
  ended_at: string | null;
  domain_focus: SessionMode;
  company: string | null;
  n_questions: number;
}

export async function getSessions(): Promise<SessionSummary[]> {
  const data = await getJson<{ sessions: SessionSummary[] }>("/api/sessions");
  return data.sessions;
}

// ── speech-to-text ─────────────────────────────────────────────────────────
export interface TranscribeResponse {
  transcript: string;
}

export function transcribeAudio(audio_b64: string, format = "webm") {
  return post<TranscribeResponse>("/api/transcribe", { audio_b64, format });
}

export async function sttStatus(): Promise<{ available: boolean; model: string }> {
  return getJson<{ available: boolean; model: string }>("/api/stt/status");
}
