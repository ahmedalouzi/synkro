# Synkro Desktop Release Packaging Runbook

This document details the exact process for building, signing, validating, and distributing production installers for Synkro Desktop (`com.synkro.desktop`) on Windows and macOS.

---

## 1. Production Build Commands

All release packaging commands run from the root or the `apps/desktop` package directory using `pnpm`.

### Environment Preparation
Copy `apps/desktop/.env.production.example` to `apps/desktop/.env` and verify gateway URL:
```bash
cp apps/desktop/.env.production.example apps/desktop/.env
# Verify SYNKRO_GATEWAY_URL=https://api.synkro.com
```

### Packaging Commands
| Target Platform | Package Manager Command | Output Artifact |
|---|---|---|
| **Windows (x64)** | `pnpm --filter @peep/desktop build:win` | `apps/desktop/release/Synkro Setup <version>.exe` |
| **macOS (Universal/Apple Silicon/x64)** | `pnpm --filter @peep/desktop build:mac` | `apps/desktop/release/Synkro-<version>.dmg`, `.zip` |
| **Current Host Platform** | `pnpm package` | Local platform target binary |

---

## 2. Code Signing & Gatekeeper / SmartScreen Handling

### 2.1 Windows Code Signing
For production releases, sign the installer and executables with an EV or Standard Code Signing Certificate:
```powershell
# Set environment variables for electron-builder / signtool
$env:CSC_LINK = "path/to/certificate.pfx"
$env:CSC_KEY_PASSWORD = "CertPassword"

pnpm --filter @peep/desktop build:win
```

#### SmartScreen First-Cohort User Instructions (Unsigned / New Cert)
Until reputation is established in Microsoft SmartScreen, Windows Defender prompts with "Windows protected your PC":
1. Instruct cohort users to click **"More info"**.
2. Click **"Run anyway"**.
3. The Synkro NSIS installer runs cleanly.

### 2.2 macOS Code Signing & Notarization
Prerequisites: Apple Developer Account ($99/yr), Developer ID Application Certificate, and App-Specific Password.
```bash
export CSC_NAME="Developer ID Application: Your Org (TEAMID)"
export APPLE_ID="developer@synkro.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="TEAMID1234"

pnpm --filter @peep/desktop build:mac
```

#### macOS Gatekeeper Instructions (Unsigned Builds)
If testing an unsigned `.dmg` build on macOS:
1. Open Terminal and run:
   ```bash
   xattr -d com.apple.quarantine /Applications/Synkro.app
   ```
2. Or navigate to **System Settings > Privacy & Security**, scroll down to the security section, and click **"Open Anyway"**.

---

## 3. Clean-Machine Validation Checklist

Before publishing any release to GitHub or notifying the first cohort, verify the installer on a pristine VM or test machine:

- [ ] **Installer Execution**: Installer executes without unhandled errors or missing DLL dependencies (VC++ runtime, conpty).
- [ ] **Installation Directory**: NSIS custom directory selector functions and installs to `%LOCALAPPDATA%\Programs\Synkro` (user-level without admin prompts).
- [ ] **Desktop & Start Menu Shortcuts**: Desktop shortcut and Start Menu entry created with correct Synkro icon.
- [ ] **First Launch**: Application boots within 3 seconds, shows loading state, and transitions to workspace.
- [ ] **DevTools Disabled**: Chrome DevTools are NOT opened automatically on launch in production mode.
- [ ] **Production Gateway Connection**: Verify network requests hit `https://api.synkro.com` (no `localhost` or dev mocks).
- [ ] **Integrated Terminal**: Embedded xterm terminal spawns shell (`powershell.exe` on Windows / `bash` on macOS) via `@lydell/node-pty`.
- [ ] **Uninstallation**: Control Panel / Settings "Uninstall Synkro" cleanly removes binary directory while retaining user workspaces.

---

## 4. SHA-256 Checksum Generation

Generate cryptographic checksums for all release binaries prior to distribution:

### Linux / macOS
```bash
cd apps/desktop/release
sha256sum *.{exe,dmg,zip,blockmap} > SHA256SUMS.txt
```

### Windows (PowerShell)
```powershell
cd apps/desktop/release
Get-FileHash -Algorithm SHA256 *.exe, *.dmg, *.zip | ForEach-Object { "$($_.Hash.ToLower())  $($_.Path | Split-Path -Leaf)" } | Out-File -Encoding utf8 SHA256SUMS.txt
```

---

## 5. GitHub Releases Publishing & Auto-Updater Compatibility

Synkro uses `electron-updater` with the GitHub provider configured in `electron-builder.yml`:
```yaml
publish:
  provider: github
  owner: ahmedalouzi
  repo: synkro
```

### Publishing Steps:
1. Ensure `apps/desktop/package.json` version is bumped (e.g. `0.1.0` -> `0.1.1`).
2. Commit and tag release:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. Create a GitHub Release in the repository corresponding to tag `v0.1.0`.
4. Upload all build assets from `apps/desktop/release/`:
   - `Synkro Setup 0.1.0.exe` (Installer)
   - `Synkro Setup 0.1.0.exe.blockmap` (Delta updater)
   - `latest.yml` (Windows update metadata — **REQUIRED** for auto-updater)
   - `Synkro-0.1.0.dmg`
   - `Synkro-0.1.0-mac.zip`
   - `latest-mac.yml` (macOS update metadata — **REQUIRED** for auto-updater)
   - `SHA256SUMS.txt` (Integrity checksums)
5. Publish release as public or draft for cohort staging.
