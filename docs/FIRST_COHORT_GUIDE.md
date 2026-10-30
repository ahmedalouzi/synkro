# Welcome to Atomvs — First-Cohort Developer & Data-Handling Guide

Welcome to the Atomvs Alpha Cohort! Atomvs is the AI-native desktop IDE designed specifically for mobile and web cross-platform engineering (Flutter and React Native).

This guide walks you through setup, our core workflows, supported frameworks, and our transparent privacy and data-handling policies.

---

## 1. Quick Setup & Account Onboarding

### 1.1 Download & Install
1. Download the latest installer from the official release link provided in your cohort invitation:
   - **Windows**: `Atomvs Setup <version>.exe`
   - **macOS**: `Atomvs-<version>.dmg`
2. Run the installer:
   - *Windows Note*: If prompted by Windows Defender SmartScreen ("Windows protected your PC"), click **"More info"** and then **"Run anyway"**.
   - *macOS Note*: If prompted by Gatekeeper, right-click and open, or go to **System Settings > Privacy & Security > Open Anyway**.
3. Launch Atomvs from your Start Menu or Applications folder.

### 1.2 Sign In & Token Authentication
- Open Atomvs and sign in with your cohort account credentials, or create a new account directly from the onboarding prompt.
- Your session is securely stored in local OS-level encrypted storage and connects directly to the Atomvs Gateway (`https://api.atomvs.com`).

---

## 2. Supported Frameworks & Scope

| Framework | Target Platforms | Local Live Preview | Cloud Build Output |
|---|---|---|---|
| **Flutter** | Android, Web | Embedded Web / Hot Reload | Signed / Unsigned APK, AAB |
| **React Native (Expo)** | Android, Web | Metro / Expo Web Canvas | APK, AAB |
| **React Native (CLI)** | Android | Metro Bundler | APK |

*Note: iOS device compilation via Cloud Build is planned for upcoming cohorts.*

---

## 3. Transparent Data-Handling, Security & Privacy Facts

We believe developer tools must have complete privacy transparency. Here is exactly how Atomvs handles your code and data:

### 3.1 AI Code Context
- **Selective Transmission**: Atomvs transmits code snippets to LLM providers (Google Gemini, Anthropic Claude, OpenAI) **only when you explicitly trigger an AI action** (chat message, code generation, refactor, or tab completion).
- **No Background Indexing**: Atomvs **never** silently uploads your entire repository or unreferenced files.
- **Zero Model Training**: Atomvs's commercial enterprise API agreements with AI providers guarantee that **your code is never used to train or fine-tune public AI models**.

### 3.2 Cloud Build Uploads & Sandboxing
- **Secure Transfer**: When you click **"Cloud Build"**, your project files are zipped locally and sent over encrypted TLS 1.3 to our dedicated build cluster.
- **Strict Ephemeral Sandboxes**: Builds run inside isolated, disposable Docker containers (`DockerSandbox`) with non-root privileges and strict resource limits.
- **Immediate Disk Wipe**: Build workspace directories on the build server are permanently destroyed as soon as the build finishes or times out.

### 3.3 Artifact & APK Retention Policy
- **Free Tier**: Compiled binaries (APK/AAB) are retained for download for **24 hours**, after which they are permanently deleted from disk and storage.
- **Pro / Paid Tiers**: Compiled binaries are retained for **7 days**, after which they are automatically purged.
- You can manually delete any build artifact at any time from the Build History pane.

### 3.4 Telemetry & Sentry Error Scrubbing
- **Opt-in Telemetry**: Usage metrics are completely anonymized and can be toggled off under **Settings > Privacy**.
- **Secret Scrubbing**: Crash reports sent to Sentry automatically scrub all environment variables, API keys, Bearer tokens, and file paths before leaving your machine.

---

## 4. First-Run Walkthrough: Building Your First App

1. **Open a Project**: Click **"Open Folder"** and select any existing Flutter or React Native project (or create a sample project from the templates).
2. **Code & Visual Editing**: Use the Monaco-powered editor with syntax highlighting, IntelliSense, and multi-cursor editing.
3. **AI Assistant & Claude Code Bridge**:
   - Open the AI panel on the right sidebar (`Ctrl+L` or `Cmd+L`).
   - Ask Atomvs to generate components, fix bugs, or optimize state management.
   - Use the built-in terminal to interact with `claude-code` or the Flutter/React Native CLI directly.
4. **Cloud Build Deployment**:
   - Navigate to the **Build** tab.
   - Choose your target (`APK` or `AAB`) and click **"Start Cloud Build"**.
   - Stream live compiler logs directly in real time.
   - Once completed, click **"Download APK"** or scan the generated QR code to install directly onto your test Android device.

---

## 5. Feedback & Support Channels

As part of the initial cohort, your feedback directly shapes Atomvs's roadmap:

- **Community**: coming soon.
- **Issue Tracker**: Submit bug reports and feature requests on [GitHub Issues](https://github.com/ahmedalouzi/synkro/issues).
- **Direct Email**: Reach our engineering team directly at `support@atomvs.com`.
