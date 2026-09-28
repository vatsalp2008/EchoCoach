"""An interview's turn state lives in the DB, not process memory.

Plays a whole first-session interview through session.start_session /
submit_answer (skipping every question, so no grading LLM call), checking the
state is persisted after each turn and nothing depends on a warm process — the
property a stateless host (Cloud Run) needs. Runs on SQLite, and on Postgres
when TEST_DATABASE_URL is set (see test_db.py).
"""

from __future__ import annotations

import asyncio

import pytest


def test_interview_survives_restart(db, monkeypatch):
    from app import memory, session
    from app.schemas import AnswerRequest, StartSessionRequest

    # Cognee sits on top of the DB mirror (writes are fire-and-forget, improve
    # is best-effort at the session boundary); stub it so no LLM is called.
    async def nothing(*a, **k):
        return None

    monkeypatch.setattr(memory, "schedule_remember", lambda *a, **k: None)
    monkeypatch.setattr(memory, "improve", nothing)
    monkeypatch.setattr(memory, "forget", nothing)
    monkeypatch.setattr(memory, "recall", nothing)

    start = asyncio.run(session.start_session(
        StartSessionRequest(target_role="backend engineer", domain_focus="technical", user_id="42")
    ))
    saved = db.load_session_state(start.session_id)
    assert saved["current"]["id"] == start.question_id
    assert saved["user_id"] == "42" and saved["is_first_session"] is True

    qid, asked = start.question_id, [start.topic]
    for _ in range(20):  # the diagnostic set is short; bound the loop anyway
        resp = asyncio.run(session.submit_answer(
            AnswerRequest(session_id=start.session_id, question_id=qid, skipped=True)
        ))
        if resp.done:
            break
        state = db.load_session_state(start.session_id)
        assert state["current"]["id"] == resp.next_question_id  # persisted every turn
        qid = resp.next_question_id
        asked.append(resp.topic)
    else:
        pytest.fail("interview never ended")

    assert db.load_session_state(start.session_id) is None  # ended -> cleared
    assert db.get_session(start.session_id)["ended_at"] is not None
    assert [q["topic"] for q in db.qa_for_session(start.session_id)] == asked
    assert all(q["skipped"] for q in db.qa_for_session(start.session_id))
    with pytest.raises(KeyError):  # an ended interview can't take more answers
        asyncio.run(session.submit_answer(
            AnswerRequest(session_id=start.session_id, question_id=qid, skipped=True)
        ))
