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

_client: genai.Client | None = None


def _get_client() -> genai.Client:
    global _client
    if _client is None:
        if APP_LLM_PROVIDER != "gemini":
            raise NotImplementedError(
                f"llm_client only wires 'gemini'; APP_LLM_PROVIDER={APP_LLM_PROVIDER!r}. "
                "Add the provider branch here and nowhere else."
            )
        _client = genai.Client(api_key=GEMINI_API_KEY or os.environ["GEMINI_API_KEY"])
    return _client


async def generate(
    prompt: str,
    temperature: float = 0.3,
    response_format: str = "text",
    model: str | None = None,
) -> str:
    """Return the model's text for `prompt`.

    response_format="json" forces a JSON-only response (application/json), which
    is required everywhere grading output feeds the memory graph (spec principle
    #5). Callers parse + pydantic-validate the returned string.
    """
    client = _get_client()
    cfg = types.GenerateContentConfig(temperature=temperature)
    if response_format == "json":
        cfg.response_mime_type = "application/json"

    # google-genai is sync; run it off the event loop so FastAPI stays async.
    import anyio

    def _call() -> str:
        resp = client.models.generate_content(
            model=model or APP_LLM_MODEL,
            contents=prompt,
            config=cfg,
        )
        return (resp.text or "").strip()

    return await anyio.to_thread.run_sync(_call)
