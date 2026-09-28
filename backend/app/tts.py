"""Server-side text-to-speech via local Kokoro-82M (MLX) — Apple Silicon only.

Additive to the browser's SpeechSynthesis (frontend/lib/speech.ts) — a second,
human-sounding voice for the interviewer, never a replacement. It is a pure
output concern: nothing here is imported by, or imports, session.py,
grading.py, memory.py, or debrief.py. The frontend asks /api/tts to voice
question text it already has; if this engine isn't available, /api/tts returns
503 and the browser's built-in voice is used instead — never a crash.

Install: .venv/bin/pip install --ignore-requires-python -r requirements-tts.txt
Verified live: Apple Silicon, Python 3.14, Kokoro-82M-bf16 — a ~6s question
renders in ~0.4s once warm.
"""

from __future__ import annotations

import io
import logging
import shutil
import tempfile
import threading
import wave
from pathlib import Path

from .config import ENABLE_KOKORO_TTS, TTS_MODEL_REPO, TTS_SPEED, TTS_VOICE

log = logging.getLogger("echocoach.tts")

_available = False
_load_error: str | None = None
_model = None                    # cached mlx_audio Kokoro model
_lock = threading.Lock()         # one generation at a time — the model isn't thread-safe


class TtsUnavailableError(RuntimeError):
    """Raised whenever synthesis can't happen right now (not installed, model
    not loaded, disabled via config, or an inference failure). Callers turn this
    into a clean fallback signal (browser voice) — never a crash."""


def _ensure_short_espeak_path() -> None:
    """misaki falls back to espeak-ng for words it doesn't know, and espeak-ng
    copies its data path into a 160-byte buffer — then calls exit(), killing the
    whole server, if the path got truncated. A venv nested deep enough hits
    that, so relocate the data to a short temp path first when needed."""
    import espeakng_loader

    src = espeakng_loader.get_data_path()
    if len(src) < 150:
        return
    dst = Path(tempfile.gettempdir()) / "echocoach-espeak-ng-data"
    shutil.copytree(src, dst, dirs_exist_ok=True)
    espeakng_loader.get_data_path = lambda: str(dst)


def _synthesize(text: str):
    """Text -> mono float32 samples at the model's sample rate."""
    import numpy as np

    with _lock:
        chunks = [
            np.array(r.audio).reshape(-1)
            for r in _model.generate(
                text=text, voice=TTS_VOICE, speed=TTS_SPEED, lang_code=TTS_VOICE[0]
            )
        ]
    return np.concatenate(chunks)


def warm_up() -> None:
    """Load the model once, at server startup, and run one tiny synthesis so the
    text pipeline (spaCy + G2P, ~9s cold) is built before the first question.
    Every failure is swallowed and logged — a broken/missing install must never
    prevent the server from starting."""
    global _available, _load_error, _model
    if not ENABLE_KOKORO_TTS:
        log.info("Kokoro TTS disabled (ENABLE_KOKORO_TTS=0)")
        return
    try:
        _ensure_short_espeak_path()
        from mlx_audio.tts.utils import load_model

        _model = load_model(TTS_MODEL_REPO)
        _synthesize("Hello.")
        _available = True
        log.info("Kokoro TTS warm: model=%s voice=%s", TTS_MODEL_REPO, TTS_VOICE)
    except ImportError as e:
        _load_error = (
            f"Kokoro not installed ({e.name}) — see backend/requirements-tts.txt"
        )
        log.warning("Kokoro TTS unavailable: %s — /api/tts will 503", _load_error)
    except Exception as e:
        _load_error = repr(e)
        _model = None
        log.warning("Kokoro TTS warm-up failed (%s) — /api/tts will 503", e)


def status() -> dict:
    return {"available": _available, "model": TTS_MODEL_REPO, "voice": TTS_VOICE}


async def synthesize_wav(text: str) -> bytes:
    """Render text as a 16-bit mono WAV. Raises TtsUnavailableError on any
    failure — never lets a raw exception escape to the caller."""
    if not _available:
        raise TtsUnavailableError(_load_error or "Kokoro model is not loaded")

    import anyio

    def _run() -> bytes:
        import numpy as np

        samples = _synthesize(text)
        pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(_model.sample_rate)
            w.writeframes(pcm.tobytes())
        return buf.getvalue()

    try:
        return await anyio.to_thread.run_sync(_run)
    except Exception as e:
        raise TtsUnavailableError(f"Speech synthesis failed: {e}") from e
