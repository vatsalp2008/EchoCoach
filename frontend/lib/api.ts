// Thin client for the EchoCoach backend. Base URL is overridable via
// NEXT_PUBLIC_API_BASE; defaults to the local FastAPI dev server.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export type Domain = "technical" | "behavioral";
export type SessionMode = "technical" | "behavioral" | "full";

export interface StartSessionResponse {
  session_id: string;
  question_id: string;
  topic: string;
  question: string;
}

export interface AnswerResponse {
  next_question_id: string | null;
  topic: string | null;
  question: string | null;
  is_follow_up: boolean;
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
