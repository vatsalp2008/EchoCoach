# EchoCoach — Complete Build Specification for Claude Code

This document is a full, end-to-end build prompt. Read it in its entirety before writing any code. Build in the phase order given — each phase must end in a fully working, demoable state before starting the next one. Do not let later phases touch or destabilize the core loop built in Phase 1.

---

## 0. The story (use this for the README and demo narrative)

The biggest hurdle in job hunting isn't a lack of technical knowledge — it's "interview amnesia." Every mock interview starts from a blank slate: same generic questions, same generic feedback, same mistakes repeated. Interview prep should be a living, evolving journey. If you struggled with system design trade-offs on Monday, you shouldn't be answering easy trivia on Tuesday — you should be pressed on those exact trade-offs until you've mastered them.

EchoCoach is a personal AI interviewer that refuses to forget. It uses Cognee's hybrid graph-vector memory layer to maintain a permanent, evolving map of a candidate's technical and behavioral interview performance — a "weakness graph." Every session, it queries that graph, routes toward whatever the candidate has struggled with or avoided, and probes deeper with real follow-up questions — the way a skilled human interviewer would, except this one remembers every previous conversation.

**How this differs from existing AI interviewers (e.g. Chakra by HackerRank):** tools like Chakra are built for companies to screen candidates once, in a single adaptive session. EchoCoach is built for the candidate, and its entire value proposition is persistence across many sessions over days or weeks — something no existing AI interviewer product does today.

**Built for:** the Cognee "Hangover Part AI" hackathon (WeMakeDevs), which is explicitly judged on: potential impact, creativity, technical excellence, depth/correctness of Cognee usage, user experience, and presentation quality. Every architectural decision below is made with those six criteria in mind — in particular, be precise and honest about which parts of the system are custom application code versus actual Cognee API calls, since overstating Cognee's role reads badly to judges who know the product, and understating it costs points on "Best Use of Cognee."

---

## 1. Full tech stack

- **Backend:** Python 3.11+, FastAPI, `asyncio`
- **Memory layer:** Cognee (open-source, self-hosted — NOT Cognee Cloud), installed via `pip install cognee --break-system-packages` or in a virtualenv
- **LLM:** provider-agnostic adapter interface (do not hardcode to one vendor). Support at minimum one of Anthropic Claude API or OpenAI API via a simple `llm_client.py` wrapper with a single `generate(prompt, temperature, response_format="json")` function, so the provider can be swapped by changing one file and an env var.
- **Frontend:** Next.js (App Router) + React + TypeScript + Tailwind CSS
- **Graph visualization:** `react-force-graph` or D3.js force-directed graph, rendered client-side from a `/graph` API endpoint
- **Speech-to-text / text-to-speech (Phase 4 only):** Browser-native Web Speech API — `SpeechRecognition` for STT, `SpeechSynthesis` for TTS. No external API keys required. Build this behind an interface so it can later be swapped for Whisper (self-hosted) or ElevenLabs (free tier) without touching the rest of the app.
- **External grounding:** PRAW (Python Reddit API Wrapper) against Reddit's free non-commercial API tier (OAuth app registration required, free); GitHub REST API (or `gh` CLI) for repo search — both free.
- **Database for app-level state** (sessions, users, question banks, follow-up counters — NOT the memory graph itself, which lives inside Cognee): SQLite for the hackathon; do not over-engineer this.
- **Deployment:** local (`localhost`) is sufficient for the demo. Do not spend time deploying to cloud infra unless every phase below is complete with time to spare.

---

## 2. Non-negotiable engineering principles

