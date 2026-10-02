"""faster-whisper can still decode audio files with the installed PyAV.

faster-whisper decodes uploads through PyAV, whose API has broken it before
(av 19 dropped an argument faster-whisper passes, failing every transcription
on the deployed server while startup looked fine). Decoding needs no model, so
this catches that kind of drift in a second, before a deploy does.
"""

from __future__ import annotations

import math
import struct
import wave

import pytest


def test_faster_whisper_decodes_a_wav_file(tmp_path):
    faster_whisper = pytest.importorskip("faster_whisper")
    path = tmp_path / "tone.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"".join(
            struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / 16000)))
            for i in range(8000)  # half a second of a 440 Hz tone
        ))
    audio = faster_whisper.decode_audio(str(path), sampling_rate=16000)
    assert abs(len(audio) - 8000) <= 16
    assert float(abs(audio).max()) > 0.1  # real samples came through, not silence


def test_whisper_warm_up_goes_through_the_file_decoder(monkeypatch):
    """warm_up() must exercise the same decode path as a transcription."""
    pytest.importorskip("faster_whisper")
    from app import stt

    seen = []

    class FakeModel:
        def __init__(self, *a, **k):
            pass

        def transcribe(self, audio, **k):
            seen.append(audio)
            return iter([]), None

    import faster_whisper

    monkeypatch.setattr(stt, "ENABLE_WHISPER_STT", True)
    monkeypatch.setattr(stt, "_detect_engine", lambda: "faster")
    monkeypatch.setattr(faster_whisper, "WhisperModel", FakeModel)
    stt.warm_up()
    assert stt.status()["available"] is True
    assert seen and isinstance(seen[0], str) and seen[0].endswith(".wav")  # a file, not an array
