#!/usr/bin/env bash
# ==============================================================================
# Fills the shared READ-ONLY Gradle dependency cache of Cloud Build (DEC-08).
#
#   sudo bash scripts/warm-gradle-cache.sh                 # react-native and flutter
#   sudo bash scripts/warm-gradle-cache.sh react-native    # one framework
#
# For each framework: builds a template project in a real sandbox (same image, limits, restricted network and DNS
# allowlist as a user's build; scripts/warm-gradle-cache.ts, run as the service user), copies Gradle's
# caches/modules-2 out of it, makes it root-owned and read-only, and swaps it in atomically:
#   ${CACHE_DIR}/.versions/<framework>-<time>/modules-2   one directory per version
#   ${CACHE_DIR}/<framework> -> .versions/<framework>-<time>   what new builds mount (DockerSandbox)
# A build that is running keeps the version it started with. If anything fails, the current cache stays as it was.
# Safe to re-run; keeps the current and the previous version, and never deletes one a running build has mounted.
#
# ${CACHE_DIR} must be the bind mount of the Docker volume that scripts/setup-production-server.sh sets up (section
# 14), so the cache never fills the root disk where Postgres lives.
# ==============================================================================
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "[-] ERROR: run as root (sudo)." >&2
  exit 1
fi

SYNKRO_HOME="${SYNKRO_HOME:-/opt/synkro}"
SYNKRO_USER="${SYNKRO_USER:-synkro}"
# Must match gradleRoCacheHostDir() in packages/agent/src/models/docker-sandbox.ts.
CACHE_DIR="${SYNKRO_GRADLE_RO_CACHE_DIR:-/var/lib/synkro/gradle-ro-cache}"
KEEP_VERSIONS=2

if [[ $# -gt 0 ]]; then FRAMEWORKS=("$@"); else FRAMEWORKS=(react-native flutter); fi

if ! mountpoint -q "${CACHE_DIR}"; then
  echo "[-] ERROR: ${CACHE_DIR} is not mounted (it must be the bind mount of the Docker volume)." >&2
  echo "[-] Run scripts/setup-production-server.sh first (section 14)." >&2
  exit 1
fi
install -d -m 0755 -o root -g root "${CACHE_DIR}" "${CACHE_DIR}/.versions"

# Versions a running container has mounted (their source paths), so pruning never removes one in use.
mounted_sources() {
  local ids
  ids="$(docker ps -q)"
  [[ -z "${ids}" ]] && return 0
  # shellcheck disable=SC2086
  docker inspect --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' ${ids} 2>/dev/null || true
}

FAILED=0
for FW in "${FRAMEWORKS[@]}"; do
  case "${FW}" in react-native|flutter) ;; *) echo "[-] Unknown framework '${FW}'" >&2; exit 1 ;; esac
  echo "[+] Warming the ${FW} Gradle cache (a full template build: 10-20 minutes)..."

  STAGE="$(mktemp -d "${CACHE_DIR}/.stage-${FW}-XXXXXX")"
  chown "${SYNKRO_USER}:${SYNKRO_USER}" "${STAGE}"
  # The build runs as the service user: no repository code runs as root.
  if ! sudo -u "${SYNKRO_USER}" -H bash -lc "cd '${SYNKRO_HOME}' && npx tsx scripts/warm-gradle-cache.ts --framework '${FW}' --out '${STAGE}/modules-2'"; then
    echo "[!] ${FW}: the warm-up build failed; the current cache is kept." >&2
    rm -rf "${STAGE}"
    FAILED=1
    continue
  fi
  if [[ ! -d "${STAGE}/modules-2/files-2.1" ]]; then
    echo "[!] ${FW}: no dependencies were cached (no modules-2/files-2.1); the current cache is kept." >&2
    rm -rf "${STAGE}"
    FAILED=1
    continue
  fi

  # A read-only cache must not contain Gradle's lock files or gc.properties (Gradle docs, "read-only dependency cache").
  find "${STAGE}/modules-2" \( -name '*.lock' -o -name 'gc.properties' \) -type f -delete
  chown -R root:root "${STAGE}"
  chmod -R u=rwX,go=rX "${STAGE}"

  VERSION="${FW}-$(date +%Y%m%d-%H%M%S)"
  mv "${STAGE}" "${CACHE_DIR}/.versions/${VERSION}"
  # Atomic swap: a new symlink, then rename(2) over the old one.
  ln -sfn ".versions/${VERSION}" "${CACHE_DIR}/.${FW}.new"
  mv -Tf "${CACHE_DIR}/.${FW}.new" "${CACHE_DIR}/${FW}"
  echo "[+] ${FW}: cache ${VERSION} is live ($(du -sh "${CACHE_DIR}/.versions/${VERSION}" | cut -f1))."

  # Keep the newest KEEP_VERSIONS; skip any version a running build has mounted.
  IN_USE="$(mounted_sources)"
  mapfile -t OLD < <(ls -1d "${CACHE_DIR}/.versions/${FW}-"* 2>/dev/null | sort -r | tail -n +$((KEEP_VERSIONS + 1)))
  for DIR in "${OLD[@]}"; do
    if grep -qxF "${DIR}" <<<"${IN_USE}"; then
      echo "[+] ${FW}: keeping $(basename "${DIR}") (a running build uses it)."
    else
      rm -rf "${DIR}"
      echo "[+] ${FW}: removed old version $(basename "${DIR}")."
    fi
  done
done

# Leftovers of an interrupted run.
find "${CACHE_DIR}" -maxdepth 1 -name '.stage-*' -mmin +120 -exec rm -rf {} + 2>/dev/null || true

if [[ "${FAILED}" -ne 0 ]]; then
  echo "[!] Some caches were not refreshed (see above). Builds still work: they download what is missing." >&2
  exit 1
fi
echo "[+] Gradle read-only caches ready in ${CACHE_DIR}."
