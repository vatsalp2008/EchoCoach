"""Pydantic models. The grading signal (spec 4.2) is the JSON that remember()
writes into a `topic:*` dataset after every answer — it must be parseable, so
we validate the LLM's output against it before touching memory.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field

Signal = Literal["mastered", "partial", "struggled", "avoided"]
Delivery = Literal["concise", "rambling", "vague", "hedgy", "direct"]
Domain = Literal["technical", "behavioral"]


class GradingAssessment(BaseModel):
    """The fields the grader LLM produces (spec 4.2, minus app-known fields).

    session_id / timestamp / topic / domain are injected authoritatively by the
    app after the call — never trusted from the model.
    """

    signal: Signal
    grader_confidence: float = Field(ge=0.0, le=1.0)
    delivery: Delivery
    evidence: str
    reasoning: str
    follow_up_needed: bool
    follow_up_focus: Optional[str] = None


class GradingSignal(GradingAssessment):
    """Full record written to the topic dataset (spec 4.2)."""

    session_id: str
    timestamp: str
    topic: str
    domain: Domain

    @classmethod
    def from_assessment(
        cls,
        assessment: GradingAssessment,
        *,
        session_id: str,
        topic: str,
        domain: Domain,
    ) -> "GradingSignal":
        return cls(
            **assessment.model_dump(),
            session_id=session_id,
            timestamp=datetime.now(timezone.utc).isoformat(),
            topic=topic,
            domain=domain,
        )


# ── API models ──────────────────────────────────────────────────────────────
class StartSessionRequest(BaseModel):
    target_role: str
    company: Optional[str] = None
    domain_focus: Domain = "technical"


class StartSessionResponse(BaseModel):
    session_id: str
    question_id: str
    topic: str
    question: str


class AnswerRequest(BaseModel):
    session_id: str
    question_id: str
    transcript: str


class AnswerResponse(BaseModel):
    """Returned after each answer. Deliberately carries NO grading info —
    feedback never leaks mid-session (spec 5.3a). `done` signals the debrief.
    """

    next_question_id: Optional[str] = None
    topic: Optional[str] = None
    question: Optional[str] = None
    is_follow_up: bool = False
    done: bool = False
