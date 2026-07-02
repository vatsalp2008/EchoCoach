"""Hardcoded question bank. Every question maps to a known `topic` slug so
grading signals attach to the correct graph node — the LLM never invents
diagnostic questions (spec 5.1). Behavioral questions land in Phase 2.
"""

from __future__ import annotations

from typing import TypedDict


class Question(TypedDict):
    id: str
    domain: str  # "technical" | "behavioral"
    topic: str
    question: str
    difficulty: str  # "easy" | "medium" | "hard"


# ── Technical (Phase 1): 8–10 questions, tagged by topic ─────────────────────
TECHNICAL: list[Question] = [
    {
        "id": "tech_two_pointer",
        "domain": "technical",
        "topic": "two_pointer",
        "question": "Given a sorted array, find two numbers that add up to a target value. Walk me through your approach.",
        "difficulty": "easy",
    },
    {
        "id": "tech_hashmap_dedup",
        "domain": "technical",
        "topic": "hashing_basics",
        "question": "How would you find the first non-repeating character in a string? Talk through the data structures you'd reach for.",
        "difficulty": "easy",
    },
    {
        "id": "tech_binary_search",
        "domain": "technical",
        "topic": "binary_search",
        "question": "You're given a rotated sorted array. How would you search it in better than linear time?",
        "difficulty": "medium",
    },
    {
        "id": "tech_consistent_hashing",
        "domain": "technical",
        "topic": "consistent_hashing",
        "question": "How would you design a caching layer that scales horizontally? What happens when you add a new cache node?",
        "difficulty": "medium",
    },
    {
        "id": "tech_db_indexing",
        "domain": "technical",
        "topic": "db_indexing",
        "question": "A read-heavy query on a large table is slow. Walk me through how you'd diagnose and speed it up.",
        "difficulty": "medium",
    },
    {
        "id": "tech_rate_limiter",
        "domain": "technical",
        "topic": "rate_limiting",
        "question": "Design a rate limiter for a public API. What algorithm do you choose and what are its tradeoffs?",
        "difficulty": "medium",
    },
    {
        "id": "tech_url_shortener",
        "domain": "technical",
        "topic": "system_design_basics",
        "question": "Design a URL shortener. Take me from the API surface down to how you store and retrieve mappings at scale.",
        "difficulty": "medium",
    },
    {
        "id": "tech_concurrency",
        "domain": "technical",
        "topic": "concurrency",
        "question": "Two threads increment a shared counter and you see lost updates. Explain why, and how you'd fix it.",
        "difficulty": "medium",
    },
    {
        "id": "tech_cap_theorem",
        "domain": "technical",
        "topic": "distributed_tradeoffs",
        "question": "Your service must stay available during a network partition. What are you giving up, and how do you reason about it?",
        "difficulty": "hard",
    },
    {
        "id": "tech_project_walkthrough",
        "domain": "technical",
        "topic": "project_depth",
        "question": "Walk me through a project you built. Focus on the hardest technical decision you made and why.",
        "difficulty": "medium",
    },
]

# ── Behavioral (Phase 2): 5–6 questions, tagged by topic ─────────────────────
BEHAVIORAL: list[Question] = [
    {
        "id": "beh_conflict",
        "domain": "behavioral",
        "topic": "conflict_story",
        "question": "Tell me about a time you disagreed with a teammate on a technical decision. How did you handle it?",
        "difficulty": "medium",
    },
    {
        "id": "beh_failure",
        "domain": "behavioral",
        "topic": "failure_story",
        "question": "Describe a project or decision that didn't go the way you hoped. What happened and what did you take from it?",
        "difficulty": "medium",
    },
    {
        "id": "beh_prioritization",
        "domain": "behavioral",
        "topic": "prioritization_story",
        "question": "Tell me about a time you had far more to do than time allowed. How did you decide what to work on?",
        "difficulty": "medium",
    },
    {
        "id": "beh_leadership",
        "domain": "behavioral",
        "topic": "leadership_story",
        "question": "Give me an example of a time you drove something forward without being asked or without formal authority.",
        "difficulty": "medium",
    },
    {
        "id": "beh_ambiguity",
        "domain": "behavioral",
        "topic": "ambiguity_story",
        "question": "Tell me about a time you had to make progress on a problem that was poorly defined or kept changing.",
        "difficulty": "medium",
    },
]

ALL_QUESTIONS: list[Question] = TECHNICAL + BEHAVIORAL

_BY_ID = {q["id"]: q for q in ALL_QUESTIONS}
_BY_TOPIC: dict[str, list[Question]] = {}
for _q in ALL_QUESTIONS:
    _BY_TOPIC.setdefault(_q["topic"], []).append(_q)


def get_question(question_id: str) -> Question | None:
    return _BY_ID.get(question_id)


def question_for_topic(topic: str) -> Question | None:
    qs = _BY_TOPIC.get(topic)
    return qs[0] if qs else None


def all_topics(domain: str | None = None) -> list[str]:
    return sorted(
        {q["topic"] for q in ALL_QUESTIONS if domain is None or q["domain"] == domain}
    )


# First-session diagnostic order per domain. Technical (spec 5.5): DSA ->
# system design -> project. Behavioral: a spread across story types.
DIAGNOSTIC_SEQUENCE: list[str] = [
    "tech_two_pointer",
    "tech_url_shortener",
    "tech_project_walkthrough",
]

DIAGNOSTIC_BY_DOMAIN: dict[str, list[str]] = {
    "technical": DIAGNOSTIC_SEQUENCE,
    "behavioral": ["beh_conflict", "beh_failure", "beh_prioritization"],
}
