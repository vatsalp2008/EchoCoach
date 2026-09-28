# Deploying EchoCoach for free

Three free services, one job each:

| Piece | Runs on | Free tier |
|---|---|---|
| Website (Next.js, `frontend/`) | **Vercel** | Hobby plan |
| Python backend (FastAPI + Cognee, `backend/`) | **Google Cloud Run** | 240,000 vCPU-seconds + 450,000 GiB-seconds / month (~60 h of uptime at 1 CPU / 2 GiB); the server only runs while someone is using the site |
| All data — users, interviews, Cognee's memory graph | **Neon** (Postgres) | 0.5 GB, 100 compute-hours / month; sleeps after 5 idle minutes and wakes on the next request |

The browser only ever talks to the Vercel site. Vercel forwards `/api/*` to Cloud Run (so login cookies stay first-party and work in Safari), and Cloud Run keeps nothing on its own disk — everything is in Neon. Local development is unchanged: without `DATABASE_URL` the backend uses SQLite and Cognee's local files as before.

Do the steps in order — each one needs a value from the one before.

## 1. Neon (the database) — ~5 minutes

1. Sign up at [neon.com](https://neon.com) (no card needed).
2. Create a project: name `echocoach`, region **AWS US East (N. Virginia)**.
3. On the project dashboard click **Connect**, turn **Connection pooling off**, and copy the connection string. It looks like:
   `postgresql://neondb_owner:••••@ep-xxxx.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`
4. Check it works from your Mac (spends ~5-8 Gemini requests — run it when the key has quota):
   ```bash
   DATABASE_URL='<the connection string>' backend/.venv/bin/python backend/scripts/postgres_smoke.py
   ```
   Every line should say `[ok]`. The app creates its tables on first start; you don't run any SQL.

## 2. Google Cloud Run (the backend) — ~20 minutes

1. Create a Google Cloud account at [cloud.google.com](https://cloud.google.com) (a card is required for verification; free-tier usage isn't charged) and create a project. Note its **project ID**.
2. **Billing → Budgets & alerts**: add a $1 budget, so you get an email if anything ever costs money.
3. Install and log in to the CLI:
   ```bash
   brew install --cask google-cloud-sdk
   gcloud init            # log in, pick the project
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
   ```
4. Create the backend's settings file **outside the repo** (it holds secrets — never commit it), e.g. `~/echocoach-cloudrun.yaml`. Copy the values from your local `.env`:
   ```yaml
   DATABASE_URL: "postgresql://...neon.tech/neondb?sslmode=require&channel_binding=require"
   SESSION_SECRET: "<new random value: python3 -c 'import secrets;print(secrets.token_urlsafe(48))'>"
   COOKIE_SECURE: "1"
   APP_LLM_PROVIDER: "gemini"
   APP_LLM_MODEL: "gemini-2.5-flash"
   GEMINI_API_KEY: "<from .env>"
   LLM_PROVIDER: "gemini"
   LLM_MODEL: "gemini/gemini-2.5-flash-lite"
   LLM_API_KEY: "<from .env>"
   EMBEDDING_PROVIDER: "fastembed"
   GOOGLE_CLIENT_ID: "<from .env>"
   GITHUB_TOKEN: "<from .env>"
   ```
   Don't copy `DB_PROVIDER`, `VECTOR_DB_PROVIDER` or `GRAPH_DATABASE_PROVIDER` — `DATABASE_URL` sets those.
5. Deploy, from the repo root:
   ```bash
   gcloud run deploy echocoach-api \
     --source backend \
     --region us-east4 \
     --allow-unauthenticated \
     --cpu 1 --memory 2Gi \
     --no-cpu-throttling \
     --min-instances 0 --max-instances 1 \
     --env-vars-file ~/echocoach-cloudrun.yaml
   ```
   Say **yes** when it offers to create an Artifact Registry repository. The first build takes 5-10 minutes. Why the flags:
   - `--no-cpu-throttling` keeps the CPU on after a response is sent, so the memory-graph saves that run in the background finish.
   - `--min-instances 0` lets it scale to zero when nobody's using it (that's what keeps it free); the first visit after a quiet spell waits ~10-20 s while it starts.
   - `--max-instances 1` caps usage (and cost) at one server.
6. It prints a **Service URL** like `https://echocoach-api-xxxxxxxx.us-east4.run.app`. Opening `<Service URL>/api/health` should show `{"status":"ok"}`.

To ship backend changes later, run the same `gcloud run deploy` command again.

## 3. Vercel (the website) — ~5 minutes

1. In the Vercel project (Root Directory `frontend`) → **Settings → Environment Variables**:
   - `BACKEND_URL` = the Cloud Run Service URL (no trailing slash)
   - `NEXT_PUBLIC_GOOGLE_CLIENT_ID` = the value in `frontend/.env.local`
2. **Deployments → Redeploy** (the backend URL is baked in at build time, so a redeploy is needed after changing it).

## 4. Google Sign-In

In [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials), open the OAuth client whose ID is `GOOGLE_CLIENT_ID` and add your Vercel URL (`https://<project>.vercel.app`) under **Authorized JavaScript origins**. Email + password login works without this.

## Check it

Open the Vercel URL (Safari works), sign up, reload — you should still be logged in — and start an interview.

## Things to know

- **Gemini quota is the real limit.** An `AQ.`-style key allows 20 requests per model per day; Cognee's model alone can use that up in a few interviews. The app keeps working (heuristic grading, the memory graph just stops updating), but for a public site create a standard key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (starts with `AIza`, much higher free limits) and put it in the settings file.
- **Voice on the deployed site** uses the browser's voice and speech recognition — Kokoro and MLX Whisper only run on Apple Silicon.
- **Container images**: each deploy stores an image in Artifact Registry (0.5 GB free). Delete old ones now and then under Artifact Registry → `cloud-run-source-deploy` to stay at $0.
- **Your local data doesn't move.** The deployed site starts with an empty database.
