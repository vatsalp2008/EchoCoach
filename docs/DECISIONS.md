# EchoCoach — Decision Log (ADRs)

Why things are the way they are: context, the choice, the tradeoff, and the
reason. Newest at the bottom. Keep entries short. When you reverse one, don't
delete it — add a new entry that supersedes it.

---

## ADR-001 — Self-hosted open-source Cognee, not Cognee Cloud
**Context.** The hackathon offers two prize tracks: "Best Use of Open Source"
(MacBook) and "Best Use of Cognee Cloud" (iPhone). We must pick what to optimize.
**Decision.** Run Cognee fully self-hosted with its default local stack —
SQLite (relational) + LanceDB (vectors) + Kuzu (graph), all embedded.
**Tradeoff.** We give up Cloud's managed scaling/dashboards and the iPhone track,
and we own all the ops (locks, storage paths, model config) ourselves.
**Reason.** The whole product thesis is a *private, personal* memory of your
interview performance — self-hosting fits that story, needs no external account,
runs offline for the demo, and targets the open-source track deliberately.

## ADR-002 — One `memory.py` wrapper is the only thing that imports `cognee`
**Context.** Judges score "depth/correctness of Cognee usage," and we must be
honest about what is our code vs. an actual Cognee call.
**Decision.** All four Cognee ops (`remember`/`recall`/`improve`/`forget`) plus
status calls go through `backend/app/memory.py`; nothing else imports `cognee`.
**Tradeoff.** A thin indirection layer and a little boilerplate.
**Reason.** (a) The integration boundary is auditable in one file — it feeds the
README's "How we used Cognee" section directly. (b) Cognee is beta (1.2.2); if a
signature changes, it's a one-file fix. (c) Forces us to name each op's purpose.

## ADR-003 — Grading LLM output is strict JSON, validated with pydantic
**Context.** The grading signal is what `remember()` writes into the graph; free
text can't be reliably structured.
**Decision.** Grading calls request `application/json` and are validated against
`GradingAssessment` before anything is written to memory. App-authoritative
fields (session_id, timestamp, topic, domain) are injected in code, never trusted
from the model.
**Tradeoff.** Occasional parse/validation retries; slightly more rigid prompts.
**Reason.** A corrupt or hallucinated field would poison the weakness graph —
the one artifact the entire product depends on.

## ADR-004 — `delivery` affects the signal for behavioral answers but NOT technical
**Context.** We record how an answer was *delivered* (concise/rambling/vague/
hedgy/direct) as a text proxy for confidence (the free Web Speech API gives no
prosody).
**Decision.** For technical answers, `delivery` is debrief-only and must not move
the signal; for behavioral, it legitimately pulls the signal (clarity is part of
the rubric).
**Tradeoff.** Two grading rubrics to maintain instead of one.
**Reason.** Conflating "how it was said" with "whether they know it" would corrupt
technical grading — a correct answer delivered ramblingly is still correct. For
behavioral rounds, communication clarity is genuinely part of what's judged.

## ADR-005 — No feedback leakage during a session; all judgment in the debrief
**Context.** EchoCoach is a structured interviewer, not a live tutor.
**Decision.** Per-answer responses carry zero grading info (`AnswerResponse` has
no signal/score fields); the only judgment surfaced is the end-of-session debrief.
**Tradeoff.** The candidate gets no instant gratification mid-session.
**Reason.** Realism — real interviews never grade you out loud — and it's the
line that separates us from a tutor-bot.

## ADR-006 — App LLM (Gemini) is fully separate from Cognee's LLM (local Ollama)
**Context.** Cognee's `cognify` calls an LLM *several times per `remember()`* to
extract graph entities. Our first Gemini key was free-tier capped at ~20
requests/day — a single interview session exhausted it.
**Decision.** Split the two LLM paths:
- App grading/debrief → **Gemini** (`APP_LLM_PROVIDER`/`GEMINI_API_KEY`), where
  quality matters and call volume is low (~1 per answer + 1 debrief).
- Cognee cognify/recall/improve → **local Ollama** (`LLM_PROVIDER=ollama`,
  `llama3.1:8b`), where volume is high and $0/unlimited matters most.
**Tradeoff.** Local extraction quality (8B model) is lower than a frontier model,
graph-building is slower (local inference), and contributors must run Ollama.
**Reason.** It removes the dominant cost/quota driver from the paid API entirely,
keeps the demo resilient (no per-turn quota risk), stays $0, and still uses Gemini
where judgment quality actually shows. It also proves the provider-agnostic design.

## ADR-007 — Embeddings via local fastembed, not a hosted embedding API
**Context.** Cognee needs an embedding model for its vector store; the Gemini
`text-embedding-004` model 404s on our key and `gemini-embedding-001` (3072-dim)
still burns API quota.
**Decision.** Use `EMBEDDING_PROVIDER=fastembed` (BAAI/bge-small-en-v1.5, 384-dim),
which runs in-process with no key and no Ollama dependency.
**Tradeoff.** Smaller embeddings (384 vs 3072) → slightly coarser semantic recall.
**Reason.** Embeddings run on every chunk; keeping them local removes another
quota drain and network dependency for near-zero quality cost at our scale.
Note: Cognee validates provider+model+dimensions as a set, so all three are set.

