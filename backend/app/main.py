"""FastAPI surface for EchoCoach.

Endpoints stay thin — the loop lives in session.py. Responses returned to the
client during a session never carry grading info (spec 5.3a); the only judgment
is the /debrief report at the end.
"""

from __future__ import annotations

from fastapi import Cookie, Depends, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware

from . import auth, db, debrief, graph_api, memory, stt, tts
from .config import COOKIE_SECURE, SESSION_COOKIE, SESSION_TTL_DAYS
from .schemas import (
    AnswerRequest,
    AnswerResponse,
    LoginRequest,
    SignupRequest,
    StartSessionRequest,
    StartSessionResponse,
    TranscribeRequest,
    TranscribeResponse,
    TtsRequest,
    UserOut,
)
from . import session as session_mod

app = FastAPI(title="EchoCoach", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,  # required so the browser sends/stores the session cookie
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── auth helpers ──────────────────────────────────────────────────────────────
def current_user(ec_session: str | None = Cookie(default=None)) -> dict:
    """FastAPI dependency: resolve the logged-in user from the session cookie,
    or 401. Used to scope a session to a real account."""
    uid = auth.user_id_from_token(ec_session)
    user = auth.get_user(uid) if uid else None
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


# Local dev: localhost:3000 and localhost:8000 are different origins but the
# same *site* (ports don't count), so SameSite=Lax cookies flow on credentialed
# fetches. Keep Secure off there — Safari silently drops Secure cookies over
# http://localhost, which broke login. Production (COOKIE_SECURE=1, HTTPS)
# uses SameSite=None; Secure so a cross-site frontend still gets the cookie.
_COOKIE_SAMESITE = "none" if COOKIE_SECURE else "lax"


def _set_session_cookie(response: Response, user_id: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE,
        value=auth.make_token(user_id),
        httponly=True,               # not readable by JS -> not stealable via XSS
        samesite=_COOKIE_SAMESITE,
        secure=COOKIE_SECURE,
        max_age=SESSION_TTL_DAYS * 24 * 3600,
        path="/",
    )


@app.on_event("startup")
async def _startup() -> None:
    db.init_db()
    memory.init()  # configure Cognee's local stack + Gemini providers once
    stt.warm_up()  # load the local Whisper model once; self-guards against failure
    tts.warm_up()  # same for the local Kokoro voice


app.include_router(graph_api.router)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/api/signup", response_model=UserOut)
async def signup(req: SignupRequest, response: Response) -> UserOut:
    try:
        user = auth.signup(
            email=req.email, display_name=req.display_name, password=req.password
        )
    except auth.EmailTakenError:
        raise HTTPException(status_code=409, detail="An account with that email already exists")
    _set_session_cookie(response, user["id"])
    return UserOut(**user)


@app.post("/api/login", response_model=UserOut)
async def login(req: LoginRequest, response: Response) -> UserOut:
    user = auth.authenticate(email=req.email, password=req.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    _set_session_cookie(response, user["id"])
    return UserOut(**user)


@app.post("/api/auth/google", response_model=UserOut)
async def auth_google(payload: dict, response: Response) -> UserOut:
    """Google Sign-In: verify the ID token from the GIS button, resolve/create the
    user (link by verified email), and issue the same session cookie."""
    try:
        user = auth.google_signin(payload.get("credential", ""))
    except auth.GoogleAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    _set_session_cookie(response, user["id"])
    return UserOut(**user)


@app.post("/api/logout")
async def logout(response: Response) -> dict:
    response.delete_cookie(
        SESSION_COOKIE, path="/", samesite=_COOKIE_SAMESITE, secure=COOKIE_SECURE
    )
    return {"ok": True}


@app.get("/api/me", response_model=UserOut)
async def me(user: dict = Depends(current_user)) -> UserOut:
    """Who is logged in (from the session cookie). 401 if not — the frontend
    calls this on load to restore auth state across refreshes."""
    return UserOut(**user)


@app.post("/api/session", response_model=StartSessionResponse)
async def start_session(
    req: StartSessionRequest, user: dict = Depends(current_user)
) -> StartSessionResponse:
    req.user_id = user["id"]  # scope the session to the authenticated account
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


@app.get("/api/sessions")
async def sessions(user: dict = Depends(current_user)) -> dict:
    """The logged-in user's past sessions (newest first) for the History page."""
    return {"sessions": db.list_sessions(user["id"])}


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


@app.get("/api/tts/status")
async def tts_status() -> dict:
    """Lets the frontend feature-detect the Kokoro voice before asking for audio."""
    return tts.status()


@app.post("/api/tts")
async def synthesize(req: TtsRequest) -> Response:
    """Question text -> WAV in the local Kokoro voice. 503 means "use the
    browser voice instead", exactly like /api/transcribe for STT."""
    try:
        audio = await tts.synthesize_wav(req.text)
    except tts.TtsUnavailableError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return Response(content=audio, media_type="audio/wav")
