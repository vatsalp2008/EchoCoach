"""App-level SQLite bookkeeping — NOT the memory graph (that lives in Cognee).

Tables (spec 4.4):
  sessions(id, user_id, started_at, domain_focus, company, target_role, ended_at)
  follow_up_counters(session_id, topic, count)   -- per session, capped at 2
  question_bank(id, domain, topic, question_text, difficulty)

Also stores each session's grading signals locally so the debrief can be built
without re-querying the graph for raw JSON (the graph holds them too, but this
keeps the debrief cheap and deterministic).
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from typing import Iterator

from .config import SQLITE_PATH
from .question_bank import ALL_QUESTIONS

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL DEFAULT 'default_user',
    started_at   TEXT NOT NULL,
    ended_at     TEXT,
    domain_focus TEXT NOT NULL,
    company      TEXT,
    target_role  TEXT
);
CREATE TABLE IF NOT EXISTS follow_up_counters (
    session_id TEXT NOT NULL,
    topic      TEXT NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, topic)
);
CREATE TABLE IF NOT EXISTS question_bank (
    id            TEXT PRIMARY KEY,
    domain        TEXT NOT NULL,
    topic         TEXT NOT NULL,
    question_text TEXT NOT NULL,
    difficulty    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS grading_signals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL DEFAULT 'default_user',
    session_id TEXT NOT NULL,
    topic      TEXT NOT NULL,
    domain     TEXT NOT NULL,
    signal     TEXT NOT NULL,
    payload    TEXT NOT NULL,       -- full GradingSignal JSON
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS qa_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    topic        TEXT NOT NULL,
    is_follow_up INTEGER NOT NULL DEFAULT 0,
    question     TEXT NOT NULL,     -- exactly what the candidate saw (incl. grounding rewrite)
    answer       TEXT NOT NULL DEFAULT '',
    skipped      INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
);
"""


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(SQLITE_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with connect() as conn:
        conn.executescript(_SCHEMA)
        for q in ALL_QUESTIONS:
            conn.execute(
                "INSERT OR REPLACE INTO question_bank(id, domain, topic, question_text, difficulty) "
                "VALUES (?,?,?,?,?)",
                (q["id"], q["domain"], q["topic"], q["question"], q["difficulty"]),
            )


# ── sessions ────────────────────────────────────────────────────────────────
def create_session(
    session_id: str, *, started_at: str, domain_focus: str, company: str | None,
    target_role: str, user_id: str = "default_user",
) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO sessions(id, user_id, started_at, domain_focus, company, target_role) "
            "VALUES (?,?,?,?,?,?)",
            (session_id, user_id, started_at, domain_focus, company, target_role),
        )


def end_session(session_id: str, ended_at: str) -> None:
    with connect() as conn:
        conn.execute("UPDATE sessions SET ended_at=? WHERE id=?", (ended_at, session_id))


def get_session(session_id: str) -> sqlite3.Row | None:
    with connect() as conn:
        return conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()


# ── follow-up counters (spec 5.3, cap = 2) ───────────────────────────────────
def get_follow_up_count(session_id: str, topic: str) -> int:
    with connect() as conn:
        row = conn.execute(
            "SELECT count FROM follow_up_counters WHERE session_id=? AND topic=?",
            (session_id, topic),
        ).fetchone()
        return row["count"] if row else 0


def increment_follow_up(session_id: str, topic: str) -> int:
    with connect() as conn:
        conn.execute(
            "INSERT INTO follow_up_counters(session_id, topic, count) VALUES (?,?,1) "
            "ON CONFLICT(session_id, topic) DO UPDATE SET count = count + 1",
            (session_id, topic),
        )
        row = conn.execute(
            "SELECT count FROM follow_up_counters WHERE session_id=? AND topic=?",
            (session_id, topic),
        ).fetchone()
        return row["count"]


# ── grading signals (local mirror for the debrief) ───────────────────────────
def record_signal(signal: dict, user_id: str = "default_user") -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO grading_signals(user_id, session_id, topic, domain, signal, payload, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (
                user_id, signal["session_id"], signal["topic"], signal["domain"],
                signal["signal"], json.dumps(signal), signal["timestamp"],
            ),
        )


def signals_for_session(session_id: str) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT payload FROM grading_signals WHERE session_id=? ORDER BY id",
            (session_id,),
        ).fetchall()
        return [json.loads(r["payload"]) for r in rows]


def all_signals(user_id: str = "default_user") -> list[dict]:
    """Every grading signal for a user, oldest first — the local mirror of that
    user's cross-session weakness graph, used for routing and the graph view."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT payload FROM grading_signals WHERE user_id=? ORDER BY id",
            (user_id,),
        ).fetchall()
        return [json.loads(r["payload"]) for r in rows]


def mastered_counts(topic: str, user_id: str = "default_user") -> tuple[int, int]:
    """Return (num mastered signals, num distinct sessions) for a user's topic —
    feeds the mastery threshold check (spec 4.3)."""
    with connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n, COUNT(DISTINCT session_id) AS s "
            "FROM grading_signals WHERE user_id=? AND topic=? AND signal='mastered'",
            (user_id, topic),
        ).fetchone()
        return row["n"], row["s"]


# ── Q&A log (transcript of every question asked + what was answered) ─────────
def record_qa(
    session_id: str, *, topic: str, is_follow_up: bool, question: str,
    answer: str, skipped: bool, created_at: str,
) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO qa_log(session_id, topic, is_follow_up, question, answer, skipped, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (session_id, topic, int(is_follow_up), question, answer, int(skipped), created_at),
        )


def qa_for_session(session_id: str) -> list[dict]:
    """Every question asked this session (incl. follow-ups), in order, with what
    the candidate answered. Skipped turns carry skipped=True and an empty answer."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT topic, is_follow_up, question, answer, skipped FROM qa_log "
            "WHERE session_id=? ORDER BY id",
            (session_id,),
        ).fetchall()
    return [
        {
            "topic": r["topic"],
            "is_follow_up": bool(r["is_follow_up"]),
            "question": r["question"],
            "answer": r["answer"],
            "skipped": bool(r["skipped"]),
        }
        for r in rows
    ]


def topics_touched(session_id: str) -> list[str]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT DISTINCT topic FROM grading_signals WHERE session_id=?",
            (session_id,),
        ).fetchall()
        return [r["topic"] for r in rows]
