"""The single Cognee integration surface for EchoCoach.

Every Cognee call in the app goes through this module — nothing else imports
cognee directly. That keeps the "which parts are our code vs. actual Cognee
operations" boundary explicit (a hackathon judging criterion) and means any
future Cognee API change is a one-file fix.

Signatures below were verified against the INSTALLED cognee 1.2.2 via
`scripts/cognee_smoke_test.py` introspection:
  remember(data, dataset_name=..., *, run_in_background=..., self_improvement=...)
  recall(query_text, *, datasets=[...], top_k=..., query_type=...)
  improve(dataset=..., *, run_in_background=...)        # one dataset per call
  forget(*, dataset=..., dataset_id=..., everything=...)
"""

from __future__ import annotations

from typing import Any

import cognee

from .config import configure_cognee

_configured = False


def init() -> None:
    """Configure Cognee's local stack + Gemini providers exactly once."""
    global _configured
    if not _configured:
        configure_cognee()
        _configured = True


# ── WRITE ───────────────────────────────────────────────────────────────────
async def remember(
    data: str | list[str],
    dataset_name: str,
    *,
    run_in_background: bool = False,
    self_improvement: bool = True,
) -> Any:
    """Cognee op: remember() = add + cognify (+ auto-improve).

    Two uses in EchoCoach:
      1. Performance signals: the grading JSON written to `topic:<slug>`.
      2. External grounding: filtered Reddit/GitHub URLs into
         `company_context:<slug>` (Phase 3), with run_in_background=True.

    Returns Cognee's RememberResult (carries dataset id/status for polling).
    """
    init()
    return await cognee.remember(
        data,
        dataset_name=dataset_name,
        run_in_background=run_in_background,
        self_improvement=self_improvement,
    )


# ── READ ──────────────────────────────────────────────────────────────────
async def recall(
    query_text: str,
    *,
    datasets: list[str] | None = None,
    top_k: int = 15,
) -> Any:
    """Cognee op: recall() = auto-routed hybrid graph+vector search.

    Used to (a) route each session toward the weakest unresolved topic, and
    (b) ground questions from `company_context:<slug>` when ready (Phase 3).
    """
    init()
    return await cognee.recall(query_text, datasets=datasets, top_k=top_k)


# ── REINFORCE ───────────────────────────────────────────────────────────────
async def improve(dataset: str) -> Any:
    """Cognee op: improve() = graph reinforcement for ONE dataset.

    Called explicitly at session boundaries over each topic dataset touched
    this session — a deliberate choice ON TOP OF remember()'s per-call
    auto-improve pass, to reinforce the whole session's signals at once.
    """
    init()
    return await cognee.improve(dataset=dataset)


# ── ARCHIVE ─────────────────────────────────────────────────────────────────
async def forget(dataset: str) -> Any:
    """Cognee op: forget() = real dataset archival/deletion.

    Called when a topic crosses the mastery threshold (spec 4.3): the
    `topic:<slug>` dataset is removed so it stops being routed to.
    """
    init()
    return await cognee.forget(dataset=dataset)


# ── STATUS / INTROSPECTION (Phase 2 graph, Phase 3 polling) ──────────────────
async def dataset_status(dataset_ids: list) -> Any:
    """Cognee op: datasets.get_status() — pipeline status for background jobs."""
    init()
    return await cognee.datasets.get_status(dataset_ids)


async def list_datasets() -> Any:
    """Cognee op: datasets.list_datasets() — used by cache check + graph API."""
    init()
    return await cognee.datasets.list_datasets()
