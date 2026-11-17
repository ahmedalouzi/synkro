#!/usr/bin/env bash
# ==============================================================================
# Synkro Production Server Setup Script
# Target OS: Ubuntu 22.04 / 24.04 LTS
# Rebuilds production environment from scratch idempotently
# ==============================================================================

set -euo pipefail

# 1. Root verification
if [[ "${EUID}" -ne 0 ]]; then
  echo "[-] ERROR: This script must be run as root (or with sudo)." >&2
  exit 1
fi

# Environment & Config
export DEBIAN_FRONTEND=noninteractive
SYNKRO_DOMAIN="${SYNKRO_DOMAIN:-api.atomvs.com}"
SYNKRO_USER="synkro"
SYNKRO_HOME="/opt/synkro"
NODE_VERSION="20"
PNPM_VERSION="9.15.0"

echo "[+] Starting Synkro production server provisioning..."
echo "    Domain:  ${SYNKRO_DOMAIN}"
echo "    User:    ${SYNKRO_USER}"
echo "    Root:    ${SYNKRO_HOME}"

# 2. System update and baseline packages
echo "[+] Updating apt repositories and installing core packages..."
apt-get update -y
apt-get install -y --no-install-recommends \
  curl \
  git \
  ca-certificates \
  gnupg \
  ufw \
  postgresql-client \
  unzip \
  jq \
  build-essential

# 3. NodeSource Node.js 20 LTS & pnpm & PM2
echo "[+] Installing Node.js ${NODE_VERSION} LTS..."
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d'.' -f1)" != "v${NODE_VERSION}" ]]; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_VERSION}.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
fi

echo "[+] Setting up Corepack, pnpm@${PNPM_VERSION}, and PM2..."
corepack enable
corepack prepare "pnpm@${PNPM_VERSION}" --activate
npm install -g pm2

# 4. Docker Engine (Required for Cloud Build Sandboxes)
echo "[+] Installing Docker Engine..."
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
  chmod a+r /etc/apt/keyrings/docker.gpg

  UBUNTU_CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME} stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

  apt-get update -y
  apt-get install -y \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin
  
  systemctl enable docker
  systemctl start docker
fi

# 4b. Docker storage: classic overlay2 graph driver, containerd snapshotter OFF (DEC-06).
# The per-build disk limit (--storage-opt size=, docker-sandbox.ts) only works with overlay2 on XFS mounted with
# pquota (/var/lib/docker, docs/LINUX_TEST_SESSION.md section 1). Docker 29+ defaults to the containerd image store,
# which accepts --storage-opt and silently ignores it, and keeps container layers under /var/lib/containerd on the
# root disk (where Postgres lives). Existing keys in daemon.json are kept; Docker restarts only if this changes it.
# Images do not carry over between the two stores: section 11 rebuilds the sandbox images when they are missing.
DAEMON_JSON="/etc/docker/daemon.json"
DOCKER_STORAGE_WANT='{"storage-driver":"overlay2","features":{"containerd-snapshotter":false}}'
mkdir -p /etc/docker
DOCKER_CONFIG_NOW="$(if [[ -s "${DAEMON_JSON}" ]]; then cat "${DAEMON_JSON}"; else echo '{}'; fi)"
if ! jq -e . >/dev/null 2>&1 <<<"${DOCKER_CONFIG_NOW}"; then
  echo "[-] ERROR: ${DAEMON_JSON} is not valid JSON; fix it by hand, then run this script again." >&2
  exit 1
fi
DOCKER_CONFIG_NEW="$(jq -S --argjson want "${DOCKER_STORAGE_WANT}" '. * $want' <<<"${DOCKER_CONFIG_NOW}")"
if [[ "$(jq -S . <<<"${DOCKER_CONFIG_NOW}")" != "${DOCKER_CONFIG_NEW}" ]]; then
  echo "[+] Setting Docker storage to overlay2 (containerd snapshotter off) in ${DAEMON_JSON}..."
  if [[ -s "${DAEMON_JSON}" ]]; then cp "${DAEMON_JSON}" "${DAEMON_JSON}.bak.$(date +%Y%m%d%H%M%S)"; fi
  printf '%s\n' "${DOCKER_CONFIG_NEW}" > "${DAEMON_JSON}"
  # Stops every running container, including a Cloud Build in progress: run this script when no build runs.
  echo "[!] Restarting Docker (running containers stop)..."
  systemctl restart docker