## ADR-008 — Cognee DB workers run in-process (Kuzu/LanceDB subprocess disabled)
**Context.** Cognee defaults to out-of-process DB workers. Sequential ops in one
process (e.g. `remember` then `forget`) collided on Kuzu's single-writer file
lock ("Lock is held by PID …").
**Decision.** `set_graph_database_subprocess_enabled(False)` and
`set_vector_db_subprocess_enabled(False)`.
**Tradeoff.** No cross-process DB parallelism (irrelevant for our single-worker app).
**Reason.** Eliminates the lock contention that otherwise crashes the loop.

## ADR-009 — Routing is deterministic over a local signal mirror, informed by recall()
**Context.** Spec says "route to the weakest topic via `recall()`." But `recall()`
returns fuzzy graph-completion text, not a clean topic id — unreliable to parse
into a concrete next question.
**Decision.** Keep a local SQLite mirror of every grading signal; pick the next
topic deterministically by severity (avoided > struggled > partial, then recency,
never mastered/asked). We STILL call `recall()` each turn as the genuine
memory-driven query (it also feeds the debrief), but the concrete pick comes from
the mirror.
**Tradeoff.** We store signals in two places (graph + SQLite) — mild duplication.
**Reason.** Guarantees the demo-critical behavior ("session 2 routes to session
1's weak topics") is reliable, while remaining honest that Cognee's `recall` is
the memory query and the selection logic on top is our code (ADR-002 honesty).

## ADR-011 — Cognee's cognify runs on Gemini, not local Ollama (supersedes the Ollama half of ADR-006)
**Context.** ADR-006 routed Cognee's `cognify` to local Ollama to dodge the app
key's ~20/day quota. On testing, local models failed hard:
- `llama3.1:8b` and `mistral:latest` BOTH raise `InstructorRetryException` — they
  won't produce the structured `KnowledgeGraph` JSON cognee's Instructor pipeline
  requires. Zero successful graph builds.
- Each attempt takes **minutes** (mistral failed after 254s), which would stall
  the interview between every answer.
**Decision.** Run Cognee's cognify/recall/improve on **Gemini** (`gemini-2.5-flash-lite`),
the same provider as the app. Keep **fastembed** for embeddings (ADR-007) so the
high-volume embedding calls stay local/free and only the handful of extraction
calls per `remember()` hit Gemini. Requires a standard AIza key (free tier
~1000 req/day is ample for demo + dev).
**Tradeoff.** Not fully offline/$0 anymore; depends on the Gemini free tier.
**Reason.** cognify quality and a responsive demo matter more than pure locality;
Gemini cognify was already verified working in Phase 0. Ollama is retained only
as a documented, currently-non-functional experiment — do not use it for cognify.

## ADR-010 — SQLite for app bookkeeping, Cognee for the memory graph
**Context.** We need sessions, follow-up counters, question bank, and a signal log.
**Decision.** Plain SQLite for all app-level state; the weakness graph lives only
in Cognee.
**Tradeoff.** Two stores to reason about.
**Reason.** Cognee is the memory layer, not a general app DB; forcing counters and
bank rows into the graph would muddy the "what's actually memory" story and
over-engineer bookkeeping the spec explicitly says to keep simple.

## ADR-012 — ID + PIN login for exactly 2 known users, not real auth
**Context.** Only two people (vatsal, sakshi) use this app. Free-text usernames
(the earlier "lightweight profile" approach) risked typos creating phantom
profiles and didn't feel like "logging in as yourself."
**Decision.** A small hardcoded registry (`backend/app/auth.py`) maps 2 user ids
to a display name and a PIN (read from env: `PIN_VATSAL`, `PIN_SAKSHI`, with demo
defaults). `GET /api/profiles` lists the public picker info; `POST /api/login`
checks the PIN and returns the display name; the frontend gates on a `login`
phase before `setup` and remembers the logged-in id in localStorage.
**Tradeoff.** Not real auth — no password hashing, no sessions/tokens, no
protection beyond "don't share your PIN." Adding a third user means editing code.
**Reason.** For 2 known people sharing one local app, this is proportionate: it
prevents accidental cross-contamination of memory graphs and gives a real
"who's interviewing" moment, without building auth infrastructure this project
doesn't need. If this ever serves untrusted users, replace with real auth first.

## ADR-013 — No follow-ups on pure DSA/coding questions
**Context.** The follow-up system (spec 5.3, cap=2) was built for open-ended
technical/behavioral questions where "dig deeper into X" is a natural interviewer
move. Pure DSA/LeetCode-style questions are different: there's one algorithmic
approach to evaluate, and a live interviewer doesn't say "dig deeper" on a coding
problem — they just move to the next one (or ask you to code a variant, which is
really a new question, not a follow-up).
**Decision.** `question_bank.py` tags topics as `CODING_TOPICS`; `session.py`'s
`submit_answer` checks `is_coding(topic)` and skips the entire follow-up branch
for those topics — the answer is graded and the session advances regardless of
`follow_up_needed`.
**Tradeoff.** A struggling DSA answer no longer gets a clarifying nudge before
being marked struggled — it's graded as answered, cap or no cap.
**Reason.** Matches how real interviews actually run for coding questions, and
was an explicit product decision (not something to reverse without asking).

## ADR-014 — Single `npm run dev` for both servers, backend stays Python
**Context.** The project has two runtimes (Python/FastAPI backend, Node/Next.js
frontend), which normally means two terminals. Wanted for ease.
**Decision.** A root `package.json` with `concurrently` runs both:
`npm run dev` at the repo root starts `uvicorn --reload` (backend) and
`next dev` (frontend) together, log-prefixed, single Ctrl+C to stop both. The
backend itself is NOT rewritten in Node — `concurrently` just shells out to the
existing `backend/.venv/bin/uvicorn`.
**Tradeoff/gotcha hit.** Adding a root `package-lock.json` made Next.js's
Turbopack mis-detect its workspace root (it picked the repo root over
`frontend/` because it saw two lockfiles), which broke the React Server
Components module manifest entirely (every page 500'd with "Could not find the
module ... in the React Client Manifest"). Fixed by explicitly pinning
`turbopack.root` to the frontend directory in `frontend/next.config.ts`.
**Reason.** One-command startup is worth the root `package.json`, but the
lockfile/workspace-root interaction is a real Next.js/Turbopack footgun worth
documenting — anyone adding more root-level Node tooling should re-check this.

## ADR-015 — Grounding built in isolation, wired in as a separate, later step
**Context.** Phase 3 (external grounding) is the only remaining spec phase.
Phase 1/2 were already working and tested; touching `session.py`/`main.py`
directly while building Reddit/GitHub logic risked breaking that.
**Decision.** `grounding.py` was written as a fully self-contained module —
same "one auditable surface" pattern as `memory.py` — with zero imports from or
into `session.py`/`grading.py`/`debrief.py`/`db.py`. Only after it worked
standalone (compiled, imported cleanly, verified via its own smoke script) was
it wired into `session.py`: `start_session()` calls
`grounding.ensure_company_context()` (fire-and-forget) when a company is given,
and every freshly-presented question is passed through
`grounding.ground_question()` before being returned.
**Tradeoff.** Two commits/steps instead of one; the company field looked
"inert" for a while between the module existing and it being connected.
**Reason.** This is `principle #1` from the original spec applied literally:
"each phase must be a layer added on top of the previous one, never a rewrite
of it." Building + wiring as separate steps meant Phase 1/2 was never at risk,
and the wiring diff itself stayed small and easy to review (a handful of call
sites in `session.py` plus two new response fields) rather than being tangled
into a big first-draft of the grounding logic.

## ADR-016 — Local Whisper (mlx-whisper) as a second, opt-in STT engine
**Context.** Voice input has always been 100% browser-side (`SpeechRecognition`
in `frontend/lib/speech.ts`), which is Chrome-reliable but sends audio through
Google's servers to recognize it, and doesn't work at all in some browsers. We
evaluated OpenAI's open-source Whisper (free, local, MIT — distinct from
OpenAI's paid hosted API) as a second engine, verified feasibility directly on
this machine before committing: `pip download` confirmed `mlx`/`mlx-whisper`
resolve to precompiled wheels for this exact Python 3.14.2/Apple Silicon combo
(no compile step), and a live smoke test transcribed a sample word-perfectly in
1.5s once the model was cached.
**Decision.** Add `backend/app/stt.py` (mlx-whisper, model
`mlx-community/whisper-large-v3-turbo-q4`) as an **additional, opt-in** engine
— a "Browser / Whisper" toggle next to the existing Text/Voice toggle, default
`"browser"`. Transport is base64-in-JSON (`TranscribeRequest.audio_b64`),
mirroring the whiteboard's existing `image_b64` pattern exactly, rather than
introducing multipart/form-data — this needed zero new dependencies
(`python-multipart` was never installed) and reused the frontend's existing
`post<T>()` helper verbatim. Considered `faster-whisper` (CPU-only, lighter
deps) instead but chose the GPU-accelerated MLX path: interview answers use
technical jargon and hedge words the grader LLM reads verbatim, so
transcription accuracy directly affects grading quality, and large-v3-turbo is
meaningfully better on that vocabulary than `base.en`, while MLX's Apple
Silicon GPU acceleration keeps latency low despite the bigger model.
**Tradeoff.** The actual install pulled in `torch`+`numba`+`llvmlite`+`scipy`
transitively (heavier than hoped) and downgraded `numpy` 2.5.0→2.4.6 — verified
this doesn't break Cognee or the rest of the app, but it's a real, sizeable
dependency addition for one feature. Model download is ~500-600MB, one-time.
**Reason.** Whisper's own architecture is turn-based (30s chunks, not live
streaming), which fits this app's Q&A shape — a candidate finishes speaking,
then it transcribes — so the accuracy upgrade was worth the dependency weight,
especially with two independent kill switches (`ENABLE_WHISPER_STT=0` env var;
the frontend simply defaults to and can always fall back to `"browser"`) so a
broken install can never take down the app or block a demo.
