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

# ── App-level LLM (grading + debrief), used by llm_client.py ────────────────
# Kept SEPARATE from Cognee's LLM: the app talks to Gemini directly for quality
# grading, while Cognee's cognify/recall/improve run on a local model (Ollama)
# to avoid burning the app's API quota. The two never share provider settings.
APP_LLM_PROVIDER = os.getenv("APP_LLM_PROVIDER", "gemini")
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

    # Fail fast: cognee routes LLM calls through LiteLLM, whose default retry
    # sleeps on a 429 (seconds of blocking backoff) stall the async event loop
    # and hang the whole server. Disable retries so quota errors surface instantly
    # and our fallbacks kick in.
    try:
        import litellm

        litellm.num_retries = 0
        litellm.request_timeout = 30
    except Exception:
        pass

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
    # Gemini: local Ollama models fail cognee's structured-output extraction and
    # take minutes per call (see ADR-011), so graph-building runs on Gemini.
    cognee_provider = os.getenv("LLM_PROVIDER", "gemini")
    cognee.config.set_llm_provider(cognee_provider)
    cognee.config.set_llm_model(os.getenv("LLM_MODEL", "gemini/gemini-2.5-flash-lite"))
    cognee.config.set_llm_api_key(os.getenv("LLM_API_KEY") or GEMINI_API_KEY)
    # gemini must NOT get a custom endpoint (overriding it hangs the connection
    # test — cognee issue #1530). Honor LLM_ENDPOINT only for other providers.
    if os.getenv("LLM_ENDPOINT") and cognee_provider != "gemini":
        cognee.config.set_llm_endpoint(os.getenv("LLM_ENDPOINT"))

    # Embeddings. Default is local fastembed (in-process, no key). Cognee's
    # config validation requires provider+model+dimensions together, so always
    # set all three; only remote providers need an API key.
    emb_provider = os.getenv("EMBEDDING_PROVIDER", "fastembed")
    cognee.config.set_embedding_provider(emb_provider)
    cognee.config.set_embedding_model(
        os.getenv("EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
    )
    cognee.config.set_embedding_dimensions(int(os.getenv("EMBEDDING_DIMENSIONS", "384")))
    if emb_provider not in ("fastembed", "ollama"):
        cognee.config.set_embedding_api_key(
            os.getenv("EMBEDDING_API_KEY") or GEMINI_API_KEY
        )