else
  echo "[+] Docker storage already set to overlay2 (containerd snapshotter off)."
fi

# 5. Non-root service user 'synkro'
echo "[+] Provisioning non-root user '${SYNKRO_USER}'..."
if ! id -u "${SYNKRO_USER}" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "${SYNKRO_USER}"
fi
usermod -aG docker "${SYNKRO_USER}"

# 6. Persistent storage and directory permissions
echo "[+] Configuring directory structure and permissions..."
mkdir -p \
  "${SYNKRO_HOME}" \
  "/var/lib/synkro/artifacts" \
  "/var/lib/synkro/builds" \
  "/var/backups/synkro" \
  "/home/${SYNKRO_USER}/.pm2"

chmod 0700 "/var/lib/synkro/artifacts"
chmod 0700 "/var/lib/synkro/builds"
chmod 0700 "/var/backups/synkro"

chown -R "${SYNKRO_USER}:${SYNKRO_USER}" \
  "${SYNKRO_HOME}" \
  "/var/lib/synkro" \
  "/var/backups/synkro" \
  "/home/${SYNKRO_USER}"

# 7. UFW Firewall Configuration
echo "[+] Configuring UFW firewall rules..."
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP Caddy challenge'
ufw allow 443/tcp comment 'HTTPS Caddy'
# Cloud Build sandboxes resolve names through Docker's embedded DNS, which forwards from the container to
# dnsmasq on 172.30.0.1:53 (bridge build0, section 12). That traffic hits the host INPUT chain, so without
# these rules "deny incoming" drops it and no build can resolve any name. Only DNS to the resolver is opened.
ufw allow in on build0 to 172.30.0.1 port 53 proto udp comment 'sandbox DNS'
ufw allow in on build0 to 172.30.0.1 port 53 proto tcp comment 'sandbox DNS'
ufw --force enable

# 8. Caddy Reverse Proxy Installation and Config
echo "[+] Installing and configuring Caddy web server..."
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

