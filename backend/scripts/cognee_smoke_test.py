"""Phase 0 gate (spec 3).

Two independent jobs:
  1. INTROSPECT the installed Cognee package to record the REAL signatures of
     remember / recall / improve / forget / memify and the dataset status API.
     This needs NO API key and always runs.
  2. Run the full remember -> recall -> improve -> forget lifecycle against real
     Cognee. This calls the LLM (Gemini) during cognify, so it needs GEMINI_API_KEY.

Do not proceed to Phase 1 until job 2 passes end to end.

Run:  backend/.venv/bin/python backend/scripts/cognee_smoke_test.py
"""

import asyncio
import inspect
import os
import sys
from pathlib import Path

# Load .env from repo root before importing cognee (cognee reads env on import).
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env")

# Make the backend package importable so we share the app's Cognee config
# (repo-local storage + Gemini providers), rather than Cognee's defaults.
sys.path.insert(0, str(REPO_ROOT / "backend"))

import cognee  # noqa: E402
from app.config import configure_cognee  # noqa: E402

configure_cognee()


def introspect():
    """Print the real API surface so we can encode it into memory.py."""
    print("=" * 70)
    print(f"cognee version: {getattr(cognee, '__version__', 'unknown')}")
    print("=" * 70)
    for name in ("remember", "recall", "improve", "forget", "memify",
                 "add", "cognify", "search", "prune"):
        fn = getattr(cognee, name, None)
        if fn is None:
            print(f"  cognee.{name:<10} : NOT PRESENT")
            continue
        try:
            sig = inspect.signature(fn)
        except (ValueError, TypeError):
            sig = "(signature unavailable)"
        print(f"  cognee.{name:<10} : {sig}")

    # Dataset / pipeline status API used by Phase 3 background polling.
    print("-" * 70)
    for path in ("datasets", "api"):
        mod = getattr(cognee, path, None)
        print(f"  cognee.{path}: {'present' if mod is not None else 'absent'}")
    print("=" * 70)


async def lifecycle():
    """Full spec-3 loop against real Cognee. Requires GEMINI_API_KEY."""
    if not os.getenv("GEMINI_API_KEY"):
        print("\n[skip] GEMINI_API_KEY not set — skipping live lifecycle loop.")
        print("       Set it in .env and re-run to verify remember/recall/improve/forget.")
        return False

    ds = "topic:consistent_hashing"
    print(f"\n[1/4] remember() -> dataset {ds!r}")
    await cognee.remember(
        "The candidate struggled to explain consistent hashing.",
        dataset_name=ds,
    )

    print("[2/4] recall()")
    result = await cognee.recall(
        "What has the candidate struggled with?",
        datasets=[ds],
    )
    print("      recall result:", result)

    print("[3/4] improve(dataset=ds)")
    # improve() targets ONE dataset (default 'main_dataset'); point it at the
    # topic dataset we just wrote, else it projects an empty graph and 404s.
    await cognee.improve(dataset=ds)

    print("[4/4] forget()")
    await cognee.forget(dataset=ds)

    print("\n[ok] Full remember -> recall -> improve -> forget loop passed.")
    return True


async def main():
    introspect()
    try:
        await lifecycle()
    except TypeError as e:
        # Most likely a keyword-arg mismatch vs. the spec's assumed names.
        print(f"\n[SIGNATURE MISMATCH] {e}")
        print("Adjust the calls above to match the introspected signatures, then re-run.")
        sys.exit(2)


if __name__ == "__main__":
    asyncio.run(main())
