"""memory.py scopes Cognee calls by dataset in Postgres (shared-store) mode.

With every dataset in one shared graph, Cognee ignores `datasets=` when
searching, so memory.py tags writes with their dataset as a node set and
filters scoped recalls on it. Locally (one database per dataset) it passes
neither, so local behavior is exactly what it was. No LLM calls: Cognee's
remember/recall are replaced with recorders.
"""

from __future__ import annotations

import asyncio

import pytest

from app import memory


@pytest.fixture
def calls(monkeypatch):
    seen: dict[str, dict] = {}

    async def fake_remember(data, **kwargs):
        seen["remember"] = kwargs

    async def fake_recall(query, **kwargs):
        seen["recall"] = kwargs
        return []

    monkeypatch.setattr(memory.cognee, "remember", fake_remember)
    monkeypatch.setattr(memory.cognee, "recall", fake_recall)
    monkeypatch.setattr(memory, "init", lambda: None)
    return seen


def test_shared_store_tags_writes_and_filters_scoped_reads(monkeypatch, calls):
    monkeypatch.setattr(memory, "COGNEE_SHARED_STORE", True)
    asyncio.run(memory.remember("signal", dataset_name="topic:7:graphs"))
    assert calls["remember"]["node_set"] == ["topic:7:graphs"]
    assert calls["remember"]["dataset_name"] == "topic:7:graphs"

    asyncio.run(memory.recall("q", datasets=["company_context:stripe"], top_k=5))
    assert calls["recall"]["node_name"] == ["company_context:stripe"]
    assert calls["recall"]["datasets"] == ["company_context:stripe"]

    asyncio.run(memory.recall("q", top_k=10))  # unscoped routing recall stays unscoped
    assert "node_name" not in calls["recall"]


def test_local_stack_passes_no_scoping(monkeypatch, calls):
    monkeypatch.setattr(memory, "COGNEE_SHARED_STORE", False)
    asyncio.run(memory.remember("signal", dataset_name="topic:7:graphs"))
    assert "node_set" not in calls["remember"]
    asyncio.run(memory.recall("q", datasets=["company_context:stripe"], top_k=5))
    assert "node_name" not in calls["recall"]
