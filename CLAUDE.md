# Remote Camera AI

WebRTC remote-camera app: a phone streams its rear camera, a browser viewer watches, a local vision pipeline (YOLO26n → tracking → ROI → YOLOE-26x → optional SAM 3 → BioCLIP 2) triggers alerts on target objects. Alerts broadcast over WS, append to a per-session log, get narrated by an LLM (Gemini 3.1 Flash Lite), and push to WhatsApp via a Baileys sidecar. All services run locally via `docker compose`.

## Services (docker-compose.yml)

| Service    | Build          | Ports                                     | Notes |
|------------|----------------|-------------------------------------------|-------|
| `web`      | `apps/web/`    | `3000→8080`, `443→8443`, `3443→8443`      | nginx; proxies `/api` + `/ws` → api. `read_only`. |
| `api`      | `server/`      | `8080→8080`                               | Fastify 5 + @fastify/websocket. `read_only` + `tmpfs:/tmp`. |
| `vision`   | `vision/`      | internal only (`8090`)                    | FastAPI + Ultralytics. Mounts `./vision/models:/app/extra-models:ro`. |
| `whatsapp` | `whatsapp/`    | internal only (`8091`)                    | Fastify + **@whiskeysockets/baileys** (no Chromium). Mounts `./data/whatsapp-auth`. |
| `coturn`   | image          | `3478/tcp+udp`, `49160-49200/udp`         | TURN fallback; empty by default for LAN. |

Network `remote-camera-ai`. Only `web`, `api`, `coturn` are exposed to the host.

## Commands

```bash
# LAN profile (macmini.local)
docker compose up --build

# Docker Desktop / localhost (Playwright + smoke)
docker compose --env-file .env.docker-desktop.example up -d --build

# Dev HTTPS certs (Android getUserMedia requires HTTPS)
./scripts/generate-dev-cert.sh <lan-ip> [hostname]

# E2E (Desktop profile must be up)
npm install && npm run test:e2e

# Per-service dev outside Docker
# server:   cd server && npm run dev / build
# web:      cd apps/web && npm run dev / build / lint
# vision:   cd vision && uvicorn app.main:app --host 0.0.0.0 --port 8090
# whatsapp: cd whatsapp && npm run dev
```

No unit tests. Only Playwright at `e2e/remote-camera.spec.mjs`. Don't claim "tests pass" without running `npm run test:e2e`.

## Repo layout

```
apps/web/       React 19 + Vite + TS + React Router 7
  src/App.tsx                ~2000 lines: HomePage / CameraPage / ViewerPage / AlertCard
  src/components/WhatsappCard.tsx
  src/hooks/{useWakeLock,useAlertSound,useWhatsappStatus}.ts
  src/lib/{api,whatsappApi,types}.ts
  nginx.conf                 proxies /api + /ws → api:8080; HTTPS on 8443
server/         Fastify 5 + @fastify/websocket
  src/index.ts               env schema, session store, REST, WS signaling, alert mint
  src/whatsapp.ts            WhatsApp proxy routes + dispatchAlert helper
  src/llm/                   Gemini / Claude / OpenAI / Together narration
vision/         FastAPI + Ultralytics
  app/main.py                ~1260 lines: full detection pipeline
  models/                    optional sam3.pt drop-in
whatsapp/       Baileys sidecar — Node-slim, no Chromium
  src/{index,client,config,rateLimit,types}.ts
e2e/            Playwright spec + Y4M fake-video generator
data/           sessions.json · snapshots/ · archive/ · whatsapp-auth/
.env.example    sanitized reference (tracked); .env and *.example are local-only (gitignored)
```

## Environment

- `.env.example` — sanitized reference, **committed**. Copy to `.env` and fill real values.
- `.env` and `.env.docker-desktop.example` — gitignored, local-only.

