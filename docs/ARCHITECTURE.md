# Atomvs Architecture

> Written from a read-only code pass (commit 26d100a). Items marked **(unverified)** were inferred from code, not run. Update this file when behavior changes.

## 1. Big picture
Desktop app (Electron) → HTTPS → Backend (Express + PostgreSQL) → AI providers (Gemini / OpenAI / Anthropic).
Cloud Build: desktop uploads project zip → backend queues job → worker runs it in a locked-down Docker container → APK saved on server disk → user downloads with login.

## 2. Chat message flow
1. **Renderer**: `ChatPane.tsx` calls `window.peep.sendAgentMessage(...)`. Streamed events are handled in `hooks/usePeepEvents.ts`; state in `stores/chat-store.ts`.
2. **Preload** (`apps/desktop/src/preload/index.ts`): exposes `window.peep`, wraps `ipcRenderer.invoke('agent:send')`. Channel names: `IPC_CHANNELS` / `IPC_EVENTS` in `packages/shared/src/index.ts`.
3. **Main IPC** (`main/ipc/index.ts`): `AGENT_SEND` → `agentService.send()`. A guard rejects string args containing `..`.
4. **Agent service** (`main/services/agent-service.ts`): builds project context, defines tool executor, chooses gateway, runs `runAgentLoop` (`packages/agent/src/orchestrator.ts`, max 50 iterations, retries with backoff).
5. **Client gateway**: `ProductionAIGateway` (`packages/agent/src/models/production-gateway.ts`) POSTs to `/v1/ai/stream` with `Bearer <sessionToken>`, auto-refreshes on 401.
6. **Server**: `apps/server/src/index.ts` → `BackendAIGateway.handleRequest` (`models/backend-gateway.ts`): kill-switch check → auth → budget guard → model router → provider adapter (with failover) → usage record.
7. Results stream back as SSE, then IPC events (`AGENT_STREAM`, `AGENT_TIMELINE`, `AGENT_PHASE_CHANGED`, `AGENT_PROPOSED_EDITS`).

Gateway selection in agent-service: `SYNKRO_USE_MOCK_GATEWAY` → mock; session token → production gateway; otherwise (non-prod) local Gemini with a key.

## 3. Agent core
- Tools (`tools/definitions.ts`): read/list/search files, propose_file_edit, patch_file, run_command, delete_file, rename_file, plan/memory/verification tools, project build/test/start/stop tools.
- Path confinement: `AgentService.resolvePath`. File edits are proposals the user accepts/rejects (unless auto-apply). `delete_file` always asks.
- Commands: `tools/safety.ts` classifies commands (blocked / dangerous = ask user / safe by prefix; unknown = ask). **Separately** `terminal-service.ts` has its own allowlist (flutter, dart, a few git commands, basic shell) — the two disagree (e.g. npm/pnpm are "safe" in one, rejected in the other). Prefix matching also allows chaining like `ls; …`. **(unverified at runtime)**
- Budget guard (`models/budget-guard.ts`): per-request/day/month limits by plan, computed from `usage_records`. Uses an in-process mutex → not safe across multiple server instances.
- Model tiers (`server-router.ts`): fast / reasoning / premium; premium needs a non-free plan.
- Auth (`models/auth.ts`, `auth-router.ts`): scrypt passwords, 24h sessions, rotating refresh tokens (reuse revokes all sessions), per-email throttling.

## 4. Backend
Routes: `/health`, `/api/build/*`, `/v1/threads/*`, `/v1/auth/{signup,signin,refresh,logout}`, `/v1/account/status`, `/v1/ai/{generate,stream}`.
Middleware: global IP limit 120/min; `/v1/ai/*` limit 60/min (in-memory); no CORS/helmet config; `express.json` 50 MB.
Secrets: env vars (`.env`); AWS Secrets Manager (`prod/synkro/backend-secrets`) only with `SYNKRO_SECRETS_SOURCE=aws`.
DB: single pool from `DATABASE_URL`; schema created at boot by `initDbSchema()` (`packages/agent/src/models/db.ts`). Tables: users, sessions, rotated_refresh_tokens, rate_limits, usage_records, system_config, chat_threads, chat_messages, chat_runs, build_jobs.
Row-level security on build_jobs and chat tables; isolation relies on `SET LOCAL ROLE api_user` (RLS is not FORCEd, so a superuser/owner connection bypasses it).

