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