Key variables:
- `PUBLIC_WEB_URL` / `PUBLIC_API_URL` / `WEB_ORIGIN` — must match how clients reach the stack; CORS allowlist = `[WEB_ORIGIN, PUBLIC_WEB_URL]`.
- `ICE_STUN_URLS` / `ICE_TURN_URLS` — empty TURN is fine on LAN.
- `VISION_*` — 25+ knobs; defaults live in both `docker-compose.yml` and `vision/app/main.py`.
- `LLM_PROVIDER` / `LLM_MODEL` / `<PROVIDER>_API_KEY` — populate only the key matching the provider.
- `WHATSAPP_ENABLED` / `WHATSAPP_SERVICE_URL` / `WHATSAPP_COOLDOWN_MS` — no admin token; LAN-only QR onboarding.
- `VITE_API_BASE_URL` — **build-time** ARG; change requires `docker compose build web`, not just restart. Empty string falls back to `window.location.origin` (works behind the nginx proxy).

## Gotchas

1. **Tokens travel in URL query strings** (`/ws?token=…`, `GET /api/sessions/:id?token=…`, snapshots). Visible in logs/referrer/history. Not suitable for public deployment as-is.
2. **`POST /api/sessions` returns both camera + viewer tokens** in the response body — intentional for current homepage UX.
3. **HTTPS mandatory for `getUserMedia()` on Android**, not on localhost. LAN flow: load `http://<ip>:3000/local-ca.crt`, trust it on Android, then use `https://<ip>`.
4. **Containers are `read_only` + `tmpfs:/tmp`** (web, api, vision). Writes outside `/tmp` or mounted volumes fail silently.
5. **`sam3.pt` is optional.** Drop at `vision/models/sam3.pt`; pipeline auto-detects. Without it, YOLOE-26x is the strongest verifier.
6. **`VISION_TARGET_LABEL` accepts German aliases** (`Vogel` → `bird`, etc.); mapping in `apps/web/src/App.tsx` + `vision/app/main.py`.
7. **`data/whatsapp-auth/` is authoritative WhatsApp state.** `POST /api/whatsapp/logout` wipes the Baileys subdir; deleting the whole folder forces a fresh pair.
8. **Baileys needs the current WA protocol version at startup** via `fetchLatestBaileysVersion()`; the library's bundled baseline ages and gets rejected with `code 405 Connection Failure` if not refreshed. Handled in `whatsapp/src/client.ts`.
9. **Fastify 5 rejects empty body + `content-type: application/json`** with `FST_ERR_CTP_EMPTY_JSON_BODY`. Any proxy helper must only set the header when a body is actually present. Bit us in `server/src/whatsapp.ts` on `/logout`.
10. **Shared Docker daemon.** Other stacks (`svai-cms-*`, etc.) run on this host — avoid global `docker compose down` without scoping.

## Signaling & REST

- `GET /api/health` — liveness.
- `GET /api/config` — ICE servers, default target/confidence/motion, vision flags.
- `POST /api/sessions` — `{ sessionId, cameraUrl, viewerUrl, cameraToken, viewerToken }`.
- `GET /api/sessions/:id?token=…` — state + fresh links.
- `POST /api/sessions/:id/detect` (multipart, `x-session-token`) — forwards to `vision:/analyze`, broadcasts detection + minted alert.
- `GET /api/sessions/:id/snapshots/:file?token=…` — saved snapshot.
- `GET /ws?sessionId=…&role=camera|viewer&token=…` — signaling. Types: `session-state`, `peer-ready`, `offer`, `answer`, `candidate`, `detection`, `alert`, `error`.
- `GET|POST /api/whatsapp/{status,config,logout,test}` — proxy to sidecar.

Vision (`http://vision:8090`, internal): `GET /health`, `GET /runtime`, `POST /analyze` (multipart).

WhatsApp sidecar (`http://whatsapp:8091`, internal): `GET /health`, `GET /status`, `GET /debug/probe`, `POST /config|/logout|/send`.