## 5. Cloud Build
**Endpoints** (`apps/server/src/build-router.ts`, all require login):
- `POST /api/build/upload` (zip ≤ 50 MB, 10 jobs/day/user) → 202 `{jobId}`
- `GET /history`, `GET /:jobId`, `GET /:jobId/stream` (SSE logs)
- `GET /:jobId/download` → streams `ARTIFACT_DIR/<userId>/<jobId>.apk`
- `POST /:jobId/cancel`

**Statuses:** queued → running → success | failed | cancelled.

**Worker** (`models/build-worker.ts`, runs inside the API process): polls every 3 s, claims one queued job with `FOR UPDATE SKIP LOCKED`, extracts zip to `/tmp/builds`, gets the project's signing key, runs the sandbox, checks for cancel every 5 s, extracts the APK, verifies its signature, stores it (local disk by default; MinIO if configured). A reconciler fails jobs stuck `running` longer than the longest sandbox timeout + 5 min (40 min); a reaper removes sandbox containers of finished jobs, and any older than that.

**Sandbox** (`models/docker-sandbox.ts`): image per framework (`synkro/flutter-sandbox:2`, `synkro/rn-sandbox:1`, built from `infra/docker`); `--memory=5g --cpus=2 --pids-limit=384`, disk 15G/5G, `--cap-drop=ALL`, no-new-privileges, user 1000; timeout 15 min Flutter, 35 min React Native (temporary); APKs carry only arm64-v8a and armeabi-v7a (Gradle init script in `GRADLE_USER_HOME`); Flutter projects without `android/` get the package `com.atomvs.p<first 10 hex of the project ID>`. Expo projects without `android/` get `expo prebuild` first. Restricted network `build0`: dnsmasq forwards only allowlisted domains (npm, pub.dev, Maven, Gradle, Google, GitHub), everything else is NXDOMAIN, and iptables/ipset drop other traffic. Set up by root at boot (`synkro-build-network.service`, `scripts/setup-build-network.ts`); a non-root worker only verifies it. Artifact extraction uses lstat checks and a 250 MB cap.

**Release signing** (`models/signing-keys.ts`, `models/apk-verify.ts`): one upload key per (user, project), created on the project's first build (RSA 2048, PKCS#12, 30 years) and stored in `signing_keys`, encrypted with AES-256-GCM under `SYNKRO_SIGNING_ENC_KEY`. It reaches the build as `android.injected.signing.*` in `GRADLE_USER_HOME` (no secrets in args, env or logs); after the build apksigner must show the project's key, never the debug key. The desktop keeps the project ID in `.synkro/project.json`. Owners can download their keystore with `POST /api/build/signing/:projectId/keystore` (account password, 5 per hour).

**Production today:** `https://api.atomvs.com`, one DigitalOcean droplet built from `scripts/setup-production-server.sh` (Caddy with a Let's Encrypt certificate, PM2 process `synkro-server` as the `synkro` user, artifacts in `/var/lib/synkro/artifacts`); see `docs/LINUX_TEST_SESSION.md` and `docs/DEPLOYMENT_RUNBOOK.md`. The desktop's default gateway is this URL (`DEFAULT_GATEWAY_URL`, `GatewayResolver.PRODUCTION_DEFAULT`); a `gatewayUrl` in the user's settings still overrides it. The previous droplet was deleted on Oct 20, 2026, with its database.

## 6. Tests & CI
- Agent suite: `pnpm --filter @peep/agent test` (custom runner, ~63 suites). With no Postgres, the DB suites are reported as skipped (CI fails instead). Cloud Build tests that need the real firewall skip themselves off Linux.
- Desktop tests exist but have no `test` script; root `scripts/*.ts` are manual.
- CI (`.github/workflows/production-pipeline.yml`): audit, typecheck, build, `pnpm -r test`; deploy jobs are placeholders. pnpm caching order looks wrong **(unverified)**.

## 7. Known risks (tracked on Trello)
- Sandbox egress is filtered by IP, not hostname: allowlisted names share CDN IPs (Cloudflare), so a build can reach other hosts on those IPs with `curl --resolve`. DNS still blocks the names. Fix: SNI proxy (post-beta).
- The build worker runs in the same process as the public API, as a user in the `docker` group (root-equivalent).
- Download/stream links carry the session token in the query string.
- Server Dockerfile may not build/start as written (packages lack `build` scripts) **(unverified)**.
- Rate limiter and budget mutex are per-process.
- Docs: README is stale.
