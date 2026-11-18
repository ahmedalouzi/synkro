# Synkro — Launch Roadmap

Status: ⬜ todo · 🔄 in progress · ✅ done · ⏸ waiting on a decision/account

## Phase 1 — Blockers (code)

| # | Task | Status |
|---|------|--------|
| 0 | Dev auth bypass removed entirely (login button, desktop sign-in shortcut, server dev provider; it also skipped usage limits and the kill switch for every user when the server ran outside `NODE_ENV=production`) | ✅ |
| 1 | Rebrand Peep → Synkro (appId, productName, window titles, dialogs; userData migrated on first launch). GitHub repo renamed to `synkro` (old `peep` URL redirects) | ✅ |
| 2 | Hide all dev-only UI (bypass badges, dev buttons) in packaged builds | ✅ |
| 3 | Tab-completion cost control in the app: debounce, cache, reuse of typed-through suggestions, 1 req/s, error backoff, smaller prompt (quotas are server-side, item 4) | ✅ |

## Found in the full audit (2026-10-26)

| # | Task | Status |
|---|------|--------|
| A1 | Installed builds don't read `.env`: `SYNKRO_GATEWAY_URL` falls back to the hard-coded `https://api.synkro.com` (10 places) and `SENTRY_DSN` is empty. Now one resolver (`src/main/build-config.ts`) with values baked in by `electron-vite build` from `SYNKRO_GATEWAY_URL` / `SENTRY_DSN` (CI env or `apps/desktop/.env.production`). **Pending:** the final server URL (B1) and a test on an installed build | 🔄 |
| A2 | 102 changed files not committed since 2026-10-23 — commit in logical steps | ⬜ |
| A3 | Repo root clutter: old reports, test scripts, `pgsql.zip`, `old_*.tsx`, Arabic plan docs — moved reports and plans to `docs/archive`, deleted scratch scripts, generated test workspaces ignored | ✅ |
| A4 | Real cloud build: the app uses MockBuildApi (`VITE_USE_REAL_BUILD_API` not set) | ⬜ |
| A5 | 3 test suites need the `peep` database / running server (build-api-isolation, p314-e2e, streaming-usage) | ⬜ |
| A6 | Upgrade/account/billing/docs links go through `config/web.ts` (`VITE_SYNKRO_WEB_URL`); the website must serve `/pricing`, `/account`, `/account/billing`, `/docs` | ✅ (app side) |

## UI/UX

| # | Task | Status |
|---|------|--------|
| U1 | Settings as a full Cursor-style page: account, search, sections (General, Plan & Usage, Editor, Tab, Rules, Mobile SDKs, Privacy, Beta, About); every control wired to a real command/IPC | ✅ |
| U2 | Chat pane like Cursor: chat tabs + history, inline agent steps, edit cards with diff preview, Undo/Keep/Review bar, rounded composer with model menu, image attach, stop button. Fixed: merged words while streaming, untitled chats, switching to unsaved chats | ✅ |
| U3 | Cursor-style single top bar (frameless window, native window buttons, menus, nav, search, layout, account) on home and workspace; Cursor-style start page; recent projects load on start; userData migration recovers projects if the folder move failed | ✅ |

## Phase 2 — Server & AI

| # | Task | Status |
|---|------|--------|
| 4 | Server usage limits, Cursor-style: weekly $ pool per plan, Pro falls back to the fast model, Tab unlimited on Pro / 2000 per month on Free, per-minute burst limits, real token cost recorded, per-user request lock removed (`packages/agent/src/models/usage-limits.ts`) | ✅ |
| 5 | Valid AI provider key on the server | ⏸ |
| 6 | Deploy server + create production database | ⬜ |

## Phase 3 — Distribution

| # | Task | Status |
|---|------|--------|
| 7 | Windows code-signing certificate | ⏸ |
| 8 | Apple Developer account + notarization | ⏸ |
| 9 | Auto-update end-to-end test (GitHub releases) | ⬜ |
| 10 | Clean-machine install test (no Node / dev tools) | ⬜ |

## Phase 4 — Business

| # | Task | Status |
|---|------|--------|
| 11 | Payments (Stripe / Lemon Squeezy) + plans + real Upgrade URL | ⏸ |
| 12 | Privacy policy & terms of service | ⬜ |
| 13 | Landing / download page (`website/`) | ⬜ |
| 14 | Crash reporting (Sentry DSN configured in production) | ⬜ |

## After launch

- MCP support inside Synkro
- @Web / @Docs context
- Semantic codebase indexing
- Full remote workspace over SSH (today: SSH opens a terminal session)
- Voice input
