"""Phase 5 seed script (spec 9.1).

Plays 2 realistic sessions for a demo user through the REAL pipeline — real
grading calls, real remember()/improve() into Cognee — so the demo opens with a
weakness graph that already has shape and a live session visibly routes around
genuine prior weak topics.

Run (backend deps + Gemini key required):
  backend/.venv/bin/python backend/scripts/seed_sessions.py [username]

Idempotent: wipes the demo user's prior signals/sessions first.
"""

import asyncio
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "backend"))

from app import db  # noqa: E402
from app import session as S  # noqa: E402
from app.schemas import AnswerRequest, StartSessionRequest  # noqa: E402

USER = sys.argv[1] if len(sys.argv) > 1 else "demo"

# Answers keyed by a phrase in the question. Session 1 = uneven (some weak),
# session 2 = stronger on the previously-weak topics to show progress.
SESSION_1 = {
    "two numbers that add up": (
        "Two pointers from both ends of the sorted array; move them based on whether "
        "the sum is above or below target. O(n) time, O(1) space, because sortedness "
        "lets each step discard one candidate."
    ),
    "url shortener": "Um, I'd put the urls in a database and look them up. Not sure about scale.",
    "project you built": "I worked on some stuff, mostly followed what my teammates decided.",
}
SESSION_2 = {
    "url shortener": (
        "POST to create a short code, GET to redirect. Store code->url in a key-value "
        "store; generate codes as base62 of a Snowflake id to avoid collisions; cache "
        "hot codes in Redis and front reads with a CDN. Shard by code hash to scale writes."
    ),
    "project you built": (
        "I owned the migration from a monolith to an event-driven pipeline. The hardest "
        "call was exactly-once vs at-least-once delivery; I chose at-least-once with "
        "idempotent, event-id-keyed writes because true exactly-once was too costly."
    ),
    "two numbers that add up": (
        "Two pointers on the sorted array, O(n)/O(1). If unsorted I'd sort first at "
        "O(n log n), or use a hash set for O(n) time at O(n) space — I'd pick based on "
        "whether the input is already sorted and memory limits."
    ),
}


def _answer(question: str, answers: dict[str, str]) -> str:
    q = question.lower()
    for kw, text in answers.items():
        if kw in q:
            return text
    return "Let me reason through it step by step, weighing the main tradeoffs as I go."


async def run(answers: dict[str, str], label: str) -> None:
    start = await S.start_session(
        StartSessionRequest(target_role="backend engineer", user_id=USER)
    )
    print(f"\n[{label}] session {start.session_id[:8]} — Q1 [{start.topic}]")
    sid, qid, question = start.session_id, start.question_id, start.question
    for _ in range(15):
        resp = await S.submit_answer(
            AnswerRequest(session_id=sid, question_id=qid, transcript=_answer(question, answers))
        )
        if resp.done:
            print("   done")
            break
        tag = "follow-up" if resp.is_follow_up else "next"
        print(f"   -> {tag} [{resp.topic}]")
        qid, question = resp.next_question_id, resp.question


async def main() -> None:
    db.init_db()
    with db.connect() as conn:
        conn.execute("DELETE FROM grading_signals WHERE user_id=?", (USER,))
        conn.execute("DELETE FROM sessions WHERE user_id=?", (USER,))
    print(f"Seeding demo user {USER!r} with 2 sessions through the real pipeline…")

    await run(SESSION_1, "session 1")
    await run(SESSION_2, "session 2")

    print("\n=== resulting weakness graph (latest signal per topic) ===")
    latest: dict[str, str] = {}
    for s in db.all_signals(USER):
        latest[s["topic"]] = s["signal"]
    for topic, signal in sorted(latest.items()):
        print(f"  {topic:<24} {signal}")
    print(f"\nDone. Open the app, log in as '{USER}', and view /graph.")


if __name__ == "__main__":
    asyncio.run(main())
