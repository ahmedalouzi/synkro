#!/usr/bin/env bash
# ==============================================================================
# Synkro Off-Site Database Backup & Retention Script
# Target: Production Linux VPS (Ubuntu 22.04 / 24.04 LTS)
# Backs up PostgreSQL database, encrypts the dump, uploads to S3/R2, and prunes old dumps
# ==============================================================================

set -euo pipefail

# Configuration & Defaults
ENV_FILE="${ENV_FILE:-/opt/synkro/.env}"
if [ -f "$ENV_FILE" ]; then
  # Safely export environment variables from .env
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

DATABASE_URL="${DATABASE_URL:-}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/synkro}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-}"
S3_ENDPOINT_URL="${S3_ENDPOINT_URL:-}" # Optional for Cloudflare R2 / MinIO (e.g., https://<account_id>.r2.cloudflarestorage.com)
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}" # Discord / Slack webhook URL for failures
ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-${SYNKRO_SIGNING_ENC_KEY:-}}"

DATE_TAG="$(date -u +"%Y%m%d_%H%M%SZ")"
RAW_DUMP_FILE="${BACKUP_DIR}/synkro_db_${DATE_TAG}.dump"
FINAL_BACKUP_FILE="${RAW_DUMP_FILE}"

notify_failure() {
  local error_msg="$1"
  echo "[-] ERROR: ${error_msg}" >&2
  if [ -n "$ALERT_WEBHOOK_URL" ]; then
    local payload
    payload=$(jq -n --arg content "🚨 **[Synkro Backup Failure]** ${error_msg} on $(hostname) at ${DATE_TAG}" '{content: $content}')
    curl -s -m 10 -H "Content-Type: application/json" -d "$payload" "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 || true
  fi
}

trap 'notify_failure "Backup script crashed unexpectedly at line ${LINENO}"' ERR

# 1. Pre-flight validations
if [ -z "$DATABASE_URL" ]; then
  notify_failure "DATABASE_URL is not configured"
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

echo "[+] [${DATE_TAG}] Starting Synkro database backup..."

# 2. Database Dump via pg_dump (-Fc custom format)
echo "[+] Generating PostgreSQL binary dump with compression..."
if ! pg_dump "$DATABASE_URL" -Fc -f "$RAW_DUMP_FILE"; then
  notify_failure "pg_dump execution failed"
  rm -f "$RAW_DUMP_FILE"
  exit 1
fi

if [ ! -s "$RAW_DUMP_FILE" ]; then
  notify_failure "Dump file was created but is empty"
  rm -f "$RAW_DUMP_FILE"
  exit 1
fi

RAW_SIZE="$(du -h "$RAW_DUMP_FILE" | cut -f1)"
echo "[+] Raw database dump created: ${RAW_DUMP_FILE} (${RAW_SIZE})"

# 3. Optional AES-256 Symmetric Encryption
if [ -n "$ENCRYPTION_KEY" ]; then
  echo "[+] Encrypting dump file with AES-256-CBC..."
  ENC_DUMP_FILE="${RAW_DUMP_FILE}.enc"
  if openssl enc -aes-256-cbc -salt -pbkdf2 -in "$RAW_DUMP_FILE" -out "$ENC_DUMP_FILE" -k "$ENCRYPTION_KEY"; then
    rm -f "$RAW_DUMP_FILE"
    FINAL_BACKUP_FILE="$ENC_DUMP_FILE"
    echo "[+] Encryption complete: ${FINAL_BACKUP_FILE}"
  else
    notify_failure "OpenSSL encryption failed"
    rm -f "$RAW_DUMP_FILE" "$ENC_DUMP_FILE"
    exit 1
  fi
fi

chmod 0600 "$FINAL_BACKUP_FILE"
BACKUP_FILENAME="$(basename "$FINAL_BACKUP_FILE")"

# 4. Off-site Upload to S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2)
if [ -n "$BACKUP_S3_BUCKET" ]; then
  echo "[+] Uploading ${BACKUP_FILENAME} to s3://${BACKUP_S3_BUCKET}/db/..."
  
  S3_ARGS=()
  if [ -n "$S3_ENDPOINT_URL" ]; then
    S3_ARGS+=(--endpoint-url "$S3_ENDPOINT_URL")
  fi

  if command -v aws >/dev/null 2>&1; then
    if ! aws s3 cp "${S3_ARGS[@]}" "$FINAL_BACKUP_FILE" "s3://${BACKUP_S3_BUCKET}/db/${BACKUP_FILENAME}"; then
      notify_failure "aws s3 cp upload failed"
      exit 1
    fi
    echo "[+] Upload to S3 completed successfully."
    
    # Prune remote backups older than RETENTION_DAYS
    echo "[+] Pruning remote S3 backups older than ${RETENTION_DAYS} days..."
    CUTOFF_DATE="$(date -u -d "${RETENTION_DAYS} days ago" +"%Y-%m-%d" 2>/dev/null || date -u -v-${RETENTION_DAYS}d +"%Y-%m-%d")"
    aws s3 "${S3_ARGS[@]}" ls "s3://${BACKUP_S3_BUCKET}/db/" | while read -r line; do
      FILE_DATE="$(echo "$line" | awk '{print $1}')"
      REMOTE_FILE="$(echo "$line" | awk '{print $4}')"
      if [[ -n "$REMOTE_FILE" && "$FILE_DATE" < "$CUTOFF_DATE" ]]; then
        echo "    Deleting expired remote backup: ${REMOTE_FILE} (${FILE_DATE})"
        aws s3 "${S3_ARGS[@]}" rm "s3://${BACKUP_S3_BUCKET}/db/${REMOTE_FILE}" || true
      fi
    done
  else
    echo "[!] WARNING: aws CLI tool is not installed. Skipping off-server transfer."
    echo "[!] Install awscli to enable automated off-site synchronization."
  fi
else
  echo "[!] NOTICE: BACKUP_S3_BUCKET is not set. Backup remains locally in ${BACKUP_DIR}."
fi

# 5. Local Retention Pruning
echo "[+] Pruning local backups older than ${RETENTION_DAYS} days in ${BACKUP_DIR}..."
find "$BACKUP_DIR" -type f \( -name "synkro_db_*.dump" -o -name "synkro_db_*.dump.enc" \) -mtime "+${RETENTION_DAYS}" -exec rm -f {} +

echo "[+] [${DATE_TAG}] Synkro database backup procedure finished successfully!"
