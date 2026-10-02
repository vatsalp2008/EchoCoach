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
    # Kokoro TTS is Apple-Silicon-only; the browser voice is used instead.
    ENABLE_KOKORO_TTS=0 \
    # Cognee pings the LLM once per process before its first op; each cold
    # start would spend a request of the Gemini quota on it.
    COGNEE_SKIP_CONNECTION_TEST=true \
    # Scratch only (Cognee's cache + raw upload files) — real state is in Postgres.
    DATA_DIR=/tmp/echocoach

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt \
 && python -c "from fastembed import TextEmbedding; TextEmbedding('BAAI/bge-small-en-v1.5')" \
 && python -c "from faster_whisper import download_model; download_model('base.en', output_dir='/opt/whisper/base.en')" \
 && useradd --create-home app \
 && chown -R app /opt/fastembed /opt/whisper

COPY app ./app
USER app

# Cloud Run sets PORT (8080 by default).
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
