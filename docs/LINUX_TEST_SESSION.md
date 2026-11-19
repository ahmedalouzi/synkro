# Linux test session: Cloud Build on a fresh DigitalOcean server

One session, before the beta, to check on real Linux what Docker Desktop cannot: the `build0` firewall
(iptables + ipset + dnsmasq), `--storage-opt`, the worker running as `synkro` without root, and signed
Flutter / React Native / Expo builds end to end. Tick each box and write the numbers in the results table.

Delete the server and its volume when done.

## 0. Before you start

- [ ] Droplet: Ubuntu 24.04, **at least 4 vCPU / 8 GB RAM** (one build uses 5 GB + the server), 25 GB disk is enough
      for the system.
- [ ] **A separate 100 GB Volume for Docker, formatted XFS.** `--storage-opt size=` (12G RN/Expo / 15G Flutter, `BUILD_DISK_LIMIT_GB`) only works on
      overlay2 over XFS mounted with `pquota`; on the default ext4 every build fails at `docker create`. Images alone are
      ~20 GB (flutter-sandbox 12 GB, rn-sandbox 7.4 GB).
- [ ] **Trap: Docker 29+ ignores `--storage-opt` with its default containerd image store** (`docker info` says
      `Storage Driver: overlayfs`, `driver-type: io.containerd.snapshotter.v1`). It accepts the option without an error,
      writes container layers under `/var/lib/containerd` on the root disk, and a "5G" build can fill the disk Postgres
      is on. The setup script switches Docker to the classic `overlay2` driver with the containerd snapshotter off
      (`/etc/docker/daemon.json`, DEC-06) and then checks for real that a 1G container cannot write 2G.
- [ ] An SSH key on the droplet; a test domain for Caddy is optional (the tests below call the API on `127.0.0.1:8080`).
- [ ] A real Android phone (arm64) for the install test; an older armv7 phone if you have one.
- [ ] Generate `SYNKRO_SIGNING_ENC_KEY` on your own machine (`openssl rand -base64 32`) and put it in the team password
      manager **first**. Use a throwaway one for this session if you prefer, but never reuse it later.

## 1. Disk for Docker (before installing Docker)

```bash
sudo mkfs.xfs /dev/disk/by-id/scsi-0DO_Volume_<name>
sudo mkdir -p /var/lib/docker
echo '/dev/disk/by-id/scsi-0DO_Volume_<name> /var/lib/docker xfs defaults,pquota,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a && mount | grep /var/lib/docker        # must show xfs and prjquota
```

## 2. Provision

- [ ] `sudo SYNKRO_DOMAIN=<domain or test.invalid> bash scripts/setup-production-server.sh` (first run: system, Docker,
      user `synkro`, Caddy; sections 11-12 are skipped because the repo is not there yet).
- [ ] `docker info | grep -E "Storage Driver|Backing Filesystem"` shows `overlay2` and `xfs` (not `overlayfs`: that is
      the containerd snapshotter, see the trap in section 0). `/etc/docker/daemon.json` has `"storage-driver": "overlay2"`
      and `"features": {"containerd-snapshotter": false}` (the script writes them).
- [ ] The second run ends with `[+] Disk quota enforced: a 1G sandbox could not write 2G`. If it says `FAILED`, Cloud
      Builds are refused (the worker logs `Disk quota NOT enforced`) until it passes. By hand:
      `docker run --rm --network none --storage-opt size=1G synkro/rn-sandbox:1 dd if=/dev/zero of=/tmp/x bs=1M count=2048`
      must stop with `No space left on device`.
- [ ] Clone the repo into `/opt/synkro` as `synkro`, then `pnpm install`.
- [ ] Run the script again: it builds `synkro/flutter-sandbox:2` and `synkro/rn-sandbox:1` (time it) and installs
      `synkro-build-network.service`.
- [ ] `id synkro` lists the `docker` group.

## 3. Environment (`/opt/synkro/.env`, owned by synkro, mode 600)

