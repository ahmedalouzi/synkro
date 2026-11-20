#!/usr/bin/env bash
# ==============================================================================
# Synkro backup restore test: proves a backup can be restored, without touching production.
#
#   scripts/synkro-backup-restore-test.sh <synkro_db_....dump.age>  < age-identity.txt
#
# Runs on the owner's computer (Windows Git Bash, macOS or Linux) with Docker, so the age PRIVATE key never goes
# to the server. The key is read from stdin (paste it, or redirect a file you delete afterwards); it is never
# written to disk or shown. In a throwaway Postgres container it:
#   1. decrypts the backup (age),
#   2. restores it into a temporary database (pg_restore --exit-on-error),
#   3. prints the number of rows of every table,
#   4. removes the container, and the database with it.
# Exit code 0 only when every step worked and the restored database has tables.
#
# POSTGRES_IMAGE (default postgres:17-alpine) must be the server's Postgres major version or newer.
# ==============================================================================
set -euo pipefail

BACKUP="${1:-}"
IMAGE="${POSTGRES_IMAGE:-postgres:17-alpine}"
if [ -z "$BACKUP" ] || [ ! -f "$BACKUP" ]; then
  echo "usage: $0 <synkro_db_....dump.age> < age-identity.txt" >&2
  exit 2
fi
if [ -t 0 ]; then
  echo "Paste the age private key (AGE-SECRET-KEY-1...), then press Enter and Ctrl-D:" >&2
fi
command -v docker >/dev/null 2>&1 || { echo "Docker is required" >&2; exit 2; }

DIR="$(cd "$(dirname "$BACKUP")" && pwd)"
FILE="$(basename "$BACKUP")"
# Docker on Windows (Git Bash) wants a Windows path for the mount.
if command -v cygpath >/dev/null 2>&1; then DIR="$(cygpath -w "$DIR")"; fi

echo "[restore-test] ${FILE} in a temporary ${IMAGE} container"
# MSYS_NO_PATHCONV: Git Bash must not rewrite the container's paths.
MSYS_NO_PATHCONV=1 docker run --rm -i \
  -e POSTGRES_PASSWORD=restore-test -e PGPASSWORD=restore-test -e PGUSER=postgres -e FILE="$FILE" \
  -v "${DIR}:/backup:ro" \
  --entrypoint sh "$IMAGE" -c '
set -eu
command -v age >/dev/null 2>&1 || apk add --no-cache age >/dev/null 2>&1 || { echo "age is not available in this image" >&2; exit 1; }
# The identity arrives on stdin; it stays in memory (tmpfs-like /dev/shm) and is never printed.
umask 077
cat > /dev/shm/identity
grep -q "^AGE-SECRET-KEY-1" /dev/shm/identity || { echo "[restore-test] stdin is not an age private key" >&2; exit 1; }
age -d -i /dev/shm/identity -o /tmp/db.dump "/backup/$FILE"
rm -f /dev/shm/identity
echo "[restore-test] decrypted ($(wc -c </tmp/db.dump) bytes)"

docker-entrypoint.sh postgres >/tmp/pg.log 2>&1 &
for i in $(seq 1 60); do pg_isready -q -h 127.0.0.1 && break; sleep 1; done
pg_isready -q -h 127.0.0.1 || { cat /tmp/pg.log >&2; exit 1; }
sleep 2
createdb -h 127.0.0.1 restore_test
pg_restore -h 127.0.0.1 --no-owner --no-privileges --exit-on-error -d restore_test /tmp/db.dump
echo "[restore-test] restored into restore_test"

tables=$(psql -h 127.0.0.1 -d restore_test -Atc "SELECT quote_ident(schemaname) || chr(46) || quote_ident(tablename) FROM pg_tables ORDER BY 1" | grep -v -E "^(pg_catalog|information_schema)[.]" || true)
[ -n "$tables" ] || { echo "[restore-test] the restored database has no tables" >&2; exit 1; }
count=0
printf "%-48s %12s\n" TABLE ROWS
for t in $tables; do
  n=$(psql -h 127.0.0.1 -d restore_test -Atc "SELECT count(*) FROM $t")
  printf "%-48s %12s\n" "$t" "$n"
  count=$((count + 1))
done
dropdb -h 127.0.0.1 restore_test
echo "[restore-test] OK: $count tables restored and counted; the temporary database was dropped"
'
echo "[restore-test] the container is removed"
