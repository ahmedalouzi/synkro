#!/usr/bin/env bash
# End-to-end test of scripts/synkro-backup-offsite.sh and scripts/synkro-backup-restore-test.sh (test only):
# Postgres with test rows, an S3 server (SeaweedFS) with an admin identity and a WRITE-ONLY identity, a real age key
# pair. Runs the backup as the server would, checks the bucket, then restores the uploaded file with the restore test.
# Prints "E2E OK" at the end; any failed check exits non-zero with a reason.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
RUN="bk$$"
NET="${RUN}-net"
WORK="$(mktemp -d)"
export MSYS_NO_PATHCONV=1
win() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
cleanup() { docker rm -f "${RUN}-db" "${RUN}-s3" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
check() { if ! eval "$1"; then echo "CHECK FAILED: $2" >&2; exit 1; fi; }

docker network create "$NET" >/dev/null

# 1. The database, with rows in tables like production's.
docker run -d --name "${RUN}-db" --network "$NET" -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=peep postgres:15-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "${RUN}-db" pg_isready -q -U postgres -h 127.0.0.1 && break; sleep 1; done
sleep 2
docker exec -i "${RUN}-db" psql -q -U postgres -d peep -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE TABLE users (id serial PRIMARY KEY, email text);
INSERT INTO users (email) SELECT 'user' || g || '@example.com' FROM generate_series(1, 42) g;
CREATE TABLE signing_keys (id serial PRIMARY KEY, project_id text, encrypted_key bytea);
INSERT INTO signing_keys (project_id, encrypted_key) SELECT 'p' || g, decode('deadbeef', 'hex') FROM generate_series(1, 7) g;
CREATE TABLE build_jobs (id serial PRIMARY KEY, status text);
INSERT INTO build_jobs (status) SELECT 'success' FROM generate_series(1, 13) g;
SQL

# 2. S3 with an admin and a write-only identity.
cat >"$WORK/s3.json" <<'JSON'
{"identities": [
  {"name": "admin", "credentials": [{"accessKey": "adminkey", "secretKey": "adminsecret"}], "actions": ["Admin", "Read", "List", "Write"]},
  {"name": "writer", "credentials": [{"accessKey": "writerkey", "secretKey": "writer-secret-value"}], "actions": ["Write:synkro-backups"]}
]}
JSON
docker run -d --name "${RUN}-s3" --network "$NET" -v "$(win "$WORK"):/cfg:ro" chrislusf/seaweedfs:3.97 \
  server -dir=/data -s3 -s3.port=8333 -s3.config=/cfg/s3.json >/dev/null
s3() { # s3 <access> <secret> <curl args...>: a signed request from inside the network.
  local id="$1" secret="$2"; shift 2
  printf 'user = "%s:%s"\n' "$id" "$secret" | docker run --rm -i --network "$NET" -v "$(win "$WORK"):/w" alpine:3.20 \
    sh -c 'apk add --no-cache curl >/dev/null 2>&1; curl -sS -K - --aws-sigv4 "aws:amz:us-east-1:s3" -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" "$@"' _ "$@"
}
for _ in $(seq 1 60); do
  code="$(s3 adminkey adminsecret -o /dev/null -w '%{http_code}' -X PUT "http://${RUN}-s3:8333/synkro-backups" || true)"
  [ "$code" = 200 ] && break; sleep 1
done
check '[ "$code" = 200 ]' "bucket created (HTTP $code)"

# 3. A real age key pair: the public key goes to the "server", the private key only to the restore test.
docker run --rm alpine:3.20 sh -c 'apk add --no-cache age >/dev/null 2>&1; age-keygen 2>/dev/null' >"$WORK/identity.txt"
RECIPIENT="$(sed -n 's/^# public key: //p' "$WORK/identity.txt")"
check '[ "${RECIPIENT#age1}" != "$RECIPIENT" ]' "age key pair"

# 4. The backup, as the server runs it: settings in backup.env, DATABASE_URL in the app .env (with a signing key
#    that must not be used or included).
mkdir -p "$WORK/etc" "$WORK/backups"
cat >"$WORK/etc/app.env" <<ENV
DATABASE_URL="postgres://postgres:pw@${RUN}-db:5432/peep"
SYNKRO_SIGNING_ENC_KEY="signing-key-that-must-not-be-used"
BACKUP_ENCRYPTION_KEY="old-symmetric-key-that-must-not-be-used"
ENV
cat >"$WORK/etc/backup.env" <<ENV
BACKUP_AGE_RECIPIENT=${RECIPIENT}
BACKUP_S3_ENDPOINT=http://${RUN}-s3:8333
BACKUP_S3_REGION=us-east-1
BACKUP_S3_BUCKET=synkro-backups
BACKUP_S3_KEY_ID=writerkey
BACKUP_S3_SECRET='writer-secret-value'
LOCAL_KEEP=2
ENV
tr -d '\r' <"$ROOT/scripts/synkro-backup-offsite.sh" >"$WORK/backup.sh"
run_backup() {
  docker run --rm --network "$NET" -v "$(win "$WORK"):/w" -e ENV_FILE=/w/etc/app.env -e BACKUP_ENV_FILE=/w/etc/backup.env \
    -e BACKUP_DIR=/w/backups -e BACKUP_S3_ALLOW_HTTP=1 "$@" alpine:3.20 sh -c \
    'apk add --no-cache bash postgresql15-client age curl findutils coreutils sed grep >/dev/null 2>&1; bash /w/backup.sh' 2>&1
}
out="$(run_backup)" || { echo "$out" >&2; echo "CHECK FAILED: the backup ran" >&2; exit 1; }
echo "$out" | sed 's/^/    | /'
check '! echo "$out" | grep -q "writer-secret-value"' "the secret is not in the log"
NAME="$(ls "$WORK/backups")"
check '[ "$(ls "$WORK/backups" | wc -l)" = 1 ] && [ "${NAME%.dump.age}" != "$NAME" ]' "one encrypted file locally, no plaintext dump ($(ls "$WORK/backups"))"
check 'head -c 21 "$WORK/backups/$NAME" | grep -q "^age-encryption.org/v1"' "the local file is age-encrypted"
check '! grep -a -q "user1@example.com" "$WORK/backups/$NAME"' "no plaintext rows in the file"

# 5. The bucket: the file is there; the upload key can neither list nor read it. (Deleting: SeaweedFS's "Write"
#    includes delete, so it is not checked here. On Backblaze B2 the key gets writeFiles without deleteFiles, and the
#    bucket's Object Lock keeps every file for 30 days whatever the key; the script never deletes or lists remotely.)
listing="$(s3 adminkey adminsecret "http://${RUN}-s3:8333/synkro-backups?list-type=2&prefix=db/")"
check 'echo "$listing" | grep -q "<Key>db/${NAME}</Key>"' "the backup is in the bucket"
check '[ "$(s3 writerkey writer-secret-value -o /dev/null -w "%{http_code}" "http://${RUN}-s3:8333/synkro-backups?list-type=2")" = 403 ]' "the upload key cannot list"
check '[ "$(s3 writerkey writer-secret-value -o /dev/null -w "%{http_code}" "http://${RUN}-s3:8333/synkro-backups/db/${NAME}")" = 403 ]' "the upload key cannot read"

# 6. Refusals: no age key -> no backup at all; a wrong secret -> a failed upload (exit 1).
sed -i 's/^BACKUP_AGE_RECIPIENT=.*/BACKUP_AGE_RECIPIENT=/' "$WORK/etc/backup.env"
if out="$(run_backup)"; then echo "CHECK FAILED: ran without an age key" >&2; exit 1; fi
check 'echo "$out" | grep -q "refusing to make an unencrypted backup"' "refuses without an age key"
sed -i "s/^BACKUP_AGE_RECIPIENT=.*/BACKUP_AGE_RECIPIENT=${RECIPIENT}/; s/^BACKUP_S3_SECRET=.*/BACKUP_S3_SECRET=wrong/" "$WORK/etc/backup.env"
if out="$(run_backup)"; then echo "CHECK FAILED: uploaded with a wrong secret" >&2; exit 1; fi
check 'echo "$out" | grep -q "ERROR: upload failed"' "a failed upload fails the backup"
check '[ "$(ls "$WORK/backups" | grep -c .)" -le 2 ]' "local copies capped by LOCAL_KEEP"

# 7. Restore test with the private key on stdin: the uploaded file, downloaded by the owner.
mkdir -p "$WORK/download"
s3 adminkey adminsecret -o "/w/download/${NAME}" "http://${RUN}-s3:8333/synkro-backups/db/${NAME}"
tr -d '\r' <"$ROOT/scripts/synkro-backup-restore-test.sh" >"$WORK/restore.sh"
restore="$(bash "$WORK/restore.sh" "$WORK/download/${NAME}" <"$WORK/identity.txt" 2>&1)" || { echo "$restore" >&2; echo "CHECK FAILED: restore test" >&2; exit 1; }
echo "$restore" | sed 's/^/    | /'
check 'echo "$restore" | grep -Eq "public[.]users +42$"' "users restored (42)"
check 'echo "$restore" | grep -Eq "public[.]signing_keys +7$"' "signing_keys restored (7)"
check 'echo "$restore" | grep -Eq "public[.]build_jobs +13$"' "build_jobs restored (13)"
check 'echo "$restore" | grep -q "OK: 3 tables restored and counted; the temporary database was dropped"' "the temporary database is dropped"
check '! echo "$restore" | grep -q "AGE-SECRET-KEY"' "the private key is not shown"
wrong="$(echo 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ' | bash "$WORK/restore.sh" "$WORK/download/${NAME}" 2>&1)" && { echo "CHECK FAILED: restored with a wrong key" >&2; exit 1; }
check 'echo "$wrong" | grep -qiE "no identity matched|failed|error"' "a wrong key cannot decrypt"
echo "E2E OK"
