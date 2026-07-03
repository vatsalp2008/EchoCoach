"""Phase 3 — external grounding (spec §7).

This is the ONLY module that touches Reddit (PRAW) or GitHub — the same
"one auditable surface" discipline `memory.py` applies to Cognee. It discovers
recent interview-experience posts for a target company, filters them for
relevance, ingests the real post TEXT (title + selftext) into a
`company_context:<slug>` dataset via Cognee, polls for readiness in the
background, and later grounds question text against it.

Isolation (spec §2.1): nothing here imports or edits the Phase 1/2 loop
(`session.py`, `grading.py`, `debrief.py`, `question_bank.py`, `db.py`) or the
`memory.py` surface. Cognee is reached only through the existing `memory.*`
functions. This module is triggered/consumed from the API boundary later.

Fallback-first (spec §2.2, §7.9): missing creds, a dead API, or an exhausted
LLM quota never raise into a caller — grounding degrades to a no-op and the
hardcoded question bank is used. Every such degradation is logged with a
DISTINCT reason so a quota skip is trivially distinguishable from a real error
or missing credentials while testing on a quota-capped key.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import uuid
from dataclasses import dataclass, field
from enum import Enum

from . import config  # noqa: F401 — importing loads .env (needed for the vars below)
from . import llm_client, memory
from .llm_client import LLMQuotaError, _is_quota_error

# ── Logging: guarantee the distinct skip/quota lines are visible everywhere ──
# A dedicated logger with its own stdout handler so the messages show up whether
# run under uvicorn or the standalone smoke script, without depending on the
# host's root-logger config.
log = logging.getLogger("echocoach.grounding")
if not log.handlers:
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(_h)
    log.setLevel(logging.INFO)
    log.propagate = False


# ── Reasons for a skip/degrade — these are the words to grep for while testing ─
class SkipReason(str, Enum):
    LLM_QUOTA = "llm-quota"              # Gemini quota/rate-limit hit (the AQ. key)
    MISSING_CREDENTIALS = "missing-credentials"
    ERROR = "error"                     # unexpected failure (network, API, parse)
    NO_RESULTS = "no-results"           # ran fine, found nothing relevant


def _skip(reason: SkipReason, step: str, detail: str) -> None:
    """Single choke point for degrade logging so the three cases the user cares
    about — quota vs. real error vs. missing creds — are always shaped the same
    and easy to tell apart."""
    line = "[grounding] SKIP reason=%s step=%s detail=%s"
    if reason is SkipReason.ERROR:
        log.error(line, reason.value, step, detail)
    else:
        log.warning(line, reason.value, step, detail)


# ── Discovery configuration (spec §7.2 / §7.3) ───────────────────────────────
SUBREDDITS = ("cscareerquestions", "leetcode", "ExperiencedDevs")
_REDDIT_PER_SUB = 3          # gather up to this per sub, then trim to the cap
MAX_REDDIT = 6               # spec §7.2: cap 5–6 Reddit results
MAX_GITHUB = 3               # spec §7.2: cap 2–3 GitHub repos
_SELFTEXT_CHARS = 3000       # trim long posts so cognify stays manageable
# NOTE (spec §7.3): we deliberately never touch Glassdoor, Blind, or LeetCode
# Discuss. Only public Reddit posts + public GitHub repo metadata.


# ── State (in-memory only; no durable cache table, per the agreed plan) ──────
class Status(str, Enum):
    PENDING = "pending"
    READY = "ready"
    NO_RESULTS = "no-results"
    SKIPPED_QUOTA = "skipped-quota"
    SKIPPED_MISSING_CREDS = "skipped-missing-credentials"
    ERROR = "error"


@dataclass
class Grounding:
    slug: str
    company: str
    status: Status
    dataset: str | None = None
    dataset_id: object = None
    n_docs: int = 0
    sources: list[str] = field(default_factory=list)  # e.g. ["r/leetcode", "GitHub"]
    detail: str = ""


# slug -> latest Grounding state. Resets on restart (agreed: no durable cache).
_registry: dict[str, Grounding] = {}
# Detached poll/build tasks kept alive so the GC can't drop them mid-flight.
_tasks: set[asyncio.Task] = set()


def company_slug(company: str) -> str:
    """`Foo Bar, Inc.` -> `foo_bar_inc` — mirrors session._slug's convention."""
    s = "".join(c if c.isalnum() else "_" for c in company.lower().strip())
    return "_".join(p for p in s.split("_") if p) or "company"


