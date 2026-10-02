"""Server-side text-to-speech: the Kokoro-82M voice, on two interchangeable engines.

Additive to the browser's SpeechSynthesis (frontend/lib/speech.ts) — a second,
human-sounding voice for the interviewer, never a replacement. It is a pure
output concern: nothing here is imported by, or imports, session.py,
grading.py, memory.py, or debrief.py. The frontend asks /api/tts to voice
question text it already has; if this engine isn't available, /api/tts returns
503 and the browser's built-in voice is used instead — never a crash.

Engines (TTS_ENGINE, auto-selected like stt.py's Whisper engines):
  • mlx  — mlx-audio, Apple Silicon only (the team's Macs). Verified live on
           Python 3.14, Kokoro-82M-bf16: a ~6s question renders in ~0.4s warm.
  • onnx — kokoro-onnx on ONNX Runtime, any CPU (the Cloud Run container).
           Same weights and voice, and the same text front end as mlx-audio
           (misaki G2P with the espeak fallback), so it sounds the same — but
           on Cloud Run's one vCPU it takes ~0.7-0.9s per second of speech,
           which is why the frontend asks for one sentence at a time.

Install: see requirements-tts.txt.
"""

from __future__ import annotations

import io
import logging
import os
import platform
import shutil
import tempfile
import threading
import wave
from collections import OrderedDict
from pathlib import Path

from .config import (
    ENABLE_KOKORO_TTS,
    TTS_ENGINE,
    TTS_MODEL_REPO,
    TTS_ONNX_MODEL,
    TTS_ONNX_VOICES,
    TTS_SPEED,
    TTS_THREADS,
    TTS_VOICE,
)

log = logging.getLogger("echocoach.tts")

_available = False
_load_error: str | None = None
_engine: str | None = None       # "mlx" | "onnx", once loaded
_model = None                    # mlx_audio model, or a kokoro_onnx.Kokoro
_g2p = None                      # misaki G2P (onnx engine; mlx-audio brings its own)
_sample_rate = 24000
_threads = 1
_lock = threading.Lock()         # one generation at a time — the model isn't thread-safe
_ready = threading.Event()       # set once loading has finished, either way

# Rendered WAVs by text: replaying a question (or reloading mid-interview)
# shouldn't cost another few seconds of CPU.
_CACHE_SIZE = 48
_cache: OrderedDict[str, bytes] = OrderedDict()


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


