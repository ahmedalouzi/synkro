# CLAUDE.md — Synkro (repo name: peep)

Electron desktop AI coding agent for mobile developers (Flutter + React Native) with a Node/Express backend, PostgreSQL, and a Docker-sandbox "Cloud Build" that produces an APK.
Source of truth for tasks/decisions: the Trello board "Synkro — Source of Truth". Architecture: `docs/ARCHITECTURE.md`. Onboarding: `docs/ONBOARDING.md`.

Naming note: code scope is `@peep/*` ("Peep"), runtime/env/infra names are `SYNKRO_*` ("Synkro"). Both mean this product.

## Commands (pnpm >= 9, Node >= 20)
- `pnpm install`
- `pnpm dev` — desktop app (electron-vite)
- `pnpm typecheck` — all packages
- `pnpm build` — desktop + server
- `pnpm test` — runs only `@peep/agent` suite (custom runner, not jest/vitest)
- `pnpm test:env:up` / `test:env:down` — Postgres for tests (docker-compose.test.yml, db `peep_test`)
- `pnpm --filter @peep/server dev` — backend on :8080 (needs `DATABASE_URL`, `GOOGLE_API_KEY`)
- `pnpm --filter @peep/agent eval` — AI evals

Local dev backend: set `SYNKRO_DEV_AUTH_BYPASS=true` (token `dev_test_session`). NEVER set this in production.

## Layout
- `apps/desktop` — Electron (main / preload / renderer). IPC channel names + shared types live in `packages/shared/src/index.ts`.
- `apps/server` — Express entry (`index.ts`), `build-router.ts`, `threads-router.ts`, `rate-limiter.ts`, `secrets.ts`. Most backend logic is in `packages/agent` (imported as `@peep/agent/server`).
- `packages/agent` — orchestrator, tools, model gateways, auth, budget guard, build-worker, docker-sandbox, DB schema (`src/models/db.ts`), tests.
- `packages/shared`, `platform-core`, `flutter-adapter` — consumed as TypeScript source (no build step).
- `infra/docker` — sandbox Dockerfiles.

## Rules for AI agents working here
1. Show the diff and wait for approval before committing or pushing. Never push to `main` directly.
2. Never print or log session tokens, API keys or passwords. Mask as `***`. Do not add new token logging.
3. Do not weaken sandbox limits (memory/pids/disk/network allowlist) or RLS policies without a DECISION card.
4. Scope changes to the ticket. Don't refactor unrelated files or add dependencies unasked.
5. Run `pnpm typecheck` and `pnpm test` before saying a change is done; say plainly if you could not run them.
6. DB schema lives in `initDbSchema()` (idempotent `CREATE ... IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`). There is no migrations folder — keep changes backward compatible.
7. Build/job data access: API uses `SET LOCAL ROLE api_user` + `app.current_user_id`; the worker uses `worker_user`. Keep that pattern for new queries.
8. Update the Trello card (comment + move) when work changes state.

## Known traps (see Trello backlog)
- Tests that need Postgres are silently skipped (counted as passed) when the DB is unreachable. Start the test DB first.
- Two command-permission layers disagree (`packages/agent/src/tools/safety.ts` vs `apps/desktop/src/main/services/terminal-service.ts`).
- No ESLint/Prettier; match surrounding style.
- `.env.example` is broken (UTF-16, Sentry only).
- Dev auth bypass relies on `NODE_ENV !== 'production'`; make sure `NODE_ENV=production` is set on the server.
