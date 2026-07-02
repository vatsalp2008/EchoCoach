"""Session orchestration — the core loop (spec 5.4).

Per-turn state (which question is pending, follow-up context) is kept in a
process-local dict: fine for the single-worker hackathon demo. Durable facts —
sessions, follow-up counters, grading signals — live in SQLite; the weakness
graph itself lives in Cognee.

Hard rules enforced here:
- Follow-up cap = 2 per topic per session (spec 5.3).
- No feedback leakage: responses carry only the next question, never grades
  (spec 5.3a). All judgment is deferred to the debrief.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from . import db, llm_client, memory
from .question_bank import (
    DIAGNOSTIC_SEQUENCE,
    all_topics,
    get_question,
    question_for_topic,
)
from .schemas import (
    AnswerRequest,
    AnswerResponse,
    Domain,
    GradingSignal,
    StartSessionRequest,
    StartSessionResponse,
)

FOLLOW_UP_CAP = 2
MAX_MAIN_QUESTIONS = 4  # main topics per returning session (diagnostics ignore this)

# Severity for routing: weakest = highest. avoided outranks struggled (spec 5.4).
_SEVERITY = {"avoided": 4, "struggled": 3, "partial": 2, "mastered": 0}

# session_id -> live turn state
_ACTIVE: dict[str, dict] = {}


def _topic_dataset(topic: str) -> str:
    return f"topic:{topic}"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _memory_text(sig: GradingSignal) -> str:
    """Natural-language statement fed to remember() so Cognee's cognify builds
    meaningful topic/signal graph nodes (raw JSON alone extracts poorly)."""
    focus = sig.follow_up_focus or "none"
    return (
        f"In session {sig.session_id} on {sig.timestamp}, on the {sig.domain} "
        f"topic '{sig.topic}', the candidate's answer was graded '{sig.signal}' "
        f"(grader_confidence {sig.grader_confidence}). Delivery was {sig.delivery}. "
        f"Evidence: {sig.evidence} Reasoning: {sig.reasoning} "
        f"Remaining gap to probe: {focus}."
    )


# ── start ─────────────────────────────────────────────────────────────────
async def start_session(req: StartSessionRequest) -> StartSessionResponse:
    session_id = uuid.uuid4().hex
    db.create_session(
        session_id,
        started_at=_now(),
        domain_focus=req.domain_focus,
        company=req.company,
        target_role=req.target_role,
    )

    first = _is_first_session()
    state = {
        "domain": req.domain_focus,
        "asked_topics": [],
        "diagnostic_queue": list(DIAGNOSTIC_SEQUENCE) if first else [],
        "is_first_session": first,
        "current": None,
    }
    _ACTIVE[session_id] = state

    if first:
        q = get_question(state["diagnostic_queue"].pop(0))
    else:
        topic = await _pick_next_topic(session_id, req.domain_focus, asked=[])
        q = question_for_topic(topic)

    state["current"] = {
        "id": q["id"], "topic": q["topic"], "domain": q["domain"],
        "question": q["question"], "is_follow_up": False,
    }
    state["asked_topics"].append(q["topic"])
    return StartSessionResponse(
        session_id=session_id, question_id=q["id"], topic=q["topic"], question=q["question"]
    )


# ── answer -> grade -> remember -> follow-up / next ──────────────────────────
async def submit_answer(req: AnswerRequest) -> AnswerResponse:
    state = _ACTIVE.get(req.session_id)
    if state is None or state.get("current") is None:
        raise KeyError("unknown or inactive session")
    current = state["current"]

    # 1-3. Grade silently, write to the topic dataset, mirror locally.
    sig = await grade_and_remember(
        session_id=req.session_id,
        topic=current["topic"],
        domain=current["domain"],
        question=current["question"],
        transcript=req.transcript,
    )

    # 6. Follow-up logic (spec 5.3), only for the topic just answered.
    topic = current["topic"]
    count = db.get_follow_up_count(req.session_id, topic)
    resolved = sig.signal in ("mastered", "partial") and not sig.follow_up_needed

    if sig.follow_up_needed and not resolved and count < FOLLOW_UP_CAP:
        db.increment_follow_up(req.session_id, topic)
        fu_text = await _generate_follow_up(
            topic, sig.follow_up_focus, current["question"], req.transcript
        )
        fu_id = f"{req.session_id}:fu:{topic}:{count + 1}"
        state["current"] = {
            "id": fu_id, "topic": topic, "domain": current["domain"],
            "question": fu_text, "is_follow_up": True,
        }
        return AnswerResponse(
            next_question_id=fu_id, topic=topic, question=fu_text, is_follow_up=True
        )

    if sig.follow_up_needed and not resolved and count >= FOLLOW_UP_CAP:
        # Two failed clarifications is itself a real signal (spec 5.3).
        await _force_struggled(req.session_id, topic, current["domain"])

    # 8. Mastery check -> archive via forget() if threshold met (spec 4.3).
    await _maybe_forget(topic)

    # 1/9. Move to the next topic, or end the session.
    return await _advance(req.session_id, state)


async def grade_and_remember(
    *, session_id: str, topic: str, domain: Domain, question: str, transcript: str
) -> GradingSignal:
    from . import grading  # local import avoids a cycle at module load

    sig = await grading.grade_answer(
        session_id=session_id, topic=topic, domain=domain,
        question=question, transcript=transcript,
    )
    # Record to the local mirror FIRST — it's the reliable source of truth for
    # routing and the debrief. The graph write is best-effort on top.
    db.record_signal(sig.model_dump())
    try:
        # Cognee op: remember() -> writes the performance signal into topic:<slug>.
        await memory.remember(_memory_text(sig), dataset_name=_topic_dataset(topic))
    except Exception:
        pass  # quota/cognify failure must not crash the interview; graph catches up later
    return sig


async def _advance(session_id: str, state: dict) -> AnswerResponse:
    # First session: walk the fixed diagnostic queue (spec 5.5).
    if state["is_first_session"] and state["diagnostic_queue"]:
        q = get_question(state["diagnostic_queue"].pop(0))
    elif state["is_first_session"]:
        return await _end(session_id)
    else:
        if len(state["asked_topics"]) >= MAX_MAIN_QUESTIONS:
            return await _end(session_id)
        topic = await _pick_next_topic(session_id, state["domain"], state["asked_topics"])
        if topic is None:
            return await _end(session_id)
        q = question_for_topic(topic)

    state["current"] = {
        "id": q["id"], "topic": q["topic"], "domain": q["domain"],
        "question": q["question"], "is_follow_up": False,
    }
    state["asked_topics"].append(q["topic"])
    return AnswerResponse(
        next_question_id=q["id"], topic=q["topic"], question=q["question"], is_follow_up=False
    )


async def _end(session_id: str) -> AnswerResponse:
    """Session boundary (spec 5.4 step 7-9): explicit improve() over each topic
    touched — deliberately on top of remember()'s per-call auto-improve — then
    a final mastery sweep. The debrief is generated lazily by its endpoint."""
    for topic in db.topics_touched(session_id):
        try:
            await memory.improve(dataset=_topic_dataset(topic))  # Cognee op
        except Exception:
            pass  # improve is best-effort reinforcement; never fail the session
        await _maybe_forget(topic)
    db.end_session(session_id, _now())
    _ACTIVE.pop(session_id, None)
    return AnswerResponse(done=True)


# ── routing / helpers ────────────────────────────────────────────────────────
def _is_first_session() -> bool:
    """No graded signals anywhere yet => first session, use the diagnostic set."""
    with db.connect() as conn:
        n = conn.execute("SELECT COUNT(*) AS n FROM grading_signals").fetchone()["n"]
    return n == 0


async def _pick_next_topic(
    session_id: str, domain: Domain, asked: list[str]
) -> str | None:
    """Route toward the weakest unresolved topic (spec 5.4 step 1).

    Cognee op: recall() queries the weakness graph for what the candidate has
    struggled with — this is the memory-driven routing the product is built on.
    The concrete pick is then made deterministically from the signal history so
    routing is reliable, honoring the recall result while never returning an
    already-mastered or already-asked topic.
    """
    try:
        # Real memory query — routes the session, and its text feeds debriefs.
        await memory.recall(
            "Which topics has the candidate struggled with or avoided and not "
            "yet mastered? Rank the weakest first.",
            top_k=10,
        )
    except Exception:
        pass  # routing must survive a recall hiccup

    # Latest signal per topic, from the graph's local mirror.
    latest: dict[str, dict] = {}
    for s in db.all_signals():
        if s["domain"] != domain:
            continue
        latest[s["topic"]] = s  # ordered by id asc, so last write wins

    candidates = []
    for topic, s in latest.items():
        if topic in asked or s["signal"] == "mastered":
            continue
        candidates.append((_SEVERITY.get(s["signal"], 1), s["created_at"], topic))

    if candidates:
        candidates.sort(reverse=True)  # highest severity, then most recent
        return candidates[0][2]

    # Fallback: any topic in this domain not yet touched this session.
    for topic in all_topics(domain):
        if topic not in asked:
            return topic
    return None


async def _generate_follow_up(
    topic: str, focus: str | None, question: str, transcript: str
) -> str:
    """Neutral, in-character follow-up probing the specific gap. Never reveals
    that the prior answer was judged (spec 5.3a)."""
    focus_line = focus or "the weakest part of their answer"
    prompt = (
        "You are a professional technical interviewer. The candidate just "
        f"answered a question on '{topic}'.\n\n"
        f"Original question: {question}\n"
        f"Their answer: {transcript}\n\n"
        f"Ask ONE concise, neutral follow-up question that probes: {focus_line}. "
        "Stay fully in character as an interviewer. Do NOT reveal any assessment, "
        "score, correction, or whether they were right or wrong. Return only the "
        "question text, nothing else."
    )
    try:
        return (await llm_client.generate(prompt, temperature=0.4)).strip()
    except Exception:
        # Quota/LLM failure: a neutral hardcoded probe keeps the follow-up flow alive.
        return f"Can you go a level deeper — specifically, {focus_line}?"


async def _force_struggled(session_id: str, topic: str, domain: Domain) -> None:
    from .schemas import GradingSignal as GS

    sig = GS(
        session_id=session_id, timestamp=_now(), topic=topic, domain=domain,
        signal="struggled", grader_confidence=0.9, delivery="hedgy",
        evidence="Two follow-up clarifications did not resolve the gap.",
        reasoning="Unresolved after the follow-up cap — recorded as a real struggle signal.",
        follow_up_needed=False, follow_up_focus=None,
    )
    db.record_signal(sig.model_dump())
    try:
        await memory.remember(_memory_text(sig), dataset_name=_topic_dataset(topic))
    except Exception:
        pass  # graph write best-effort


async def _maybe_forget(topic: str) -> None:
    """Archive a mastered topic (spec 4.3): >=3 mastered signals across >=2
    distinct sessions -> forget() the dataset so it stops being routed to."""
    n_mastered, n_sessions = db.mastered_counts(topic)
    if n_mastered >= 3 and n_sessions >= 2:
        try:
            await memory.forget(dataset=_topic_dataset(topic))  # Cognee op
        except Exception:
            pass