def get_state(slug: str) -> Grounding | None:
    return _registry.get(slug)


def ui_note(slug: str) -> str | None:
    """Unobtrusive payoff note for the UI (spec §7.8), or None if not ready."""
    g = _registry.get(slug)
    if not g or g.status is not Status.READY or not g.sources:
        return None
    return "Now grounding questions in real reports from " + ", ".join(g.sources)


# ── Credentials ──────────────────────────────────────────────────────────────
def _reddit_creds() -> tuple[str, str, str]:
    return (
        os.getenv("REDDIT_CLIENT_ID", "").strip(),
        os.getenv("REDDIT_CLIENT_SECRET", "").strip(),
        os.getenv("REDDIT_USER_AGENT", "").strip(),
    )


def _has_reddit_creds() -> bool:
    cid, csec, ua = _reddit_creds()
    # Treat the .env.example placeholder user-agent as "not set".
    placeholder = ("your_reddit_username" in ua) or ("<your" in ua)
    return bool(cid and csec and ua and not placeholder)


# ── Discovery: Reddit (spec §7.2) ────────────────────────────────────────────
def _fetch_reddit_sync(company: str) -> list[dict]:
    """PRAW is synchronous — called via asyncio.to_thread so it never blocks the
    event loop. Read-only app-only auth (a `script` app); we only read public
    posts. Returns real post text, not bare URLs (per the agreed plan)."""
    import praw

    cid, csec, ua = _reddit_creds()
    reddit = praw.Reddit(
        client_id=cid,
        client_secret=csec,
        user_agent=ua,
        check_for_async=False,  # silence PRAW's async-context warning; we're in a thread
    )
    reddit.read_only = True

    docs: list[dict] = []
    for sub in SUBREDDITS:
        try:
            results = reddit.subreddit(sub).search(
                company, sort="new", limit=_REDDIT_PER_SUB
            )
            for post in results:
                selftext = (getattr(post, "selftext", "") or "")[:_SELFTEXT_CHARS]
                docs.append(
                    {
                        "source": f"r/{sub}",
                        "title": getattr(post, "title", "") or "",
                        "text": selftext,
                        "url": f"https://reddit.com{getattr(post, 'permalink', '')}",
                    }
                )
        except Exception as e:  # one bad sub must not kill the others
            log.warning("[grounding] reddit search failed sub=%s: %r", sub, e)
    return docs[:MAX_REDDIT]


# ── Discovery: GitHub (spec §7.2) — no credentials required ───────────────────
async def _fetch_github(company: str) -> list[dict]:
    """Search public repos for company interview material. Works token-less (at a
    lower rate limit); GITHUB_TOKEN just raises the limit."""
    import httpx

    token = os.getenv("GITHUB_TOKEN", "").strip()
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    params = {
        "q": f"{company} interview questions",
        "sort": "stars",
        "order": "desc",
        "per_page": MAX_GITHUB,
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            "https://api.github.com/search/repositories", params=params, headers=headers
        )
        resp.raise_for_status()
        items = resp.json().get("items", [])

    docs: list[dict] = []
    for it in items[:MAX_GITHUB]:
        docs.append(
            {
                "source": "GitHub",
                "title": it.get("full_name", "") or "",
                "text": (it.get("description") or it.get("full_name") or ""),
                "url": it.get("html_url", "") or "",
            }
        )
    return docs


