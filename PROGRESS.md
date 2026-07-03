# EchoCoach — Build Progress (teammate reference)

Living doc of **what's done** and **what's left**. Update it as you land work.
Last verified: core loop + Phase 2 + voice + code editor + whiteboard + proctoring
+ ID+PIN login for 2 users + single `npm run dev` all working end-to-end; README +
demo seed done. Only external grounding (Reddit/GitHub) and UI polish remain.

---

## What EchoCoach is (1 paragraph)
A personal AI interviewer that **refuses to forget**. It uses **Cognee** (open-source,
self-hosted hybrid graph+vector memory) to keep an evolving "weakness graph" of a
candidate's interview performance, routes each new session toward what they struggled
with, and probes with real follow-ups. Built for the Cognee "Hangover Part AI"
hackathon (WeMakeDevs) — **open-source / self-hosted track** (MacBook prize).

Full spec: [`echocoach_build_spec.md`](echocoach_build_spec.md). Build plan lives in
the spec's 5 phases; we execute them in order, each demoable before the next.

---

## ✅ Done — Phase 0 (environment + Cognee gate)
- Standalone git repo initialized in this dir (parent `~` is a separate repo — don't be confused).
- `backend/.venv` (Python 3.14.2) with cognee 1.2.2 + deps (`backend/requirements.txt`).
- Cognee configured for **100% local** storage: SQLite + LanceDB + Kuzu, stored in
  repo-local `backend/.cognee_data` / `backend/.cognee_system` (gitignored).
- **Verified the full memory lifecycle passes** against real Cognee + Gemini:
  `remember → recall → improve → forget` (run `backend/scripts/cognee_smoke_test.py`).
- Single Cognee integration surface: [`backend/app/memory.py`](backend/app/memory.py).
  Nothing else imports `cognee` directly.

### Confirmed Cognee API (introspected from installed 1.2.2 — use these, not guesses)
| Op | Real signature (relevant args) |
|----|-------------------------------|
| `remember` | `remember(data, dataset_name=..., *, run_in_background=False, self_improvement=True)` → `RememberResult` |
| `recall` | `recall(query_text, *, datasets=[...], top_k=15, query_type=None)` → list of Response entries |
| `improve` | `improve(dataset=..., *, run_in_background=False)` — **one dataset per call** |
| `forget` | `forget(*, dataset=..., dataset_id=..., everything=False)` |
| status | `cognee.datasets.get_status([ids])`, `list_datasets()`, `has_data()` (Phase 2/3) |

---

## ⚠️ Gotchas discovered (save yourself the pain)
1. **Gemini model availability on our free-tier key:**
   - ✅ works: `gemini-2.5-flash` (app grading/debrief), `gemini-2.5-flash-lite` (Cognee cognify), `gemini-embedding-001` (3072 dims).
   - ❌ quota-0 / not found: `gemini-2.0-flash`, `gemini-2.0-flash-lite`, `text-embedding-004`.
2. **Do NOT set `LLM_ENDPOINT` for the gemini provider** — LiteLLM routes `gemini/*`
   natively; an override hangs Cognee's 30s LLM connection test (cognee issue #1530).
3. **Disable Cognee's DB subprocess workers** (`set_graph_database_subprocess_enabled(False)`,
   `set_vector_db_subprocess_enabled(False)`) — the default out-of-process Kuzu worker
   holds a file lock that collides when sequential ops (remember → forget) run in one
   process. Already handled in [`config.py`](backend/app/config.py).
4. `improve()` takes **one** dataset (default `main_dataset`) — call it per topic
   dataset at session end, not bare, or it 404s on an empty graph.
5. If a run crashes mid-op you may leave a stray Kuzu worker holding a lock:
   `pkill -9 -f cognee_db_workers` then delete `backend/.cognee_data` + `backend/.cognee_system`.
6. **⚠️ Need a standard AIza Gemini key (current blocker).** The key in use
   (`AQ.…`) is capped at **~20 requests/day** — exhausted instantly. Get a normal
   AI Studio key (`AIza…`, ~1000/day free) at aistudio.google.com/apikey and put
   it in `.env` as `GEMINI_API_KEY` and `LLM_API_KEY`.
