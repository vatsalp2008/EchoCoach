# Reddit API setup (Phase 3 grounding) — currently skipped, here's why

**Status: not in use for this submission.** The code path is fully built and
still tries Reddit first on every grounding request (see `backend/app/
grounding.py`), but as of **November 2025, Reddit ended self-serve API key
creation**. Creating an app at reddit.com/prefs/apps no longer hands you a
`client_id`/`client_secret` instantly — new access now requires applying
through Reddit's Developer Support form under their "Responsible Builder
Policy" and waiting for manual review, typically **2-4 weeks**. That's
incompatible with a hackathon deadline, so we made the call to skip it rather
than block on an external approval process we can't control.

This is exactly the scenario the fallback-first design was built for
(spec §7.9): missing Reddit credentials are treated as a normal, permanent
condition, not an error — grounding silently falls back to **GitHub-only**
search, which needs no approval and works today (verified live against real
companies). The interview and demo are never blocked by this.

## If you already have pre-November-2025 Reddit API credentials
Old credentials created before the policy change still work. If you (or
anyone on the team) has an old Reddit "script" app from a prior personal
project, its `client_id`/`client_secret` can be dropped straight into `.env`:
```
REDDIT_CLIENT_ID=<existing client id>
REDDIT_CLIENT_SECRET=<existing client secret>
REDDIT_USER_AGENT=echocoach:v1.0 (by /u/<your_reddit_username>)
```
No code changes needed — `grounding.py` will pick them up automatically and
start using Reddit alongside GitHub the next time the backend starts.

## Do not work around this by scraping
Don't fetch Reddit's `.json` endpoints without authentication as a workaround
— unauthenticated scraping was also blocked (returns 403) as of May 2026, and
it would violate the same terms the API access requires anyway. Per spec §7.3
we already exclude Glassdoor, Blind, and LeetCode Discuss for the same reason
(scraping-prohibited or unclear-terms sources) — Reddit-without-a-key now
belongs in that same "don't" list.

## GitHub token (optional, unaffected by any of this)
Only needed to raise search rate limits — no approval process, works today.
Create a **fine-grained or classic PAT** with **no scopes** (public read is
enough) at https://github.com/settings/tokens → put it in `.env` as
`GITHUB_TOKEN=`.
