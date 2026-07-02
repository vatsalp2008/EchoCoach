# EchoCoach — Build Progress (teammate reference)

Living doc of **what's done** and **what's left**. Update it as you land work.
Last verified: Phase 0 complete, full Cognee lifecycle passing.

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

## 🚧 What's left (spec phases)
- [x] **Phase 1 — core loop (text technical interview). VERIFIED END-TO-END.**
      schemas (§4.2), question bank (§5.1), grading prompt (§5.2 verbatim), follow-up
      cap=2 (§5.3), no-feedback-leakage (§5.3a), session loop (§5.4), first-session
      diagnostic (§5.5), debrief (§5.6), SQLite, FastAPI routes, Next.js interview+
      debrief screens. A full session (start → diagnostics + follow-ups → done →
      debrief) runs over HTTP with real Gemini grading + a genuine coaching debrief
      (`scripts/http_smoke.py`). **Quota-resilient**: LLM/graph calls degrade
      gracefully — heuristic grading, template debrief, and graph writes that are
      **fire-and-forget + time-bounded + circuit-broken** so cognify quota-retries
      never hang a turn (`scripts/test_fallbacks.py` passes under simulated total
      failure). Remaining Phase-1 nicety: session-2-routing assertion in
      `scripts/phase1_e2e.py` (needs 2 real sessions; run when convenient).
- [ ] **Phase 2 — behavioral domain + graph viz.** behavioral bank + grading prompt
      (§6.2 verbatim; delivery DOES affect signal here), `/api/graph`, react-force-graph.
- [ ] **Phase 3 — external grounding.** Reddit (PRAW) + GitHub search → filter → `remember`
      into `company_context:<slug>` in background, poll `get_status`, fallback-first,
      never block UI. (Reddit/GitHub creds coming.)
- [ ] **Phase 4 — voice + avatar.** Web Speech STT/TTS behind a `speech.ts` interface,
      volume-driven avatar. **Wrapper only — text loop stays reachable via toggle.**
- [ ] **Phase 5 — demo readiness.** seed script (real pipeline), README, rehearsals.

---

## File map (current)
```
echocoach_build_spec.md      full spec
PROGRESS.md                  this file
.env.example / .env          env template / real secrets (gitignored)
backend/
  requirements.txt
  app/
    config.py                env load + cognee local/Gemini config  ✅
    memory.py                 the ONLY cognee wrapper                ✅
    (llm_client, schemas, grading, session, debrief, question_bank, db, graph_api, grounding/ — Phase 1+)
  scripts/
    cognee_smoke_test.py     Phase 0 gate + API introspection        ✅
frontend/                    Next.js (Phase 1+)
```
