# EchoCoach — Build Progress (teammate reference)

Living doc of **what's done** and **what's left**. Update it as you land work.
Last verified: core loop + Phase 2 + voice + code editor + whiteboard + proctoring
+ per-user profiles all working end-to-end; README + demo seed done. Only external
grounding (Reddit/GitHub) and UI polish remain.

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

# 2. Secrets — copy the template and fill in the Gemini key (+ Reddit/GitHub later)
cd .. && cp .env.example .env    # then edit .env

# 3. Prove Cognee works end to end
backend/.venv/bin/python backend/scripts/cognee_smoke_test.py
# expect: "[ok] Full remember -> recall -> improve -> forget loop passed."
```
`.env` is gitignored — never commit the key. `.env.example` documents every var.

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
- [x] **Per-user profiles.** username scopes the memory graph (datasets `topic:<user>:<slug>`,
      signals filtered by user, `/api/graph?user=`).
- [x] **Voice + avatar (Phase 4).** `lib/speech.ts` (Web Speech STT/TTS) + pulsing `Avatar`;
      text stays the fallback via a toggle. Chrome-only for voice.
- [x] **Code editor.** Monaco for DSA topics (backend `coding` flag).
- [x] **Whiteboard.** sketch → base64 PNG → **Gemini vision grading** (verified working).
- [x] **Proctoring.** tab-switch / blur / fullscreen-exit detection, warnings + tally.
- [x] **Demo readiness.** `README.md` (incl. mandatory AI-disclosure + How-we-used-Cognee),
      `docs/DECISIONS.md`, `scripts/seed_sessions.py` (seeds a shaped demo graph — run
      `seed_sessions.py demo`, then log in as `demo` and open `/graph`).

## 🚧 Remaining
- [ ] **External grounding (Phase 3).** Reddit (PRAW) + GitHub → filter → `remember` into
      `company_context:<slug>` in background, poll `get_status`, fallback-first. **The
      company field on the setup screen is currently inert** until this lands. Creds guide:
      `docs/reddit_api_setup.md`.
- [ ] **UI polish pass** (deferred by decision — do after core features).
- [ ] **Rehearsals** — 2 full run-throughs in Chrome before submission.
- [ ] (nicety) `scripts/phase1_e2e.py` 2-session routing assertion when convenient.

---

## File map (current)
```
README.md                    story, architecture, How-we-used-Cognee, AI disclosure
echocoach_build_spec.md      full spec
PROGRESS.md                  this file
docs/DECISIONS.md            ADR log (with tradeoffs)
docs/reddit_api_setup.md     Phase 3 creds guide
.env.example / .env          env template / real secrets (gitignored)
backend/
  requirements.txt
  app/
    config.py                env load + cognee local/Gemini config
    memory.py                the ONLY cognee wrapper (remember/recall/improve/forget + breaker)
    llm_client.py            Gemini adapter (JSON + multimodal image; quota detection)
    grading.py               technical + behavioral rubrics (verbatim) + heuristic fallback
    session.py               loop, follow-up cap, routing, mastery, per-user, full mode
    debrief.py               concise end-of-session report (+ template fallback)
    question_bank.py         technical + behavioral banks; coding topics; diagnostics
    db.py                    SQLite: sessions, follow_up_counters, question_bank, signals
    graph_api.py             /api/graph nodes+edges (per-user)
    schemas.py               pydantic (grading signal, API models)
  scripts/
    cognee_smoke_test.py     Phase 0 gate + API introspection
    http_smoke.py            drive a full session over HTTP
    test_fallbacks.py        quota-resilience test
    seed_sessions.py         seed a shaped demo graph
    phase1_e2e.py            (nicety) 2-session routing assertion
frontend/
  app/            page.tsx (interview: setup→intro→interview→debrief), graph/page.tsx, layout (nav)
  components/     Avatar, CodeEditor, Whiteboard, WeaknessGraph
  lib/            api.ts, speech.ts, useProctor.ts
```
