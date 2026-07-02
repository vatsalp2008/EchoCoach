"""End-of-session debrief (spec 5.6) — the ONLY place the candidate ever sees a
judgment. A separate LLM call from per-answer grading: it synthesizes the
session's grading JSONs into second-person coaching, and compares against prior
graph state (via recall) for the progress section.
"""

from __future__ import annotations

import json

from . import db, llm_client
from .llm_client import LLMQuotaError

_DEBRIEF_PROMPT = """You are an expert interview coach writing a candidate's end-of-session debrief.
Speak directly to the candidate in second person ("you"). Be specific, warm, and honest.

This session's graded signals (JSON, internal — never quote the raw fields):
{signals}

Question text for reference (topic -> question):
{questions}

The candidate's PRIOR state on these topics, from their long-term memory graph:
{prior}

Write a SHORT, scannable debrief in markdown. Be concise — this is a quick
post-interview summary, not an essay. Hard limits:
- One sentence of overall summary.
- ONE line per topic (a tight bullet), no multi-sentence paragraphs.
- Total under ~150 words.
No preamble, no filler, no "great job" padding. Use these exact section headers:

## Summary
One sentence: overall how the session went.

## By topic
One bullet per topic: `- **topic name** — <mastered/partial/struggled/avoided in plain words>: <≤12-word why>`

## Progress
One short bullet per topic that moved vs the prior state (e.g. "struggled → mastered").
If there's no prior state, a single line: "Baseline session — first time on these topics."

## Focus next
1–3 short bullets: the specific things to work on next.

Return only the markdown report, nothing else."""


async def generate_debrief(session_id: str) -> str:
    signals = db.signals_for_session(session_id)
    if not signals:
        return "No answers were recorded this session, so there's nothing to debrief yet."

    topics = sorted({s["topic"] for s in signals})

    # Question text per topic (best-effort; follow-ups aren't in the bank).
    questions = {t: (get_question_text(t) or t) for t in topics}

    # Prior state for the progress section, derived from the local signal mirror
    # (fast, deterministic). Cognee recall() drives the live routing instead —
    # doing it here too would be slow and redundant.
    prior = _prior_state_from_db(session_id, topics)

    prompt = _DEBRIEF_PROMPT.format(
        signals=json.dumps(signals, indent=2),
        questions=json.dumps(questions, indent=2),
        prior=prior,
    )
    try:
        return await llm_client.generate(prompt, temperature=0.4)
    except LLMQuotaError:
        return _template_debrief(signals, questions)


def _template_debrief(signals: list[dict], questions: dict[str, str]) -> str:
    """No-LLM debrief built directly from the graded signals — used when the LLM
    is quota-exhausted so the candidate still gets a usable report."""
    # Latest signal per topic.
    latest: dict[str, dict] = {}
    for s in signals:
        latest[s["topic"]] = s
    weak = [t for t, s in latest.items() if s["signal"] in ("struggled", "avoided")]

    def nice(t: str) -> str:
        return t.replace("_", " ")

    lines = ["## Summary",
             "Quick summary from your graded answers (detailed synthesis skipped — LLM quota reached).",
             "", "## By topic"]
    for topic, s in latest.items():
        lines.append(f"- **{nice(topic)}** — {s['signal']} ({s['delivery']} delivery)")
    lines += ["", "## Focus next"]
    lines += [f"- {nice(t)}" for t in weak] or ["- Keep reinforcing what you covered; no weak topics flagged."]
    return "\n".join(lines)


def get_question_text(topic: str) -> str | None:
    from .question_bank import question_for_topic

    q = question_for_topic(topic)
    return q["question"] if q else None


def _prior_state_from_db(session_id: str, topics: list[str]) -> str:
    """Prior signal per topic from OTHER sessions (the persistent weakness graph's
    local mirror), so the debrief can call out session-over-session movement."""
    topic_set = set(topics)
    prior: dict[str, dict] = {}
    for s in db.all_signals():
        if s["session_id"] == session_id or s["topic"] not in topic_set:
            continue
        prior[s["topic"]] = s  # ordered oldest-first, so last prior wins
    if not prior:
        return "(no prior sessions — treat this as the baseline session)"
    return "\n".join(
        f"- {t}: previously '{s['signal']}' ({s['delivery']} delivery)"
        for t, s in prior.items()
    )
