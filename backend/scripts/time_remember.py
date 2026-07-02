"""Quick timing/reliability probe for a single remember() under the configured
Cognee LLM. Prints elapsed seconds or the failure. Usage:
  LLM_MODEL=ollama/mistral:latest .venv/bin/python scripts/time_remember.py
"""
import asyncio, sys, time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "backend"))
from dotenv import load_dotenv
load_dotenv(REPO / ".env")
from app.config import configure_cognee
configure_cognee()
import cognee


async def main():
    t0 = time.time()
    try:
        await cognee.remember(
            "The candidate confused BFS and DFS and could not explain time complexity.",
            dataset_name="topic:probe",
        )
        print(f"REMEMBER_OK elapsed={time.time()-t0:.1f}s")
        r = await cognee.recall("What did the candidate struggle with?", datasets=["topic:probe"])
        print(f"RECALL_OK entries={len(r)} elapsed={time.time()-t0:.1f}s")
        await cognee.forget(dataset="topic:probe")
        print("FORGET_OK")
    except Exception as e:
        print(f"FAILED after {time.time()-t0:.1f}s: {type(e).__name__}: {str(e)[:200]}")
        sys.exit(1)


asyncio.run(main())
