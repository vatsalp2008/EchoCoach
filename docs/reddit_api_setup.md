# Reddit API setup (Phase 3 grounding)

EchoCoach uses Reddit's **free** non-commercial API tier via PRAW to pull recent
interview-experience threads for a target company. You only need a free Reddit
account. ~5 minutes.

## Steps
1. **Log in to Reddit** with any account at https://www.reddit.com.
2. Go to **https://www.reddit.com/prefs/apps** (Settings → scroll to "Developed Applications").
3. Click **"are you a developer? create an app…"** (or **"Create Another App"**).
4. Fill in the form:
   - **name:** `echocoach`
   - **type:** select **`script`** (this is the important one — it's for personal-use scripts).
   - **description:** optional, e.g. "interview prep memory app".
   - **about url:** leave blank.
   - **redirect uri:** `http://localhost:8080` (required field; value is unused for a script app).
5. Click **"create app"**.
6. Read the credentials off the created app box:
   - **client id** — the short string shown *directly under the app name* / under the words "personal use script" (a ~14-char string).
   - **client secret** — the value labeled **`secret`**.

## Put them in `.env`
```
REDDIT_CLIENT_ID=<the short id under the app name>
REDDIT_CLIENT_SECRET=<the secret value>
REDDIT_USER_AGENT=echocoach:v1.0 (by /u/<your_reddit_username>)
```
- The **user agent must be unique and descriptive** and include your username —
  Reddit rate-limits/blocks generic agents. Replace `<your_reddit_username>`.
- No password/OAuth-web flow is needed: a `script` app with id+secret uses
  read-only "application-only" auth, which is all we need for public search.

## Notes / limits
- Free tier is ~100 queries/min — far more than we use (we cap at 5–6 results per company).
- We only **read** public posts; we never post or scrape logged-in-only content.
- Per spec §7.3 we deliberately do **not** touch Glassdoor, Blind, or LeetCode Discuss.
- If creds are missing or a call fails, Phase 3 silently falls back to the
  hardcoded question bank — the interview never blocks on Reddit.

## GitHub token (optional, same phase)
Only needed to raise search rate limits. Create a **fine-grained or classic PAT**
with **no scopes** (public read is enough) at
https://github.com/settings/tokens → put it in `.env` as `GITHUB_TOKEN=`.
