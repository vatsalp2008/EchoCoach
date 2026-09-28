"""db.py behaves the same on SQLite (local dev) and Postgres (deployed).

Every test taking the `db` fixture (conftest.py) runs once per engine.
"""

from __future__ import annotations

import os
import sqlite3

import pytest


def test_question_bank_seeded(db):
    from app.question_bank import ALL_QUESTIONS

    with db.connect() as conn:
        n = conn.execute(db._sql("SELECT COUNT(*) FROM {question_bank}")).scalar_one()
    assert n == len(ALL_QUESTIONS)


def test_users(db):
    uid = db.create_user(email="Ada@Example.com", display_name="Ada",
                         password_hash="h", created_at="2026-01-01T00:00:00+00:00")
    assert isinstance(uid, int)
    row = db.get_user_by_email("ada@example.COM")  # case-insensitive
    assert row["id"] == uid and row["display_name"] == "Ada" and row["password_hash"] == "h"
    assert db.get_user_by_id(uid)["email"] == "Ada@Example.com"
    assert db.get_user_by_id(uid + 999) is None
    with pytest.raises(db.IntegrityError):
        db.create_user(email="ADA@example.com", display_name="Dup",
                       password_hash=None, created_at="2026-01-01T00:00:00+00:00")
    db.set_google_sub(uid, "google-123")
    assert db.get_user_by_google_sub("google-123")["id"] == uid
    assert db.get_user_by_google_sub("nope") is None
    guest = db.create_user(email="g@example.com", display_name="G", password_hash=None,
                           created_at="2026-01-02T00:00:00+00:00", google_sub="google-456")
    assert db.get_user_by_id(guest)["password_hash"] is None


def test_sessions_and_history(db):
    db.create_session("s1", started_at="2026-01-01T10:00:00", domain_focus="technical",
                      company=None, target_role="backend", user_id="7")
    db.create_session("s2", started_at="2026-01-02T10:00:00", domain_focus="full",
                      company="Stripe", target_role="backend", user_id="7")
    db.create_session("s3", started_at="2026-01-03T10:00:00", domain_focus="technical",
                      company=None, target_role="backend", user_id="7")  # never asked anything
    for sid in ("s1", "s2", "s2"):
        db.record_qa(sid, topic="t", is_follow_up=False, question="q", answer="a",
                     skipped=False, created_at="2026-01-01T10:01:00")
    history = db.list_sessions("7")
    assert [s["id"] for s in history] == ["s2", "s1"]  # newest first, s3 hidden
    assert [s["n_questions"] for s in history] == [2, 1]
    assert history[0]["company"] == "Stripe"
    assert db.list_sessions("someone-else") == []

    assert db.get_session("s1")["domain_focus"] == "technical"
    assert db.get_session("missing") is None
    db.end_session("s1", "2026-01-01T11:00:00")
    assert db.get_session("s1")["ended_at"] == "2026-01-01T11:00:00"
    assert db.get_stored_debrief("s1") is None
    db.store_debrief("s1", "## Debrief")
    assert db.get_stored_debrief("s1") == "## Debrief"
    assert db.get_stored_debrief("missing") is None


def test_follow_up_counters(db):
    assert db.get_follow_up_count("s1", "graphs") == 0
    assert db.increment_follow_up("s1", "graphs") == 1
    assert db.increment_follow_up("s1", "graphs") == 2
    assert db.increment_follow_up("s1", "trees") == 1
    assert db.get_follow_up_count("s1", "graphs") == 2


def _signal(session_id, topic, signal, domain="technical", ts="2026-01-01T10:00:00"):
    return {"session_id": session_id, "topic": topic, "domain": domain,
            "signal": signal, "timestamp": ts, "notes": "x"}


def test_signals(db):
    db.record_signal(_signal("s1", "graphs", "struggled"), user_id="7")
    db.record_signal(_signal("s1", "trees", "mastered"), user_id="7")
    db.record_signal(_signal("s2", "trees", "mastered", ts="2026-01-02T10:00:00"), user_id="7")
    db.record_signal(_signal("s2", "star", "partial", domain="behavioral"), user_id="7")
    db.record_signal(_signal("s9", "graphs", "mastered"), user_id="8")

    assert [s["topic"] for s in db.signals_for_session("s1")] == ["graphs", "trees"]
    assert db.signals_for_session("s1")[0] == _signal("s1", "graphs", "struggled")  # JSON round-trip
    assert [s["topic"] for s in db.all_signals("7")] == ["graphs", "trees", "trees", "star"]
    assert db.count_signals("7") == 4
    assert db.count_signals("7", "behavioral") == 1
    assert db.count_signals("nobody") == 0
    assert db.mastered_counts("trees", "7") == (2, 2)
    assert db.mastered_counts("graphs", "7") == (0, 0)
    assert sorted(db.topics_touched("s2")) == ["star", "trees"]

    db.delete_user_history("7")
    assert db.all_signals("7") == [] and db.count_signals("8") == 1