1. **Isolation over integration speed.** Each phase must be a layer added on top of the previous one, never a rewrite of it. The voice layer (Phase 4) wraps the text loop's input/output — it must never require changes to the grading, memory, or recall logic underneath.
2. **Fallback-first for anything external.** Every call to Reddit, GitHub, or any network-dependent service must be wrapped in try/except with a safe fallback (the hardcoded question bank) and must never block or crash the interview loop.
3. **Never block the UI on a background job.** External grounding (Phase 3) runs asynchronously; the user is never shown a loading spinner waiting for it.
4. **Be precise about what is "your code" vs. an actual Cognee call.** Log or comment clearly at each integration point which Cognee operation is being invoked and why, so this can be pulled directly into the README's "How we used Cognee" section.
5. **JSON-structured LLM outputs everywhere they feed the graph.** Free-text grading output is not acceptable — it must be parseable, or `remember()` has nothing reliable to write.

---

## 3. Cognee setup

Follow the official self-hosted setup guide at `docs.cognee.ai/setup-configuration/overview` before writing any application code. Use Cognee's default local providers (vector store, graph store, relational store) unless you hit a specific performance or compatibility issue — do not spend build time customizing the backend stack unless forced to.

Verify, with a standalone test script before building anything else, that this full loop works:

```python
import cognee, asyncio

async def test():
    await cognee.remember("The candidate struggled to explain consistent hashing.", dataset_name="topic:consistent_hashing")
    result = await cognee.recall("What has the candidate struggled with?", datasets=["topic:consistent_hashing"])
    print(result)
    await cognee.improve()
    await cognee.forget(dataset="topic:consistent_hashing")

asyncio.run(test())
```

Do not proceed to Phase 1 until this passes end to end.

---

## 4. Data model

### 4.1 Dataset naming convention (this IS the schema — Cognee datasets are the primary structuring mechanism)

- `topic:<topic_slug>` — one dataset per interview concept (e.g. `topic:consistent_hashing`, `topic:conflict_story`). Each session's transcript + grading signal for that topic is written here via `remember()`.
- `company_context:<company_slug>` — one dataset per target company, populated by Phase 3's external grounding pipeline.
- `profile:<user_id>` — optional, session-level metadata (target role, resume/JD text if provided) that isn't topic-specific.

### 4.2 Grading signal schema (this is the JSON `remember()` writes into a `topic:*` dataset after every answer)

```json
{
  "session_id": "string",
  "timestamp": "ISO8601",
  "topic": "consistent_hashing",
  "domain": "technical",
  "signal": "mastered | partial | struggled | avoided",
  "grader_confidence": 0.0,
  "delivery": "concise | rambling | vague | hedgy | direct",
  "evidence": "one sentence, the key moment that justified this signal",
  "reasoning": "1-2 sentences on why this signal was chosen",
  "follow_up_needed": true,
  "follow_up_focus": "the specific sub-gap to probe next, or null"
}
```

**Naming note:** `grader_confidence` is the LLM's own confidence in its assessment (e.g. "90% sure this counts as mastered") — it is NOT a measure of the candidate's vocal confidence. Do not conflate these; keep the field name explicit to avoid confusion elsewhere in the code.

**The `delivery` field** is the practical answer to "did they ramble, hedge, or stay vague," derived from transcript text alone:
- `concise` — direct, no padding
- `rambling` — repeats itself, wanders, takes long to get to the point
- `vague` — lacks concrete specifics, hand-waves
- `hedgy` — heavy use of uncertainty language ("I think," "maybe," "probably," "I'm not sure") — the closest text-based proxy for low confidence achievable with the free Web Speech API, which provides no tone/pitch/pacing data
- `direct` — clear, decisive, no notable padding or hedging

**Scope of `delivery`'s effect on the graph, by domain (this matters — do not let it silently distort technical grading):**
- For **technical** answers: `delivery` is recorded for the debrief report only. It must NOT influence the `signal` value — a correct answer delivered ramblingly is still a correct answer, and conflating "how it was said" with "whether they know it" would corrupt the weakness graph's actual purpose.
- For **behavioral** answers: `delivery` DOES legitimately factor into the `signal`, since communication clarity is already part of the behavioral rubric (Section 6.2) — a `rambling` or `vague` behavioral answer can reasonably pull the signal down toward `partial`/`struggled`.

