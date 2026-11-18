# Engine v2 — design notes (lessons from production)

Short lessons from real user problems, for the next version of the agent engine. Each one has:
- what happened;
- why the current engine let it through;
- what v2 should do by design.

---

## 2. Don't trust the project's generated platform folders: check them before the build (2026-11-18)

**What happened.** A user's Flutter project failed Cloud Build after 12 seconds with "Build failed due to use of deleted Android v1 embedding." Its android/ folder came from an old Flutter version. Our build command only ran `flutter create` when android/ was missing, so a present-but-outdated folder went straight to `flutter build apk`, which refuses it.

**Why the engine let it through.**
- The build treated "android/ exists" as "android/ is usable". Generated platform folders age with the toolchain: Flutter 3.44 refuses the v1 embedding (no `flutterEmbedding` = 2 in the manifest, `io.flutter.app.FlutterApplication`) and the Gradle plugin applied the old way (`apply from: .../flutter.gradle` now throws). Code that uses the deleted `io.flutter.app.FlutterActivity` passes Flutter's own check and then fails at compile time.
- The failure message is toolchain language. The user can't act on it, and nothing in the agent's loop could see a Cloud Build failure.

**What we did (v1).**
- **The sandbox checks android/ first** (`FLUTTER_ANDROID_FN`, `docker-sandbox.ts`). It uses the same rules as Flutter 3.44, plus the two it misses (old `MainActivity`, old Gradle setup, missing settings or app Gradle files). An outdated folder is moved aside in the sandbox copy only and generated again with our `--org`. The log gets "[SYSTEM] android/ was outdated (v1 embedding), regenerated it", and the build screen gets one plain sentence.
  - A current folder is kept as it is.
  - A missing `gradlew` alone is not a reason: Flutter's own `.gitignore` leaves it out and `flutter build` adds it. This was verified in the sandbox image.
- **A prompt rule** (`ANDROID FOLDER (Flutter)`): never hand-write android/; keep the v2 embedding when editing it.
- Checked on fixtures against the real Flutter 3.44 in `synkro/flutter-sandbox:2`. Each outdated variant was regenerated and then got past Flutter's check to Gradle. The valid ones were untouched.

**What v2 should do by design.**
- **Treat generated platform folders (android/, ios/) as build output, not source.** Keep only the user's real customizations (permissions, icons, signing, Firebase files) as data. Generate the folder fresh for the toolchain version in the image on every build, then apply the customizations. A toolchain upgrade then never breaks old projects.
- **Run a preflight before queuing a build**, on the desktop, in seconds: SDK and toolchain compatibility, platform-folder health, and dependency resolution. Fail fast with a fix the agent can apply, not after a slot on the build server.
- **Feed Cloud Build failures back to the agent** as structured errors (kind, file, line, suggested fix), the same way preview errors are fed back. The agent can then fix the project and rebuild without the user copying logs around.
- **Pin and record the toolchain version per build** (Flutter, Gradle, AGP) in the build log and job row, so "worked last month, fails today" is visible at once.
