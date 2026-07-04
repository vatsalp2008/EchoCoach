"""Email + password auth with a stateless JWT session (delivered in an HttpOnly
cookie by main.py).

Designed so 'Sign in with Google' is a clean later addition, not a rebuild:
a user is identified primarily by email; `password_hash` is nullable (a future
Google-only account simply has none) and `users.google_sub` is reserved for the
Google subject id. Adding Google then means: verify the Google ID token, link by
verified email (or create a user with password_hash=NULL), and issue the same
JWT cookie — no schema or session-model change.

Passwords are hashed with bcrypt. The `user_id` used everywhere else in the app
(session scoping, weakness graph) is the users table primary key as a string.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from . import db
from .config import GOOGLE_CLIENT_ID, SESSION_SECRET, SESSION_TTL_DAYS

_ALG = "HS256"


class EmailTakenError(Exception):
    """Raised when signing up with an email that already exists."""


class GoogleAuthError(Exception):
    """Raised when a Google ID token is missing, invalid, or unverified."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _public(row: sqlite3.Row) -> dict:
    """Public user shape returned to the client — never includes the hash."""
    return {
        "id": str(row["id"]),
        "email": row["email"],
        "display_name": row["display_name"],
    }


# ── password hashing (bcrypt) ────────────────────────────────────────────────
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def _check_password(password: str, password_hash: str | None) -> bool:
    if not password_hash:
        return False  # e.g. a future Google-only account has no password
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


# ── signup / login ───────────────────────────────────────────────────────────
def signup(*, email: str, display_name: str, password: str) -> dict:
    email = email.strip().lower()
    if db.get_user_by_email(email):
        raise EmailTakenError(email)
    try:
        uid = db.create_user(
            email=email,
            display_name=display_name.strip(),
            password_hash=hash_password(password),
            created_at=_now(),
        )
    except sqlite3.IntegrityError as e:  # race on the unique email
        raise EmailTakenError(email) from e
    row = db.get_user_by_id(uid)
    return _public(row)


def authenticate(*, email: str, password: str) -> dict | None:
    row = db.get_user_by_email(email.strip().lower())
    if row and _check_password(password, row["password_hash"]):
        return _public(row)
    return None


def get_user(user_id: str) -> dict | None:
    try:
        row = db.get_user_by_id(int(user_id))
    except (ValueError, TypeError):
        return None
    return _public(row) if row else None


# ── Google Sign-In (ID-token flow) ────────────────────────────────────────────
def google_signin(credential: str) -> dict:
    """Verify a Google ID token (from the GIS button) and resolve it to a user.

    Linking policy (Google emails are verified by Google):
      1. Known google_sub -> that user.
      2. Same verified email as an existing account -> link google_sub to it.
      3. Otherwise -> create a new account (password_hash=NULL, google_sub set).
    Returns the public user dict. Raises GoogleAuthError on any verification issue.
    """
    if not GOOGLE_CLIENT_ID:
        raise GoogleAuthError("Google sign-in is not configured on the server.")
    if not credential:
        raise GoogleAuthError("Missing Google credential.")

    # Local imports so a missing google-auth never breaks module import.
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token as google_id_token

    try:
        # Verifies signature, audience (== our client id), issuer, and expiry.
        claims = google_id_token.verify_oauth2_token(
            credential, google_requests.Request(), GOOGLE_CLIENT_ID
        )
    except Exception as e:
        raise GoogleAuthError(f"Invalid Google token: {e}") from e

    sub = claims.get("sub")
    email = (claims.get("email") or "").strip().lower()
    if not sub or not email:
        raise GoogleAuthError("Google token missing subject/email.")
    if claims.get("email_verified") is False:
        raise GoogleAuthError("Google account email is not verified.")

    # 1. Already-linked Google account.
    row = db.get_user_by_google_sub(sub)
    if row:
        return _public(row)

    # 2. Existing account with the same (verified) email -> link.
    row = db.get_user_by_email(email)
    if row:
        db.set_google_sub(int(row["id"]), sub)
        return _public(db.get_user_by_id(int(row["id"])))

    # 3. New Google-only account (no password).
    display_name = claims.get("name") or email.split("@")[0]
    uid = db.create_user(
        email=email, display_name=display_name, password_hash=None,
        created_at=_now(), google_sub=sub,
    )
    return _public(db.get_user_by_id(uid))


# ── JWT session token ─────────────────────────────────────────────────────────
def make_token(user_id: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=SESSION_TTL_DAYS)).timestamp()),
    }
    return jwt.encode(payload, SESSION_SECRET, algorithm=_ALG)


def user_id_from_token(token: str | None) -> str | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SESSION_SECRET, algorithms=[_ALG])
    except jwt.PyJWTError:
        return None  # invalid/expired -> treated as logged out
    return payload.get("sub")