If you want real vocal confidence detection later (actual tone/pacing analysis, not a text proxy), that requires swapping to a speech provider that exposes prosodic features — out of scope for this build, and not worth the time given the free-stack decision already made.

### 4.3 Mastery threshold (used by the `forget()` decision — commit to concrete numbers, do not leave this vague)

A topic is considered mastered, and its dataset is archived via `forget(dataset="topic:<slug>")`, when:
- At least **3** `mastered` signals exist for that topic
- Across **at least 2 different session_ids** (not all earned within a single session — this prevents a lucky single session from wiping out a real weakness)

### 4.4 App-level SQLite tables (not the memory itself — just bookkeeping)
- `sessions(id, user_id, started_at, domain_focus, company)`
- `follow_up_counters(session_id, topic, count)` — resets each session, capped at 2
- `question_bank(id, domain, topic, question_text, difficulty)`

---

## 5. Phase 1 — Core memory loop + technical interview (text-based, no voice yet)

**Goal at end of phase:** a working, text-input-only technical mock interviewer with a real, persistent weakness graph. This is the safety net for the rest of the build — it must work perfectly before anything else is added.

### 5.1 Hardcoded technical question bank
Write 8-10 questions tagged by topic, e.g.:
```json
{"topic": "two_pointer", "question": "Given a sorted array, find two numbers that add up to a target value. Walk me through your approach.", "difficulty": "easy"}
{"topic": "consistent_hashing", "question": "How would you design a caching layer that scales horizontally? What happens when you add a new cache node?", "difficulty": "medium"}
```
Do not let the LLM freely improvise diagnostic questions — every question must map to a known topic tag so grading signals attach to the correct graph node.

### 5.2 Grading prompt (technical) — use verbatim, do not paraphrase the rubric

```
You are grading a technical interview answer on ONE topic: {topic}.

Question asked: {question}
Candidate's answer (transcribed from speech): {transcript}

Ignore filler words, false starts, and speech disfluencies entirely —
they came from voice transcription and carry no signal here.
Grade only the technical substance.

Evaluate on:
1. Correctness — is the core claim/approach right?
2. Completeness — did they cover key tradeoffs or edge cases,
   or only the surface-level happy path?
3. Depth — did they explain WHY, not just WHAT?
4. Delivery — separately, note whether the answer was concise, rambling,
   vague, hedgy (heavy use of "I think"/"maybe"/"I'm not sure"), or direct.
   This does NOT affect your correctness/completeness/depth judgment or
   the signal you choose below — it is recorded only for the candidate's
   end-of-session debrief.

Decide:
- "mastered" if correct, complete, and reasoned through tradeoffs unprompted
- "partial" if the core idea is right but missing tradeoffs/edge cases
- "struggled" if the core approach is wrong or confused
- "avoided" if they didn't actually attempt the technical substance

Return only the JSON object matching this schema, no other text:
{schema}
```
Use temperature 0.2-0.3 for grading calls — consistency across sessions matters more than creative variance here.

### 5.3 Follow-up logic (cap = 2, hard rule)
```
if follow_up_needed and follow_up_counters[topic] < 2:
    ask_follow_up(follow_up_focus)
    follow_up_counters[topic] += 1
elif follow_up_counters[topic] >= 2 and not resolved:
    force_signal = "struggled"   # two failed clarifications is itself a real signal
    move_to_next_topic_via_recall()
else:
    move_to_next_topic_via_recall()
```

### 5.3a In-session behavior: no feedback leakage (confirmed design decision)

EchoCoach is a structured interviewer with bounded follow-up probing — NOT a free-form conversational chatbot, and NOT a tutor that corrects answers live. This has one hard consequence for how the agent must behave during a session:

**The agent must never reveal grading results, scores, or corrections during the session.** Grading happens silently in the background after every answer — the JSON from Section 5.2 is written to memory, but nothing derived from it is ever spoken or displayed to the candidate until the session ends. Transitions between questions and follow-ups must stay neutral and in-character, exactly as a real interviewer would:

- Correct: "Let's move on to the next question." / "Can you walk me through how you'd handle a hot partition in that scenario?"
- Incorrect (never do this): "That's wrong, let's try again." / "Good job, that was mostly correct."

This matters for realism (real interviews never pause to grade you out loud) and it is what separates EchoCoach from a tutor-style bot. All actual feedback is delivered exclusively through the end-of-session debrief (Section 5.6).

### 5.4 Session loop, in order
1. `recall()` — pick weakest unresolved topic (first session: no history, so pull from the diagnostic set below)
2. Present question (text input for this phase)
3. Candidate answers
4. Grading pass (Section 5.2) — LLM call, returns JSON
5. `remember()` — write the JSON into `topic:<slug>` dataset
6. Follow-up check (Section 5.3)
7. At end of session: explicit `improve()` call (see note below) to reinforce across the whole session's signals at once, rather than relying only on `remember()`'s internal auto-improve pass. Note this distinction directly in code comments — it demonstrates you understand Cognee's API at a level beyond default usage.
8. Mastery check (Section 4.3) → `forget()` if threshold met
9. Loop back to step 1 for next topic, or end session → generate the end-of-session debrief (Section 5.6) as the final step before returning control to the user

### 5.5 First-session diagnostic (no memory yet to route from)
Before anything else: ask for target role (required) and optionally company/JD (optional — feeds Phase 3 later). Then ask, in this order:
1. One DSA/coding fundamentals question
2. One lightweight system-design scenario, scaled to seniority implied by role
3. "Walk me through a project you built"

All three come from the hardcoded bank, tagged normally, graded normally — this is a real session, not throwaway content, and its results seed the graph for session 2.

### 5.6 End-of-session debrief (this is where all feedback lives — confirmed design decision)

When the session ends, generate a single human-readable debrief report. This is a separate LLM call from the per-answer grading pass in Section 5.2 — it synthesizes that session's grading JSONs into coaching language, rather than reusing them verbatim.

Debrief report structure:
1. **Topics covered this session** — for each: the question asked, and a plain-language recap of what went well or didn't (rewritten from the `evidence`/`reasoning` fields into second-person coaching tone, e.g. "You explained the core sharding approach clearly, but didn't address what happens when a node goes down mid-rebalance.")
2. **Progress since last session** — compare this session's signals against the topic's prior state in the graph (query via `recall()` before generating the report). Call out any topic that moved from `struggled`/`partial` to `mastered`, or vice versa.
3. **What's still weak** — topics with `struggled` or `avoided` signals, unresolved after follow-ups
4. **What's coming next** — a short teaser of what the next session will likely focus on, based on a preview `recall()` query, e.g. "Next time, expect more pressure on consistent hashing and your conflict-resolution story."

This report is shown as a dedicated debrief screen in the UI (text, not spoken — no need to route this through the voice layer), and it is the only place in the entire product where the candidate ever sees a judgment about their performance.

### 5.7 Phase 1 checkpoint (do not proceed until all true)
- [ ] `remember`/`recall`/`improve`/`forget` all confirmed working against real (not dummy) session data
- [ ] Follow-up cap enforced and tested
- [ ] Mastery threshold correctly triggers `forget()`
- [ ] A second session, run manually after a first, visibly routes toward the first session's weak topics
- [ ] No grading signal, score, or correction is ever surfaced to the user before the end-of-session debrief
- [ ] Debrief report generates correctly and reflects real session-over-session progress

---

## 6. Phase 2 — Behavioral domain + graph visualization

### 6.1 Behavioral question bank
5-6 questions tagged by topic, e.g. `conflict_story`, `failure_story`, `prioritization_story`.

### 6.2 Grading prompt (behavioral) — use verbatim

