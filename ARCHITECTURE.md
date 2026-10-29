# Synkro Architecture

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
Secrets: in production read from AWS Secrets Manager (`prod/synkro/backend-secrets`); otherwise env vars.
DB: single pool from `DATABASE_URL`; schema created at boot by `initDbSchema()` (`packages/agent/src/models/db.ts`). Tables: users, sessions, rotated_refresh_tokens, rate_limits, usage_records, system_config, chat_threads, chat_messages, chat_runs, build_jobs.
Row-level security on build_jobs and chat tables; isolation relies on `SET LOCAL ROLE api_user` (RLS is not FORCEd, so a superuser/owner connection bypasses it).

## 5. Cloud Build
**Endpoints** (`apps/server/src/build-router.ts`, all require login):
- `POST /api/build/upload` (zip ≤ 50 MB, 10 jobs/day/user) → 202 `{jobId}`
- `GET /history`, `GET /:jobId`, `GET /:jobId/stream` (SSE logs)
- `GET /:jobId/download` → streams `ARTIFACT_DIR/<userId>/<jobId>.apk`
- `POST /:jobId/cancel`

**Statuses:** queued → running → success | failed | cancelled.

**Worker** (`models/build-worker.ts`, runs inside the API process): polls every 3 s, claims one queued job with `FOR UPDATE SKIP LOCKED`, extracts zip to `/tmp/builds`, runs the sandbox, checks for cancel every 5 s, extracts the APK, stores it (local disk by default; MinIO if configured). A reconciler fails jobs stuck `running` > 25 min; a reaper removes exited `build_sandbox_*` containers.

**Sandbox** (`models/docker-sandbox.ts`): image per framework (flutter `synkro/flutter-sandbox:2`, RN pinned image); `--memory=5g --cpus=2 --pids-limit=384`, disk 15G/5G, `--cap-drop=ALL`, no-new-privileges, user 1000, 15 min timeout, restricted network `build0` with DNS allowlist (pub.dev, npm, Maven, Gradle, Google, GitHub) set up by `network-setup.ts` (needs root, iptables, ipset, dnsmasq). Artifact extraction uses lstat checks and a 250 MB cap.

**Production today:** one DigitalOcean droplet, PM2 process `synkro-server`, artifacts in `/var/lib/synkro/artifacts`.

## 6. Tests & CI
- Agent suite: `pnpm --filter @peep/agent test` (custom runner, ~55 suites). With no Postgres, 12 DB suites are skipped but reported as passed.
- Desktop tests exist but have no `test` script; root `scripts/*.ts` are manual.
- CI (`.github/workflows/production-pipeline.yml`): audit, typecheck, build, `pnpm -r test`; deploy jobs are placeholders. pnpm caching order looks wrong **(unverified)**.

## 7. Known risks (tracked on Trello)
- Session tokens are logged in several places (desktop, gateway, server).
- Electron accepts any TLS certificate (`certificate-error` handler) and `.npmrc` has `strict-ssl=false`.
- Worker with root-level network setup runs in the same process as the public API.
- `/upload` writes to `/tmp/builds` without creating it; `framework`/`target` not validated; uploaded zips and old APKs are never deleted.
- Download/stream links carry the session token in the query string.
- Server Dockerfile may not build/start as written (packages lack `build` scripts) **(unverified)**.
- Rate limiter and budget mutex are per-process.
- Docs: README is stale; repo root has many leftover files.
