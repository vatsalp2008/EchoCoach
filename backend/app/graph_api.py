"""/api/graph — the weakness graph projected for visualization (spec 6.3).

Nodes are interview topics with their current signal, mastery, and recency;
edges are the (mostly prerequisite/related) structure between topics. Node state
comes from the local signal mirror, which mirrors what remember() writes into
Cognee — reliable and instant to query for the live view.
"""

from __future__ import annotations

from fastapi import APIRouter

from . import db
from .question_bank import ALL_QUESTIONS

router = APIRouter()

_TOPIC_DOMAIN = {q["topic"]: q["domain"] for q in ALL_QUESTIONS}

# Related/prerequisite structure — this is where a graph beats a flat list.
_TOPIC_EDGES: list[tuple[str, str]] = [
    ("hashing_basics", "two_pointer"),
    ("two_pointer", "binary_search"),
    ("consistent_hashing", "system_design_basics"),
    ("db_indexing", "system_design_basics"),
    ("rate_limiting", "system_design_basics"),
    ("system_design_basics", "distributed_tradeoffs"),
    ("consistent_hashing", "distributed_tradeoffs"),
    ("concurrency", "distributed_tradeoffs"),
    ("conflict_story", "leadership_story"),
    ("prioritization_story", "leadership_story"),
    ("failure_story", "ambiguity_story"),
]


def _pretty(topic: str) -> str:
    return topic.replace("_", " ")


@router.get("/api/graph")
async def graph(user: str = "default_user") -> dict:
    signals = db.all_signals(user)  # oldest-first, scoped to this profile
    latest: dict[str, str] = {}
    counts: dict[str, int] = {}
    last_seen: dict[str, str] = {}
    for s in signals:
        latest[s["topic"]] = s["signal"]  # last write wins
        counts[s["topic"]] = counts.get(s["topic"], 0) + 1
        last_seen[s["topic"]] = s["timestamp"]

    topics = sorted(set(_TOPIC_DOMAIN) | set(latest))
    nodes = []
    for topic in topics:
        n_mastered, n_sessions = db.mastered_counts(topic, user)
        nodes.append(
            {
                "id": topic,
                "label": _pretty(topic),
                "domain": _TOPIC_DOMAIN.get(topic, "technical"),
                "signal": latest.get(topic, "unassessed"),
                "interactions": counts.get(topic, 0),
                "last_seen": last_seen.get(topic),
                "archived": n_mastered >= 3 and n_sessions >= 2,  # forget() threshold
            }
        )

    known = {n["id"] for n in nodes}
    edges = [
        {"source": a, "target": b}
        for a, b in _TOPIC_EDGES
        if a in known and b in known
    ]
    return {"nodes": nodes, "edges": edges}