# ── Filter (spec §7.4): keep only plausibly-relevant items ───────────────────
async def _filter(company: str, candidates: list[dict]) -> list[dict]:
    """One cheap relevance pass. Batched into a single LLM call (kinder to a
    quota-capped key than one call per URL). On quota we DON'T silently drop
    everything — we degrade to a keyword check and log the quota event, so
    grounding still works and the reason is visible."""
    if not candidates:
        return []
    try:
        return await _llm_filter(company, candidates)
    except LLMQuotaError:
        _skip(SkipReason.LLM_QUOTA, "filter",
              "quota hit during relevance filter; falling back to keyword match")
        return _keyword_filter(company, candidates)
    except Exception as e:
        if _is_quota_error(e):
            _skip(SkipReason.LLM_QUOTA, "filter",
                  "quota-like error during relevance filter; keyword fallback")
        else:
            _skip(SkipReason.ERROR, "filter", f"{e!r}; keyword fallback")
        return _keyword_filter(company, candidates)


async def _llm_filter(company: str, candidates: list[dict]) -> list[dict]:
    numbered = "\n".join(
        f"{i}. [{d['source']}] {d['title']}" for i, d in enumerate(candidates)
    )
    prompt = (
        f"You are screening candidate web results for relevance to REAL interview "
        f"questions/experiences at the company: {company}.\n\n"
        f"Results:\n{numbered}\n\n"
        f"Return ONLY a JSON array of the integer indices that plausibly discuss "
        f"real interview questions, rounds, or experiences for {company}. "
        f"Example: [0, 2, 3]. No other text."
    )
    raw = await llm_client.generate(prompt, temperature=0.0, response_format="json")
    import json

    try:
        keep_idx = {int(i) for i in json.loads(raw)}
    except Exception:
        # Unparseable -> treat as "no strong signal", fall back to keywords.
        return _keyword_filter(company, candidates)
    kept = [d for i, d in enumerate(candidates) if i in keep_idx]
    log.info("[grounding] filter(llm) kept %d/%d", len(kept), len(candidates))
    return kept


def _keyword_filter(company: str, candidates: list[dict]) -> list[dict]:
    """No-LLM relevance heuristic: mentions the company AND an interview-y word."""
    comp = company.lower()
    marks = ("interview", "onsite", "phone screen", "oa", "online assessment",
             "recruiter", "offer", "loop", "round", "question")
    kept = []
    for d in candidates:
        blob = f"{d['title']} {d['text']}".lower()
        if comp in blob and any(m in blob for m in marks):
            kept.append(d)
    log.info("[grounding] filter(keyword) kept %d/%d", len(kept), len(candidates))
    return kept


# ── Ingest text builder (real post text, not URLs — agreed plan / spec §7.5) ──
def _doc_text(d: dict) -> str:
    body = d["text"].strip()
    header = f"[{d['source']}] {d['title']}".strip()
    return f"{header}\n\n{body}".strip() if body else header


# ── Cognee dataset-id / status helpers (shapes confirmed by the smoke script) ─
def _extract_dataset_id(res: object) -> object:
    """RememberResult's id attribute name isn't guaranteed across versions, so
    probe the common ones. Falls back to None -> poll resolves via name."""
    for attr in ("dataset_id", "id", "dataset"):
        val = getattr(res, attr, None)
        if val is not None:
            return val
    if isinstance(res, dict):
        for key in ("dataset_id", "id", "dataset"):
            if res.get(key) is not None:
                return res[key]
    return None


async def _resolve_dataset_id(name: str) -> object:
    """Find a dataset id by name via list_datasets, defensively across shapes."""
    try:
        datasets = await memory.list_datasets()
    except Exception as e:
        log.warning("[grounding] list_datasets failed: %r", e)
        return None
    for ds in datasets or []:
        ds_name = getattr(ds, "name", None) or (
            ds.get("name") if isinstance(ds, dict) else None
        )
        if ds_name == name:
            return (
                getattr(ds, "id", None)
                or (ds.get("id") if isinstance(ds, dict) else None)
            )
    return None


