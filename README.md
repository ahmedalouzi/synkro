# Atomvs

**The AI-Native Desktop IDE for Flutter & React Native Developers.**

Atomvs accelerates mobile and web cross-platform engineering by pairing a high-performance desktop editor with deep AI-assisted development, live component preview, Claude Code IDE integration, and cloud-native Android/Web compilation.

---

## Key Features

- **Monaco-Powered Code Editor**: Native multi-file Monaco editor with Dart, TypeScript, JSX, YAML, and JSON syntax highlighting, IntelliSense, and quick file search (`Ctrl+P` / `Cmd+P`).
- **Multi-Model AI Gateway**: Unified streaming assistant supporting Google Gemini, Anthropic Claude, and OpenAI with automated failover, model tier routing (fast, reasoning, premium), and token budgeting.
- **Claude Code CLI Integration**: Integrated terminal bridge allowing direct command-line pairing with `claude-code` and framework toolchains.
- **Visual Design Intelligence & Preview**: Live hot-reload previews for Flutter Web and Expo/React Native canvas alongside automated design DNA inference and styling audits.
- **Containerized Cloud Build**: One-click remote cloud compilation producing release APKs and AABs inside hardened, ephemeral Docker sandboxes.
- **Row-Level Security & Tenant Isolation**: PostgreSQL RLS policies ensuring complete data isolation across build jobs, chat threads, and usage quotas.
- **Built-in Git & Terminal**: Integrated terminal powered by xterm.js and node-pty, Git staging, commit authoring, and side-by-side diff viewers.

---

## Monorepo Architecture

```
peep/
├── apps/
│   ├── desktop/            # Electron + React + Vite desktop application
│   └── server/             # Express + PostgreSQL production backend gateway
├── packages/
│   ├── agent/              # AI orchestrator, model adapters, DB schema & Cloud Build worker
│   ├── flutter-adapter/    # Flutter project detection, analyzer diagnostics & run pipeline
│   ├── platform-core/      # Framework adapter interface & lifecycle registry
│   └── shared/             # IPC protocols, AI contracts & shared TypeScript types
├── scripts/
│   └── setup-production-server.sh  # Zero-to-hero server provisioning script
└── docs/
    ├── DEPLOYMENT_RUNBOOK.md       # Production deploy, health check & rollback runbook
    ├── RELEASE_PACKAGING.md        # Desktop installer packaging & code signing guide
    └── FIRST_COHORT_GUIDE.md       # Cohort developer onboarding & data-handling guide
```

---

## Prerequisites

- **Node.js**: `v20.x` LTS or later
- **pnpm**: `v9.15.0` or later (`corepack enable && corepack prepare pnpm@9.15.0 --activate`)
- **PostgreSQL**: `15+` (for backend server and integration test suites)
- **Docker**: (Required for local Cloud Build sandbox execution)

---

## Quick Start

### 1. Install Dependencies
```bash
pnpm install
```

### 2. Run the Desktop App (Development Mode)
```bash
pnpm dev
```

### 3. Run the Backend API Server
```bash
cd apps/server
pnpm dev
```

### 4. Run Monorepo Verification
```bash
# Validate TypeScript across all packages and apps
pnpm typecheck

# Run test suites
pnpm test
```

### 5. Package Desktop Installers
```bash
# Package for Windows
pnpm --filter @peep/desktop build:win

# Package for macOS
pnpm --filter @peep/desktop build:mac
```

---

## Documentation

- [Deployment Runbook](docs/DEPLOYMENT_RUNBOOK.md)
- [Release Packaging Guide](docs/RELEASE_PACKAGING.md)
- [First-Cohort Guide & Data Handling](docs/FIRST_COHORT_GUIDE.md)

---

## License

Private and proprietary. Copyright © 2026 Atomvs All rights reserved.
