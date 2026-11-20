#!/usr/bin/env bash
# ==============================================================================
# Synkro off-site database backup (daily, systemd: infra/systemd/synkro-backup.{service,timer})
#
#   pg_dump -Fc  |  age -r <public key>  ->  <dir>/synkro_db_<UTC>.dump.age  ->  PUT to an S3-compatible bucket
#
# - Encrypted before it touches the disk or the network, with an age PUBLIC key (BACKUP_AGE_RECIPIENT). The
#   private key is not on the server: it lives in the owner's password manager, and only the restore test uses it.
#   No recipient, no backup: it never uploads anything unencrypted.
# - The backup holds the database only. Secrets from the .env (SYNKRO_SIGNING_ENC_KEY and the rest) are never in
#   it and are never used to encrypt it. The signing_keys rows in the dump are already encrypted with
#   SYNKRO_SIGNING_ENC_KEY, so that key must be kept separately (password manager) to use them after a restore.
# - Uploaded with curl's AWS SigV4 and a WRITE-ONLY key: the key can add files but not list, read or delete them,
#   so a leaked server cannot wipe the backups. Retention is a lifecycle rule on the bucket, not done here.
#   The key is passed to curl on stdin, never on a command line (ps) or in the log.
# - Keeps the last LOCAL_KEEP encrypted files on the server for a quick restore.
# - On failure: a webhook alert (optional). On success: a heartbeat ping (optional, e.g. healthchecks.io),
#   so a backup that stops running is noticed too.
#
# Settings (in BACKUP_ENV_FILE, default /etc/synkro/backup.env, mode 0600; DATABASE_URL from ENV_FILE):
#   BACKUP_AGE_RECIPIENT   age1...                                required
#   BACKUP_S3_ENDPOINT     https://s3.<region>.backblazeb2.com    required
#   BACKUP_S3_REGION       e.g. eu-central-003                    required
#   BACKUP_S3_BUCKET       bucket name                            required
#   BACKUP_S3_KEY_ID       write-only application key ID          required
#   BACKUP_S3_SECRET       its secret                             required
#   ALERT_WEBHOOK_URL      Discord/Slack webhook                  optional
#   BACKUP_HEARTBEAT_URL   pinged after a good backup             optional
#   LOCAL_KEEP             encrypted copies kept locally (default 3)
#   BACKUP_DIR             default /var/backups/synkro
# ==============================================================================
set -euo pipefail
umask 077

ENV_FILE="${ENV_FILE:-/opt/synkro/.env}"
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/etc/synkro/backup.env}"

# Reads one KEY=value from a .env-style file without running it as shell code (surrounding quotes removed).
env_value() {
  local file="$1" key="$2"
  [ -r "$file" ] || return 0
  sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*//p" "$file" | tail -n 1 \
    | sed -E -e 's/^"(.*)"[[:space:]]*$/\1/' -e "s/^'(.*)'[[:space:]]*\$/\\1/"
}
# A setting: from the environment, else the backup env file, else the app's .env.
setting() {
  local key="$1" value="${!1:-}"
  [ -n "$value" ] || value="$(env_value "$BACKUP_ENV_FILE" "$key")"
  [ -n "$value" ] || value="$(env_value "$ENV_FILE" "$key")"
  printf '%s' "$value"
}

DATABASE_URL="$(setting DATABASE_URL)"
AGE_RECIPIENT="$(setting BACKUP_AGE_RECIPIENT)"
S3_ENDPOINT="$(setting BACKUP_S3_ENDPOINT)"
S3_REGION="$(setting BACKUP_S3_REGION)"
S3_BUCKET="$(setting BACKUP_S3_BUCKET)"
S3_KEY_ID="$(setting BACKUP_S3_KEY_ID)"
S3_SECRET="$(setting BACKUP_S3_SECRET)"
ALERT_WEBHOOK_URL="$(setting ALERT_WEBHOOK_URL)"
HEARTBEAT_URL="$(setting BACKUP_HEARTBEAT_URL)"
LOCAL_KEEP="$(setting LOCAL_KEEP)"; LOCAL_KEEP="${LOCAL_KEEP:-3}"
BACKUP_DIR="$(setting BACKUP_DIR)"; BACKUP_DIR="${BACKUP_DIR:-/var/backups/synkro}"