cat <<CADDYFILE > /etc/caddy/Caddyfile
${SYNKRO_DOMAIN} {
    # 55MB body limit for zip uploads on Cloud Build
    @upload path /api/build/upload
    request_body @upload {
        max_size 55MB
    }

    # SSE endpoints: disable proxy buffering and set immediate flush
    @sse path /v1/ai/stream /api/build/*/stream
    handle @sse {
        reverse_proxy 127.0.0.1:8080 {
            flush_interval -1
            header_up X-Accel-Buffering no
        }
    }

    # Default API reverse proxy to Node server
    handle {
        reverse_proxy 127.0.0.1:8080
    }
}
CADDYFILE

systemctl enable caddy
systemctl restart caddy

# 9. PM2 systemd startup for 'synkro' user
echo "[+] Configuring PM2 systemd daemon unit for ${SYNKRO_USER}..."
env PATH="$PATH:/usr/bin:/usr/local/bin" pm2 startup systemd -u "${SYNKRO_USER}" --hp "/home/${SYNKRO_USER}" || true

# ==============================================================================
# Cloud Build sandbox (sections 10-14)
# The build worker runs as '${SYNKRO_USER}' (in the docker group) without root. The parts that need root
# (iptables, ipset, dnsmasq) are set up here and by synkro-build-network.service at every boot, because
# iptables/ipset rules do not survive a reboot.
# Sections 11 and 12 need the repo in ${SYNKRO_HOME}: on a fresh server, clone it and run this script again.
# ==============================================================================
TSX_VERSION="4.22.4"
BUILD_NETWORK_LIB="/usr/local/lib/synkro-build-network"
REPO_READY="false"
if [[ -f "${SYNKRO_HOME}/packages/agent/src/models/network-setup.ts" ]]; then
  REPO_READY="true"
fi

# 10. Firewall packages for the build sandbox
echo "[+] Installing ipset, iptables and dnsmasq for the build sandbox firewall..."
# Do not let apt start dnsmasq: with its default config it binds port 53 on every interface, which clashes
# with systemd-resolved. It is configured and started by synkro-build-network.service (section 12).
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
chmod +x /usr/sbin/policy-rc.d
apt-get install -y --no-install-recommends ipset iptables dnsmasq
rm -f /usr/sbin/policy-rc.d
systemctl enable dnsmasq
# tsx for root, so the root service never runs code from node_modules that '${SYNKRO_USER}' can modify.
npm install -g "tsx@${TSX_VERSION}"

# 11. Sandbox images (our own, not on any registry, so they are built here)
if [[ "${REPO_READY}" == "true" ]]; then
  # Read the image names from the code so they cannot drift apart; each one is built from
  # infra/docker/Dockerfile.<name>, e.g. synkro/rn-sandbox:1 from Dockerfile.rn-sandbox.
  # Set SYNKRO_REBUILD_IMAGES=1 to rebuild after changing a Dockerfile.
  for IMAGE in $(grep -oE "synkro/[a-z-]+-sandbox:[0-9]+" "${SYNKRO_HOME}/packages/agent/src/models/docker-sandbox.ts" | sort -u); do
    DOCKERFILE="${SYNKRO_HOME}/infra/docker/Dockerfile.$(echo "${IMAGE}" | sed -E 's#^synkro/([a-z-]+):.*#\1#')"
    if [[ "${SYNKRO_REBUILD_IMAGES:-0}" == "1" ]] || ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
      echo "[+] Building ${IMAGE} from ${DOCKERFILE#"${SYNKRO_HOME}"/} (takes a while)..."
      docker build -t "${IMAGE}" -f "${DOCKERFILE}" "${SYNKRO_HOME}/infra/docker"
    else
      echo "[+] ${IMAGE} already built (SYNKRO_REBUILD_IMAGES=1 to rebuild)."
    fi
  done
else
  echo "[!] ${SYNKRO_HOME} has no repo yet: skipping sandbox images (re-run this script after cloning)."
fi

# 12. Build sandbox firewall service (root, at every boot)
if [[ "${REPO_READY}" == "true" ]]; then
  echo "[+] Installing synkro-build-network.service..."
  # Root-owned copy of the two files it needs (network-setup.ts only imports Node built-ins).
  # Re-run this script after changing the allowlist in network-setup.ts.
  install -d -m 0755 -o root -g root \
    "${BUILD_NETWORK_LIB}/scripts" \
    "${BUILD_NETWORK_LIB}/packages/agent/src/models"
  install -m 0644 -o root -g root "${SYNKRO_HOME}/scripts/setup-build-network.ts" "${BUILD_NETWORK_LIB}/scripts/"
  install -m 0644 -o root -g root "${SYNKRO_HOME}/packages/agent/src/models/network-setup.ts" "${BUILD_NETWORK_LIB}/packages/agent/src/models/"
  # Image for the in-container DNS check (the service runs it at every boot, and it runs again below).
  DNS_CHECK_IMAGE="$(grep -oE "synkro/rn-sandbox:[0-9]+" "${SYNKRO_HOME}/packages/agent/src/models/docker-sandbox.ts" | head -n 1 || true)"

  cat <<UNIT > /etc/systemd/system/synkro-build-network.service
[Unit]
Description=Synkro Cloud Build sandbox firewall (build0 network, ipset, iptables, dnsmasq allowlist)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target
Before=pm2-${SYNKRO_USER}.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=SYNKRO_DNS_CHECK_IMAGE=${DNS_CHECK_IMAGE}
ExecStart=/usr/bin/env tsx ${BUILD_NETWORK_LIB}/scripts/setup-build-network.ts

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable synkro-build-network.service
  if ! systemctl restart synkro-build-network.service; then
    journalctl -u synkro-build-network.service -n 30 --no-pager -o cat || true
    echo "[!] FAILED: synkro-build-network.service did not start (log above). Cloud Builds will not work." >&2
    exit 1
  fi

  # The service checks DNS from the host. Builds resolve through Docker's embedded DNS inside the container,
  # which a host firewall can block while the host check passes, so check from a throwaway sandbox container too.
  if [[ -z "${DNS_CHECK_IMAGE}" ]] || ! docker image inspect "${DNS_CHECK_IMAGE}" >/dev/null 2>&1; then
    echo "[!] WARNING: no sandbox image ${DNS_CHECK_IMAGE:-synkro/rn-sandbox} yet: in-container DNS check skipped."
    echo "[!] Build network NOT confirmed. Build the images (section 11) and run this script again."
  else
    DNS_RESULT="$(docker run --rm --network build-restricted --dns 172.30.0.1 "${DNS_CHECK_IMAGE}" sh -c \
      'for n in registry.npmjs.org example.com; do if getent hosts "$n" >/dev/null; then echo "$n RESOLVED"; else echo "$n UNRESOLVED"; fi; done' 2>&1)" || true
    echo "${DNS_RESULT}"
    if ! grep -qx "registry.npmjs.org RESOLVED" <<<"${DNS_RESULT}" || ! grep -qx "example.com UNRESOLVED" <<<"${DNS_RESULT}"; then
      echo "[!] FAILED: in-container DNS check (registry.npmjs.org must resolve, example.com must not)." >&2
      echo "[!] Check 'ufw status' allows DNS in on build0 to 172.30.0.1 (section 7). Cloud Builds will not work." >&2
      exit 1
    fi
    echo "[+] Build network ready (checked inside a ${DNS_CHECK_IMAGE} container: only allowlisted names resolve)."
  fi
else
  echo "[!] Skipping synkro-build-network.service until the repo is in ${SYNKRO_HOME}."
fi

# 13. Disk quota verification (hard check). Same check as the build worker (packages/agent/src/models/disk-quota.ts):
# overlay2 on xfs, and a container limited to 1G that writes 2G must fail with "No space left on device".
echo "[+] Verifying the per-build disk quota..."
DOCKER_DRIVER="$(docker info --format '{{.Driver}}')"
DOCKER_BACKING_FS="$(docker info --format '{{range .DriverStatus}}{{if eq (index . 0) "Backing Filesystem"}}{{index . 1}}{{end}}{{end}}')"
if [[ "${DOCKER_DRIVER}" != "overlay2" || "${DOCKER_BACKING_FS}" != "xfs" ]]; then
  echo "[!] FAILED: Docker storage is '${DOCKER_DRIVER}' on '${DOCKER_BACKING_FS:-unknown}'; the disk quota needs overlay2 on xfs." >&2
  echo "[!] /var/lib/docker must be the XFS volume mounted with pquota (docs/LINUX_TEST_SESSION.md section 1), and" >&2
  echo "[!] ${DAEMON_JSON} must keep storage-driver overlay2 with the containerd snapshotter off (section 4b)." >&2
  echo "[!] Cloud Builds are refused until this passes." >&2
  exit 1
fi
QUOTA_IMAGE="$(grep -oE "synkro/rn-sandbox:[0-9]+" "${SYNKRO_HOME}/packages/agent/src/models/docker-sandbox.ts" 2>/dev/null | head -n 1 || true)"
if [[ "${REPO_READY}" != "true" || -z "${QUOTA_IMAGE}" ]] || ! docker image inspect "${QUOTA_IMAGE}" >/dev/null 2>&1; then
  echo "[!] WARNING: no sandbox image yet: disk quota enforcement NOT confirmed. Run this script again after cloning the repo."
else
  QUOTA_PROBE="synkro-quota-probe-$$"
  QUOTA_OUT="$(docker run --rm --name "${QUOTA_PROBE}" --network none --cap-drop=ALL --user=1000:1000 --storage-opt size=1G \
    "${QUOTA_IMAGE}" sh -c 'dd if=/dev/zero of=/tmp/quota-probe bs=1M count=2048 2>&1' 2>&1)" && QUOTA_RC=0 || QUOTA_RC=$?
  docker rm -f "${QUOTA_PROBE}" >/dev/null 2>&1 || true
  if [[ "${QUOTA_RC}" -eq 0 ]] || ! grep -qiE "No space left on device|Disk quota exceeded" <<<"${QUOTA_OUT}"; then
    echo "${QUOTA_OUT}" | tail -n 3
    echo "[!] FAILED: a container limited to 1G could write 2G (or the probe failed for another reason, output above)." >&2
    echo "[!] --storage-opt is NOT enforced; one build could fill the disk. Cloud Builds are refused until this passes." >&2
    exit 1
  fi
  echo "[+] Disk quota enforced: a 1G sandbox could not write 2G (overlay2 on xfs)."
fi

# 14. Shared READ-ONLY Gradle dependency cache for Cloud Build (DEC-08)
# The cache lives on the Docker volume (/var/lib/docker, XFS) so it can never fill the root disk where Postgres lives,
# and appears at ${GRADLE_RO_CACHE_DIR} through a bind mount, with its own 0755 permissions: the build worker (user
# ${SYNKRO_USER}) must see it, and it cannot traverse /var/lib/docker (0710). Builds mount <framework>/ read-only
# (DockerSandbox); without a cache, or without this mount, they run as before and download everything.
# scripts/warm-gradle-cache.sh fills it from a template build. Here it runs for a framework that has no cache yet;
# SYNKRO_WARM_GRADLE_CACHE=1 refreshes both (e.g. after SYNKRO_REBUILD_IMAGES=1), =0 skips it.
GRADLE_RO_CACHE_DIR="/var/lib/synkro/gradle-ro-cache"
GRADLE_RO_CACHE_STORE="/var/lib/docker/synkro-cache/gradle-ro"
if mountpoint -q /var/lib/docker; then
  install -d -m 0755 -o root -g root "${GRADLE_RO_CACHE_STORE}" "${GRADLE_RO_CACHE_DIR}"
  FSTAB_LINE="${GRADLE_RO_CACHE_STORE} ${GRADLE_RO_CACHE_DIR} none bind,nofail,x-systemd.requires-mounts-for=/var/lib/docker 0 0"
  if ! grep -qF " ${GRADLE_RO_CACHE_DIR} " /etc/fstab; then
    echo "${FSTAB_LINE}" >> /etc/fstab
    systemctl daemon-reload
  fi
  mountpoint -q "${GRADLE_RO_CACHE_DIR}" || mount "${GRADLE_RO_CACHE_DIR}"
  if [[ "${SYNKRO_WARM_GRADLE_CACHE:-}" == "0" ]]; then
    echo "[+] Gradle cache warm-up skipped (SYNKRO_WARM_GRADLE_CACHE=0)."
  elif [[ "${REPO_READY}" != "true" ]]; then
    echo "[!] Gradle cache warm-up skipped until the repo is in ${SYNKRO_HOME}."
  else
    WARM=()
    for FW in react-native flutter; do
      if [[ "${SYNKRO_WARM_GRADLE_CACHE:-}" == "1" || ! -d "${GRADLE_RO_CACHE_DIR}/${FW}/modules-2" ]]; then WARM+=("${FW}"); fi
    done
    if [[ ${#WARM[@]} -gt 0 ]]; then
      # Not fatal: without a cache, builds still work (slower).
      bash "${SYNKRO_HOME}/scripts/warm-gradle-cache.sh" "${WARM[@]}" || echo "[!] WARNING: Gradle cache warm-up failed (see above). Builds still work, without the cache."
    else
      echo "[+] Gradle read-only caches present (SYNKRO_WARM_GRADLE_CACHE=1 to refresh)."
    fi
  fi
else
  echo "[!] /var/lib/docker is not a separate volume: no shared Gradle cache (it must not fill the root disk)."
fi

# 15. Signing key warning
cat <<'WARNING'
==============================================================================
[!] SYNKRO_SIGNING_ENC_KEY (in the server .env) encrypts every app signing key.
    - Keep a copy OFF this server (e.g. the team password manager). If this
      server is lost and the key is gone, every user's signing key is gone
      too, and their apps can no longer be updated on Google Play.
    - Do not change it on a running system: a new key needs a re-encrypt
      step for every stored signing key first.
[!] DOWNLOAD_TOKEN_SECRET (in the server .env) signs the APK download links.
    The server does not start in production without it. Make one with:
        openssl rand -base64 48
    It must be its own value (not a session/JWT secret). Rotating it is safe:
    it only expires the download links already handed out.
==============================================================================
WARNING


echo "=============================================================================="
echo "[+] Synkro production server provisioning complete!"
echo "    App Directory:   ${SYNKRO_HOME}"
echo "    Service User:    ${SYNKRO_USER}"
echo "    Public Domain:   https://${SYNKRO_DOMAIN}"
echo "    Next Step: Clone repo into ${SYNKRO_HOME} and run DEPLOYMENT_RUNBOOK.md steps."
echo "=============================================================================="
