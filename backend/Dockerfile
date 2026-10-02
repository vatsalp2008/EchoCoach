# Backend image for a stateless host (Google Cloud Run). All state lives in
# Postgres (DATABASE_URL, e.g. Neon) — the app's tables and Cognee's memory
# graph — so nothing here needs a persistent disk.
#
#   gcloud run deploy echocoach-api --source backend ...   (see PROGRESS.md)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # The embedding model is baked in below; fastembed reads it from here at
    # runtime instead of downloading ~130 MB on every cold start.
    FASTEMBED_CACHE_PATH=/opt/fastembed \
    # Server-side Whisper runs on faster-whisper here (the MLX engine is
    # Apple-Silicon-only) with the small English model, also baked in below:
    # ~150 MB, loads in well under a second, so cold starts barely notice.
    # The browser's own speech recognition stays the default engine in the UI.
    ENABLE_WHISPER_STT=1 \
    WHISPER_MODEL_FW=/opt/whisper/base.en \
    # The interviewer's Kokoro voice, on ONNX Runtime (the MLX engine is
    # Apple-Silicon-only): same model and voice as on the Macs, files baked in.
    ENABLE_KOKORO_TTS=1 \
    TTS_ENGINE=onnx \
    TTS_ONNX_MODEL=/opt/kokoro/kokoro-v1.0.onnx \
    TTS_ONNX_VOICES=/opt/kokoro/voices-v1.0.bin \
    # One ONNX thread per vCPU (--cpu 1). Auto-detection would see the startup
    # CPU boost's 2 vCPUs, and 2 threads on 1 vCPU rendered ~40% slower.
    TTS_THREADS=1 \
    # Cognee pings the LLM once per process before its first op; each cold
    # start would spend a request of the Gemini quota on it.
    COGNEE_SKIP_CONNECTION_TEST=true \
    # Scratch only (Cognee's cache + raw upload files) — real state is in Postgres.
    DATA_DIR=/tmp/echocoach

WORKDIR /app
COPY requirements.txt requirements-tts.txt ./
# Kokoro's files come from kokoro-onnx's v1.0 release (~350 MB), checked
# against pinned SHA-256s so a changed or corrupt download fails the build.
RUN pip install -r requirements.txt -r requirements-tts.txt \
 && python -c "from fastembed import TextEmbedding; TextEmbedding('BAAI/bge-small-en-v1.5')" \
 && python -c "from faster_whisper import download_model; download_model('base.en', output_dir='/opt/whisper/base.en')" \
 && python -c "import hashlib, os, urllib.request; \
base = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/'; \
files = {'kokoro-v1.0.onnx': '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5', \
         'voices-v1.0.bin': 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d'}; \
os.makedirs('/opt/kokoro', exist_ok=True); \
[urllib.request.urlretrieve(base + f, '/opt/kokoro/' + f) for f in files]; \
bad = [f for f, h in files.items() if hashlib.sha256(open('/opt/kokoro/' + f, 'rb').read()).hexdigest() != h]; \
assert not bad, f'checksum mismatch: {bad}'" \
 && useradd --create-home app \
 && chown -R app /opt/fastembed /opt/whisper

COPY app ./app
USER app

# Cloud Run sets PORT (8080 by default).
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
