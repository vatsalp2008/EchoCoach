"""Server-side speech-to-text via local Whisper (mlx-whisper, Apple Silicon).

Additive to the browser's Web Speech API (frontend/lib/speech.ts) — this module
is a second, opt-in STT engine, never a replacement. It is a pure input-
transcription concern: nothing here is imported by, or imports, session.py,
grading.py, memory.py, or debrief.py. A transcript produced here flows back to
the client and is submitted through the exact same /api/answer path as typed
or browser-STT text.

Verified live on this machine (Python 3.14.2, Apple Silicon): a cold model load
+ transcribe of a 4s clip took ~1.5s once the model was cached on disk, with a
word-perfect transcript.
"""

from __future__ import annotations

import base64
import logging
import tempfile

from .config import ENABLE_WHISPER_STT, WHISPER_MODEL_REPO

log = logging.getLogger("echocoach.stt")

_available = False
_load_error: str | None = None


class SttUnavailableError(RuntimeError):
    """Raised whenever transcription can't happen right now (model not loaded,
    disabled via config, or a decode/inference failure). Callers turn this into
    a clean fallback signal (typing / browser STT) — never an app crash."""


def warm_up() -> None:
    """Force the model to load once, at server startup. All failures are
    swallowed and logged — a broken/missing install must never prevent the
    server from starting. mlx_whisper is imported INSIDE this function so a
    missing package can't break importing this module (or main.py)."""
    global _available, _load_error
    if not ENABLE_WHISPER_STT:
        log.info("Whisper STT disabled (ENABLE_WHISPER_STT=0)")
        return
    try:
        import numpy as np
        import mlx_whisper

        mlx_whisper.transcribe(
            np.zeros(16000, dtype=np.float32), path_or_hf_repo=WHISPER_MODEL_REPO
        )
        _available = True
        log.info("Whisper STT warm: %s", WHISPER_MODEL_REPO)
    except Exception as e:
        _load_error = repr(e)
        _available = False
        log.warning("Whisper STT warm-up failed (%s) — /api/transcribe will 503", e)


def status() -> dict:
    return {"available": _available, "model": WHISPER_MODEL_REPO}


async def transcribe_b64(audio_b64: str, fmt: str = "webm") -> str:
    """Decode base64 audio and transcribe it. Raises SttUnavailableError on any
    failure (model not loaded, corrupt audio, decode error) — never lets a raw
    exception escape to the caller."""
    if not _available:
        raise SttUnavailableError(_load_error or "Whisper model is not loaded")

    import anyio

    def _run() -> str:
        import mlx_whisper

        raw = base64.b64decode(audio_b64)
        with tempfile.NamedTemporaryFile(suffix=f".{fmt}") as f:
            f.write(raw)
            f.flush()
            result = mlx_whisper.transcribe(f.name, path_or_hf_repo=WHISPER_MODEL_REPO)
        return (result.get("text") or "").strip()

    try:
        return await anyio.to_thread.run_sync(_run)
    except Exception as e:
        raise SttUnavailableError(f"Transcription failed: {e}") from e
