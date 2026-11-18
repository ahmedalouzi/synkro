# Engine v2 — design notes (lessons from production)

Short lessons from real user problems, for the next version of the agent engine. Each one has:
- what happened;
- why the current engine let it through;
- what v2 should do by design.

---

## 1. Rules in the prompt are not enough: check the result on screen (2026-11-18)

**What happened.** A user's Expo app (SDK 51) showed its bottom tab bar as icons only: the labels ("Ana Sayfa", "Etkinlikler", …) were missing or cut in half. The user thought the app was broken. The cause was in the generated app, not in Atomvs:

- `tabBarStyle: { height: 60, paddingBottom: 8, paddingTop: 8 }`. A fixed height plus a padding that **replaces** the bottom safe-area inset React Navigation adds. The bar ignored the home indicator (34pt on iPhone, ~24dp on Android), and the labels were squashed to 5px.
- `@react-navigation/*@^7` on Expo SDK 51. v7 needs react-native-screens 4 (SDK 52+). It was installed past the peer-dependency error (`--legacy-peer-deps`). On the web its tab labels are cut by about a third even without the fixed height. With v6 and no fixed height, the labels are whole and the bar sits above the home indicator.

**Why the engine let it through.**
- The prompt already said "On Expo SDK 51 use React Navigation 6" and "never use --legacy-peer-deps". The agent still installed v7.
- Nothing told it the screen looked wrong. The preview's checks covered errors and an empty screen, not layout. The app built, ran, showed content and threw nothing, so the agent's verify step passed.

**What we did (v1).**
- **A prompt rule** (`SAFE AREAS (React Native / Expo)`): no fixed `height`/`paddingBottom` in `tabBarStyle`; use `useSafeAreaInsets()` + `insets.bottom` if a custom height is needed; React Navigation 6 on SDK 51.
- **A runtime layout check** in the preview shim (`tabBarLayoutIssues`, `@peep/shared`). It measures bottom tab bars (`[role=tablist]`) in the page against the device's inset and reports two kinds of problem through `get_preview_logs` / `restart_preview`, as "Layout problems on screen":
  - tabs under the home-indicator area;
  - labels smaller than their text.

  The agent's verify step treats those as failures.
- Verified on a copy of the user's app: both problems reported for the original, none after the fix.

**What v2 should do by design.**
- **Verify what the user sees, not only what the toolchain says.** Every generated screen gets a structural layout check after each change: safe areas, clipped text, overlapping or off-screen controls, tap targets under system bars. Results feed the agent's loop like compiler errors.
- **Make the layout checks a library of measurable rules**, each with a clear fix hint, run in the preview for each device frame (insets differ per device). Tab bars are the first rule; headers under the status bar / Dynamic Island, FABs under the home indicator, and keyboard overlap are next.
- **Enforce dependency rules mechanically, not only in prose.** Refuse `--legacy-peer-deps` / `--force` in `run_command` for Expo projects, and check installed majors against the project's SDK (`expo install --check`, `npm ls` "invalid") before the turn ends. A rule the model can ignore will eventually be ignored.
- **Prefer platform defaults in generated code.** Fixed sizes for system-adjacent UI (tab bars, headers, status-bar areas) should be a lint error unless the code also reads the safe-area insets.

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