def _as_uuid(val: object) -> uuid.UUID | None:
    """Coerce a dataset id to a uuid.UUID for get_status().

    Cognee's API is asymmetric here: RememberResult.dataset_id is a *str*
    ("Dataset UUID (str)"), but datasets.get_status(dataset_ids: list[UUID])
    binds it as a UUID column — SQLAlchemy calls value.hex, which a str lacks
    ('str' object has no attribute 'hex'). So convert before polling. Ids that
    come from list_datasets are already UUID objects and pass through."""
    if isinstance(val, uuid.UUID):
        return val
    try:
        return uuid.UUID(str(val))
    except (ValueError, AttributeError, TypeError):
        return None


def _classify_status(st: object) -> tuple[bool, bool]:
    """(completed, errored) from whatever get_status returns — matched on the
    string form so we don't hard-depend on an enum shape."""
    s = str(st).upper()
    completed = "COMPLET" in s          # DATASET_PROCESSING_COMPLETED etc.
    errored = ("ERROR" in s) or ("FAIL" in s)
    return completed, errored


async def _poll_ready(g: Grounding, interval: float, max_checks: int) -> str:
    """Poll get_status (spec §7.6). Returns one of:
    'ready' | 'timeout' | 'quota' | 'error'. Quota is inferred when a poll fails
    with a quota error OR the write breaker has since tripped."""
    if g.dataset_id is None:
        g.dataset_id = await _resolve_dataset_id(g.dataset or "")
    if g.dataset_id is None:
        log.warning("[grounding] no dataset id for %s; cannot poll status", g.dataset)
        return "error"

    # get_status requires UUID objects, but remember() gave us a str — coerce.
    ds_uuid = _as_uuid(g.dataset_id)
    if ds_uuid is None:
        log.warning("[grounding] dataset id %r is not a valid UUID; cannot poll",
                    g.dataset_id)
        return "error"
    ids = [ds_uuid]
    for i in range(max_checks):
        await asyncio.sleep(interval)
        try:
            st = await memory.dataset_status(ids)
        except Exception as e:
            if _is_quota_error(e):
                return "quota"
            log.warning("[grounding] poll %d/%d get_status error: %r",
                        i + 1, max_checks, e)
            continue
        completed, errored = _classify_status(st)
        log.info("[grounding] poll %d/%d slug=%s status=%r",
                 i + 1, max_checks, g.slug, st)
        if completed:
            return "ready"
        if errored:
            # Cognify errored — distinguish quota from a genuine pipeline error.
            return "quota" if not memory.llm_available() else "error"
    return "timeout"


# ── Cache check (spec §7.1) ──────────────────────────────────────────────────
async def _already_populated(slug: str) -> bool:
    """True only if company_context:<slug> exists AND its cognify graph is built.

    Mere dataset existence is NOT enough: a prior partial or failed ingest leaves
    data item(s) with an EMPTY knowledge graph ("N data items but the knowledge
    graph is empty"). Treating that as ready would ground questions against
    nothing. So we gate on the cognify pipeline having COMPLETED, checked via the
    same get_status the poll uses. Best-effort: any uncertainty returns False so
    we simply re-ingest, which is always safe."""
    name = f"company_context:{slug}"
    dataset_id = await _resolve_dataset_id(name)
    if dataset_id is None:
        return False  # doesn't exist yet
    ds_uuid = _as_uuid(dataset_id)
    if ds_uuid is None:
        return False
    try:
        st = await memory.dataset_status([ds_uuid])
    except Exception as e:
        log.warning("[grounding] cache readiness check failed for %s: %r", name, e)
        return False
    completed, _ = _classify_status(st)
    if not completed:
        log.info(
            "[grounding] cache MISS slug=%s — dataset exists but graph not ready "
            "(status=%r); will re-ingest",
            slug, st,
        )
    return completed


