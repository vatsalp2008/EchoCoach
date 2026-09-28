"""Shared fixtures: a fresh app.db on SQLite and, optionally, Postgres.

SQLite always runs. Postgres runs when TEST_DATABASE_URL points at a disposable
database whose name contains "test" — the tests drop and recreate the
`echocoach` schema there (and add a stand-in for Cognee's `public.users`
table), so never point it at a real one.

    TEST_DATABASE_URL=postgresql://postgres@localhost:55432/echocoach_test \
        backend/.venv/bin/python -m pytest backend/tests -q
"""

from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # `import app` from anywhere

TEST_PG_URL = os.getenv("TEST_DATABASE_URL", "")


@pytest.fixture
def load_db(monkeypatch, tmp_path):
    """Returns load(database_url) -> a freshly configured app.db module
    ("" = SQLite in tmp_path). app.config and app.db read env at import."""

    def load(database_url: str):
        monkeypatch.setenv("DATA_DIR", str(tmp_path))
        monkeypatch.setenv("DATABASE_URL", database_url)  # wins over .env
        import app.config
        import app.db

        importlib.reload(app.config)
        return importlib.reload(app.db)

    return load


@pytest.fixture(params=["sqlite", "postgres"])
def db(request, load_db):
    if request.param == "sqlite":
        mod = load_db("")
    else:
        if not TEST_PG_URL:
            pytest.skip("set TEST_DATABASE_URL to run the Postgres variant")
        assert "test" in urlsplit(TEST_PG_URL).path, "TEST_DATABASE_URL must be a *test* database"
        mod = load_db(TEST_PG_URL)
        with mod.connect() as conn:
            conn.exec_driver_sql("DROP SCHEMA IF EXISTS echocoach CASCADE")
            # Stand-in for Cognee's own `users` table in the shared database.
            conn.exec_driver_sql("CREATE TABLE IF NOT EXISTS public.users (id UUID PRIMARY KEY)")
    mod.init_db()
    mod.init_db()  # idempotent
    yield mod
    mod._get_engine().dispose()
