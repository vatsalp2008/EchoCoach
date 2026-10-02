"""The end-of-session debrief never fails just because the LLM call does.

Grading and follow-ups already fall back on any LLM error; the debrief used to
fall back only on quota errors, so a Gemini timeout / 503 / bad key turned the
last screen of an interview into a 500. Runs on SQLite and Postgres (conftest).
"""

from __future__ import annotations

import asyncio

import pytest


@pytest.mark.parametrize("error", [RuntimeError("503 model overloaded"), TimeoutError()])
def test_debrief_falls_back_to_template_on_any_llm_error(db, monkeypatch, error):
    from app import debrief, grading, llm_client
    from app.schemas import GradingSignal

    async def broken_generate(*a, **k):
        raise error

    monkeypatch.setattr(llm_client, "generate", broken_generate)
    db.create_session("s1", started_at="t", domain_focus="technical", company=None,
                      target_role="backend", user_id="7")
    # A real signal, as the no-LLM heuristic grader would have recorded it.
    sig = GradingSignal.from_assessment(
        grading._heuristic_assessment("I would maybe use two pointers I think"),
        session_id="s1", topic="two_pointer", domain="technical",
    )
    db.record_signal(sig.model_dump(), user_id="7")

    report = asyncio.run(debrief.generate_debrief("s1"))
    assert report and "two" in report.lower()  # the template names the topic
    assert db.get_stored_debrief("s1") == report  # frozen for History, as before
