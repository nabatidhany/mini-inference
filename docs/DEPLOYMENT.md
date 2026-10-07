# Deployment guide

Target architecture (both free tiers):

- **Gateway** → Render web service (long-lived Node process: SSE-friendly, no serverless timeouts, SQLite on disk)
- **Console** → Vercel (static Vite build; `VITE_API_URL` points at the Render service)

## 0. Push to GitHub

```bash
cd <repo>
git remote add origin git@github.com:<you>/mini-inference-router.git
git push -u origin main
```

## 1. Gateway on Render

1. Render dashboard → **New → Web Service** → connect the GitHub repo above.
2. Settings:
   - **Root Directory**: `server`
   - **Build Command**: `npm ci`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
   - **Health Check Path**: `/healthz`
3. Environment variables:
   - `GROQ_API_KEY` — (secret) your Groq key
   - `ADMIN_KEY` — (secret) any long random string
   - `DB_PATH` — `data/app.db` (default; the service re-seeds the KB on boot)
   - `CORS_ORIGIN` — leave unset until the console URL is known, then set it to the Vercel origin (e.g. `https://mini-inference-router.vercel.app`)
4. Deploy → note the service URL: `https://<service>.onrender.com`.

Note: with `render.yaml` present at repo root you can instead use **New → Blueprint** and just fill in the two secrets.

Free-tier caveats (accepted trade-offs, also in REPORT.md §6):
- spins down after ~15 min idle → first request pays a ~50s cold start. Wake with `curl <url>/healthz` before demoing.
- disk is ephemeral across deploys → the DB is re-seeded on boot by design (metering history resets on redeploy; fine for a demo).

## 2. Console on Vercel

1. Vercel dashboard → **Add New → Project** → import the same GitHub repo.
2. Settings:
   - **Root Directory**: `web`
   - Framework preset: Vite (auto-detected; build `npm run build`, output `dist`)
3. Environment variable:
   - `VITE_API_URL` = `https://<service>.onrender.com` (the Render URL from step 1)
4. Deploy → note the console URL, e.g. `https://mini-inference-router.vercel.app`.
5. (Recommended) Go back to Render and set `CORS_ORIGIN` to this URL, then redeploy.

## 3. Verify the deployed stack

```bash
# gateway awake + seeded
curl https://<service>.onrender.com/healthz

# a full streamed request through the deployed gateway
curl -N -X POST https://<service>.onrender.com/v1/chat \
  -H 'content-type: application/json' \
  -H 'x-api-key: sk-demo-acme-0001' \
  -d '{"message":"help me reset my PIN"}'

# admin state (replace ADMIN_KEY)
curl https://<service>.onrender.com/admin/state -H 'x-admin-key: <ADMIN_KEY>'
```

Then open the console URL, send a message, and check the inspector + usage views.

## 4. Demo checklist (for the video)

1. Normal flow: ask a KB question → answer streams, inspector fills (intent, model, tokens, latency, cost).
2. Short-circuit: ask a near-exact KB question (`help me reset my PIN`) → extractive backend, $0 cost, fast TTFB.
3. Fallback drill: `curl -X POST <url>/admin/chaos -H 'x-admin-key: ...' -d '{"backend":"groq","mode":"error"}'` → next request shows `fallback fired` in the inspector + usage view. Restore with `mode: "off"`.
4. Slow-backend drill: `{"backend":"groq","mode":"slow"}` → TTFB timeout → fallback (reason recorded). Restore.
5. Quota fail-closed: switch the console tenant to `globex` → next request returns a clear 429 with used/limit/reset.
6. Refusal: ask something out of scope (`what is the capital city of France`) → the assistant refuses instead of guessing.
7. Usage view: per-tenant requests, cost, remaining quota (polls every 5s).

## 5. Re-run the evaluation against the deployed URL (optional, nice for the report)

```bash
cd server
GROQ_API_KEY=<key> npx tsx src/scripts/eval.ts --judge \
  --api-base https://<service>.onrender.com --admin-key <ADMIN_KEY>
```
