# Deployment Plan: WO-C2E5A3 "AI tmux" (`ait`) on Railway

## Assumptions and a blunt warning first

- No customer preference was given, so the target is **Railway** (the default).
- `ait` is a local tool: its core needs a tmux server, a `claude` binary and a user terminal. A Railway container has none of these in a useful way. **Only the HTTP API (`npm start`, `bin/serve.js`) can be deployed.** The dashboard and session launching will not work there.
- Per `factory.json`: start `npm start`, port 3000, health path `/health`.
- **Release gate: do not deploy the current build.** Open blockers from earlier stations:
  1. One unidentified failing unit test (170/171).
  2. Security SR-01 (Critical): CSRF and DNS rebinding on the API.
  3. Security SR-02 (High): the API binds `0.0.0.0` and trusts loopback callers when no token is set.
  4. QA D2: a row stays "waiting" after a permission is approved.
  
  Deploying a public URL with launch, purge and export routes is unsafe until 1-3 are fixed. The steps below assume they are, and use `AIT_API_TOKEN` as the mandatory control in the meantime.
- Railway gives the container a proxy that is not loopback to the app. Without a token, every route except `/health` returns 403 (the code only trusts loopback). So **`AIT_API_TOKEN` is required** or the deployed API is unusable.

## Required environment variables

| Variable | Required | Value / purpose |
|---|---|---|
| `PORT` | Injected by Railway | Server reads it (default 3000). Do not hardcode. |
| `AIT_API_TOKEN` | **Yes** | Random 32+ bytes: `openssl rand -hex 32`. Bearer token for all routes except `/health`. |
| `AIT_HOME` | Yes | `/data/ait` on a mounted volume, so the registry persists. |
| `AIT_SOCKET` | Optional | Leave `ait` (default). |
| `AIT_DESKTOP` | Recommended | `0` (no desktop notifier in a container). |
| `AIT_DEBUG` | No | Leave unset in production. |

## Start command and health check

- **Start command:** `npm start` (runs `node bin/serve.js`).
- **Health check path:** `/health` (returns 200 `{"status":"ok"}`, and is the only unauthenticated route). Timeout 30 s.
- The server binds `0.0.0.0` and reads `PORT`, which is what Railway needs.
- Graceful stop on SIGTERM is already handled.

## Dockerfile note

A Dockerfile is needed only if you want `/sessions` routes to function, because Nixpacks' Node image has no tmux. Without tmux, every route that calls tmux returns 503 (exit code 10). `/health` still returns 200, so the deploy passes its health check but is mostly non-functional. If you want tmux present:

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends tmux git procps \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
USER node
ENV AIT_HOME=/data/ait
CMD ["npm", "start"]
```

Notes: there is no `npm install` step (zero dependencies). Mount the volume at `/data` and make it writable by `node`. `claude` is not in the image, so `POST /sessions` returns 424 regardless. Installing and authenticating Claude Code inside a shared container is not recommended.

## Deploy steps (Railway CLI)

```bash
# 0. Prerequisite: blockers above fixed and `npm test` is 171/171 green
npm test

# 1. Install and log in
npm i -g @railway/cli
railway login

# 2. Create and link the project (from the repo root)
railway init --name ait-api

# 3. Create the service by deploying, then add a volume
railway up --detach
railway volume add --mount-path /data

# 4. Set variables
railway variables --set "AIT_API_TOKEN=$(openssl rand -hex 32)" \
                  --set "AIT_HOME=/data/ait" \
                  --set "AIT_DESKTOP=0"

# 5. Public domain
railway domain

# 6. Redeploy with variables applied, then watch logs
railway up --detach
railway logs
```

In the Railway dashboard, under the service **Settings**, set the healthcheck path to `/health` and the start command to `npm start` if they were not detected. Railway has no CLI flag for the health path in every version, so confirm it in the UI.

Read the token back for testing with `railway variables --kv | grep AIT_API_TOKEN` (the token prints to your terminal, so avoid doing this on a shared screen).

**Rollback:** `railway redeploy` to a previous deployment from the dashboard, or `railway down` to remove the latest deployment. State lives on the volume. `POST /purge` with `{"confirm":"purge"}` wipes it.

## Post-deploy verification checklist

Set `URL=https://<your-domain>` and `TOKEN=<AIT_API_TOKEN>`.

- [ ] Deployment shows **Active** and logs print `ait API listening on port <PORT>`.
- [ ] `curl -s $URL/health` returns 200 and `{"status":"ok"}`.
- [ ] `curl -si $URL/sessions` (no token) returns **401** (token set). A 403 means `AIT_API_TOKEN` is missing.
- [ ] `curl -s -H "Authorization: Bearer wrong" $URL/sessions` returns 401.
- [ ] `curl -s -H "Authorization: Bearer $TOKEN" $URL/sessions` returns 200 with an empty list (with tmux in the image) or 503 `{"error":10,...}` (without tmux). Record which one you got, as it tells you whether the Dockerfile is in effect.
- [ ] `curl -s -H "Authorization: Bearer $TOKEN" $URL/doctor` returns 200, with `stateDir` equal to `/data/ait` and `stateDirModesOk: true`.
- [ ] Redeploy once and confirm `/data/ait` contents persist (volume mounted).
- [ ] Confirm no secrets in logs (`railway logs | grep -i token` returns nothing).
- [ ] **CSRF check (must fail safely):** `curl -si -X POST $URL/purge -H "Content-Type: text/plain" -d '{"confirm":"purge"}'` without a token returns 401. This is only protected by the token until SR-01 is fixed, so never share the token or put the URL in a browser session with it.
- [ ] Confirm `POST /sessions` is not usable for real work here (expected 424 `claude` not found), and that nobody expects the dashboard on Railway. Use `ait` locally for actual session management.
- [ ] Record the deployed commit, URL and date, and note the open blockers in the README gate-results section.

## Recommendation

The product's real value (dashboard, alerts, one-key switching) runs locally via `npm link` and `ait`. A Railway deploy adds little and adds attack surface. If a hosted target is still wanted, ship only after the SR-01 and SR-02 fixes and the green test run, and treat this as a health-checked API shell, not a working deployment of the product.