```
You are grading a behavioral interview answer on ONE topic: {topic}.

Question asked: {question}
Candidate's answer (transcribed from speech): {transcript}

Unlike technical answers, communication clarity IS part of the
evaluation here — real interviewers judge how clearly a story is told,
not just its content. Frequent filler words, rambling, or losing the
thread should lower the "structure" evaluation below, though a few
natural fillers are normal speech and not a flaw on their own.

Evaluate on:
1. Structure — is there a clear situation, action taken, and result?
   (STAR-shaped, even if not rigidly labeled)
2. Ownership — do they own their role/decisions, or deflect blame?
3. Specificity — concrete details and outcomes, or vague generalities?
4. Communication clarity — was the story easy to follow as delivered?
5. Delivery — note whether the answer was concise, rambling, vague,
   hedgy (heavy use of "I think"/"maybe"/"I'm not sure"), or direct.
   Unlike a technical answer, delivery quality here DOES legitimately
   factor into the signal you choose below — communication clarity is
   part of what real interviewers judge in behavioral rounds.

Decide:
- "mastered" if structured, specific, owns their role, clearly told
- "partial" if the content is fine but poorly structured/rambling,
  or well-told but vague/generic
- "struggled" if unclear, deflects responsibility, or no real substance
- "avoided" if they dodged the actual question asked

Return only the JSON object matching this schema, no other text:
{schema}
```
Note the deliberate difference from the technical prompt: filler words are explicitly graded here, not ignored, per the earlier design decision.

### 6.3 Graph visualization
- Endpoint `/api/graph` returns all topic nodes with their current signal state and mastery progress
- Frontend renders as a force-directed graph: node color = current dominant signal (e.g. red = struggled, amber = partial, green = mastered, gray = not yet assessed), node size = recency of last interaction
- This should be usable as a live debugging tool during Phase 3 and 4 build, not just a demo-day showpiece — build it now so you benefit from it immediately.

### 6.4 Phase 2 checkpoint
- [ ] Behavioral and technical questions both route correctly through the same loop with domain-appropriate grading
- [ ] Graph visualization accurately reflects real `topic:*` dataset states, refreshed after every graded answer

---

## 7. Phase 3 — External grounding (Reddit + GitHub)

### 7.1 Trigger and caching
The moment a company name is submitted: check whether `company_context:<company_slug>` already exists and is populated. If yes, skip fetching entirely. If no, fire the background job below immediately and let the session proceed using the fallback bank in the meantime — never block the UI on this.

### 7.2 Discovery
- **Reddit (via PRAW, free OAuth app):** search `r/cscareerquestions`, `r/leetcode`, `r/ExperiencedDevs` for the company name, sorted by recency, cap at **top 5-6 results**.
- **GitHub:** search for interview-question repos matching the company name, cap at **2-3 URLs**.
- Total per company: roughly 7-9 URLs. Do not pull more.

### 7.3 Sources to explicitly avoid
Do not scrape Glassdoor or Blind (teamblind) — both actively prohibit scraping in their terms of service. Do not build a LeetCode Discuss scraper either — no official API and unclear terms; skip it for this build.

### 7.4 Filter before ingesting
One cheap LLM call or keyword check per candidate URL/title: "does this plausibly discuss real interview questions for this company?" Drop anything that doesn't pass.

### 7.5 Ingest
```python
result = await cognee.remember(
    filtered_urls,
    dataset_name=f"company_context:{company_slug}",
    run_in_background=True,
)
dataset_id = result.dataset_id
```

### 7.6 Poll, don't block
Check `cognee.datasets.get_status([dataset_id])` every ~10 seconds, capped at 6-9 checks (60-90 seconds total). If still not complete after that, treat as failed for this session and fall back — do not retry immediately; retry once in a later session instead.

### 7.7 Source-selection logic (runs on every question, not once per session)
Before generating each question: if `company_context:<slug>` is marked ready, `recall()` from it to ground the question. If not ready or failed, silently use the fallback bank. Never surface an error to the user for this — a gradual improvement in question relevance within the session is the correct and acceptable behavior.

