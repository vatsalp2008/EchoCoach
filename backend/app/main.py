"""FastAPI surface for EchoCoach.

Endpoints stay thin — the loop lives in session.py. Responses returned to the
client during a session never carry grading info (spec 5.3a); the only judgment
is the /debrief report at the end.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import auth, db, debrief, graph_api, memory, stt
from .schemas import (
    AnswerRequest,
    AnswerResponse,
    LoginRequest,
    LoginResponse,
    StartSessionRequest,
    StartSessionResponse,
    TranscribeRequest,
    TranscribeResponse,
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
    stt.warm_up()  # load the local Whisper model once; self-guards against failure


app.include_router(graph_api.router)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/api/profiles")
async def profiles() -> list[dict]:
    """Public profile list (no pins) for the login screen's picker."""
    return auth.list_profiles()


@app.post("/api/login", response_model=LoginResponse)
async def login(req: LoginRequest) -> LoginResponse:
    display_name = auth.verify(req.user_id, req.pin)
    if not display_name:
        raise HTTPException(status_code=401, detail="Invalid ID or PIN")
    return LoginResponse(user_id=req.user_id, display_name=display_name)


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


@app.get("/api/session/{session_id}/qa")
async def get_qa(session_id: str) -> dict:
    """Full transcript for the debrief's Questions & Answers view: every question
    asked (incl. follow-ups) with what the candidate answered; skipped turns are
    flagged so the UI shows them as skipped rather than blank."""
    return {"session_id": session_id, "qa": db.qa_for_session(session_id)}


@app.get("/api/stt/status")
async def stt_status() -> dict:
    """Lets the frontend feature-detect server-side Whisper, same idea as the
    client's own speechSupported() check for the browser engine."""
    return stt.status()


@app.post("/api/transcribe", response_model=TranscribeResponse)
async def transcribe(req: TranscribeRequest) -> TranscribeResponse:
    try:
        text = await stt.transcribe_b64(req.audio_b64, fmt=req.format)
    except stt.SttUnavailableError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return TranscribeResponse(transcript=text)
