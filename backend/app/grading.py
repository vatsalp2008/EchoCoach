"""Grading pass. One LLM call per answer, returns validated JSON (spec 5.2 /
6.2). The prompts are used VERBATIM from the spec — do not paraphrase the
rubrics. Grading happens silently: nothing here is ever shown to the candidate
mid-session (spec 5.3a).
"""

from __future__ import annotations

import json

from . import llm_client
from .llm_client import LLMQuotaError
from .schemas import Domain, GradingAssessment, GradingSignal

_HEDGE_WORDS = ("i think", "maybe", "probably", "i'm not sure", "im not sure",
                "i guess", "kind of", "sort of", "not sure")
_DODGE_MARKERS = ("no idea", "don't know", "dont know", "not sure", "skip",
                  "pass", "can't answer", "cant answer")

# The JSON schema the grader must return (spec 4.2). Shown to the model as-is;
# the app overrides session_id/timestamp/topic/domain authoritatively after.
_SCHEMA = """{
  "session_id": "string",
  "timestamp": "ISO8601",
  "topic": "string",
  "domain": "technical | behavioral",
  "signal": "mastered | partial | struggled | avoided",
  "grader_confidence": 0.0,
  "delivery": "concise | rambling | vague | hedgy | direct",
  "evidence": "one sentence, the key moment that justified this signal",
  "reasoning": "1-2 sentences on why this signal was chosen",
  "follow_up_needed": true,
  "follow_up_focus": "the specific sub-gap to probe next, or null"
}"""

# ── Technical grading prompt (spec 5.2, verbatim) ─────────────────────────────
_TECHNICAL_PROMPT = """You are grading a technical interview answer on ONE topic: {topic}.

Question asked: {question}
Candidate's answer (transcribed from speech): {transcript}

Ignore filler words, false starts, and speech disfluencies entirely —
they came from voice transcription and carry no signal here.
Grade only the technical substance.

Evaluate on:
1. Correctness — is the core claim/approach right?
2. Completeness — did they cover key tradeoffs or edge cases,
   or only the surface-level happy path?
3. Depth — did they explain WHY, not just WHAT?
4. Delivery — separately, note whether the answer was concise, rambling,
   vague, hedgy (heavy use of "I think"/"maybe"/"I'm not sure"), or direct.
   This does NOT affect your correctness/completeness/depth judgment or
   the signal you choose below — it is recorded only for the candidate's
   end-of-session debrief.

Decide:
- "mastered" if correct, complete, and reasoned through tradeoffs unprompted
- "partial" if the core idea is right but missing tradeoffs/edge cases
- "struggled" if the core approach is wrong or confused
- "avoided" if they didn't actually attempt the technical substance

Return only the JSON object matching this schema, no other text:
{schema}"""

# ── Behavioral grading prompt (spec 6.2, verbatim) — used in Phase 2 ──────────
_BEHAVIORAL_PROMPT = """You are grading a behavioral interview answer on ONE topic: {topic}.

Question asked: {question}
Candidate's answer (transcribed from speech): {transcript}

Unlike technical answers, communication clarity IS part of the
evaluation here — real interviewers judge how clearly a story is told,
not just its content. Frequent filler words, rambling, or losing the
thread should lower the "structure" evaluation below, though a few
natural fillers are normal speech and not a flaw on their own.

Evaluate on:
1. Structure — is there a clear situation, action taken, and result?
   (STAR-shaped, even if not rigidly labeled)
2. Ownership — do they own their role/decisions, or deflect blame?
3. Specificity — concrete details and outcomes, or vague generalities?
4. Communication clarity — was the story easy to follow as delivered?
5. Delivery — note whether the answer was concise, rambling, vague,
   hedgy (heavy use of "I think"/"maybe"/"I'm not sure"), or direct.
   Unlike a technical answer, delivery quality here DOES legitimately
   factor into the signal you choose below — communication clarity is
   part of what real interviewers judge in behavioral rounds.

Decide:
- "mastered" if structured, specific, owns their role, clearly told
- "partial" if the content is fine but poorly structured/rambling,
  or well-told but vague/generic
- "struggled" if unclear, deflects responsibility, or no real substance
- "avoided" if they dodged the actual question asked

Return only the JSON object matching this schema, no other text:
{schema}"""

_PROMPTS = {"technical": _TECHNICAL_PROMPT, "behavioral": _BEHAVIORAL_PROMPT}


async def grade_answer(
    *, session_id: str, topic: str, domain: Domain, question: str, transcript: str
) -> GradingSignal:
    """Grade one answer -> validated GradingSignal. Temp 0.2 for consistency."""
    prompt = _PROMPTS[domain].format(
        topic=topic, question=question, transcript=transcript, schema=_SCHEMA
    )
    try:
        raw = await llm_client.generate(prompt, temperature=0.2, response_format="json")
        assessment = _parse_assessment(raw)
    except (LLMQuotaError, ValueError, KeyError) as e:
        # Quota exhausted or unparsable JSON -> heuristic fallback so the session
        # never stalls. The signal is coarse but non-random; grader_confidence is
        # kept low so the debrief can flag it.
        assessment = _heuristic_assessment(transcript)
    return GradingSignal.from_assessment(
        assessment, session_id=session_id, topic=topic, domain=domain
    )


def _parse_assessment(raw: str) -> GradingAssessment:
    """Validate the model's JSON. Only the assessment fields are trusted; the
    app supplies session_id/timestamp/topic/domain."""
    data = json.loads(raw)
    return GradingAssessment.model_validate(data)


def _heuristic_assessment(transcript: str) -> GradingAssessment:
    """No-LLM fallback grade from transcript text alone. Coarse but deterministic:
    empty/dodging -> avoided; very short -> struggled; long+specific -> partial.
    Never claims 'mastered' without a real grade."""
    t = transcript.strip().lower()
    words = t.split()
    hedges = sum(t.count(h) for h in _HEDGE_WORDS)
    if not words or any(m in t for m in _DODGE_MARKERS):
        signal, focus = "avoided", "attempt the question at all"
    elif len(words) < 20:
        signal, focus = "struggled", "give a fuller, more concrete answer"
    else:
        signal, focus = "partial", "cover tradeoffs and edge cases"
    delivery = "hedgy" if hedges >= 2 else ("vague" if len(words) < 20 else "direct")
    return GradingAssessment(
        signal=signal,
        grader_confidence=0.3,  # low: this is a heuristic, not a real grade
        delivery=delivery,
        evidence="Graded heuristically (LLM unavailable/quota) from answer length and phrasing.",
        reasoning="Fallback grade; the model was unavailable, so this is a coarse text-based estimate.",
        follow_up_needed=signal in ("struggled", "avoided"),
        follow_up_focus=focus,
    )
