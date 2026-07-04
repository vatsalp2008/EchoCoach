"""Server-side speech-to-text via local Whisper — cross-platform.

Additive to the browser's Web Speech API (frontend/lib/speech.ts) — this module
is a second, opt-in STT engine, never a replacement. It is a pure input-
transcription concern: nothing here is imported by, or imports, session.py,
grading.py, memory.py, or debrief.py. A transcript produced here flows back to
the client and is submitted through the exact same /api/answer path as typed
or browser-STT text.

Two interchangeable engines, auto-selected at warm-up so the feature works on
ANY device:
  • mlx-whisper    — Apple Silicon only; the fastest path when present.
  • faster-whisper — cross-platform (Windows/Linux/Intel Mac), CPU or CUDA.
MLX is preferred if importable; otherwise we fall back to faster-whisper. If
neither is installed, /api/transcribe returns 503 and the UI stays on typing /
browser STT — never a crash.

Verified live: MLX on Apple Silicon (Python 3.14, whisper-large-v3-turbo-q4),
and faster-whisper on Windows (Python 3.11, "small"/int8/cpu).
"""

from __future__ import annotations

import base64
import logging
import os
import tempfile

from .config import (
    ENABLE_WHISPER_STT,
    WHISPER_FW_COMPUTE,
    WHISPER_FW_DEVICE,
    WHISPER_MODEL_FW,
    WHISPER_MODEL_REPO,
)

log = logging.getLogger("echocoach.stt")

_available = False
_load_error: str | None = None
_engine: str | None = None       # "mlx" | "faster" | None
_fw_model = None                 # cached faster_whisper.WhisperModel


class SttUnavailableError(RuntimeError):
    """Raised whenever transcription can't happen right now (no engine, model not
    loaded, disabled via config, or a decode/inference failure). Callers turn
    this into a clean fallback signal (typing / browser STT) — never a crash."""


def _model_name() -> str:
    """The model identifier for whichever engine is active (for status/logging)."""
    return WHISPER_MODEL_REPO if _engine == "mlx" else WHISPER_MODEL_FW


def _detect_engine() -> str | None:
    """Prefer MLX (Apple Silicon fast path); fall back to faster-whisper. Imports
    are attempted lazily so a missing package just rules that engine out."""
    try:
        import mlx_whisper  # noqa: F401
        return "mlx"
    except Exception:
        pass
    try:
        import faster_whisper  # noqa: F401
        return "faster"
    except Exception:
        return None


def warm_up() -> None:
    """Select an engine and load its model once, at server startup. Every failure
    is swallowed and logged — a broken/missing install must never prevent the
    server from starting. All engine imports happen INSIDE this function so a
    missing package can't break importing this module (or main.py)."""
    global _available, _load_error, _engine, _fw_model
    if not ENABLE_WHISPER_STT:
        log.info("Whisper STT disabled (ENABLE_WHISPER_STT=0)")
        return

    _engine = _detect_engine()
    if _engine is None:
        _load_error = (
            "no Whisper engine installed — need 'mlx-whisper' (Apple Silicon) or "
            "'faster-whisper' (any platform); see backend/requirements.txt"
        )
        _available = False
        log.warning("Whisper STT unavailable: %s — /api/transcribe will 503", _load_error)
        return

    try:
        import numpy as np

        if _engine == "mlx":
            import mlx_whisper

            mlx_whisper.transcribe(
                np.zeros(16000, dtype=np.float32), path_or_hf_repo=WHISPER_MODEL_REPO
            )
        else:  # faster-whisper
            from faster_whisper import WhisperModel

            _fw_model = WhisperModel(
                WHISPER_MODEL_FW, device=WHISPER_FW_DEVICE, compute_type=WHISPER_FW_COMPUTE
            )
            # Force the (lazy) generator to run so the model actually loads now.
            segments, _ = _fw_model.transcribe(np.zeros(16000, dtype=np.float32))
            list(segments)

        _available = True
        log.info("Whisper STT warm: engine=%s model=%s", _engine, _model_name())
    except Exception as e:
        _load_error = repr(e)
        _available = False
        _fw_model = None
        log.warning("Whisper STT warm-up failed (%s) — /api/transcribe will 503", e)


def status() -> dict:
    return {"available": _available, "engine": _engine, "model": _model_name()}


async def transcribe_b64(audio_b64: str, fmt: str = "webm") -> str:
    """Decode base64 audio and transcribe it with the active engine. Raises
    SttUnavailableError on any failure (no engine, corrupt audio, decode error)
    — never lets a raw exception escape to the caller."""
    if not _available:
        raise SttUnavailableError(_load_error or "Whisper model is not loaded")

    import anyio

    def _run() -> str:
        raw = base64.b64decode(audio_b64)
        # delete=False + manual unlink: on Windows a NamedTemporaryFile open handle
        # can't be reopened by the decoder (file lock), so we close it first, let
        # the engine read the path, then remove it in finally.
        tmp = tempfile.NamedTemporaryFile(suffix=f".{fmt}", delete=False)
        try:
            tmp.write(raw)
            tmp.flush()
            tmp.close()
            if _engine == "mlx":
                import mlx_whisper

                result = mlx_whisper.transcribe(tmp.name, path_or_hf_repo=WHISPER_MODEL_REPO)
                return (result.get("text") or "").strip()
            # faster-whisper: transcribe() returns (segments_generator, info)
            segments, _info = _fw_model.transcribe(tmp.name)
            return " ".join(seg.text for seg in segments).strip()
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass

    try:
        return await anyio.to_thread.run_sync(_run)
    except Exception as e:
        raise SttUnavailableError(f"Transcription failed: {e}") from e