| Variable | Value for the session |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | a Postgres for the session (e.g. `docker compose -f docker-compose.test.yml up -d`) |
| `SYNKRO_SIGNING_ENC_KEY` | from step 0 |
| `DOWNLOAD_TOKEN_SECRET` | `openssl rand -base64 48` (its own value; signs the APK download links) |
| `ARTIFACT_DIR` | `/var/lib/synkro/artifacts` |
| `GOOGLE_API_KEY` | only if you also test the AI agent |

## 4. Firewall (as root)

- [ ] `systemctl status synkro-build-network` is `active (exited)`; its log ends with "only allowlisted names resolve (checked inside a synkro/rn-sandbox:1 container)".
- [ ] `ufw status` has the two "sandbox DNS" rules (in on build0 to 172.30.0.1 port 53, udp and tcp), and nothing else new.
- [ ] `dig @172.30.0.1 example.com` returns NXDOMAIN; `dig @172.30.0.1 registry.npmjs.org` returns an address. This runs from the host, so it passes even when ufw blocks the sandboxes; the next check is the one that counts.
- [ ] From a container, the way builds resolve (through Docker's embedded DNS):
  `docker run --rm --network build-restricted --dns 172.30.0.1 synkro/rn-sandbox:1 sh -c 'getent hosts registry.npmjs.org; getent hosts example.com || echo "example.com UNRESOLVED"'`
  prints an address for registry.npmjs.org and then `example.com UNRESOLVED`.
- [ ] `iptables -S DOCKER-USER | grep build0`: the last build0 rule is `-i build0 -j DROP`.
- [ ] `cd /opt/synkro/packages/agent && sudo SYNKRO_RUN_SANDBOX_TESTS=1 npx tsx tests/dns-allowlist.test.ts` passes (includes the in-sandbox check).
- [ ] `sudo SYNKRO_RUN_SANDBOX_TESTS=1 npx tsx tests/network-fqdn-distinction.test.ts` passes (DNS BAD must say NXDOMAIN, not "RESOLVED").
- [ ] All real-Docker sandbox tests (see "Sandbox integration tests" below) pass with `SYNKRO_RUN_SANDBOX_TESTS=1`.
- [ ] Reboot the droplet; after it comes back, repeat the first three checks (the service must re-apply everything).

## 5. Server boot without the signing key

- [ ] As synkro, start the server with `NODE_ENV=production` and **no** `SYNKRO_SIGNING_ENC_KEY`: it must exit with
      `[BOOT] SYNKRO_SIGNING_ENC_KEY is not set. Refusing to start.`
- [ ] Same with a 16-byte key (`openssl rand -base64 16`): exits with "must be 32 bytes".
- [ ] With the signing key but **no** `DOWNLOAD_TOKEN_SECRET`: exits with
      `[BOOT] DOWNLOAD_TOKEN_SECRET is not set (generate one with: openssl rand -base64 48). Refusing to start.`;
      with a short one (`openssl rand -base64 16`): exits with "shorter than 32 bytes".
- [ ] With both keys: starts; `pm2 start npx --name synkro-server -- tsx apps/server/src/index.ts` as synkro.
- [ ] `ps -o user= -p $(pgrep -f apps/server/src/index.ts)` prints `synkro` (the worker is not root).

## 6. Signed builds through the API (worker as synkro)

Sign up a test user, take its session token, and upload each project as the desktop does: a ZIP plus `framework`,
`target=apk` and a fixed `projectId` UUID (reuse it for the second build). For each build record the times
(npm install, prebuild, Gradle, total), the APK size, and run on the APK:

```bash
$BT/apksigner verify --print-certs app.apk      # signer must NOT be CN=Android Debug
$BT/aapt2 dump badging app.apk | grep -E "^package|native-code"
```

- [ ] **Flutter** (pubspec + lib/main.dart only; the sandbox runs `flutter create`), built **twice** with the same projectId.
- [ ] **Bare React Native** with its own `android/` (e.g. `npx @react-native-community/cli init RnTest --version 0.74.5`), twice.
- [ ] **Expo** from the Synkro template (no `android/`), twice.
- [ ] While a build runs: `docker inspect build_sandbox_<jobId> --format '{{.HostConfig.StorageOpt}}'` shows the size,
      and `--memory`, `--pids-limit=384`, `--cap-drop=ALL` are as before.
- [ ] Each APK's SHA-256 equals `signing_keys.cert_sha256` for its project; both builds of a project have the same one;
      `build_jobs.signing_cert_sha256` is set.
- [ ] `native-code` is **only** `arm64-v8a` for RN, Expo and Flutter (64-bit ARM, DEC-09: no armeabi-v7a, x86 or
      x86_64). A 32-bit-only phone cannot install it; that is the accepted trade-off.
- [ ] The build log has three `[CACHE]` lines after Gradle: how many dependencies were downloaded (not in the shared
      read-only cache), how many the cache offers, and where the disk went (Gradle caches/transforms, node_modules,
      android/).
- [ ] The first successful build of each project logs "If an older copy of this app is on your phone, uninstall it
      first"; the second does not.
- [ ] No build log, `docker inspect` output or server log contains a signing password.
- [ ] **oss.sonatype.org:** `journalctl -u dnsmasq` (or the dnsmasq log) shows it blocked during RN/Expo builds. If a
      build **fails** because of it, add it back to `ALLOWLISTED_FQDNS`, re-run the script (section 12 copies the
      allowlist), and rebuild.
- [ ] Install each APK on the phone (uninstall older copies first); a second build of the same project installs as an
      update over the first.

## 7. Keystore download endpoint

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"password":"<account password>"}' http://127.0.0.1:8080/api/build/signing/$PROJECT_ID/keystore
```

- [ ] Right password: 200, and `keytool -list -storetype PKCS12` opens the decoded keystore with the returned password.
- [ ] Token in `?token=` instead of the header: 401. Wrong password: 403. Another user's token: 404.
- [ ] The 6th attempt within an hour: 429.
- [ ] `pm2 logs` shows one `[KEYSTORE_DOWNLOAD] ... result=` line per attempt and no secrets.

## 8. Decisions after the numbers

- [ ] **Flutter over 15 minutes** on this server: raise `BUILD_TIMEOUT_MS.flutter` to 25 minutes (the reconciler
      follows automatically: longest timeout + 5).
- [ ] **React Native / Expo**: timeout is 35 minutes now (Expo measured 23-25 min); keep it until the pre-warmed image.
- [ ] oss.sonatype.org: stays out unless step 6 needed it.

## Sandbox integration tests

Ten suites run real Docker sandboxes: `concurrent-isolation`, `disk-exhaustion`, `dns-allowlist` (its in-sandbox
part), `expo-android-build`, `fork-bomb`, `fs-escape`, `gradle-ro-cache-sandbox` (the shared Gradle cache cannot be
written from a build), `memory-exhaustion`, `network-fqdn-distinction`, `timeout-zombie`. They need a Linux host with Docker, the `synkro/rn-sandbox:1` image and the `build-restricted`
network with the DNS allowlist (sections 2 and 4). `memory-exhaustion` and `network-fqdn-distinction` also need root
(dmesg, tcpdump), and `disk-exhaustion` needs an **enforced** `--storage-opt` (overlay2 on the XFS volume from
section 1; the requirement check writes 2G into a 1G container, so "Docker accepts the option" is not enough).

- Without them (CI, Windows, macOS) the suites are reported as **skipped** with what is missing, like the Postgres
  suites without a database (`tests/sandbox-requirements.ts`).
- With `SYNKRO_RUN_SANDBOX_TESTS=1` a missing piece is a **failure**, so they can't be skipped by accident on the server.

Run them on the server, as root, when no user build is running: the fork bomb, OOM and disk tests load the host.

```bash
cd /opt/synkro/packages/agent
sudo SYNKRO_RUN_SANDBOX_TESTS=1 npx tsx tests/test-runner.ts
```

Expected: the ten suites report `🟢 Passed`, none `🟡 Skipped`. The Postgres suites skip unless `DATABASE_URL` points
at a test database. One suite on its own: `sudo SYNKRO_RUN_SANDBOX_TESTS=1 npx tsx tests/fork-bomb.test.ts`.

## Shared read-only Gradle cache (DEC-08)

Builds mount `/var/lib/synkro/gradle-ro-cache/<framework>` read-only and point `GRADLE_RO_DEP_CACHE` at it, so Gradle
does not download every dependency again. The data is on the Docker volume (`/var/lib/docker/synkro-cache/gradle-ro`,
bind-mounted there by the setup script, section 14). Without it, builds work as before, only slower.

- [ ] After a reboot too: the bind mount is an `/etc/fstab` line (`bind,nofail,x-systemd.requires-mounts-for=/var/lib/docker`),
      so systemd mounts it after the Docker volume. If the volume is missing, boot is not blocked (`nofail`) and builds
      run without the cache.
- [ ] `mountpoint /var/lib/synkro/gradle-ro-cache` says it is a mountpoint; `ls -l /var/lib/synkro/gradle-ro-cache`
      shows `react-native` and `flutter` as symlinks into `.versions/`, all owned by root.
- [ ] Refresh by hand (e.g. after a new template): `sudo bash scripts/warm-gradle-cache.sh` (10-20 minutes per
      framework, one template build each). It keeps the current and the previous version.
- [ ] A build log starts with `[SYSTEM] Using the shared Gradle dependency cache (read-only).` and ends with the
      `[STEP]` times and `Disk used`.

## Gradle build cache in the RN image (DEC-11)

`synkro/rn-sandbox:1` contains Gradle's build cache and transforms from one release build of the Atomvs Expo template
(Dockerfile step 4), made at image build time with the same settings as real builds. Builds read it
(`org.gradle.caching=true`) and never write it (`push = false`, `init.d/atomvs-cache.gradle`). It is refreshed only by
rebuilding the image (`SYNKRO_REBUILD_IMAGES=1`), e.g. after changing the template's Expo SDK.
A missing or stale cache only means cache misses. Gradle 8.8 fails a build on an unreadable entry instead of
rebuilding it, so the image build refuses empty entries and `gradle_build` retries Gradle once with `--no-build-cache`
when the log shows a build-cache load error (`[SYSTEM] Build cache unreadable, retrying without it`).

- [ ] A real Expo build's Gradle output ends with `N actionable tasks: X executed, Y from cache` with Y well above 0.
- [ ] The image holds no signing material: `docker run --rm synkro/rn-sandbox:1 sh -c 'ls -a /tmp /tmp/.gradle; find / -xdev \( -name "*.jks" -o -name "*.keystore" -o -name "*.p12" \) 2>/dev/null'`
      lists no `.android` folder, no `gradle.properties` in `/tmp/.gradle`, and only the JDK's own `cacerts`-type stores, if any.

## 9. Teardown

- [ ] Destroy the droplet **and** the volume; revoke the SSH key; if a real `SYNKRO_SIGNING_ENC_KEY` was used, keep it
      only in the password manager.

## Results

| Build | npm | prebuild | Gradle | Total | APK MB | native-code | Cert SHA-256 (first 8) | Same cert on 2nd build |
|---|---|---|---|---|---|---|---|---|
| Flutter #1 / #2 | - | - | | | | | | |
| Bare RN #1 / #2 | | - | | | | | | |
| Expo #1 / #2 | | | | | | | | |

Local reference (Docker Desktop, 2 CPUs, Oct 29-30): Flutter 18.7 / 14.6 min, 42.4 MB; Expo 31.4 min on the pinned
community image and 26.2 min on `synkro/rn-sandbox:1`, 60.2 MB.