DATE_TAG="$(date -u +%Y%m%d_%H%M%SZ)"
NAME="synkro_db_${DATE_TAG}.dump.age"
OUT="${BACKUP_DIR}/${NAME}"
PARTIAL="${OUT}.partial"

fail() {
  trap - ERR
  echo "[backup] ERROR: $1" >&2
  rm -f "$PARTIAL"
  if [ -n "$ALERT_WEBHOOK_URL" ]; then
    # No secrets in the message: the step that failed, the host and the time.
    local text
    text="Synkro backup failed on $(hostname) at ${DATE_TAG}: $1"
    text="${text//\\/\\\\}"; text="${text//\"/\\\"}"
    curl -sS -m 10 -H 'Content-Type: application/json' -d "{\"content\":\"${text}\"}" "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 || true
  fi
  exit 1
}
trap 'fail "unexpected error at line ${LINENO}"' ERR

for tool in pg_dump age curl; do
  command -v "$tool" >/dev/null 2>&1 || fail "${tool} is not installed"
done
[ -n "$DATABASE_URL" ] || fail "DATABASE_URL is not set"
case "$AGE_RECIPIENT" in
  age1*) ;;
  *) fail "BACKUP_AGE_RECIPIENT is not an age public key (age1...): refusing to make an unencrypted backup" ;;
esac
for v in S3_ENDPOINT S3_REGION S3_BUCKET S3_KEY_ID S3_SECRET; do
  [ -n "${!v}" ] || fail "BACKUP_${v} is not set"
done
# HTTPS only. BACKUP_S3_ALLOW_HTTP=1 is for the test's local S3 server.
case "$S3_ENDPOINT" in
  https://*) ;;
  http://*) [ "${BACKUP_S3_ALLOW_HTTP:-}" = 1 ] || fail "BACKUP_S3_ENDPOINT must be https://" ;;
  *) fail "BACKUP_S3_ENDPOINT must be https://" ;;
esac

mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

echo "[backup] ${DATE_TAG}: dumping and encrypting the database"
# The plaintext dump only exists in the pipe. pipefail: a failing pg_dump fails the whole step.
if ! pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" | age -r "$AGE_RECIPIENT" -o "$PARTIAL"; then
  fail "pg_dump or age failed"
fi
[ -s "$PARTIAL" ] || fail "the encrypted dump is empty"
head -c 21 "$PARTIAL" | grep -q '^age-encryption.org/v1' || fail "the output is not an age file"
mv "$PARTIAL" "$OUT"
SIZE="$(wc -c <"$OUT" | tr -d ' ')"
echo "[backup] encrypted dump: ${NAME} (${SIZE} bytes)"

echo "[backup] uploading to ${S3_BUCKET}/db/${NAME}"
# Credentials on stdin (curl -K -): not visible in ps, not in the journal.
if ! printf 'user = "%s:%s"\n' "$S3_KEY_ID" "$S3_SECRET" | curl -sS --fail --retry 3 --retry-delay 5 -m 1800 -K - \
    --aws-sigv4 "aws:amz:${S3_REGION}:s3" \
    -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" \
    -H "Content-Type: application/octet-stream" \
    -T "$OUT" "${S3_ENDPOINT%/}/${S3_BUCKET}/db/${NAME}" -o /dev/null; then
  fail "upload failed"
fi
echo "[backup] uploaded"

# Local copies: keep the newest LOCAL_KEEP.
mapfile -t old < <(find "$BACKUP_DIR" -maxdepth 1 -name 'synkro_db_*.dump.age' -printf '%T@ %p\n' | sort -rn | tail -n +"$((LOCAL_KEEP + 1))" | cut -d' ' -f2-)
if [ "${#old[@]}" -gt 0 ]; then rm -f -- "${old[@]}"; fi

if [ -n "$HEARTBEAT_URL" ]; then curl -fsS -m 10 --retry 3 "$HEARTBEAT_URL" >/dev/null 2>&1 || true; fi
echo "[backup] ${DATE_TAG}: done"
