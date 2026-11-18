# Synkro Production Backup, Sentry & Monitoring Runbook

This operational runbook defines procedures for setting up off-site database backups, Sentry crash reporting, uptime monitoring, and disaster recovery drills for Synkro production infrastructure.

---

## 1. Automated Off-Site Backups (AWS S3 / Cloudflare R2 / Backblaze B2)

### 1.1 Overview
The backup utility [`scripts/synkro-backup-offsite.sh`](file:///d:/peep/scripts/synkro-backup-offsite.sh) executes daily at **03:00 UTC** via systemd timers:
1. Performs `pg_dump -Fc` (compressed PostgreSQL binary dump).
2. Encrypts the dump with AES-256-CBC (`pbkdf2`) using `$BACKUP_ENCRYPTION_KEY` or `$SYNKRO_SIGNING_ENC_KEY`.
3. Streams the encrypted file to your remote S3 bucket (`s3://${BACKUP_S3_BUCKET}/db/`).
4. Prunes local and remote backups older than 14 days.
5. Emits an instant webhook notification (Discord/Slack) if any failure occurs.

### 1.2 Installation on the Production Server

```bash
# 1. Install AWS CLI (if not already installed)
sudo apt-get update && sudo apt-get install -y awscli jq

# 2. Copy the backup script and set permissions
sudo cp /opt/synkro/scripts/synkro-backup-offsite.sh /usr/local/bin/synkro-backup-offsite.sh
sudo chmod 0755 /usr/local/bin/synkro-backup-offsite.sh

# 3. Install and enable systemd service and timer
sudo cp /opt/synkro/infra/systemd/synkro-backup.service /etc/systemd/system/
sudo cp /opt/synkro/infra/systemd/synkro-backup.timer /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now synkro-backup.timer

# 4. Verify timer status
systemctl list-timers synkro-backup.timer
```

### 1.3 Required Environment Variables (`/opt/synkro/.env`)
Add the following variables to `/opt/synkro/.env` (`chmod 0600 synkro:synkro`):

```bash
# S3 Bucket Name
BACKUP_S3_BUCKET="synkro-production-backups"

# For Cloudflare R2 or MinIO (leave unset for standard AWS S3)
# S3_ENDPOINT_URL="https://<account_id>.r2.cloudflarestorage.com"

# AWS / R2 Credentials (or configure via `aws configure --profile synkro`)
AWS_ACCESS_KEY_ID="<your-access-key-id>"
AWS_SECRET_ACCESS_KEY="<your-secret-access-key>"
AWS_DEFAULT_REGION="auto" # or us-east-1 / eu-central-1

# Optional Discord/Slack webhook for failure notifications
ALERT_WEBHOOK_URL="https://discord.com/api/webhooks/..."

# Retention period (defaults to 14 days)
RETENTION_DAYS="14"
```

---

## 2. Disaster Recovery & Restoration Drill

To test recovery or restore after an incident:

### Step 1: Download the Target Backup
```bash
# List available backups
aws s3 ls s3://synkro-production-backups/db/

# Download the latest encrypted backup
aws s3 cp s3://synkro-production-backups/db/synkro_db_20261104_030000Z.dump.enc /tmp/restore_target.dump.enc
```

### Step 2: Decrypt the Backup
```bash
# Decrypt using the encryption key from /opt/synkro/.env
openssl enc -d -aes-256-cbc -pbkdf2 \
  -in /tmp/restore_target.dump.enc \
  -out /tmp/restore_target.dump \
  -k "$BACKUP_ENCRYPTION_KEY"
```

### Step 3: Restore into Throwaway Database for Verification
```bash
# Create temporary verification database
createdb -U postgres synkro_verify_restore

# Restore dump into verification database
pg_restore -U postgres -d synkro_verify_restore /tmp/restore_target.dump

# Verify critical tables and row counts
psql -U postgres -d synkro_verify_restore -c "SELECT COUNT(*) AS user_count FROM users;"
psql -U postgres -d synkro_verify_restore -c "SELECT COUNT(*) AS key_count FROM signing_keys;"
psql -U postgres -d synkro_verify_restore -c "SELECT COUNT(*) AS job_count FROM build_jobs;"

# Cleanup verification database & temp files
dropdb -U postgres synkro_verify_restore
rm -f /tmp/restore_target.dump /tmp/restore_target.dump.enc
echo "[+] Disaster recovery drill verified successfully!"
```

---

## 3. Production Healthcheck & Uptime Monitoring

### 3.1 Endpoint Specification: `GET /health`
The `/health` endpoint in [`apps/server/src/index.ts`](file:///d:/peep/apps/server/src/index.ts) is a deep healthcheck that queries the PostgreSQL database (`SELECT 1`).

- **HTTP 200 OK (Healthy):**
  ```json
  {
    "status": "ok",
    "db": "healthy",
    "latencyMs": 4,
    "version": "2a84bcf",
    "uptimeSec": 43200
  }
  ```
- **HTTP 503 Service Unavailable (Database Connection Failure):**
  ```json
  {
    "status": "error",
    "db": "unhealthy",
    "error": "connection to server at '127.0.0.1' failed: Connection refused",
    "version": "2a84bcf",
    "uptimeSec": 43200
  }
  ```

### 3.2 Uptime Monitor Configuration (BetterStack / UptimeRobot)
1. **Monitor URL:** `https://api.atomvs.com/health` (or `https://api.synkro.dev/health`)
2. **Method:** `GET`
3. **Expected Status Code:** `200`
4. **Heartbeat Frequency:** Every 60 seconds (1 minute).
5. **Alert Escalation:**
   - Discord channel `#alerts-prod` or PagerDuty/SMS.
   - Triggers when 2 consecutive checks return non-200 or timeout (> 5000ms).

---

## 4. Sentry Crash Reporting Setup

### 4.1 Server-Side Sentry Configuration
In `/opt/synkro/.env`:
```env
SENTRY_DSN="https://<public_key>@o<org_id>.ingest.sentry.io/<project_id>"
```
- **Data Scrubbing:** Automatically scrubs Bearer tokens, session tokens, passwords, and file paths using `scrubString()` before events leave the machine.
- **Express Error Handling:** Unhandled exceptions in Express routes are captured with `Sentry.setupExpressErrorHandler(app)` before returning `500 Internal Server Error`.

### 4.2 Desktop Client Sentry Configuration
The desktop client bakes the DSN into the production build or reads it from environment:
- Set in GitHub Actions release workflow:
  ```yaml
  env:
    SENTRY_DSN: ${{ secrets.SENTRY_DESKTOP_DSN }}
  ```
- Users have opt-in control over crash analytics via Settings (`apps/desktop/src/renderer/src/main.tsx`).