def _usable_cpus() -> int:
    """CPUs this process can really use. In a container that's the cgroup
    quota — Cloud Run's 1 vCPU can still show the host's cores to
    os.cpu_count(), and oversubscribed ONNX threads only slow each other down."""
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        if quota != "max":
            return max(1, int(quota) // int(period))
    except (OSError, ValueError):
        pass
    try:
        return len(os.sched_getaffinity(0))
    except AttributeError:  # macOS
        return os.cpu_count() or 1


def _pick_engine() -> str:
    if TTS_ENGINE in ("mlx", "onnx"):
        return TTS_ENGINE
    apple_silicon = platform.system() == "Darwin" and platform.machine() == "arm64"
    return "mlx" if apple_silicon else "onnx"


def _load_mlx() -> None:
    global _model, _sample_rate
    from mlx_audio.tts.utils import load_model

    _model = load_model(TTS_MODEL_REPO)
    _sample_rate = _model.sample_rate


def _load_onnx() -> None:
    global _model, _g2p, _sample_rate, _threads
    if not (TTS_ONNX_MODEL and Path(TTS_ONNX_MODEL).is_file()):
        raise FileNotFoundError(f"TTS_ONNX_MODEL not found: {TTS_ONNX_MODEL or '(unset)'}")
    if not (TTS_ONNX_VOICES and Path(TTS_ONNX_VOICES).is_file()):
        raise FileNotFoundError(f"TTS_ONNX_VOICES not found: {TTS_ONNX_VOICES or '(unset)'}")
    import onnxruntime as rt
    from kokoro_onnx import SAMPLE_RATE, Kokoro
    from misaki import en, espeak

    # Exactly the G2P mlx-audio's Kokoro pipeline builds, so both engines say
    # every word the same way.
    british = TTS_VOICE[0] == "b"
    _g2p = en.G2P(
        trf=False, british=british, fallback=espeak.EspeakFallback(british=british), unk=""
    )
    _threads = TTS_THREADS or _usable_cpus()
    opts = rt.SessionOptions()
    opts.intra_op_num_threads = _threads
    opts.inter_op_num_threads = 1
    session = rt.InferenceSession(TTS_ONNX_MODEL, opts, providers=["CPUExecutionProvider"])
    _model = Kokoro.from_session(session, TTS_ONNX_VOICES)
    _sample_rate = SAMPLE_RATE


def _trim_silence(samples, sample_rate: int, pad_s: float = 0.05):
    """Cut leading/trailing silence (frames 50 dB below the peak), keeping a
    short pad so no consonant is clipped. Both engines go through this —
    kokoro-onnx trims on its own, mlx-audio leaves ~0.4s at each end — so the
    frontend's pause between sentences sounds the same on either."""
    import numpy as np

    frame = max(1, sample_rate // 100)  # 10 ms
    n = len(samples) // frame
    if n == 0:
        return samples
    rms = np.sqrt((samples[: n * frame].reshape(n, frame) ** 2).mean(axis=1))
    loud = np.nonzero(rms > rms.max() * 10 ** (-50 / 20))[0]
    if len(loud) == 0:
        return samples
    pad = int(pad_s * sample_rate)
    return samples[max(0, loud[0] * frame - pad) : (loud[-1] + 1) * frame + pad]


def _synthesize(text: str):
    """Text -> mono float32 samples at the model's sample rate."""
    import numpy as np

    with _lock:
        if _engine == "mlx":
            chunks = [
                np.array(r.audio).reshape(-1)
                for r in _model.generate(
                    text=text, voice=TTS_VOICE, speed=TTS_SPEED, lang_code=TTS_VOICE[0]
                )
            ]
            return _trim_silence(np.concatenate(chunks), _sample_rate)
        phonemes, _ = _g2p(text)
        if not phonemes.strip():  # nothing pronounceable (e.g. only symbols)
            return np.zeros(_sample_rate // 10, dtype=np.float32)
        audio, _ = _model.create(phonemes, voice=TTS_VOICE, speed=TTS_SPEED, is_phonemes=True)
        return _trim_silence(audio, _sample_rate)


def warm_up() -> None:
    """Load the model once, at server startup, in the background: it takes ~11s
    on a Cloud Run vCPU (mostly spaCy + G2P), and every request — the login
    check included — would otherwise wait for it after a cold start. Starting
    an interview takes longer than that anyway, and a /api/tts call that comes
    in sooner waits for loading to finish."""
    if not ENABLE_KOKORO_TTS:
        log.info("Kokoro TTS disabled (ENABLE_KOKORO_TTS=0)")
        _ready.set()
        return
    threading.Thread(target=_load, name="kokoro-warm-up", daemon=True).start()


def _load() -> None:
    """Load the engine and run one tiny synthesis so the text pipeline is built
    before the first question. Every failure is swallowed and logged — a
    broken/missing install must never take the server down."""
    global _available, _load_error, _model, _engine
    engine = _pick_engine()
    try:
        _ensure_short_espeak_path()
        if engine == "mlx":
            _load_mlx()
        else:
            _load_onnx()
        _engine = engine
        _synthesize("Hello.")
        _available = True
        if engine == "onnx":
            log.info("Kokoro TTS warm: engine=onnx voice=%s threads=%d", TTS_VOICE, _threads)
        else:
            log.info("Kokoro TTS warm: engine=mlx model=%s voice=%s", TTS_MODEL_REPO, TTS_VOICE)
    except ImportError as e:
        _load_error = (
            f"Kokoro ({engine}) not installed ({e.name}) — see backend/requirements-tts.txt"
        )
        log.warning("Kokoro TTS unavailable: %s — /api/tts will 503", _load_error)
    except Exception as e:
        _load_error = repr(e)
        _model = _engine = None
        log.warning("Kokoro TTS warm-up failed (%s) — /api/tts will 503", e)
    finally:
        _ready.set()


def status() -> dict:
    # Reported available while still loading: the frontend checks once per
    # page, so "no" here would mean the robotic voice for that whole visit.
    # If loading then fails, /api/tts 503s and the browser voice takes over.
    loading = not _ready.is_set()
    engine = _engine or (_pick_engine() if ENABLE_KOKORO_TTS else None)
    model = Path(TTS_ONNX_MODEL).name if engine == "onnx" else TTS_MODEL_REPO
    return {
        "available": _available or loading,
        "loading": loading,
        "engine": engine,
        "model": model,
        "voice": TTS_VOICE,
    }


async def synthesize_wav(text: str) -> bytes:
    """Render text as a 16-bit mono WAV. Raises TtsUnavailableError on any
    failure — never lets a raw exception escape to the caller."""
    import anyio

    if not _ready.is_set():  # still loading (just after a cold start)
        await anyio.to_thread.run_sync(_ready.wait, 120)
    if not _available:
        raise TtsUnavailableError(_load_error or "Kokoro model is not loaded")
    if text in _cache:
        _cache.move_to_end(text)
        return _cache[text]

    def _run() -> bytes:
        import numpy as np

        samples = _synthesize(text)
        pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(_sample_rate)
            w.writeframes(pcm.tobytes())
        return buf.getvalue()

    try:
        wav = await anyio.to_thread.run_sync(_run)
    except Exception as e:
        raise TtsUnavailableError(f"Speech synthesis failed: {e}") from e
    _cache[text] = wav
    if len(_cache) > _CACHE_SIZE:
        _cache.popitem(last=False)
    return wav
