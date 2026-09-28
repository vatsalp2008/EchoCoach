"""Central configuration for EchoCoach.

Loads .env from the repo root and configures Cognee's local, self-hosted stack
(SQLite + LanceDB + Kuzu) plus its Gemini LLM/embedding providers — or, when
DATABASE_URL is set, points both the app and Cognee at Postgres instead. Import
this module once, early, before any Cognee operation runs.
"""

import json
import os
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPO_ROOT / "backend"

# Cognee reads several settings from env on import, so load .env first.
load_dotenv(REPO_ROOT / ".env")

# Everything the app persists (the SQLite DB + Cognee's stores) lives under
# DATA_DIR. Defaults to backend/ for local dev; on a host, point it at a
# persistent volume — the rest of a container's filesystem is wiped on deploy.
DATA_DIR = Path(os.getenv("DATA_DIR") or BACKEND_ROOT)
DATA_DIR.mkdir(parents=True, exist_ok=True)

# ── Postgres mode ─────────────────────────────────────────────────────────────
# Unset (local dev): SQLite + Cognee's local file stores under DATA_DIR.
# Set to a Postgres URL (e.g. Neon's connection string) and ALL state moves to
# that one database — the app's tables (in their own `echocoach` schema) and
# Cognee's relational, vector (pgvector) and graph stores — so the server
# itself keeps nothing on disk and can run on a stateless host (Cloud Run).
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
# Cognee normally isolates every dataset in its own database. In Postgres that
# means a CREATE DATABASE per dataset (~8 MB each, one per user x topic), which
# a free-tier database fills fast — so Postgres mode keeps every dataset in the
# one shared store, and memory.py tags writes / filters reads by dataset
# instead (node sets) so a dataset-scoped recall still only sees its dataset.
COGNEE_SHARED_STORE = bool(DATABASE_URL)


def _postgres_parts(url: str) -> dict:
    u = urlsplit(url)
    sslmode = (parse_qs(u.query).get("sslmode") or [""])[0]
    return {
        "host": u.hostname or "localhost",
        "port": u.port or 5432,
        "username": unquote(u.username or ""),
        "password": unquote(u.password or ""),
        "name": u.path.lstrip("/"),
        # Managed Postgres (Neon) requires TLS; Cognee's asyncpg engines take
        # it as a connect arg rather than a URL param.
        "ssl": sslmode in ("require", "verify-ca", "verify-full"),
    }


def _point_cognee_at_postgres(url: str) -> None:
    """Translate DATABASE_URL into the env vars Cognee reads for its relational,
    vector and graph stores, overriding any local-stack values from .env — a
    DATABASE_URL means Postgres, whatever DB_PROVIDER=sqlite says. Runs before
    Cognee is imported, and again in configure_cognee() (see there for why)."""
    p = _postgres_parts(url)
    os.environ["DB_PROVIDER"] = "postgres"
    os.environ["VECTOR_DB_PROVIDER"] = "pgvector"
    os.environ["GRAPH_DATABASE_PROVIDER"] = "postgres"
    os.environ["ENABLE_BACKEND_ACCESS_CONTROL"] = "false"  # see COGNEE_SHARED_STORE
    for prefix in ("DB_", "VECTOR_DB_", "GRAPH_DATABASE_"):
        for key in ("host", "port", "username", "password", "name"):
            os.environ[prefix + key.upper()] = str(p[key])
    if p["ssl"]:
        os.environ["DATABASE_CONNECT_ARGS"] = json.dumps({"ssl": "require"})


if DATABASE_URL:
    _point_cognee_at_postgres(DATABASE_URL)

# ── App-level LLM (grading + debrief), used by llm_client.py ────────────────
# Kept SEPARATE from Cognee's LLM: the app talks to Gemini directly for quality
# grading, while Cognee's cognify/recall/improve run on a local model (Ollama)
# to avoid burning the app's API quota. The two never share provider settings.
APP_LLM_PROVIDER = os.getenv("APP_LLM_PROVIDER", "gemini")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
APP_LLM_MODEL = os.getenv("APP_LLM_MODEL", "gemini-2.5-flash")

# App bookkeeping DB (NOT the memory graph — that lives inside Cognee).
SQLITE_PATH = DATA_DIR / "echocoach.db"

