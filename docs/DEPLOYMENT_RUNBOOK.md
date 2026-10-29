# Synkro Production Deployment & Rollback Runbook

This runbook defines the exact operational procedures for deploying, verifying, and rolling back the Synkro API Server (`@peep/server`) and Cloud Build Worker in production.

---

## 1. Prerequisites & Environment Verification

### Required Environment Variables (`/opt/synkro/.env`)
Ensure the following variables are present in `/opt/synkro/.env` with `chmod 0600` permissions owned by `synkro:synkro`:

| Variable | Description | Example / Value |
|---|---|---|
| `PORT` | Local listen port for Express | `8080` |
| `NODE_ENV` | Production mode | `production` |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://synkro:<password>@127.0.0.1:5432/peep` |
| `GOOGLE_API_KEY` | Gemini provider API key | `AIzaSy...` |
| `OPENAI_API_KEY` | OpenAI provider API key | `sk-proj-...` |
| `ANTHROPIC_API_KEY` | Anthropic provider API key | `sk-ant-...` |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | Billing webhook HMAC secret | `whsec_...` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | `whsec_...` |
| `ARTIFACT_DIR` | Local artifact storage directory | `/var/lib/synkro/artifacts` |

---

## 2. Pre-Deployment Database Backup & Check

Before pulling new code or restarting services, execute a full binary database dump:

```bash
# 1. Record current live Git commit SHA
PREV_SHA=$(git -C /opt/synkro rev-parse --short HEAD)
BACKUP_FILE="/var/backups/synkro/pre-deploy-${PREV_SHA}-$(date +%Y%m%d_%H%M%S).dump"

# 2. Run pg_dump using the custom archive format (-Fc)
pg_dump "$DATABASE_URL" -Fc -f "$BACKUP_FILE"

# 3. Verify backup file exists and has non-zero size
if [ ! -s "$BACKUP_FILE" ]; then
  echo "[-] ERROR: Database backup failed or empty! Aborting deployment." >&2
  exit 1
fi

echo "[+] Backup successfully verified: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
```

---

## 3. Standard Zero-Downtime Deployment Procedure

Synkro packages (such as `@peep/agent`) export TypeScript directly without bundling to CJS/ESM. Therefore, the production server runs via `tsx` under PM2 cluster/fork mode. Type-checking is performed upfront via `pnpm typecheck` before process reload.

### Sandbox Images
The Cloud Build worker uses two pre-warmed, unprivileged Docker sandboxes:
- `synkro/flutter-sandbox:2` (`infra/docker/Dockerfile.flutter-sandbox`): Pre-warmed Flutter SDK environment.
- `synkro/rn-sandbox:1` (`infra/docker/Dockerfile.rn-sandbox`): Pre-warmed React Native / Expo environment with Gradle 8.8 & 8.6 distribution wrappers and Expo SDK 51 & React Native 0.74 npm packages cached to `/tmp/.npm-cache`.

Execute deployment as the `synkro` service user:

```bash
sudo -u synkro bash -lc '
  set -euo pipefail
  cd /opt/synkro

  # 1. Fetch latest changes
  git fetch origin main
  git checkout main
  git pull --ff-only origin main

  # 2. Install dependencies with lockfile consistency
  pnpm install --frozen-lockfile

  # 3. Validate entire monorepo TypeScript definitions
  pnpm typecheck

  # 4. Pre-build / update Cloud Build sandbox Docker images
  docker build -t synkro/flutter-sandbox:2 -f infra/docker/Dockerfile.flutter-sandbox infra/docker
  docker build -t synkro/rn-sandbox:1 -f infra/docker/Dockerfile.rn-sandbox infra/docker

  # 5. Gracefully reload or launch PM2 process with updated environment
  pm2 reload synkro-server --update-env || pm2 start npx --name synkro-server -- tsx apps/server/src/index.ts

  # 6. Save PM2 process list for auto-boot on server restart
  pm2 save
'
```

---

## 4. Post-Deployment Smoke Verification

Run these automated checks immediately following PM2 reload:

### 1. Health & Server Version Header
```bash
curl -i https://api.synkro.com/health
# Expected: HTTP/2 200 OK
# Header: X-Synkro-Server-Version matching `git rev-parse --short HEAD`
# Body: {"status":"ok"}
```

### 2. User Authentication
```bash
AUTH_RES=$(curl -s -X POST https://api.synkro.com/v1/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"test-admin@synkro.com","password":"<secure-password>"}')

TOKEN=$(echo "$AUTH_RES" | jq -r '.sessionToken')
test "$TOKEN" != "null" && test -n "$TOKEN"
echo "[+] Auth signin passed, token acquired."
```

### 3. Account Status & Usage Pool
```bash
curl -sf -H "Authorization: Bearer $TOKEN" https://api.synkro.com/v1/account/status | jq .
# Expected: { "tier": "...", "weeklyPoolUsd": ..., "weeklyUsedUsd": ... }
```

### 4. Billing Webhook Rejection (Unsigned)
```bash
STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST https://api.synkro.com/v1/billing/webhook)
test "$STATUS_CODE" -eq 401
echo "[+] Billing webhook signature validation passed (401 returned for unsigned request)."
```

### 5. Build History Endpoint
```bash
curl -sf -H "Authorization: Bearer $TOKEN" https://api.synkro.com/api/build/history | jq .
# Expected: 200 OK with JSON array
```

### 6. Application Logs Audit
```bash
pm2 logs synkro-server --lines 50 --nostream | grep "\[DATABASE_BOOT\] Database initialized successfully!"
echo "[+] Database boot confirmation verified in PM2 logs."
```

### 7. Cloud Build Sandbox Docker Images
```bash
docker image inspect synkro/flutter-sandbox:2 >/dev/null && echo "[+] Flutter sandbox image verified."
docker image inspect synkro/rn-sandbox:1 >/dev/null && echo "[+] React Native sandbox image verified."
```

---

## 5. Emergency Incident Responses

### 5.1 Global AI Kill Switch (<10 Seconds)
In case of runaway provider costs, malicious abuse, or API provider outages, activate the system-wide kill switch to instantly block all outbound LLM traffic with `503 SERVICE_UNAVAILABLE`:

```bash
# Enable Kill Switch
psql "$DATABASE_URL" -c "UPDATE system_config SET value = '{\"is_active\": true}' WHERE key = 'global_kill_switch';"

# Disable Kill Switch (Restore normal traffic)
psql "$DATABASE_URL" -c "UPDATE system_config SET value = '{\"is_active\": false}' WHERE key = 'global_kill_switch';"
```

### 5.2 Fast Rollback (<60 Seconds)
If smoke checks fail or severe regressions occur:

```bash
sudo -u synkro bash -lc "
  set -euo pipefail
  cd /opt/synkro
  
  echo '[!] Initiating emergency rollback to commit $PREV_SHA...'
  git checkout \"$PREV_SHA\"
  pnpm install --frozen-lockfile
  pm2 reload synkro-server --update-env
  
  echo '[+] Rollback completed. Current commit:'
  git rev-parse --short HEAD
"
```

### 5.3 Database Restore (Disaster Recovery Only)
If a destructive migration occurred and database rollback is mandatory:

```bash
# Drop current schema connections and restore from pre-deploy dump
pg_restore -d "$DATABASE_URL" --clean --if-exists "$BACKUP_FILE"
```
