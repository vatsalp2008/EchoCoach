"""Phase 3 grounding smoke test — exercise app/grounding.py end to end,
WITHOUT wiring it into the interview loop yet (that integration comes later).

What it does:
  1. Runs the full discovery -> filter -> ingest -> poll pipeline for one company
     (awaited, so you see the final state), then
  2. If the dataset became READY, tries one ground_question() rewrite.

It prints the DISTINCT skip reasons so you can tell a quota skip from a real
error or missing credentials on your quota-capped key — grep the output for:
    reason=llm-quota            (Gemini quota hit)
    reason=missing-credentials  (Reddit creds not set)
    reason=error                (something actually broke)

Usage:
    backend/.venv/Scripts/python.exe backend/scripts/grounding_smoke.py "Stripe"

Notes:
  - This DOES make live calls: Reddit/GitHub for discovery, and Gemini for the
    relevance filter + cognify (graph build). On a quota-capped key it may skip
    at the filter/ingest step — that's expected and will be logged as llm-quota.
  - Poll interval/count are shortened here vs. the request-path defaults so the
    test finishes faster.
"""

import asyncio
import logging
import sys
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env")
sys.path.insert(0, str(REPO_ROOT / "backend"))

# INFO so grounding's info/skip lines are visible even if it didn't self-attach.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

from app import grounding  # noqa: E402


async def main() -> None:
    company = sys.argv[1] if len(sys.argv) > 1 else "Stripe"
    print("=" * 72)
    print(f"Grounding smoke test for company: {company!r}  (slug={grounding.company_slug(company)})")
    print(f"Reddit creds present: {grounding._has_reddit_creds()}")
    print("=" * 72)

    # Awaited full pipeline with a shorter poll window for a faster test.
    g = await grounding.ensure_company_context(
        company, background=False, poll_interval=6.0, poll_max=6
    )

    print("-" * 72)
    print("FINAL STATE")
    print(f"  status     : {g.status.value}")
    print(f"  dataset    : {g.dataset}")
    print(f"  dataset_id : {g.dataset_id!r}")
    print(f"  n_docs     : {g.n_docs}")
    print(f"  sources    : {g.sources}")
    print(f"  detail     : {g.detail}")
    print(f"  ui_note    : {grounding.ui_note(g.slug)!r}")
    print("-" * 72)

    if g.status is grounding.Status.READY:
        base_q = "How would you design a rate limiter for a public API?"
        print(f"Trying ground_question() on: {base_q!r}")
        grounded = await grounding.ground_question(base_q, g.slug, topic="rate_limiting")
        print("Grounded question:")
        print(f"  {grounded}")
    else:
        print("Dataset not READY — skipping the ground_question() step.")
        print("(See the reason= line above to tell why: quota vs error vs creds.)")


if __name__ == "__main__":
    asyncio.run(main())
