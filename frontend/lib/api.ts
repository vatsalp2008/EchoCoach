// Thin client for the EchoCoach backend. Base URL is overridable via
// NEXT_PUBLIC_API_BASE; defaults to the local FastAPI dev server.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export type Domain = "technical" | "behavioral";
export type SessionMode = "technical" | "behavioral" | "full";

export interface Profile {
  user_id: string;
  display_name: string;
}

export interface LoginResponse {
  user_id: string;
  display_name: string;
}

export async function getProfiles(): Promise<Profile[]> {
  const res = await fetch(`${API_BASE}/api/profiles`);
  if (!res.ok) throw new Error(`profiles failed: ${res.status}`);
  return res.json() as Promise<Profile[]>;
}

export async function login(user_id: string, pin: string): Promise<LoginResponse> {
  const res = await fetch(`${API_BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id, pin }),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("Wrong ID or PIN.");
    throw new Error(`login failed: ${res.status}`);
  }
  return res.json() as Promise<LoginResponse>;
}

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

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export function startSession(input: {
  target_role: string;
  company?: string;
  domain_focus?: SessionMode;
  user_id?: string;
}) {
  return post<StartSessionResponse>("/api/session", input);
}

export function submitAnswer(input: {
  session_id: string;
  question_id: string;
  transcript: string;
  image_b64?: string;
}) {
  return post<AnswerResponse>("/api/answer", input);
}

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

export async function getGraph(user = "default_user"): Promise<GraphData> {
  const res = await fetch(`${API_BASE}/api/graph?user=${encodeURIComponent(user)}`);
  if (!res.ok) throw new Error(`graph failed: ${res.status}`);
  return res.json() as Promise<GraphData>;
}

export async function getDebrief(sessionId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/session/${sessionId}/debrief`);
  if (!res.ok) throw new Error(`debrief failed: ${res.status}`);
  const data = (await res.json()) as { debrief: string };
  return data.debrief;
}
