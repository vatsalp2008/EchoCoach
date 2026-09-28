"""App-level bookkeeping DB — NOT the memory graph (that lives in Cognee).

Runs on SQLite by default (local dev: DATA_DIR/echocoach.db) or on Postgres
when DATABASE_URL is set (deployed, e.g. Neon). One code path for both: the SQL
here sticks to the subset the two share — ON CONFLICT upserts, RETURNING, and
lower() for case-insensitive email — and goes through SQLAlchemy Core.

In Postgres the tables live in their own `echocoach` schema, because that
database is shared with Cognee, which has tables of its own (one is even called
`users`). Queries name tables as {users}, {sessions}, ... and `_sql()` fills in
the schema — SQLite's default schema is "main", so the same names work there.

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
from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import Engine, TextClause, create_engine, text
from sqlalchemy.engine import Connection, RowMapping
from sqlalchemy.exc import IntegrityError  # noqa: F401 — re-exported (duplicate email -> 409)

from .config import DATABASE_URL, SQLITE_PATH
from .question_bank import ALL_QUESTIONS

_POSTGRES = bool(DATABASE_URL)
_SCHEMA_NAME = "echocoach" if _POSTGRES else "main"
_TABLES = ("sessions", "follow_up_counters", "question_bank", "grading_signals", "users", "qa_log")
_QUALIFIED = {t: f"{_SCHEMA_NAME}.{t}" for t in _TABLES}

_SQLITE_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL DEFAULT 'default_user',
    started_at   TEXT NOT NULL,
    ended_at     TEXT,
    domain_focus TEXT NOT NULL,
    company      TEXT,
    target_role  TEXT,
    debrief      TEXT,           -- frozen debrief markdown (history shows the original)
    state        TEXT            -- in-progress interview state (JSON); NULL once ended
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
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- primary identity
    display_name  TEXT NOT NULL,
    password_hash TEXT,           -- NULLABLE: a Google-only account has none
    google_sub    TEXT UNIQUE,    -- reserved for future 'Sign in with Google'
    created_at    TEXT NOT NULL
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

# Same tables and column types (timestamps stay ISO-8601 TEXT, flags INTEGER 0/1)
# so rows read back identically on both engines. Email uniqueness is a unique
# index on lower(email) — Postgres' equivalent of SQLite's COLLATE NOCASE.
_POSTGRES_SCHEMA = """
CREATE SCHEMA IF NOT EXISTS echocoach;
CREATE TABLE IF NOT EXISTS {sessions} (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL DEFAULT 'default_user',
    started_at   TEXT NOT NULL,
    ended_at     TEXT,
    domain_focus TEXT NOT NULL,
    company      TEXT,
    target_role  TEXT,
    debrief      TEXT,
    state        TEXT
);
CREATE TABLE IF NOT EXISTS {follow_up_counters} (
    session_id TEXT NOT NULL,
    topic      TEXT NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, topic)
);
CREATE TABLE IF NOT EXISTS {question_bank} (
    id            TEXT PRIMARY KEY,
    domain        TEXT NOT NULL,
    topic         TEXT NOT NULL,
    question_text TEXT NOT NULL,
    difficulty    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS {grading_signals} (
    id         BIGSERIAL PRIMARY KEY,
    user_id    TEXT NOT NULL DEFAULT 'default_user',
    session_id TEXT NOT NULL,
    topic      TEXT NOT NULL,
    domain     TEXT NOT NULL,
    signal     TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS {users} (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    password_hash TEXT,
    google_sub    TEXT UNIQUE,
    created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_ci ON {users} (lower(email));
CREATE TABLE IF NOT EXISTS {qa_log} (
    id           BIGSERIAL PRIMARY KEY,
    session_id   TEXT NOT NULL,
    topic        TEXT NOT NULL,
    is_follow_up INTEGER NOT NULL DEFAULT 0,
    question     TEXT NOT NULL,
    answer       TEXT NOT NULL DEFAULT '',
    skipped      INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
);
"""

_engine: Engine | None = None


def _get_engine() -> Engine:
    """Created on first use, so importing this module never opens a connection."""
    global _engine
    if _engine is None:
        if _POSTGRES:
            url = DATABASE_URL
            for prefix in ("postgres://", "postgresql://"):
                if url.startswith(prefix):
                    url = "postgresql+psycopg2://" + url[len(prefix):]
            # pre_ping + recycle: a serverless Postgres (Neon) drops idle
            # connections when it scales to zero; never hand out a dead one.
            _engine = create_engine(url, pool_pre_ping=True, pool_recycle=300, pool_size=5)
        else:
            _engine = create_engine(f"sqlite:///{SQLITE_PATH}")
    return _engine


def _sql(query: str) -> TextClause:
    """A query with its {table} placeholders filled in for this engine."""
    return text(query.format(**_QUALIFIED))


def _statements(script: str) -> list[str]:
    """Split a schema script into statements (comments dropped first, so a ';'
    inside one can't split a statement)."""
    code = "\n".join(line.split("--", 1)[0] for line in script.splitlines())
    return [s.strip() for s in code.split(";") if s.strip()]


@contextmanager
def connect() -> Iterator[Connection]:
    """One transaction: commits on success, rolls back on error."""
    with _get_engine().begin() as conn:
        yield conn


def init_db() -> None:
    with connect() as conn:
        if _POSTGRES:
            for stmt in _statements(_POSTGRES_SCHEMA):
                conn.execute(_sql(stmt))
            conn.execute(_sql("ALTER TABLE {sessions} ADD COLUMN IF NOT EXISTS state TEXT"))
        else:
            for stmt in _statements(_SQLITE_SCHEMA):
                conn.execute(text(stmt))
            # Lightweight migration for DBs created before these columns existed.
            cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(sessions)")}
            for col in ("debrief", "state"):
                if col not in cols:
                    conn.exec_driver_sql(f"ALTER TABLE sessions ADD COLUMN {col} TEXT")
        conn.execute(
            _sql(
                "INSERT INTO {question_bank}(id, domain, topic, question_text, difficulty) "
                "VALUES (:id, :domain, :topic, :question_text, :difficulty) "
                "ON CONFLICT(id) DO UPDATE SET domain = excluded.domain, topic = excluded.topic, "
                "question_text = excluded.question_text, difficulty = excluded.difficulty"
            ),
            [
                {"id": q["id"], "domain": q["domain"], "topic": q["topic"],
                 "question_text": q["question"], "difficulty": q["difficulty"]}
                for q in ALL_QUESTIONS
            ],
        )


# ── users (email+password; google_sub reserved for later) ────────────────────
def create_user(
    *, email: str, display_name: str, password_hash: str | None,
    created_at: str, google_sub: str | None = None,
) -> int:
    """Insert a user and return its id. password_hash may be None (Google-only
    account). Raises IntegrityError on a duplicate email (caller -> 409)."""
    with connect() as conn:
        return int(conn.execute(
            _sql(
                "INSERT INTO {users}(email, display_name, password_hash, google_sub, created_at) "
                "VALUES (:email, :display_name, :password_hash, :google_sub, :created_at) "
                "RETURNING id"
            ),
            {"email": email, "display_name": display_name, "password_hash": password_hash,
             "google_sub": google_sub, "created_at": created_at},
        ).scalar_one())


def get_user_by_email(email: str) -> RowMapping | None:
    with connect() as conn:
        return conn.execute(
            _sql("SELECT * FROM {users} WHERE lower(email) = lower(:email)"), {"email": email}
        ).mappings().first()


def get_user_by_id(user_pk: int) -> RowMapping | None:
    with connect() as conn:
        return conn.execute(
            _sql("SELECT * FROM {users} WHERE id = :id"), {"id": user_pk}
        ).mappings().first()


def get_user_by_google_sub(google_sub: str) -> RowMapping | None:
    with connect() as conn:
        return conn.execute(
            _sql("SELECT * FROM {users} WHERE google_sub = :sub"), {"sub": google_sub}
        ).mappings().first()


def set_google_sub(user_pk: int, google_sub: str) -> None:
    """Link a Google identity to an existing (e.g. email+password) account."""
    with connect() as conn:
        conn.execute(
            _sql("UPDATE {users} SET google_sub = :sub WHERE id = :id"),
            {"sub": google_sub, "id": user_pk},
        )


# ── sessions ────────────────────────────────────────────────────────────────
def create_session(
    session_id: str, *, started_at: str, domain_focus: str, company: str | None,
    target_role: str, user_id: str = "default_user",
) -> None:
    with connect() as conn:
        conn.execute(
            _sql(
                "INSERT INTO {sessions}(id, user_id, started_at, domain_focus, company, target_role) "
                "VALUES (:id, :user_id, :started_at, :domain_focus, :company, :target_role)"
            ),
            {"id": session_id, "user_id": user_id, "started_at": started_at,
             "domain_focus": domain_focus, "company": company, "target_role": target_role},
        )


def end_session(session_id: str, ended_at: str) -> None:
    with connect() as conn:
        conn.execute(
            _sql("UPDATE {sessions} SET ended_at = :ended_at WHERE id = :id"),
            {"ended_at": ended_at, "id": session_id},
        )


def get_session(session_id: str) -> RowMapping | None:
    with connect() as conn:
        return conn.execute(
            _sql("SELECT * FROM {sessions} WHERE id = :id"), {"id": session_id}
        ).mappings().first()


def list_sessions(user_id: str) -> list[dict]:
    """A user's past sessions, newest first, with a question count — for the
    History page. Only sessions that actually asked something are included."""
    with connect() as conn:
        rows = conn.execute(
            _sql(
                "SELECT s.id, s.started_at, s.ended_at, s.domain_focus, s.company, "
                "  (SELECT COUNT(*) FROM {qa_log} q WHERE q.session_id = s.id) AS n_questions "
                "FROM {sessions} s WHERE s.user_id = :user_id ORDER BY s.started_at DESC"
            ),
            {"user_id": user_id},
        ).mappings().all()
    return [dict(r) for r in rows if r["n_questions"] > 0]


def get_stored_debrief(session_id: str) -> str | None:
    with connect() as conn:
        return conn.execute(
            _sql("SELECT debrief FROM {sessions} WHERE id = :id"), {"id": session_id}
        ).scalar_one_or_none()


def store_debrief(session_id: str, markdown: str) -> None:
    with connect() as conn:
        conn.execute(
            _sql("UPDATE {sessions} SET debrief = :debrief WHERE id = :id"),
            {"debrief": markdown, "id": session_id},
        )


def load_session_state(session_id: str) -> dict | None:
    """The in-progress interview's state, or None if unknown or ended. Kept in
    the DB (not process memory) so an interview survives a restart and works
    whichever server instance a request lands on."""
    with connect() as conn:
        raw = conn.execute(
            _sql("SELECT state FROM {sessions} WHERE id = :id"), {"id": session_id}
        ).scalar_one_or_none()
    return json.loads(raw) if raw else None


def save_session_state(session_id: str, state: dict | None) -> None:
    """Persist the interview's state after a turn; None marks it ended."""
    with connect() as conn:
        conn.execute(
            _sql("UPDATE {sessions} SET state = :state WHERE id = :id"),
            {"state": json.dumps(state) if state is not None else None, "id": session_id},
        )


# ── follow-up counters (spec 5.3, cap = 2) ───────────────────────────────────
def get_follow_up_count(session_id: str, topic: str) -> int:
    with connect() as conn:
        count = conn.execute(
            _sql(
                "SELECT count FROM {follow_up_counters} "
                "WHERE session_id = :session_id AND topic = :topic"
            ),
            {"session_id": session_id, "topic": topic},
        ).scalar_one_or_none()
        return count or 0


def increment_follow_up(session_id: str, topic: str) -> int:
    with connect() as conn:
        return conn.execute(
            _sql(
                "INSERT INTO {follow_up_counters} AS f (session_id, topic, count) "
                "VALUES (:session_id, :topic, 1) "
                "ON CONFLICT(session_id, topic) DO UPDATE SET count = f.count + 1 "
                "RETURNING count"
            ),
            {"session_id": session_id, "topic": topic},
        ).scalar_one()


# ── grading signals (local mirror for the debrief) ───────────────────────────
def record_signal(signal: dict, user_id: str = "default_user") -> None:
    with connect() as conn:
        conn.execute(
            _sql(
                "INSERT INTO {grading_signals}"
                "(user_id, session_id, topic, domain, signal, payload, created_at) "
                "VALUES (:user_id, :session_id, :topic, :domain, :signal, :payload, :created_at)"
            ),
            {"user_id": user_id, "session_id": signal["session_id"], "topic": signal["topic"],
             "domain": signal["domain"], "signal": signal["signal"],
             "payload": json.dumps(signal), "created_at": signal["timestamp"]},
        )


def signals_for_session(session_id: str) -> list[dict]:
    with connect() as conn:
        payloads = conn.execute(
            _sql("SELECT payload FROM {grading_signals} WHERE session_id = :session_id ORDER BY id"),
            {"session_id": session_id},
        ).scalars().all()
        return [json.loads(p) for p in payloads]


def all_signals(user_id: str = "default_user") -> list[dict]:
    """Every grading signal for a user, oldest first — the local mirror of that
    user's cross-session weakness graph, used for routing and the graph view."""
    with connect() as conn:
        payloads = conn.execute(
            _sql("SELECT payload FROM {grading_signals} WHERE user_id = :user_id ORDER BY id"),
            {"user_id": user_id},
        ).scalars().all()
        return [json.loads(p) for p in payloads]


def count_signals(user_id: str, domain: str | None = None) -> int:
    """How many grading signals a user has (optionally in one domain) — zero
    means their first session, which runs the diagnostic set."""
    with connect() as conn:
        if domain is None:
            return conn.execute(
                _sql("SELECT COUNT(*) FROM {grading_signals} WHERE user_id = :user_id"),
                {"user_id": user_id},
            ).scalar_one()
        return conn.execute(
            _sql(
                "SELECT COUNT(*) FROM {grading_signals} "
                "WHERE user_id = :user_id AND domain = :domain"
            ),
            {"user_id": user_id, "domain": domain},
        ).scalar_one()


def mastered_counts(topic: str, user_id: str = "default_user") -> tuple[int, int]:
    """Return (num mastered signals, num distinct sessions) for a user's topic —
    feeds the mastery threshold check (spec 4.3)."""
    with connect() as conn:
        row = conn.execute(
            _sql(
                "SELECT COUNT(*) AS n, COUNT(DISTINCT session_id) AS s FROM {grading_signals} "
                "WHERE user_id = :user_id AND topic = :topic AND signal = 'mastered'"
            ),
            {"user_id": user_id, "topic": topic},
        ).mappings().one()
        return row["n"], row["s"]


def delete_user_history(user_id: str) -> None:
    """Drop a user's grading signals and sessions (dev scripts reseed with this)."""
    with connect() as conn:
        conn.execute(_sql("DELETE FROM {grading_signals} WHERE user_id = :u"), {"u": user_id})
        conn.execute(_sql("DELETE FROM {sessions} WHERE user_id = :u"), {"u": user_id})


# ── Q&A log (transcript of every question asked + what was answered) ─────────
def record_qa(
    session_id: str, *, topic: str, is_follow_up: bool, question: str,
    answer: str, skipped: bool, created_at: str,
) -> None:
    with connect() as conn:
        conn.execute(
            _sql(
                "INSERT INTO {qa_log}"
                "(session_id, topic, is_follow_up, question, answer, skipped, created_at) "
                "VALUES (:session_id, :topic, :is_follow_up, :question, :answer, :skipped, :created_at)"
            ),
            {"session_id": session_id, "topic": topic, "is_follow_up": int(is_follow_up),
             "question": question, "answer": answer, "skipped": int(skipped),
             "created_at": created_at},
        )


def qa_for_session(session_id: str) -> list[dict]:
    """Every question asked this session (incl. follow-ups), in order, with what
    the candidate answered. Skipped turns carry skipped=True and an empty answer."""
    with connect() as conn:
        rows = conn.execute(
            _sql(
                "SELECT topic, is_follow_up, question, answer, skipped FROM {qa_log} "
                "WHERE session_id = :session_id ORDER BY id"
            ),
            {"session_id": session_id},
        ).mappings().all()
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
        return list(conn.execute(
            _sql("SELECT DISTINCT topic FROM {grading_signals} WHERE session_id = :session_id"),
            {"session_id": session_id},
        ).scalars().all())
