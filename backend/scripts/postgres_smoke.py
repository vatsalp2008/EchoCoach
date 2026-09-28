"""End-to-end check of Postgres mode (DATABASE_URL) against a real database.

Run once after pointing DATABASE_URL at a new database (e.g. Neon) to confirm
the app tables and Cognee's memory graph both work there:

    DATABASE_URL='postgresql://...' backend/.venv/bin/python backend/scripts/postgres_smoke.py

It writes two small memories into throwaway datasets, checks a dataset-scoped
recall only sees its own dataset (the node-set scoping memory.py relies on in
shared-store mode), then forgets both. Cognify calls the LLM, so this spends a
handful (~5-8) of Gemini requests.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import config, db, memory  # noqa: E402

COMPANY = "company_context:smoke-test-co"
PRIVATE = "topic:smoke-test-user:graphs"


def check(ok: bool, label: str) -> None:
    print(f"[{'ok' if ok else 'FAIL'}] {label}")
    if not ok:
        sys.exit(1)


async def main() -> None:
    check(bool(config.DATABASE_URL), "DATABASE_URL is set (this script tests Postgres mode)")
    db.init_db()
    check(db.get_user_by_email("nobody@smoke.test") is None, "app tables reachable (echocoach schema)")

    import cognee
    from cognee.modules.search.types import SearchType

    from app.llm_client import _is_quota_error

    memory.init()
    try:
        await memory.remember(
            "Smoke Test Co interview reports: candidates were asked to design a rate limiter "
            "for a payments API and to discuss idempotency keys.",
            dataset_name=COMPANY, self_improvement=False,
        )
        await memory.remember(
            "Private memory: the candidate froze on red-black tree rotations and avoided "
            "the question about B-trees.",
            dataset_name=PRIVATE, self_improvement=False,
        )
    except Exception as e:
        if isinstance(e, asyncio.TimeoutError) or _is_quota_error(e):
            print("[FAIL] the Gemini key is out of quota (cognify needs the LLM) — the "
                  "database side is fine; rerun after the daily reset.")
            sys.exit(2)
        raise
    names = {d.name for d in await memory.list_datasets()}
    check({COMPANY, PRIVATE} <= names, "remember() created both datasets")

    # Same scoping memory.recall() applies, minus the answer-writing LLM call.
    scope = {"node_name": [COMPANY]} if config.COGNEE_SHARED_STORE else {}
    hits = await cognee.recall(
        "What were candidates asked in interviews?", SearchType.GRAPH_COMPLETION,
        datasets=[COMPANY], top_k=10, only_context=True, **scope,
    )
    context = str(hits).lower()
    check("rate limiter" in context or "idempotency" in context, "scoped recall finds the company memory")
    check("red-black" not in context and "b-tree" not in context,
          "scoped recall does NOT see another dataset's memory")

    await memory.forget(PRIVATE)
    await memory.forget(COMPANY)
    names = {d.name for d in await memory.list_datasets()}
    check(not ({COMPANY, PRIVATE} & names), "forget() removed both datasets")
    print("Postgres mode works end to end.")


if __name__ == "__main__":
    asyncio.run(main())
