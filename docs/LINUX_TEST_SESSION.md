# Linux test session: Cloud Build on a fresh DigitalOcean server

One session, before the beta, to check on real Linux what Docker Desktop cannot: the `build0` firewall
(iptables + ipset + dnsmasq), `--storage-opt`, the worker running as `synkro` without root, and signed
Flutter / React Native / Expo builds end to end. Tick each box and write the numbers in the results table.

Delete the server and its volume when done.

## 0. Before you start

- [ ] Droplet: Ubuntu 24.04, **at least 4 vCPU / 8 GB RAM** (one build uses 5 GB + the server), 25 GB disk is enough
      for the system.
- [ ] **A separate 100 GB Volume for Docker, formatted XFS.** `--storage-opt size=` (5G RN / 15G Flutter) only works on
      overlay2 over XFS mounted with `pquota`; on the default ext4 every build fails at `docker create`. Images alone are
      ~20 GB (flutter-sandbox 12 GB, rn-sandbox 7.4 GB).
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
- [ ] `docker info | grep -E "Storage Driver|Backing Filesystem"` shows `overlay2` and `xfs`.
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
| `ARTIFACT_DIR` | `/var/lib/synkro/artifacts` |
| `GOOGLE_API_KEY` | only if you also test the AI agent |

## 4. Firewall (as root)

- [ ] `systemctl status synkro-build-network` is `active (exited)`; its log ends with "only allowlisted names resolve".
- [ ] `dig @172.30.0.1 example.com` returns NXDOMAIN; `dig @172.30.0.1 registry.npmjs.org` returns an address.
- [ ] `iptables -S DOCKER-USER | grep build0`: the last build0 rule is `-i build0 -j DROP`.
- [ ] `cd /opt/synkro/packages/agent && sudo npx tsx tests/dns-allowlist.test.ts` passes (includes the in-sandbox check).
- [ ] `sudo npx tsx tests/network-fqdn-distinction.test.ts` passes (DNS BAD must say NXDOMAIN, not "RESOLVED").
- [ ] Reboot the droplet; after it comes back, repeat the first three checks (the service must re-apply everything).

## 5. Server boot without the signing key

- [ ] As synkro, start the server with `NODE_ENV=production` and **no** `SYNKRO_SIGNING_ENC_KEY`: it must exit with
      `[BOOT] SYNKRO_SIGNING_ENC_KEY is not set. Refusing to start.`
- [ ] Same with a 16-byte key (`openssl rand -base64 16`): exits with "must be 32 bytes".
- [ ] With the real key: starts; `pm2 start npx --name synkro-server -- tsx apps/server/src/index.ts` as synkro.
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
- [ ] `native-code` includes **both** `arm64-v8a` and `armeabi-v7a` for RN and Expo (x86 / x86_64 are still there too:
      shrinking the APK is a post-beta item on the pre-warmed image card).
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
- [ ] **React Native / Expo**: if well under 45 minutes with `rn-sandbox:1`, lower its timeout (temporary value).
- [ ] oss.sonatype.org: stays out unless step 6 needed it.

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