# ── Public: trigger the pipeline (spec §7.1) ─────────────────────────────────
async def ensure_company_context(
    company: str | None,
    *,
    background: bool = True,
    poll_interval: float = 10.0,
    poll_max: int = 8,
) -> Grounding | None:
    """Ensure a company_context dataset exists for `company`.

    - Returns immediately with a PENDING state and runs the build detached when
      `background=True` (the real request-path behavior — never blocks the UI).
    - Set `background=False` to await the full pipeline and get the final state
      (used by the smoke script).
    Returns None only when `company` is empty.
    """
    if not company or not company.strip():
        return None
    slug = company_slug(company)

    existing = _registry.get(slug)
    if existing and existing.status in (Status.PENDING, Status.READY):
        return existing  # already building or done — don't re-fetch (spec §7.1)

    if await _already_populated(slug):
        g = Grounding(slug, company, Status.READY,
                      dataset=f"company_context:{slug}", detail="cache hit")
        _registry[slug] = g
        log.info("[grounding] cache hit slug=%s — dataset already populated", slug)
        return g

    g = Grounding(slug, company, Status.PENDING, dataset=f"company_context:{slug}")
    _registry[slug] = g
    log.info("[grounding] start company=%r slug=%s", company, slug)

    if background:
        task = asyncio.create_task(_build(company, slug, poll_interval, poll_max))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)
        return g
    return await _build(company, slug, poll_interval, poll_max)


async def _build(
    company: str, slug: str, poll_interval: float, poll_max: int
) -> Grounding:
    g = _registry[slug]
    have_reddit = _has_reddit_creds()
    if not have_reddit:
        _skip(SkipReason.MISSING_CREDENTIALS, "reddit",
              "REDDIT_CLIENT_ID/SECRET/USER_AGENT not set — see docs/reddit_api_setup.md; "
              "trying GitHub only")

    # 1. Discovery (each source guarded independently) ─────────────────────────
    docs: list[dict] = []
    if have_reddit:
        try:
            docs += await asyncio.to_thread(_fetch_reddit_sync, company)
        except Exception as e:
            _skip(SkipReason.ERROR, "reddit-fetch", f"{e!r}")
    try:
        docs += await _fetch_github(company)
    except Exception as e:
        _skip(SkipReason.ERROR, "github-fetch", f"{e!r}")

    if not docs:
        if not have_reddit:
            g.status = Status.SKIPPED_MISSING_CREDS
            g.detail = "no Reddit creds and GitHub returned nothing"
        else:
            g.status = Status.NO_RESULTS
            g.detail = "discovery returned no posts"
            _skip(SkipReason.NO_RESULTS, "discovery", "no candidate posts found")
        return g

    # 2. Filter (spec §7.4) ────────────────────────────────────────────────────
    kept = await _filter(company, docs)
    if not kept:
        g.status = Status.NO_RESULTS
        g.detail = "nothing passed the relevance filter"
        _skip(SkipReason.NO_RESULTS, "filter", "0 items passed relevance")
        return g

    # 3. Ingest real post text (spec §7.5) ─────────────────────────────────────
    texts = [_doc_text(d) for d in kept]
    try:
        res = await memory.remember(
            texts, dataset_name=g.dataset, run_in_background=True
        )
    except Exception as e:
        if _is_quota_error(e):
            g.status = Status.SKIPPED_QUOTA
            _skip(SkipReason.LLM_QUOTA, "ingest",
                  "cognify rejected the write for quota; graph skipped this run")
        else:
            g.status = Status.ERROR
            _skip(SkipReason.ERROR, "ingest", f"{e!r}")
        return g

    if res is None:
        # memory.remember returns None when the graph-write breaker is OPEN,
        # which only happens after a prior quota/timeout failure — so this is a
        # quota skip, distinct from a real error.
        g.status = Status.SKIPPED_QUOTA
        _skip(SkipReason.LLM_QUOTA, "ingest",
              "graph-write circuit breaker open (prior quota failure) — write skipped")
        return g

    g.dataset_id = _extract_dataset_id(res)
    g.n_docs = len(texts)
    g.sources = sorted({d["source"] for d in kept})
    log.info("[grounding] ingested %d docs into %s (id=%r) sources=%s",
             g.n_docs, g.dataset, g.dataset_id, g.sources)

    # 4. Poll for readiness (spec §7.6) ────────────────────────────────────────
    outcome = await _poll_ready(g, poll_interval, poll_max)
    if outcome == "ready":
        g.status = Status.READY
        g.detail = "company_context ready"
        log.info("[grounding] READY slug=%s docs=%d sources=%s",
                 slug, g.n_docs, g.sources)
    elif outcome == "quota":
        g.status = Status.SKIPPED_QUOTA
        _skip(SkipReason.LLM_QUOTA, "poll",
              "cognify did not finish — quota exhausted; will retry a later session")
    elif outcome == "timeout":
        g.status = Status.ERROR
        g.detail = "cognify did not complete within the poll window"
        _skip(SkipReason.ERROR, "poll",
              f"not ready after {poll_max} checks (~{int(poll_interval * poll_max)}s)")
    else:  # "error"
        g.status = Status.ERROR
        _skip(SkipReason.ERROR, "poll", "pipeline reported an error")
    return g