# ── Auth (email+password now; the model leaves room for Google later) ────────
# Session is a stateless JWT delivered in an HttpOnly cookie. Set a strong
# SESSION_SECRET in .env for any real deployment — the default is dev-only and
# rotating it invalidates all existing sessions.
SESSION_SECRET = os.getenv("SESSION_SECRET", "dev-insecure-change-me")
SESSION_TTL_DAYS = int(os.getenv("SESSION_TTL_DAYS", "14"))
SESSION_COOKIE = "ec_session"
# Google Sign-In (ID-token flow): the client id is the token audience we verify.
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip()
# Secure cookies require HTTPS, so default off for local dev; set COOKIE_SECURE=1
# (and serve over HTTPS) in production. SameSite=lax works for same-site dev.
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "0") == "1"

# ── Server-side speech-to-text (Whisper) ─────────────────────────────────────
# Additive to the browser's Web Speech API (frontend/lib/speech.ts) — never a
# replacement. Two interchangeable engines, auto-selected in stt.py:
#   • mlx-whisper   — Apple Silicon only, fastest there (the team's Macs).
#   • faster-whisper — cross-platform (Windows/Linux/Intel Mac), CPU or CUDA.
# So the feature works regardless of device; MLX is just the fast path when present.
ENABLE_WHISPER_STT = os.getenv("ENABLE_WHISPER_STT", "1") != "0"
# Model for the MLX engine (Apple Silicon). Swappable via env, e.g. drop to
# "mlx-community/whisper-small.en" if turbo-q4 is too slow/large on a given Mac.
WHISPER_MODEL_REPO = os.getenv("WHISPER_MODEL_REPO", "mlx-community/whisper-large-v3-turbo-q4")
# Model + runtime for the faster-whisper engine (everywhere else). "small" is a
# good accuracy/speed balance on CPU (~460MB); int8 keeps CPU inference quick.
WHISPER_MODEL_FW = os.getenv("WHISPER_MODEL_FW", "small")
WHISPER_FW_DEVICE = os.getenv("WHISPER_FW_DEVICE", "cpu")      # "cpu" | "cuda"
WHISPER_FW_COMPUTE = os.getenv("WHISPER_FW_COMPUTE", "int8")   # e.g. int8 | float16

# ── Server-side text-to-speech (Kokoro) ──────────────────────────────────────
# Additive to the browser's SpeechSynthesis voice (see tts.py): a neural voice
# that sounds human instead of robotic. Needs the optional requirements-tts.txt
# (Apple Silicon); without it the frontend keeps using the browser voice.
ENABLE_KOKORO_TTS = os.getenv("ENABLE_KOKORO_TTS", "1") != "0"
TTS_MODEL_REPO = os.getenv("TTS_MODEL_REPO", "mlx-community/Kokoro-82M-bf16")
# Kokoro voice id; the first letter is the accent (a = American, b = British),
# the second the gender — e.g. af_heart, am_michael, bf_emma, bm_george.
TTS_VOICE = os.getenv("TTS_VOICE", "af_heart")
TTS_SPEED = float(os.getenv("TTS_SPEED", "1.0"))

# Keep Cognee's stores under DATA_DIR (gitignored in the repo), not in site-packages.
COGNEE_DATA_DIR = DATA_DIR / ".cognee_data"
COGNEE_SYSTEM_DIR = DATA_DIR / ".cognee_system"


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

    if DATABASE_URL:
        # `import cognee` re-reads .env with override=True, putting the local
        # stack's providers (DB_PROVIDER=sqlite, ...) back over the env set at
        # the top of this module — so restate them, and set Cognee's config
        # objects directly, which nothing reloads.
        _point_cognee_at_postgres(DATABASE_URL)
        p = _postgres_parts(DATABASE_URL)
        cognee.config.set_relational_db_config({
            "db_provider": "postgres", "db_host": p["host"], "db_port": str(p["port"]),
            "db_username": p["username"], "db_password": p["password"], "db_name": p["name"],
            "database_connect_args": (("ssl", "require"),) if p["ssl"] else None,
            # A serverless Postgres (Neon) drops idle connections when it scales
            # to zero; ping before reuse. Cognee's graph and pgvector engines
            # inherit these. (Tuple of pairs: Cognee caches engines by config.)
            "pool_args": (("pool_pre_ping", True), ("pool_recycle", 280)),
        })
        cognee.config.set_vector_db_config({
            "vector_db_provider": "pgvector", "vector_db_host": p["host"],
            "vector_db_port": p["port"], "vector_db_username": p["username"],
            "vector_db_password": p["password"], "vector_db_name": p["name"],
        })
        cognee.config.set_graph_db_config({
            "graph_database_provider": "postgres", "graph_database_host": p["host"],
            "graph_database_port": p["port"], "graph_database_username": p["username"],
            "graph_database_password": p["password"], "graph_database_name": p["name"],
        })

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
