"""Central configuration for EchoCoach.

Loads .env from the repo root and configures Cognee's local, self-hosted stack
(SQLite + LanceDB + Kuzu) plus its Gemini LLM/embedding providers. Import this
module once, early, before any Cognee operation runs.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPO_ROOT / "backend"

# Cognee reads several settings from env on import, so load .env first.
load_dotenv(REPO_ROOT / ".env")

# ── App-level settings (used by llm_client.py, db.py) ───────────────────────
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "gemini")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
APP_LLM_MODEL = os.getenv("APP_LLM_MODEL", "gemini-2.5-flash")

# App bookkeeping DB (NOT the memory graph — that lives inside Cognee).
SQLITE_PATH = BACKEND_ROOT / "echocoach.db"

# Keep Cognee's stores inside the repo (gitignored), not in site-packages.
COGNEE_DATA_DIR = BACKEND_ROOT / ".cognee_data"
COGNEE_SYSTEM_DIR = BACKEND_ROOT / ".cognee_system"


def configure_cognee() -> None:
    """Point Cognee at repo-local storage and the Gemini providers.

    Called once at startup. Env vars alone would mostly suffice, but we set
    these explicitly so the config is auditable in one place and immune to the
    Gemini-provider env quirk (cognee issue #1530).
    """
    import cognee

    COGNEE_DATA_DIR.mkdir(parents=True, exist_ok=True)
    COGNEE_SYSTEM_DIR.mkdir(parents=True, exist_ok=True)
    cognee.config.data_root_directory(str(COGNEE_DATA_DIR))
    cognee.config.system_root_directory(str(COGNEE_SYSTEM_DIR))

    # Run Kuzu (graph) and LanceDB (vector) IN-PROCESS. Cognee's default
    # out-of-process DB workers hold file locks that collide when sequential
    # ops (e.g. remember then forget) run in one process — the single-writer
    # Kuzu lock then errors. In-process is correct for our single-process app.
    cognee.config.set_graph_database_subprocess_enabled(False)
    cognee.config.set_vector_db_subprocess_enabled(False)

    # LLM used by Cognee's internal cognify (entity/relation extraction).
    cognee.config.set_llm_provider(os.getenv("LLM_PROVIDER", "gemini"))
    cognee.config.set_llm_model(os.getenv("LLM_MODEL", "gemini/gemini-2.5-flash-lite"))
    cognee.config.set_llm_api_key(os.getenv("LLM_API_KEY") or GEMINI_API_KEY)
    # NOTE: do NOT set a custom endpoint for the "gemini" provider — LiteLLM
    # routes gemini/* natively, and overriding LLM_ENDPOINT makes the connection
    # test hang (cognee issue #1530). Only honor it for other providers.
    if os.getenv("LLM_ENDPOINT") and os.getenv("LLM_PROVIDER", "gemini") != "gemini":
        cognee.config.set_llm_endpoint(os.getenv("LLM_ENDPOINT"))

    # Embeddings. fastembed is the local, key-free fallback if Gemini embeddings
    # misbehave — set EMBEDDING_PROVIDER=fastembed in .env to switch.
    emb_provider = os.getenv("EMBEDDING_PROVIDER", "gemini")
    cognee.config.set_embedding_provider(emb_provider)
    if emb_provider != "fastembed":
        cognee.config.set_embedding_model(
            os.getenv("EMBEDDING_MODEL", "gemini/gemini-embedding-001")
        )
        if os.getenv("EMBEDDING_DIMENSIONS"):
            cognee.config.set_embedding_dimensions(int(os.getenv("EMBEDDING_DIMENSIONS")))
        cognee.config.set_embedding_api_key(
            os.getenv("EMBEDDING_API_KEY") or GEMINI_API_KEY
        )
