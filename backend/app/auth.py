"""Minimal ID+PIN auth for a small, known set of users.

Not a real auth system — no sessions/tokens/hashing. This is a lightweight gate
so two specific people (vatsal, sakshi) each land on their own memory graph
without typing a free-text name that could collide or be mistyped. PINs are
read from env (with demo defaults) so they aren't hardcoded secrets in git.
"""

import os

USERS: dict[str, dict[str, str]] = {
    "vatsal": {
        "display_name": "Vatsal",
        "pin": os.getenv("PIN_VATSAL", "1111"),
    },
    "sakshi": {
        "display_name": "Sakshi",
        "pin": os.getenv("PIN_SAKSHI", "2222"),
    },
}


def list_profiles() -> list[dict[str, str]]:
    """Public info only (no pins) — for the login screen's profile picker."""
    return [
        {"user_id": uid, "display_name": info["display_name"]}
        for uid, info in USERS.items()
    ]


def verify(user_id: str, pin: str) -> str | None:
    """Return the display name if user_id/pin match, else None."""
    info = USERS.get(user_id)
    if info and pin == info["pin"]:
        return info["display_name"]
    return None
