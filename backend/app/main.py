"""FastAPI surface for EchoCoach.

Endpoints stay thin — the loop lives in session.py. Responses returned to the
client during a session never carry grading info (spec 5.3a); the only judgment
is the /debrief report at the end.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import db, debrief, memory
from .schemas import (
    AnswerRequest,
    AnswerResponse,
    StartSessionRequest,
    StartSessionResponse,
)
from . import session as session_mod

app = FastAPI(title="EchoCoach", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup() -> None:
    db.init_db()
    memory.init()  # configure Cognee's local stack + Gemini providers once


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/api/session", response_model=StartSessionResponse)
async def start_session(req: StartSessionRequest) -> StartSessionResponse:
    return await session_mod.start_session(req)


@app.post("/api/answer", response_model=AnswerResponse)
async def answer(req: AnswerRequest) -> AnswerResponse:
    try:
        return await session_mod.submit_answer(req)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/api/session/{session_id}/debrief")
async def get_debrief(session_id: str) -> dict:
    report = await debrief.generate_debrief(session_id)
    return {"session_id": session_id, "debrief": report}
