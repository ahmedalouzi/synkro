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
SYNKRO_DOMAIN="${SYNKRO_DOMAIN:-api.synkro.com}"
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

# 10. Pre-build Cloud Build Sandbox Docker Images
echo "[+] Checking Cloud Build sandbox Docker images..."
if [ -d "${SYNKRO_HOME}/infra/docker" ]; then
  echo "    Building synkro/flutter-sandbox:2..."
  docker build -t synkro/flutter-sandbox:2 -f "${SYNKRO_HOME}/infra/docker/Dockerfile.flutter-sandbox" "${SYNKRO_HOME}/infra/docker"

  echo "    Building synkro/rn-sandbox:1..."
  docker build -t synkro/rn-sandbox:1 -f "${SYNKRO_HOME}/infra/docker/Dockerfile.rn-sandbox" "${SYNKRO_HOME}/infra/docker"
  echo "[+] Cloud Build sandbox images built and tagged successfully."
else
  echo "[!] INFO: ${SYNKRO_HOME}/infra/docker not found yet. Sandbox images will be built during first deploy."
fi

echo "=============================================================================="
echo "[+] Synkro production server provisioning complete!"
echo "    App Directory:   ${SYNKRO_HOME}"
echo "    Service User:    ${SYNKRO_USER}"
echo "    Public Domain:   https://${SYNKRO_DOMAIN}"
echo "    Next Step: Clone repo into ${SYNKRO_HOME} and run DEPLOYMENT_RUNBOOK.md steps."
echo "=============================================================================="
