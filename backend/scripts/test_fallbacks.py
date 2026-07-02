"""Quota-resilience test — runs a full session with EVERY LLM/graph call forced
to fail (simulating an exhausted quota) and asserts the interview still completes
end-to-end on hardcoded/heuristic fallbacks. Uses zero network calls.

Run: backend/.venv/bin/python backend/scripts/test_fallbacks.py
"""

import asyncio
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "backend"))

from app import db, debrief, llm_client, memory  # noqa: E402
from app import session as S  # noqa: E402
from app.llm_client import LLMQuotaError  # noqa: E402
from app.schemas import AnswerRequest, StartSessionRequest  # noqa: E402


async def _raise_quota(*a, **k):
    raise LLMQuotaError("simulated 429 RESOURCE_EXHAUSTED quota")


async def _raise(*a, **k):
    raise RuntimeError("simulated cognee/graph failure")


def install_failures():
    llm_client.generate = _raise_quota          # all app LLM calls fail
    memory.remember = _raise                     # graph writes fail
    memory.improve = _raise
    memory.recall = _raise
    memory.forget = _raise


async def main():
    install_failures()
    if db.SQLITE_PATH.exists():
        db.SQLITE_PATH.unlink()
    db.init_db()

    start = await S.start_session(StartSessionRequest(target_role="backend engineer"))
    sid, qid, question = start.session_id, start.question_id, start.question
    turns = 0
    for _ in range(15):
        resp = await S.submit_answer(
            AnswerRequest(session_id=sid, question_id=qid, transcript="I'm not sure, maybe a loop?")
        )
        assert "signal" not in resp.model_dump(), "grade leaked into AnswerResponse"
        turns += 1
        if resp.done:
            break
        qid, question = resp.next_question_id, resp.question

    signals = db.signals_for_session(sid)
    assert signals, "no signals recorded under fallback"
    # heuristic grades are 0.3; forced-struggled (2 failed follow-ups) are 0.9
    assert all(s["grader_confidence"] in (0.3, 0.9) for s in signals), "unexpected grade source"
    assert any(s["grader_confidence"] == 0.3 for s in signals), "no heuristic grade produced"
    report = await debrief.generate_debrief(sid)
    assert "LLM quota reached" in report, "expected template debrief"

    print(f"[ok] session completed under total-quota-failure in {turns} turns")
    print(f"[ok] {len(signals)} heuristic signals recorded; template debrief produced")
    print("-" * 60)
    print(report[:700])
    print("-" * 60)
    print("FALLBACK RESILIENCE PASSED")


if __name__ == "__main__":
    asyncio.run(main())
