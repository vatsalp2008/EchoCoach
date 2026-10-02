"""Server TTS plumbing that doesn't need the model: silence trimming, the WAV
cache, and failing safe when the ONNX engine's files are missing."""

from __future__ import annotations

import asyncio
import io
import threading
import wave

import numpy as np
import pytest

from app import tts


@pytest.fixture
def fake_engine(monkeypatch):
    """A loaded engine whose 'model' renders 1s of tone and counts calls."""
    calls = []

    def fake_synthesize(text):
        calls.append(text)
        return np.full(24000, 0.5, dtype=np.float32)

    ready = threading.Event()
    ready.set()
    monkeypatch.setattr(tts, "_ready", ready)
    monkeypatch.setattr(tts, "_available", True)
    monkeypatch.setattr(tts, "_sample_rate", 24000)
    monkeypatch.setattr(tts, "_synthesize", fake_synthesize)
    monkeypatch.setattr(tts, "_cache", type(tts._cache)())
    return calls


def test_trim_silence_cuts_edges_but_keeps_a_pad():
    sr = 24000
    speech = np.sin(np.linspace(0, 2000, sr)).astype(np.float32) * 0.5  # 1s
    padded = np.concatenate([np.zeros(sr // 2), speech, np.zeros(sr // 2)]).astype(np.float32)
    out = tts._trim_silence(padded, sr)
    assert 1.0 <= len(out) / sr <= 1.0 + 2 * 0.05 + 0.02  # speech + ~50 ms pad each side
    assert tts._trim_silence(np.zeros(sr, dtype=np.float32), sr).size == sr  # all silence: untouched


def test_synthesize_wav_renders_a_wav_once_per_text(fake_engine):
    wav = asyncio.run(tts.synthesize_wav("Tell me about a time you failed."))
    with wave.open(io.BytesIO(wav)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, 24000)
        assert w.getnframes() == 24000
    again = asyncio.run(tts.synthesize_wav("Tell me about a time you failed."))
    assert again == wav and fake_engine == ["Tell me about a time you failed."]  # replay: cached
    asyncio.run(tts.synthesize_wav("Why?"))
    assert len(fake_engine) == 2


def test_a_request_during_loading_waits_for_the_voice(fake_engine, monkeypatch):
    loading = threading.Event()
    monkeypatch.setattr(tts, "_ready", loading)
    monkeypatch.setattr(tts, "_available", False)
    # Just after a cold start: reported available, so the page keeps the voice.
    assert tts.status()["available"] is True and tts.status()["loading"] is True

    def finish_loading():
        tts._available = True
        loading.set()

    threading.Timer(0.2, finish_loading).start()
    wav = asyncio.run(tts.synthesize_wav("Why?"))  # waits instead of failing
    assert wav and fake_engine == ["Why?"]


def test_missing_onnx_files_mean_browser_voice_not_a_crash(monkeypatch):
    monkeypatch.setattr(tts, "ENABLE_KOKORO_TTS", True)
    monkeypatch.setattr(tts, "TTS_ENGINE", "onnx")
    monkeypatch.setattr(tts, "TTS_ONNX_MODEL", "/nonexistent/kokoro-v1.0.onnx")
    monkeypatch.setattr(tts, "_available", False)
    monkeypatch.setattr(tts, "_load_error", None)
    monkeypatch.setattr(tts, "_ready", threading.Event())
    tts.warm_up()  # must not raise; loads in the background
    assert tts._ready.wait(10)
    assert tts.status()["available"] is False and tts.status()["loading"] is False
    with pytest.raises(tts.TtsUnavailableError):
        asyncio.run(tts.synthesize_wav("Hello."))
