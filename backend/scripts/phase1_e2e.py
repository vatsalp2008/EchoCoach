"""Phase 1 end-to-end check (spec 5.7 checkpoint).

Drives the real loop through session.py (real grading, real remember/recall/
improve/forget, real Gemini) against a scratch DB + scratch Cognee stores, and
asserts the phase-1 invariants:
  - grading JSON validates
  - follow-up counter caps at 2
  - no grading info leaks in AnswerResponse
  - a debrief generates
  - (light) a second session routes toward the first session's weak topic

Run:  backend/.venv/bin/python backend/scripts/phase1_e2e.py
"""

import asyncio
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "backend"))

from app import db, debrief, session as S  # noqa: E402
from app.schemas import AnswerRequest, StartSessionRequest  # noqa: E402


def _resp_has_no_grades(resp) -> bool:
    fields = resp.model_dump()
    leaked = {"signal", "grader_confidence", "evidence", "reasoning", "score"}
    return not (leaked & set(fields.keys()))


async def run_session(role: str, answers: dict[str, str]) -> str:
    """answers maps a keyword-in-question (lowercased) -> transcript to give.
    Falls back to a generic weak answer if nothing matches."""
    start = await S.start_session(StartSessionRequest(target_role=role))
    print(f"\nSESSION {start.session_id[:8]} — Q1 [{start.topic}]: {start.question[:70]}...")
    session_id = start.session_id
    qid, question = start.question_id, start.question

    for turn in range(12):  # generous cap; loop ends on done
        transcript = _pick_answer(question, answers)
        resp = await S.submit_answer(
            AnswerRequest(session_id=session_id, question_id=qid, transcript=transcript)
        )
        assert _resp_has_no_grades(resp), "LEAK: grading info in AnswerResponse"
        if resp.done:
            print("  -> session done")
            break
        tag = "follow-up" if resp.is_follow_up else "next"
        print(f"  -> {tag} [{resp.topic}]: {resp.question[:70]}...")
        qid, question = resp.next_question_id, resp.question
    return session_id


def _pick_answer(question: str, answers: dict[str, str]) -> str:
    q = question.lower()
    for kw, text in answers.items():
        if kw in q:
            return text
    return "I'm not really sure. Maybe I'd just loop through it? I think that works."


async def main():
    # Fresh scratch state so assertions are deterministic.
    if db.SQLITE_PATH.exists():
        db.SQLITE_PATH.unlink()
    db.init_db()

    # Session 1 (first session -> diagnostic set): answer the two-pointer Q well,
    # ramble/dodge the rest so we seed some weak topics.
    strong = (
        "Use two pointers from both ends of the sorted array. If the sum is too "
        "big move the right pointer left, if too small move left pointer right. "
        "O(n) time, O(1) space. Tradeoff: requires the array be sorted first, "
        "otherwise sorting dominates at O(n log n)."
    )
    await run_session(
        "backend engineer",
        {"two numbers that add up": strong, "url shortener": "um, I guess a database?"},
    )

    # Follow-up cap: no topic should have a counter above 2.
    with db.connect() as conn:
        over = conn.execute(
            "SELECT topic, count FROM follow_up_counters WHERE count > 2"
        ).fetchall()
    assert not over, f"follow-up cap breached: {[dict(r) for r in over]}"
    print("\n[ok] follow-up cap (<=2) holds")

    # Debrief generates and reads as coaching text.
    sid1 = db.connect().__enter__().execute(
        "SELECT id FROM sessions ORDER BY started_at LIMIT 1"
    ).fetchone()["id"]
    report = await debrief.generate_debrief(sid1)
    assert "## Topics covered this session" in report, "debrief missing sections"
    print("[ok] debrief generated:\n" + "-" * 60)
    print(report[:900])
    print("-" * 60)

    # Session 2 should route toward a weak topic (system_design_basics / a dodged
    # topic), not repeat the mastered two_pointer first.
    start2 = await S.start_session(StartSessionRequest(target_role="backend engineer"))
    print(f"\n[ok] session 2 first topic routed to: {start2.topic}")
    assert start2.topic != "two_pointer", "session 2 wrongly re-routed to a strong topic"
    print("\nALL PHASE-1 CHECKS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