7. **Local Ollama for cognify does NOT work** (tested, see ADR-011). Both
   `llama3.1:8b` and `mistral:latest` fail cognee's structured graph extraction
   (`InstructorRetryException`) and take minutes per call. Cognee's cognify runs
   on **Gemini**; embeddings stay local on **fastembed**. Don't retry Ollama for cognify.
8. **Cognee retries a 429 for up to 240s** (`retry_config.py`: `stop_after_attempt(2)
   & stop_after_delay(240)`, not env-configurable). So NEVER `await` a cognify write
   on the request path. Graph writes go through `memory.schedule_remember()` —
   fire-and-forget, `asyncio.wait_for`-bounded (45s), and circuit-broken (300s cooldown
   after a quota failure). `run_in_background=True` is NOT enough: it hides the
   exception so the breaker can't trip and the retry storms pile up.
9. **Bug found live + fixed: heuristic grading substring false-positive.**
   `grading.py`'s no-LLM fallback (`_heuristic_assessment`, used whenever Gemini
   quota is exhausted — which happens often given gotcha #6) checked dodge markers
   with naive `"pass" in text` / `"skip" in text`. This matched **inside real
   words** — e.g. "impasse" contains "pass" — so a full, detailed, well-structured
   behavioral answer got graded `avoided` just because it used the word "impasse."
   Fixed with `\b`-word-boundary regexes (`_HEDGE_PATTERNS` / `_DODGE_PATTERNS`).
   **Lesson: any future heuristic/text-matching code must use word boundaries, not
   raw substring `in` checks.** Editing `grading.py` triggers uvicorn `--reload`,
   which wipes in-memory `_ACTIVE` sessions — anyone mid-interview when this kind
   of fix lands needs to restart their session (turn state isn't persisted).
10. **`get_status()` needs UUID objects, but `remember()` returns the dataset id
   as a `str`** — passing the str straight through raises
   `StatementError: 'str' object has no attribute 'hex'` (SQLAlchemy's UUID bind).
   `grounding.py` coerces via `_as_uuid()` before polling. (Phase 3.)
11. **(cosmetic, known)** The `google-genai` async client isn't explicitly closed,
    so scripts/one-off runs print `Unclosed client session` / `Unclosed connector`
    (aiohttp) warnings at exit. Harmless — no leak in the long-running server.
    Fix later with an explicit `client.aclose()` on shutdown.

## Hackathon compliance (don't lose points / get DQ'd)
- **MUST disclose AI-assistant use (Claude Code) in the README** — non-disclosure is
  an automatic disqualification. (Separate from our "no Claude in commit messages"
  convention — commits stay clean, README discloses.)
- Coding started within the event window (Jun 29–Jul 5 2026) ✅. Cognee powers memory ✅.
  Self-hosted open-source track (MacBook) ✅. Teams own IP ✅.
- Full rules/resources: `docs/` + wemakedevs.org/hackathons/cognee/rules|resources.

---

## Setup (for a teammate cloning fresh)
```bash
# 1. Python backend
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd ..

# 2. Frontend deps + root dev-orchestration deps (concurrently)
cd frontend && npm install && cd ..
npm install    # root package.json — installs `concurrently`

# 3. Secrets — copy the template and fill in the Gemini key (+ login PINs, Reddit/GitHub later)
cp .env.example .env    # then edit .env

# 4. Prove Cognee works end to end (one-time sanity check, not needed every run)
backend/.venv/bin/python backend/scripts/cognee_smoke_test.py
# expect: "[ok] Full remember -> recall -> improve -> forget loop passed."

# 5. Run everything with ONE command from the repo root
npm run dev
# -> backend on :8000 (with --reload), frontend on :3000, both logs interleaved.
# Ctrl+C stops both. (Prefer running them in separate terminals? See below.)
```
`.env` is gitignored — never commit the key/PINs. `.env.example` documents every var.

Prefer separate terminals (to watch each log cleanly) instead of the combined
`npm run dev`? Run these in two tabs:
```bash
cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000
cd frontend && npm run dev
```

---

## ✅ Done (verified end-to-end)
- [x] **Core loop (Phase 1).** schemas (§4.2), question bank (§5.1), grading prompts
      (§5.2 verbatim), follow-up cap=2 (§5.3), no-feedback-leakage (§5.3a), session
      loop (§5.4), first-session diagnostic (§5.5), debrief (§5.6, short + markdown),
      SQLite, FastAPI. Full session over HTTP with real Gemini (`scripts/http_smoke.py`).
- [x] **Quota resilience.** heuristic grading + template debrief + graph writes that are
      fire-and-forget / time-bounded / circuit-broken so cognify quota-retries never hang
      a turn (`scripts/test_fallbacks.py` passes under total simulated failure).
- [x] **Behavioral domain + Full mode (Phase 2).** behavioral bank + rubric (§6.2 verbatim,
      delivery affects signal); technical/behavioral/**full** session modes.
- [x] **Weakness-graph viz.** `/api/graph` + `react-force-graph-2d` at `/graph`, colored by signal.
- [x] **Per-user profiles.** user_id scopes the memory graph (datasets `topic:<user>:<slug>`,
      signals filtered by user, `/api/graph?user=`).
- [x] **Login: ID + PIN for 2 known users.** `backend/app/auth.py` — `vatsal` / `sakshi`,
      PINs from env (`PIN_VATSAL`, `PIN_SAKSHI`, demo defaults `1111`/`2222`). Endpoints:
      `GET /api/profiles` (public list for the picker), `POST /api/login` (401 on bad
      id/pin). Frontend gained a "login" phase before "setup": pick a profile card, enter
      PIN, session persists in localStorage (`echocoach_user` id + `echocoach_display_name`)
      until "not you?" logs out. This **replaces** the old free-text name field — no more
      typed usernames, only the two registered profiles. Not real auth (no hashing/sessions/
      tokens) — deliberately minimal for a 2-person local demo; see `docs/DECISIONS.md` ADR-012.
- [x] **No follow-ups on pure DSA/coding questions.** A LeetCode-style problem has one
      approach to grade, not a "dig deeper" probe — real interviewers don't do that for a
      coding question. `session.py`'s `submit_answer` now checks `is_coding(topic)`
      (from `question_bank.py`) and skips the whole follow-up branch for coding topics —
      graded and moved on regardless of `follow_up_needed`. Behavioral/non-coding technical
      topics are unaffected (follow-up cap=2 logic unchanged there). See ADR-013.
- [x] **Single `npm run dev` from the repo root.** Root `package.json` (+ `concurrently`)
      runs the FastAPI backend (`--reload`, :8000) and the Next.js frontend (:3000)
      together, prefixed `[backend]`/`[frontend]` in one terminal; Ctrl+C stops both.
      Gotcha hit + fixed: adding a root `package-lock.json` made Next/Turbopack mis-detect
      its workspace root (picked the repo root instead of `frontend/`), which broke the
      React Server Components module manifest (`GET / 500`, "Could not find the module...
      in the React Client Manifest"). Fixed by pinning `turbopack.root` explicitly in
      `frontend/next.config.ts`. See ADR-014.
- [x] **Voice + avatar (Phase 4).** `lib/speech.ts` (Web Speech STT/TTS) + pulsing `Avatar`;
      text stays the fallback via a toggle. Chrome-only for voice.
- [x] **Code editor.** Monaco for DSA topics (backend `coding` flag).
- [x] **Whiteboard.** sketch → base64 PNG → **Gemini vision grading** (verified working).
- [x] **Proctoring.** tab-switch / blur / fullscreen-exit detection, warnings + tally.
- [x] **Demo readiness.** `README.md` (incl. mandatory AI-disclosure + How-we-used-Cognee),
      `docs/DECISIONS.md`, `scripts/seed_sessions.py` (seeds a shaped demo graph — run
      `seed_sessions.py demo`, then log in as `demo` and open `/graph`).
- [x] **External grounding (Phase 3) — built AND wired in.** Sakshi built
      `backend/app/grounding.py` (615 lines) as a fully isolated module — same "one
      auditable surface" discipline as `memory.py` — for Reddit (PRAW) + GitHub
      discovery, an LLM (with keyword-fallback) relevance filter, ingest into
      `company_context:<slug>` via the existing `memory.remember()`, and background
      polling via `memory.dataset_status()`. She deliberately did NOT touch
      `session.py`/`main.py` (isolation — Phase 1/2 stays untouched and safe).
      **Wired in afterward** (`session.py`): `start_session()` now calls
      `grounding.ensure_company_context(company, background=True)` when a company is
      given (returns instantly; the real fetch/filter/ingest runs detached); every
      freshly-presented (non-follow-up) question is passed through
      `grounding.ground_question()`, which rewrites it against real reported context
      once ready and otherwise returns it unchanged; `StartSessionResponse`/
      `AnswerResponse` gained `grounding_note` (spec 7.8's unobtrusive "now using real
      reports from r/leetcode, GitHub" banner), shown in the frontend just above the
      question. **Verified live** against a real company ("Stripe"): correctly skipped
      Reddit (no creds — see `docs/reddit_api_setup.md`), found a real GitHub repo,
      passed the LLM relevance filter, ingested into Cognee — cognify didn't finish
      within the 80s poll window this run (a slow-cognify/quota timing issue, not a
      wiring bug) and degraded to `Status.ERROR` exactly as designed: no crash, no
      block, `grounding_note` stays hidden, the interview and debrief completed
      normally throughout. **The company field is no longer inert.**

## 🚧 Remaining
- [ ] **UI polish pass** (deferred by decision — do after core features).
- [ ] **Rehearsals** — 2 full run-throughs in Chrome before submission.
- [ ] (nicety) `scripts/phase1_e2e.py` 2-session routing assertion when convenient.
- [ ] (nicety) Set up real Reddit credentials (`docs/reddit_api_setup.md`) so grounding
      isn't GitHub-only.

---

## File map (current)
```
README.md                    story, architecture, How-we-used-Cognee, AI disclosure
echocoach_build_spec.md      full spec
PROGRESS.md                  this file
package.json                 root — `npm run dev` runs backend+frontend via concurrently
docs/DECISIONS.md            ADR log (with tradeoffs)
docs/reddit_api_setup.md     Phase 3 creds guide
.env.example / .env          env template / real secrets (gitignored) — incl. PIN_VATSAL/PIN_SAKSHI
backend/
  requirements.txt
  app/
    config.py                env load + cognee local/Gemini config
    memory.py                the ONLY cognee wrapper (remember/recall/improve/forget + breaker)
    llm_client.py            Gemini adapter (JSON + multimodal image; quota detection)
    auth.py                  2-user ID+PIN registry (vatsal/sakshi) + verify()
    grading.py               technical + behavioral rubrics (verbatim) + heuristic fallback
    session.py               loop, follow-up cap (skipped for coding topics), routing,
                              mastery, per-user, full mode
    debrief.py               concise end-of-session report (+ template fallback)
    question_bank.py         technical + behavioral banks; CODING_TOPICS; diagnostics
    db.py                    SQLite: sessions, follow_up_counters, question_bank, signals
    graph_api.py             /api/graph nodes+edges (per-user)
    schemas.py               pydantic (grading signal, API models, login)
    main.py                  FastAPI routes incl. /api/login, /api/profiles
  scripts/
    cognee_smoke_test.py     Phase 0 gate + API introspection
    http_smoke.py            drive a full session over HTTP
    test_fallbacks.py        quota-resilience test
    seed_sessions.py         seed a shaped demo graph
    phase1_e2e.py            (nicety) 2-session routing assertion
frontend/
  next.config.ts             pins turbopack.root (see gotcha above)
  app/            page.tsx (login→setup→intro→interview→debrief), graph/page.tsx, layout (nav)
  components/     Avatar, CodeEditor, Whiteboard, WeaknessGraph
  lib/            api.ts (incl. login/getProfiles), speech.ts, useProctor.ts
```
