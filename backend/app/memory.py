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

import asyncio
import time
from typing import Any

import cognee

from .config import configure_cognee
from .llm_client import _is_quota_error

_configured = False

# Circuit breaker for graph WRITES (cognify). When cognify hits quota, skip
# further writes for a cooldown so we don't repeatedly pay the failing call —
# the local SQLite mirror stays authoritative and the graph catches up later.
_GRAPH_WRITE_COOLDOWN_S = 300.0
_graph_writes_paused_until = 0.0

# Hard time bound on any single Cognee LLM op. Cognee's tenacity retry is
# hardcoded to back off for up to 240s on a persistent 429, which would hang the
# interview — we cancel well before that and let the breaker take over.
_BOUND_S = 45.0
_READ_BOUND_S = 20.0  # recall reads fail faster than writes so debrief stays snappy

# Keep references to detached write tasks so they aren't garbage-collected.
_pending: set[asyncio.Task] = set()


def init() -> None:
    """Configure Cognee's local stack + Gemini providers exactly once."""
    global _configured
    if not _configured:
        configure_cognee()
        _configured = True


def _graph_writes_open() -> bool:
    return time.time() >= _graph_writes_paused_until


def llm_available() -> bool:
    """True unless the breaker is open. Used as a proxy for 'the LLM has quota'
    so read paths (recall) can skip work that would just time out."""
    return _graph_writes_open()


def _trip_breaker() -> None:
    global _graph_writes_paused_until
    _graph_writes_paused_until = time.time() + _GRAPH_WRITE_COOLDOWN_S


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

    Returns Cognee's RememberResult (carries dataset id/status for polling), or
    None if graph writes are paused by the circuit breaker.
    """
    init()
    if not _graph_writes_open():
        return None  # breaker open — skip the write, mirror stays authoritative
    try:
        return await asyncio.wait_for(
            cognee.remember(
                data,
                dataset_name=dataset_name,
                run_in_background=run_in_background,
                self_improvement=self_improvement,
            ),
            timeout=_BOUND_S,
        )
    except Exception as e:
        if isinstance(e, asyncio.TimeoutError) or _is_quota_error(e):
            _trip_breaker()
        raise


def schedule_remember(data: str | list[str], dataset_name: str) -> None:
    """Fire-and-forget graph write. Never blocks the caller: the cognify (and
    any quota backoff) runs as a detached, time-bounded, breaker-aware task while
    the interview turn returns immediately on the synchronous SQLite mirror."""
    init()
    if not _graph_writes_open():
        return

    async def _run() -> None:
        try:
            await remember(data, dataset_name=dataset_name)
        except Exception:
            pass  # best-effort; breaker already tripped inside remember() if quota

    task = asyncio.create_task(_run())
    _pending.add(task)
    task.add_done_callback(_pending.discard)


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
    Time-bounded so a quota-stalled completion can't hang the caller.
    """
    init()
    return await asyncio.wait_for(
        cognee.recall(query_text, datasets=datasets, top_k=top_k), timeout=_READ_BOUND_S
    )


# ── REINFORCE ───────────────────────────────────────────────────────────────
async def improve(dataset: str) -> Any:
    """Cognee op: improve() = graph reinforcement for ONE dataset.

    Called explicitly at session boundaries over each topic dataset touched
    this session — a deliberate choice ON TOP OF remember()'s per-call
    auto-improve pass, to reinforce the whole session's signals at once.
    """
    init()
    if not _graph_writes_open():
        return None
    try:
        return await asyncio.wait_for(cognee.improve(dataset=dataset), timeout=_BOUND_S)
    except Exception as e:
        if isinstance(e, asyncio.TimeoutError) or _is_quota_error(e):
            _trip_breaker()
        raise


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