### 7.8 UI touch
Once `company_context` becomes ready mid-session, show a small unobtrusive note (e.g. "now using real reports from r/cscareerquestions") — visible payoff for the demo, no blocking involved.

### 7.9 Phase 3 checkpoint
- [ ] Discovery, filtering, ingestion, and polling all function against a real company name
- [ ] A missing/misspelled company name, or a simulated Reddit API failure, never crashes or blocks the interview loop
- [ ] Caching prevents redundant fetches for a company already ingested

---

## 8. Phase 4 — Voice + animated avatar layer

**Critical constraint: this phase is a wrapper, not a rewrite.** The text loop from Phases 1-3 must remain fully functional and reachable via a visible text-input toggle at all times, including during the live demo, as insurance against a live mic/browser issue.

### 8.1 Voice turn loop
1. Browser mic captures audio → `SpeechRecognition` converts to text
2. That text is passed into the exact same grading + `recall()` logic already built — no duplication, no parallel code path
3. AI's reply text → `SpeechSynthesis` converts to speech
4. While audio plays, read output volume/amplitude repeatedly (many times per second) and drive a simple animated shape (pulsing circle, soundwave, minimal face) — no real lip-sync needed, volume-driven movement reads as intentional
5. Loop back to listening

### 8.2 Known limitations to design around, not fight
- Web Speech API works reliably in Chrome only — test and demo in Chrome specifically
- Accuracy drops with background noise — demo in a quiet room
- The built-in voice sounds synthetic — do not apologize for this in the demo; it fits the "AI interviewer" framing

### 8.3 Swap-readiness
Build the STT/TTS calls behind a small interface (`transcribe(audio)`, `speak(text)`) so a future swap to Whisper or ElevenLabs touches only that one file.

### 8.4 Phase 4 checkpoint
- [ ] Full voice loop works end to end in Chrome
- [ ] Text-input toggle remains fully functional as a fallback at all times
- [ ] Avatar animation visibly syncs to audio playback

---

## 9. Phase 5 — Demo readiness

### 9.1 Seed script
A one-time script that plays 2-3 realistic past sessions through the REAL pipeline (real grading calls, real `remember()`/`improve()` calls — not hardcoded graph data) before the live demo, so the demo can open with a graph that already has shape, and a live session can visibly route around genuine prior weak topics.

### 9.2 README structure
1. The story (Section 0 above)
2. Architecture overview + the "How we used Cognee" section, written directly from the phase notes above about which calls are custom code vs. actual Cognee operations
3. Tech stack list
4. Setup instructions
5. Judging-criteria-aligned "what to look for" section (briefly: impact, the graph, the dataset-scoped forget logic, the dual grounding pathways)

### 9.3 Rehearsal
Full run-through at least twice before submission, in the actual demo environment (Chrome, quiet room, real network conditions for Reddit/GitHub calls).

### 9.4 Optional, only if time remains
- Blog post about the build (Keychron prize track)
- Social post tagging @wemakedevs and Cognee (swag track)

---

## 10. Environment variables needed

```
LLM_PROVIDER=anthropic|openai
LLM_API_KEY=
COGNEE_CONFIG=... (per docs.cognee.ai/setup-configuration/overview)
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USER_AGENT=echocoach:v1.0 (by /u/<your_username>)
GITHUB_TOKEN= (optional, raises rate limits for search)
```

---

## 11. Summary of what makes this submission strong (for your own reference while building, and to lift directly into the README)

- Two distinct, correctly-mapped uses of `remember()`/`recall()`: session performance signals, and external company-specific grounding
- `forget()` implemented as real dataset archival, not a metaphor
- `improve()` called explicitly at session boundaries, on top of its automatic per-`remember()` pass — a deliberate design choice, not default behavior
- A genuinely graph-shaped domain (interview topics have real prerequisite/related structure), which is where Cognee's hybrid approach earns its keep over a plain vector store
- Honest, fallback-first engineering around every external dependency, so the demo never breaks on stage