def test_qa_log(db):
    db.record_qa("s1", topic="graphs", is_follow_up=False, question="Q1", answer="A1",
                 skipped=False, created_at="2026-01-01T10:00:00")
    db.record_qa("s1", topic="graphs", is_follow_up=True, question="Q2", answer="",
                 skipped=True, created_at="2026-01-01T10:01:00")
    assert db.qa_for_session("s1") == [
        {"topic": "graphs", "is_follow_up": False, "question": "Q1", "answer": "A1", "skipped": False},
        {"topic": "graphs", "is_follow_up": True, "question": "Q2", "answer": "", "skipped": True},
    ]


def test_sqlite_upgrades_an_older_database(load_db, tmp_path):
    """Existing local DBs predate the debrief/state columns; init_db adds them."""
    old = sqlite3.connect(tmp_path / "echocoach.db")
    old.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT "
                "'default_user', started_at TEXT NOT NULL, ended_at TEXT, domain_focus TEXT "
                "NOT NULL, company TEXT, target_role TEXT)")
    old.execute("INSERT INTO sessions(id, started_at, domain_focus) VALUES ('old', 't', 'technical')")
    old.commit()
    old.close()
    db = load_db("")
    db.init_db()
    assert db.get_session("old")["debrief"] is None
    db.store_debrief("old", "kept")
    assert db.get_stored_debrief("old") == "kept"
    assert db.load_session_state("old") is None
    db.save_session_state("old", {"current": {"id": "q1"}, "asked_topics": ["t"]})
    assert db.load_session_state("old") == {"current": {"id": "q1"}, "asked_topics": ["t"]}


def test_session_state_round_trip(db):
    db.create_session("s1", started_at="t", domain_focus="technical", company=None,
                      target_role="backend", user_id="7")
    assert db.load_session_state("s1") is None
    state = {"user_id": "7", "asked_topics": ["a"], "diagnostic_queue": ["q2"],
             "is_first_session": True, "current": {"id": "q1", "is_follow_up": False},
             "company_slug": None}
    db.save_session_state("s1", state)
    assert db.load_session_state("s1") == state
    db.save_session_state("s1", None)
    assert db.load_session_state("s1") is None
    assert db.load_session_state("missing") is None


def test_database_url_points_cognee_at_postgres(load_db, monkeypatch):
    url = "postgresql://neon_user:p%40ss@ep-cool-1.us-east-2.aws.neon.tech/neondb?sslmode=require"
    # Register every var config will write so monkeypatch restores them after.
    for prefix in ("DB_", "VECTOR_DB_", "GRAPH_DATABASE_"):
        for suffix in ("HOST", "PORT", "USERNAME", "PASSWORD", "NAME"):
            monkeypatch.setenv(prefix + suffix, "")
    for key in ("ENABLE_BACKEND_ACCESS_CONTROL", "DATABASE_CONNECT_ARGS"):
        monkeypatch.setenv(key, "")
    for key in ("VECTOR_DB_PROVIDER", "GRAPH_DATABASE_PROVIDER", "DB_PROVIDER"):
        monkeypatch.setenv(key, "local-stack-value-from-.env")
    load_db(url)
    import app.config

    assert app.config.COGNEE_SHARED_STORE is True
    env = os.environ
    assert (env["DB_PROVIDER"], env["VECTOR_DB_PROVIDER"], env["GRAPH_DATABASE_PROVIDER"]) == (
        "postgres", "pgvector", "postgres")
    for prefix in ("DB_", "VECTOR_DB_", "GRAPH_DATABASE_"):
        assert env[prefix + "HOST"] == "ep-cool-1.us-east-2.aws.neon.tech"
        assert env[prefix + "PORT"] == "5432"
        assert env[prefix + "USERNAME"] == "neon_user"
        assert env[prefix + "PASSWORD"] == "p@ss"  # URL-decoded
        assert env[prefix + "NAME"] == "neondb"
    assert env["ENABLE_BACKEND_ACCESS_CONTROL"] == "false"
    assert env["DATABASE_CONNECT_ARGS"] == '{"ssl": "require"}'
