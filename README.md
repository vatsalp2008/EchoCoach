# EchoCoach — the AI interviewer that refuses to forget

> Built for the Cognee **"The Hangover Part AI"** hackathon (WeMakeDevs) — open-source / self-hosted track.

## The story

The biggest hurdle in job hunting isn't a lack of knowledge — it's **interview amnesia**. Every mock interview starts from a blank slate: same generic questions, same generic feedback, the same mistakes repeated. If you struggled with system-design trade-offs on Monday, you shouldn't be answering easy trivia on Tuesday — you should be pressed on those exact trade-offs until you've mastered them.

**EchoCoach** is a personal AI interviewer that refuses to forget. It uses **Cognee's** hybrid graph-vector memory to maintain a permanent, evolving **"weakness graph"** of a candidate's interview performance. Every session it queries that graph, routes toward whatever you've struggled with or avoided, and probes deeper with real follow-ups — the way a skilled human interviewer would, except this one remembers every previous conversation.

Unlike company-facing screeners (e.g. Chakra by HackerRank) that assess you once in a single adaptive session, EchoCoach is built **for the candidate**, and its whole value is **persistence across many sessions over days and weeks**.

## Architecture

```
Next.js (App Router) ──HTTP──> FastAPI ──> Cognee (self-hosted memory)
  interview / graph / voice        │          SQLite + LanceDB + Kuzu (all local)
  code editor / whiteboard         │          embeddings: fastembed (local)
                                   ├─ Gemini  (grading, debrief, cognify, vision)
                                   └─ SQLite  (app bookkeeping + signal mirror)
```

- **`backend/app/memory.py`** is the *only* module that touches Cognee — the whole memory integration is auditable in one file.
- The interview loop grades each answer into strict JSON, writes it to a per-user topic dataset in Cognee, and routes the next question from the accumulated graph.

### How we used Cognee (honest breakdown)

We use Cognee's **V2 memory lifecycle** — `remember` / `recall` / `improve` / `forget` — for real, in two distinct ways:

| Cognee op | Where | What it does here |
|---|---|---|
| `remember()` | after every graded answer | writes the performance signal into `topic:<user>:<slug>`; also (Phase 3) ingests external company-context sources |
| `recall()` | start of each turn + question grounding | queries the weakness graph for what the candidate is weakest at, to route the session |
| `improve()` | end of every session | explicit graph reinforcement over each topic touched — a deliberate call *on top of* `remember()`'s per-call auto-improve |
| `forget()` | mastery threshold met | real dataset archival: a topic mastered ≥3× across ≥2 sessions is removed from rotation |

**What's Cognee vs. our code (we're precise about this):** the memory graph, embeddings, vector store, and graph store are all Cognee (self-hosted, local). The interview orchestration, grading rubric, follow-up cap, and the deterministic routing layer are our code. Routing *queries* Cognee via `recall()` and is backed by a local SQLite mirror of the same signals for reliability — so the demo never stalls if a network call is slow.

Why a **graph** and not a flat list: interview topics have genuine prerequisite/related structure (two-pointer → binary search, system design → distributed trade-offs), which is where Cognee's hybrid graph+vector approach earns its keep.

## Features

- **Persistent weakness graph** with session-over-session routing and mastery→archive
- **Live graph visualization** (`/graph`) — force-directed, colored by signal (red struggled · amber partial · green mastered · sky archived · gray unassessed)
- **Technical, Behavioral, and Full** interview modes with domain-appropriate grading
- **Per-user profiles** — each username gets its own memory graph
- **Voice mode** — Web Speech STT/TTS + a volume-driven avatar (text stays a fallback)
- **Code editor** (Monaco) for DSA questions
- **Whiteboard** — sketch a design; the multimodal grader (Gemini vision) sees it
- **Proctoring** — warns and tallies when you switch tabs / lose focus, like a real remote interview
- **Fallback-first everywhere** — heuristic grading + template debrief keep a session alive even when the LLM quota is exhausted

## Tech stack

- **Backend:** Python 3.11+ (tested on 3.14), FastAPI, Cognee 1.2.2 (self-hosted: SQLite + LanceDB + Kuzu), SQLite for app state
- **LLM:** Google Gemini via a one-file provider adapter (`llm_client.py`); embeddings via local `fastembed`
- **Frontend:** Next.js (App Router) + TypeScript + Tailwind, `react-force-graph-2d`, Monaco, Web Speech API

## Setup

```bash
# 1. Backend deps
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && cd ..

# 2. Frontend + root deps (root package.json runs both servers together)
cd frontend && npm install && cd .. && npm install

# 3. Env — copy the template and add your Gemini key + login PINs (see .env.example)
cp .env.example .env      # set GEMINI_API_KEY, LLM_API_KEY, PIN_VATSAL, PIN_SAKSHI

# 4. (Optional) prove the memory layer works end to end
backend/.venv/bin/python backend/scripts/cognee_smoke_test.py

# 5. (Optional) seed a demo user's graph so the demo opens with shape
backend/.venv/bin/python backend/scripts/seed_sessions.py demo

# 6. Run everything — one command, from the repo root
npm run dev              # backend on :8000, frontend on :3000
```

Log in with one of the two configured profiles (ID + PIN — see `.env`) at `http://localhost:3000`.

Voice mode is Chrome-only (Web Speech API); text mode works everywhere.

## What to look for (judging criteria)

- **Best use of Cognee:** the four-verb memory lifecycle used for real (`remember`/`recall`/`improve`/`forget`), including `forget()` as genuine dataset archival and an explicit session-boundary `improve()`.
- **Impact:** solves interview amnesia — the graph *routes* each session toward your weak spots.
- **The graph:** `/graph` visualizes the live weakness graph; run the seed script and watch a second session route around prior weak topics.
- **Engineering:** fallback-first around every external dependency, so the live demo never breaks on stage.

## AI-assistance disclosure

Per the hackathon rules, we disclose that this project was built with the assistance of an AI coding assistant (**Claude Code**), used for implementation, refactoring, and documentation. All architectural decisions, the product concept, and the use of Cognee were directed by the team; see `docs/DECISIONS.md` for the decision log.

## Docs

- `docs/DECISIONS.md` — architecture decision log (with trade-offs)
- `PROGRESS.md` — build progress + gotchas for contributors
- `docs/reddit_api_setup.md` — external-grounding credential setup (Phase 3)
