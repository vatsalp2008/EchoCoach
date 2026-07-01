"""End-of-session debrief (spec 5.6) — the ONLY place the candidate ever sees a
judgment. A separate LLM call from per-answer grading: it synthesizes the
session's grading JSONs into second-person coaching, and compares against prior
graph state (via recall) for the progress section.
"""

from __future__ import annotations

import json

from . import db, llm_client, memory

_DEBRIEF_PROMPT = """You are an expert interview coach writing a candidate's end-of-session debrief.
Speak directly to the candidate in second person ("you"). Be specific, warm, and honest.

This session's graded signals (JSON, internal — never quote the raw fields):
{signals}

Question text for reference (topic -> question):
{questions}

The candidate's PRIOR state on these topics, from their long-term memory graph:
{prior}

Write the debrief in exactly these four sections, as markdown with these headers:

## Topics covered this session
For each topic: name the question in plain language and recap what went well or
didn't, rewritten from the evidence/reasoning into coaching tone.

## Progress since last session
Compare this session's signals to the prior state above. Call out any topic that
moved toward mastery, or slipped back. If there's no prior state, say this is the
baseline session.

## What's still weak
Topics graded "struggled" or "avoided" and left unresolved after follow-ups.

## What's coming next
A short teaser of what the next session will likely focus on, based on the
weakest remaining topics.

Return only the markdown report."""


async def generate_debrief(session_id: str) -> str:
    signals = db.signals_for_session(session_id)
    if not signals:
        return "No answers were recorded this session, so there's nothing to debrief yet."

    topics = sorted({s["topic"] for s in signals})

    # Question text per topic (best-effort; follow-ups aren't in the bank).
    questions = {t: (get_question_text(t) or t) for t in topics}

    # Cognee op: recall() the prior state of each topic for the progress section.
    prior = await _prior_state(topics)

    prompt = _DEBRIEF_PROMPT.format(
        signals=json.dumps(signals, indent=2),
        questions=json.dumps(questions, indent=2),
        prior=prior,
    )
    return await llm_client.generate(prompt, temperature=0.4)


def get_question_text(topic: str) -> str | None:
    from .question_bank import question_for_topic

    q = question_for_topic(topic)
    return q["question"] if q else None


async def _prior_state(topics: list[str]) -> str:
    parts = []
    for topic in topics:
        try:
            res = await memory.recall(
                f"Summarize the candidate's history and mastery on '{topic}' "
                "across all prior sessions.",
                datasets=[f"topic:{topic}"],
                top_k=5,
            )
            parts.append(f"- {topic}: {_flatten_recall(res)}")
        except Exception:
            parts.append(f"- {topic}: (no prior memory available)")
    return "\n".join(parts) if parts else "(no prior state)"


def _flatten_recall(res) -> str:
    """recall() returns a list of typed response entries; pull their text out."""
    if not res:
        return "(nothing recalled)"
    texts = []
    for entry in res:
        text = getattr(entry, "text", None)
        if text:
            texts.append(text)
    return " ".join(texts) if texts else "(nothing recalled)"
