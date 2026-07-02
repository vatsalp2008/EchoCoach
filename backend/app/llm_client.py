"""Provider-agnostic LLM adapter.

The whole app calls exactly one function — `generate()`. Swapping providers
means editing only this file + the LLM_PROVIDER env var (spec principle: the
provider must be swappable by changing one file). Current provider: Gemini.
"""

from __future__ import annotations

import os

from google import genai
from google.genai import types

from .config import APP_LLM_MODEL, APP_LLM_PROVIDER, GEMINI_API_KEY


class LLMQuotaError(RuntimeError):
    """Raised when the provider rejects a call for quota/rate-limit reasons.

    Callers catch this to fall back to hardcoded/heuristic behavior so the
    interview never crashes on an exhausted free-tier quota."""


def _is_quota_error(exc: Exception) -> bool:
    s = str(exc).lower()
    return (
        "resource_exhausted" in s
        or "429" in s
        or "quota" in s
        or "rate limit" in s
        or "ratelimit" in s
    )


_client: genai.Client | None = None


def _get_client() -> genai.Client:
    global _client
    if _client is None:
        if APP_LLM_PROVIDER != "gemini":
            raise NotImplementedError(
                f"llm_client only wires 'gemini'; APP_LLM_PROVIDER={APP_LLM_PROVIDER!r}. "
                "Add the provider branch here and nowhere else."
            )
        # Bound each call so a slow/hanging request can't stall the interview;
        # on quota (429) Gemini returns immediately anyway. timeout is in ms.
        _client = genai.Client(
            api_key=GEMINI_API_KEY or os.environ["GEMINI_API_KEY"],
            http_options=types.HttpOptions(timeout=45_000),
        )
    return _client


async def generate(
    prompt: str,
    temperature: float = 0.3,
    response_format: str = "text",
    model: str | None = None,
    image_b64: str | None = None,
) -> str:
    """Return the model's text for `prompt`.

    response_format="json" forces a JSON-only response (application/json), which
    is required everywhere grading output feeds the memory graph (spec principle
    #5). Callers parse + pydantic-validate the returned string.

    image_b64: optional base64 PNG (e.g. a whiteboard sketch). Gemini is
    multimodal, so it's attached as an image part alongside the prompt.
    """
    client = _get_client()
    cfg = types.GenerateContentConfig(temperature=temperature)
    if response_format == "json":
        cfg.response_mime_type = "application/json"

    # google-genai is sync; run it off the event loop so FastAPI stays async.
    import anyio
    import base64

    def _call() -> str:
        contents: object = prompt
        if image_b64:
            img = types.Part.from_bytes(
                data=base64.b64decode(image_b64), mime_type="image/png"
            )
            contents = [prompt, img]
        resp = client.models.generate_content(
            model=model or APP_LLM_MODEL,
            contents=contents,
            config=cfg,
        )
        return (resp.text or "").strip()

    try:
        return await anyio.to_thread.run_sync(_call)
    except Exception as e:
        if _is_quota_error(e):
            raise LLMQuotaError(str(e)) from e
        raise
