# Synkro Production Backup, Sentry & Monitoring Runbook

This operational runbook defines procedures for setting up off-site database backups, Sentry crash reporting, uptime monitoring, and disaster recovery drills for Synkro production infrastructure.

---

## 1. Off-site database backups

### 1.1 What it does
`scripts/synkro-backup-offsite.sh` runs daily at 03:00 UTC (`infra/systemd/synkro-backup.timer`).

1. **Dump and encrypt in one stream.** `pg_dump -Fc` of the production database is piped into `age -r <public key>`. The plaintext dump never touches the disk.
2. **Upload.** The `.dump.age` file goes to `db/` in an S3-compatible bucket (Backblaze B2), using `curl --aws-sigv4` and a **write-only** application key. The key is passed on stdin, so it never appears in `ps` or in the journal.
3. **Local copies.** It keeps the newest 3 encrypted files in `/var/backups/synkro` for a fast restore.
4. **Alerts.** A failure posts to `ALERT_WEBHOOK_URL`. Success pings `BACKUP_HEARTBEAT_URL`, so a backup that stops running is noticed too.

**What is in the backup:** the database only (users, projects, build jobs, signing_keys, ...).

**What is not in it:**
- the server's `.env`: `SYNKRO_SIGNING_ENC_KEY`, `DATABASE_URL` and API keys;
- build artifacts (APKs can be built again).

**Why the key choices matter:**
- **Only the public key is on the server**, and it can only encrypt. The private key is in the owner's password manager, used only for a restore.
- **`signing_keys` rows are already encrypted with `SYNKRO_SIGNING_ENC_KEY`.** So that key must also be in the password manager: without it, restored signing keys cannot be used.
- **The upload key can only add files.** It cannot list, read or delete them.
- **Retention is a lifecycle rule on the bucket, not the script.** Object Lock keeps every file for 30 days even if a key leaks.

### 1.2 One-time setup: Backblaze B2 (the owner's account)
1. **Bucket**:
   - name `atomvs-db-backups-<random>`, **Private**;
   - **Default Encryption: enabled (SSE-B2)**;
   - **Object Lock: enabled.** Object Lock can only be turned on when the bucket is created.
2. **Object Lock default retention**: **Governance, 30 days**.
3. **Lifecycle rule** (custom), for files prefixed `db/`: hide after **35** days, delete **1** day after hiding. That keeps about 35 daily backups.
4. **Application key** for the server:
   - name `synkro-server-backup-upload`;
   - bucket: only this one;
   - type of access: **Write Only**;
   - file name prefix: `db/`.

   Note the keyID and the applicationKey (shown once), and the bucket's **S3 endpoint** (e.g. `s3.eu-central-003.backblazeb2.com`, region `eu-central-003`).
5. **No read key on the server.** For a restore, download the file from the B2 web UI.

### 1.3 One-time setup: the age key pair (on the owner's computer, never on the server)
```bash
# Docker (or install age: winget install FiloSottile.age)
docker run --rm alpine:3.20 sh -c "apk add --no-cache age >/dev/null && age-keygen"
```
- **Save the whole output in the password manager.** It is the private key (`AGE-SECRET-KEY-1...`) plus a `# public key: age1...` line. Losing it means the backups cannot be read.
- **Only the `age1...` public key goes to the server.**

### 1.4 Install on the server
```bash
sudo apt-get update && sudo apt-get install -y age curl postgresql-client
# pg_dump must be the server's Postgres major version or newer:
pg_dump --version; sudo -u postgres psql -tAc 'show server_version'

sudo install -m 0755 /opt/synkro/scripts/synkro-backup-offsite.sh /usr/local/bin/synkro-backup-offsite.sh
sudo install -d -m 0700 -o synkro -g synkro /var/backups/synkro
sudo install -d -m 0750 -o root -g synkro /etc/synkro
sudo install -m 0640 -o root -g synkro /dev/null /etc/synkro/backup.env
sudo nano /etc/synkro/backup.env     # the settings below (typed in the editor, not in the shell history)
sudo cp /opt/synkro/infra/systemd/synkro-backup.service /opt/synkro/infra/systemd/synkro-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now synkro-backup.timer

# First backup now (in the background), and its log:
sudo systemctl start --no-block synkro-backup.service
journalctl -u synkro-backup.service -f      # Ctrl-C when it says "done"
systemctl list-timers synkro-backup.timer
```

`/etc/synkro/backup.env`:
```bash
BACKUP_AGE_RECIPIENT=age1...                         # the public key only
BACKUP_S3_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
BACKUP_S3_REGION=eu-central-003
BACKUP_S3_BUCKET=atomvs-db-backups-<random>
BACKUP_S3_KEY_ID=<keyID of the write-only key>
BACKUP_S3_SECRET=<applicationKey of the write-only key>
ALERT_WEBHOOK_URL=                                   # optional: Discord/Slack webhook
BACKUP_HEARTBEAT_URL=                                # optional: e.g. a healthchecks.io check (period 1 day, grace 2 h)
```

### 1.5 Updating the script later
```bash
sudo install -m 0755 /opt/synkro/scripts/synkro-backup-offsite.sh /usr/local/bin/synkro-backup-offsite.sh
```

---

## 2. Restore test (monthly, and before trusting the backups)
On the owner's computer (Windows Git Bash, macOS or Linux), with Docker. The private key never goes to the server.

1. **Download the newest file** from the B2 web UI: bucket, then `db/`, then the newest `synkro_db_<date>.dump.age`.
2. **Run the test** from the repository:
   ```bash
   scripts/synkro-backup-restore-test.sh ~/Downloads/synkro_db_<date>.dump.age
   # Paste the private key (AGE-SECRET-KEY-1...), then Enter and Ctrl-D.
   ```
   It decrypts the file in a throwaway `postgres:17-alpine` container and restores it into a temporary database (stopping at the first error). It prints the rows of every table, then drops the database and removes the container.
3. **Check the counts** against production. They should be close, given the backup's age:
   ```bash
   sudo -u postgres psql -d peep -c "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY 1;"
   ```
4. **Delete the downloaded file.**

A real restore uses the same steps: `age -d` and then `pg_restore` into the production database, after stopping the API. Keep `SYNKRO_SIGNING_ENC_KEY` from the password manager in the new `.env`.

---

## 3. Production Healthcheck & Uptime Monitoring

### 3.1 Endpoint Specification: `GET /health`
The `/health` endpoint in [`apps/server/src/index.ts`](../apps/server/src/index.ts) is a deep healthcheck that queries the PostgreSQL database (`SELECT 1`).

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