# ── Public: ground a question against ready company context (spec §7.7) ──────
async def ground_question(base_question: str, slug: str, *, topic: str | None = None) -> str:
    """Rewrite `base_question` using recalled company context, IF ready. Returns
    the base question unchanged on not-ready / quota / any error — the caller
    (later, at the API boundary) always gets usable text and never blocks.

    Never leaks grading and never changes the topic — it only makes the same
    question more company-specific (spec §5.3a still holds)."""
    g = _registry.get(slug)
    if not g or g.status is not Status.READY or not g.dataset:
        return base_question

    try:
        hits = await memory.recall(
            f"Real interview questions and topics reported for this company, "
            f"relevant to: {topic or base_question}",
            datasets=[g.dataset],
            top_k=5,
        )
    except LLMQuotaError:
        _skip(SkipReason.LLM_QUOTA, "ground-recall", "quota during company recall")
        return base_question
    except Exception as e:
        reason = SkipReason.LLM_QUOTA if _is_quota_error(e) else SkipReason.ERROR
        _skip(reason, "ground-recall", f"{e!r}")
        return base_question

    context = _recall_to_text(hits)
    if not context:
        return base_question

    prompt = (
        "You are an interviewer tailoring a question to a specific company using "
        "real reported interview context. Rewrite the question below so it reflects "
        "what candidates actually report for this company, keeping the SAME topic "
        "and difficulty. Do not reveal any assessment or feedback. Return only the "
        "rewritten question.\n\n"
        f"Company context:\n{context}\n\n"
        f"Original question: {base_question}"
    )
    try:
        out = (await llm_client.generate(prompt, temperature=0.4)).strip()
        return out or base_question
    except LLMQuotaError:
        _skip(SkipReason.LLM_QUOTA, "ground-rewrite", "quota during question rewrite")
        return base_question
    except Exception as e:
        reason = SkipReason.LLM_QUOTA if _is_quota_error(e) else SkipReason.ERROR
        _skip(reason, "ground-rewrite", f"{e!r}")
        return base_question


def _recall_to_text(hits: object) -> str:
    """Flatten Cognee's recall result into plain text for the grounding prompt.
    Recall's entry shape varies, so stringify defensively and cap the length."""
    if not hits:
        return ""
    if isinstance(hits, str):
        return hits[:2000]
    parts: list[str] = []
    for h in hits if isinstance(hits, (list, tuple)) else [hits]:
        if isinstance(h, str):
            parts.append(h)
        elif isinstance(h, dict):
            parts.append(str(h.get("text") or h.get("content") or h))
        else:
            parts.append(str(getattr(h, "text", None) or h))
    return "\n".join(p for p in parts if p).strip()[:2000]
