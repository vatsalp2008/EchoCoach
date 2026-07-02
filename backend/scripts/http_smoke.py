"""Drive a full interview over HTTP against a running backend (localhost:8000)
and print each turn + the final debrief. Useful for demo rehearsal and for
confirming the API contract end-to-end.

Run (backend must be up):  backend/.venv/bin/python backend/scripts/http_smoke.py
"""

import sys

import httpx

BASE = "http://localhost:8000"

ANSWERS = {
    "two_pointer": "Two pointers from both ends of the sorted array, moving inward "
    "based on whether the current sum is above or below the target. O(n) time, O(1) "
    "space. It works because sortedness lets each comparison eliminate one candidate.",
    "system_design_basics": "I'd expose a POST to create a short code and a GET to "
    "redirect. Store code->url in a key-value store, generate codes with base62 of an "
    "incrementing id, and cache hot lookups. Scale reads with replicas and a CDN.",
    "project_depth": "I built a streaming pipeline; the hardest call was choosing "
    "exactly-once over at-least-once, which I handled with idempotent writes keyed by "
    "event id and a transactional sink.",
}


def answer_for(topic: str, question: str) -> str:
    if topic in ANSWERS:
        return ANSWERS[topic]
    return "Let me think — I'd approach it step by step and reason about the tradeoffs."


def main() -> None:
    with httpx.Client(base_url=BASE, timeout=90) as c:
        start = c.post("/api/session", json={"target_role": "backend engineer"}).json()
        sid = start["session_id"]
        print(f"session {sid[:8]}  Q1 [{start['topic']}]: {start['question'][:70]}...")
        qid, topic, question = start["question_id"], start["topic"], start["question"]

        for _ in range(15):
            r = c.post("/api/answer", json={
                "session_id": sid, "question_id": qid,
                "transcript": answer_for(topic, question),
            }).json()
            assert "signal" not in r, "grade leaked into answer response"
            if r["done"]:
                print("  -> done")
                break
            tag = "follow-up" if r["is_follow_up"] else "next"
            print(f"  -> {tag} [{r['topic']}]: {r['question'][:70]}...")
            qid, topic, question = r["next_question_id"], r["topic"], r["question"]

        debrief = c.get(f"/api/session/{sid}/debrief").json()["debrief"]
        print("\n===== DEBRIEF =====\n" + debrief)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FAILED: {type(e).__name__}: {e}")
        sys.exit(1)
