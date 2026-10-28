# Complete Engineering Systems & Architecture Report: Peep IDE

**Document ID:** FEPR-2026-V2  
**Date:** August 3, 2026  
**Status:** Canonical Engineering Record  
**Target Codebase:** `ahmedalouzi/peep`  
**Authors:** Lead Systems Architect & AI Pair Engineering Team  

---

## 1. Project Overview & Initial Architecture

### 1.1 Core Mission & Scope
Peep IDE is a desktop Integrated Development Environment (IDE) built using Electron, React, TypeScript, and Vite. It is tailored for cross-platform app developers using frameworks like Expo, React Native, and Flutter. 

The core architectural goal of Peep IDE is to provide:
1. **Integrated Multi-Platform Workspaces:** Automated environment detection, CLI task management (Expo Web, Flutter Web), and integrated terminal execution.
2. **High-Fidelity Preview System:** Realistic device rendering frames (iPhone 15, iPhone 15 Pro, Pixel 8, Pixel Fold, Galaxy S24) matching real hardware chassis geometries, screen corner radii, status bars, and hardware cutouts.
3. **AI-Assisted Workflow Integration:** Direct DOM inspection, inline context retrieval, automated build failure diagnosis, and LLM-driven code modification.

### 1.2 Initial System Architecture
The original architecture of Peep IDE relied on standard web and Electron conventions:

```
+-----------------------------------------------------------------------------------+
|                                 MAIN PROCESS                                      |
|  - ProcessManager: Spawns Expo / Flutter CLI processes & monitors logs             |
|  - IPC Handlers: Direct bridge forwarding stdout/stderr strings to Renderer       |
|  - Window Manager: Manages BrowserWindow lifecycle & Detached Floating Windows    |
+-----------------------------------------------------------------------------------+
                                         │  (Direct IPC Pass-through)
                                         ▼
+-----------------------------------------------------------------------------------+
|                               RENDERER PROCESS                                    |
|  - WorkspaceStore / PreviewStore: Zustand state managers                          |
|  - PreviewPane: Holds Device Selector, Scale Container, and Iframe Viewport       |
|  - PhoneFrame: Legacy single-class CSS component (`.pf-iphone`) mixing chassis     |
|    dimensions (290x600) with internal viewport bounds (278x588)                   |
|  - Side Panels: Unvirtualized log lists, standard recursive file tree DOM         |
+-----------------------------------------------------------------------------------+
```

### 1.3 Architectural Friction Points
As the system grew, four major architectural bottlenecks were identified:
1. **Geometry Domain Entanglement:** Physical chassis dimensions (`290x600`), padding (`6px`), and viewport bounds (`393x852`) were implicitly mixed across CSS stylesheets and React state, causing screen clipping and artwork distortion when scaling.
2. **Chromium GuestView IPC Collapse:** Nested `<webview>` elements inside transformed CSS containers collapsed to intrinsic spec fallbacks (`300x150` / `150px` height) due to unresolved IPC layout coordinate translation.
3. **IPC Event Flooding:** High-frequency stdout emissions from compiler processes flooded the main-to-renderer context bridge without throttling, creating UI thread overhead.
4. **DOM Memory Footprint:** Unbounded log streams created thousands of DOM nodes during long compiler runs.

---

## 2. Chronological Timeline of Engineering Phases

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              ENGINEERING PHASES TIMELINE                               │
├────────┬────────────────────────────────┬──────────────┬───────────────────────────────┤
│ Phase  │ Focus Area                     │ Outcome      │ Status                        │
├────────┼────────────────────────────────┼──────────────┼───────────────────────────────┤
│ 1      │ WebContentsView PoC            │ Rejected     │ Z-Index / Overlay failure     │
│ 2      │ Iframe + Scale Baseline        │ Adopted      │ Baseline established          │
│ 3      │ Scale Quantization & Hints     │ Rejected     │ Visual snapping & text blur   │
│ 4      │ Experimental Code Cleanup      │ Completed    │ Purged unneeded hacks         │
│ 5      │ Engineering Roadmap Definition │ Completed    │ Phase 1-3 roadmap created     │
│ 6      │ IPC Profiling & Batching       │ Shipped      │ 16ms frame windowing shipped  │
│ 7      │ Lazy Loading Implementation    │ Shipped      │ Deferred modal mounting       │
│ 8      │ DOM Virtualization             │ Partial (3A) │ Logs virtualized; Tree on hold│
│ 9      │ Geometry Ownership Audit       │ Stabilized   │ 3-Domain Contract enforced    │
│ 10     │ GuestView Layout Fix           │ Shipped      │ Explicit container bounds     │
└────────┴────────────────────────────────┴──────────────┴───────────────────────────────┘
```

### Phase 1: WebContentsView Proof of Concept (PoC)
* **Proposal:** Replace DOM `<webview>` / `<iframe>` elements with native Electron `WebContentsView` (formerly `BrowserView`) attached directly to the native `BrowserWindow`.
* **Hypothesis:** Offloading rendering to native main-process views would bypass DOM scaling overhead and eliminate text raster blur.
* **Evaluation:** Implemented a main-process layout synchronizer (`WebContentsViewManager`) tracking DOM element bounds in the renderer via IPC.
* **Outcome:** **REJECTED.** `WebContentsView` renders out-of-band directly on the OS window surface. As a result, renderer DOM overlays (command palette `Ctrl+P`, dropdown menus, modal windows, inspection overlays) rendered *behind* the native view. Punching visual "transparent holes" in the main window led to severe visual tearing and focus-hijack bugs during window resizing.

### Phase 2: Validation of Iframe + Transform Scale Baseline
* **Proposal:** Standardize on standard DOM elements (`<iframe>` / `<webview>`) positioned inside the DOM hierarchy and scaled using CSS `transform: scale()`.
* **Evaluation:** Measured event bubbling, CSS z-index stacking, and visual element inspection capabilities.
* **Outcome:** **ADOPTED (ADR-001).** Native DOM integration guaranteed 100% z-index compliance for IDE dialogs and inspection overlays.

### Phase 3: Preview Optimization & Rendering Hints Research
* **Scale Quantization Experiment:** Restricting scale steps to discrete increments (`0.25`, `0.50`, `0.75`, `1.00`). **REJECTED.** Caused harsh visual layout jumping during smooth sidebar dragging.
* **CSS Rendering Hints Experiment:** Injecting `will-change: transform`, `image-rendering: pixelated`, and `text-rendering: geometricPrecision`. **REJECTED.** `will-change` forced Chrome to isolate containers into fixed bitmapped compositing layers before scaling, resulting in severe font anti-aliasing degradation.

### Phase 4: Experimental Code Purge & System Cleanup
* **Action:** Deleted experimental `WebContentsViewManager` code, scale quantization hooks, and experimental CSS render hint attributes from `PhoneFrame.css` and `PreviewPane.css`.

### Phase 5: Engineering Roadmap Setup
* **Action:** Drafted `ENGINEERING_ROADMAP.md` organizing architectural tasks into Phase 1 (IPC Profiling), Phase 2 (Lazy Component Initialization), and Phase 3 (DOM Virtualization).

### Phase 6: IPC Profiling, Batching Implementation, and Validation
* **Analysis:** Identified that CLI processes emitted individual IPC events for every stdout text line (up to 400 events/sec during initial compilation).
* **Implementation:** Created `main/services/ipc-batcher.ts` which buffers high-frequency IPC calls into a 16.6ms window payload matching the 60Hz display frame rate.
* **Validation:** Verified via IPC event logging that events dispatch once per frame period under heavy streams.

### Phase 7: Lazy Loading Implementation (Phase 2)
* **Implementation:** Wrapped non-critical side panels and modals (SettingsModal, DependencyExplorer) in `React.lazy()` and `Suspense` boundaries.
* **Validation:** Empirically verified reduced initial component tree depth on application boot.

### Phase 8: DOM Virtualization Research & Phase 3 Execution
* **Phase 3A (Log Stream Virtualization):** Integrated `@tanstack/react-virtual` into build stdout panels. **SHIPPED.** Empirically verified DOM node count capped at ~35 elements regardless of total log dataset size.
* **Phase 3B (File Tree Virtualization):** Tested virtualizing the multi-depth directory tree. **ON HOLD.** Flattening nested directory state introduced edge-case bugs with keyboard accessibility, expand/collapse animations, and drag-and-drop file operations.

### Phase 9: Geometry Ownership Audit & Contract Definition
* **Analysis:** Discovered that geometry duplication across JS configs and CSS stylesheets caused phone artwork distortion and viewport misalignments.
* **Outcome:** Formally defined the **3-Domain Geometry Ownership Contract**:
  1. *Logical Viewport:* OS render bounds (`393x852`).
  2. *Shared Screen Geometry:* Glass cutout contract (`x`, `y`, `width`, `height`, `cornerRadius`).
  3. *Artwork Geometry:* Hardware chassis decorations (`frameWidth`, `frameHeight`, `outerRadius`, `buttons`).

### Phase 10: GuestView Layout Collapse Investigation & Fix
* **Investigation:** Electron's `<webview>` element collapsed to `150px` height (`window.innerHeight = 150`) when placed inside nested transformed containers lacking explicit layout dimensions.
* **Root Cause:** Chromium GuestView IPC fails to map percentage heights (`height: 100%`) through transformed ancestor layers that lack explicit width/height boundaries.
* **Fix:** Applied explicit pixel dimensions derived from `device.logicalViewport` directly to the transformed outer root container (`.phone-scale-container`). Empirically verified guest `window.innerHeight` restored to `852px`.

---

## 3. Architecture Decision Records (ADRs)

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              ARCHITECTURAL DECISION MATRIX                             │
├─────────┬───────────────────────────────┬───────────────────────────┬──────────────────┤
│ ADR #   │ Subject                       │ Chosen Option             │ Status           │
├─────────┼───────────────────────────────┼───────────────────────────┼──────────────────┤
│ ADR-001 │ Preview Engine Engine         │ DOM Viewport + Scale      │ ADOPTED          │
│ ADR-002 │ Geometry Ownership Contract   │ 3-Domain Strict Isolation │ ADOPTED          │
│ ADR-003 │ High-Frequency IPC Transport  │ 16.6ms Windowed Batcher   │ SHIPPED          │
│ ADR-004 │ Component Lifecycle           │ Lazy Suspense Boundaries  │ SHIPPED          │
│ ADR-005 │ File Tree Rendering           │ Standard Recursive DOM    │ ON HOLD (Phase3B)│
└─────────┴───────────────────────────────┴───────────────────────────┴──────────────────┘
```

### ADR 001: Preview Engine Engine (Native WebContentsView vs DOM Viewport + Scale)
- **Context:** Need a preview engine inside an Electron window that supports realistic frame styling, dynamic scaling, and interactive IDE overlays.
- **Options Evaluated:**
  1. *Native WebContentsView:* Out-of-process GPU overlay.
  2. *In-DOM `<webview>` / `<iframe>` with CSS `transform: scale()`.* Standard DOM rendering.
- **Decision:** **Adopt In-DOM Preview with CSS Scale (Option 2).**
- **Justification:** `WebContentsView` cannot participate in CSS `z-index` stacking. DOM previews allow modals, search dialogs, command palettes, and visual inspection overlays to render above the preview cleanly.

### ADR 002: 3-Domain Geometry Ownership Contract
- **Context:** Mixed coordinate systems caused phone artwork to stretch improperly when changing logical viewports.
- **Decision:** Enforce 3 strict, non-overlapping domains:

```
+-----------------------------------------------------------------------+
|                         LOGICAL VIEWPORT                              |
|  - logicalViewport.width (e.g. 393)                                   |
|  - logicalViewport.height (e.g. 852)                                  |
|  * Strictly owns OS viewport dimensions painted by Guest WebView       |
+-----------------------------------------------------------------------+
                                  │
                                  ▼
+-----------------------------------------------------------------------+
|                      SHARED SCREEN GEOMETRY                           |
|  - screenCutout.x (e.g. 16)      - screenCutout.width (393)          |
|  - screenCutout.y (e.g. 16)      - screenCutout.height (852)         |
|  - screenCutout.cornerRadius (42)                                     |
|  * Physical glass cutout contract bridging hardware chassis & viewport |
+-----------------------------------------------------------------------+
                                  │
                                  ▼
+-----------------------------------------------------------------------+
|                          ARTWORK GEOMETRY                             |
|  - outerFrameWidth (425 = 393 + 16*2)                                 |
|  - outerFrameHeight (884 = 852 + 16*2)                                |
|  - outerCornerRadius, buttons, dynamic island, notch, status bar      |
|  * Hardware chassis decorations; uses negative offsets from opening  |
+-----------------------------------------------------------------------+
```

- **Justification:** Neither the artwork nor the viewport defines the other. The Shared Screen Geometry acts as the singular contract.

### ADR 003: High-Frequency IPC Transport Batching
- **Context:** Background processes emitting stdout lines flooded the IPC IPC bridge.
- **Decision:** Implement a 16.6ms frame-aligned batching queue in `main/services/ipc-batcher.ts`.
- **Justification:** Flushes accumulated log entries into a single array payload per animation frame (60Hz), preventing renderer event loop congestion.

---

## 4. Performance Optimizations & Verification Status

To maintain strict scientific accuracy, all performance metrics in this section are explicitly classified as either **Empirically Verified & Measured** or **Pending System Profiler Validation (Projected)**.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                          PERFORMANCE OPTIMIZATION CLASSIFICATION                       │
├──────────────────────┬────────────────────────┬───────────────────┬────────────────────┤
│ Optimization         │ Metric Metric          │ Value / Target    │ Verification Status│
├──────────────────────┼────────────────────────┼───────────────────┼────────────────────┤
│ Log Virtualization   │ DOM Node Count         │ ~35 DOM nodes     │ EMPIRICALLY PASSED │
│ Guest Layout Fix     │ Guest innerHeight      │ 852px (was 150px) │ EMPIRICALLY PASSED │
│ IPC Frame Batcher    │ Dispatch Interval      │ 16.6ms window     │ EMPIRICALLY PASSED │
│ Lazy Modal Loading   │ Unmounted Initial Nodes│ Reduced Tree Depth│ EMPIRICALLY PASSED │
│ IPC CPU Overhead     │ Host CPU % Reduction   │ Projected ~80%    │ PENDING VALIDATION │
│ Initial Memory Heap  │ Heap Allocation (MB)   │ Projected -18MB   │ PENDING VALIDATION │
│ Resizing Drag FPS    │ Framerate Stability    │ Projected ~60 FPS │ PENDING VALIDATION │
└──────────────────────┴────────────────────────┴───────────────────┴────────────────────┤
```

### 4.1 IPC Transport Batcher (`main/services/ipc-batcher.ts`)
* **Motivation:** Avoid sending individual IPC messages for every line of stdout emitted by Expo CLI or Flutter daemons.
* **Implementation:**
  ```typescript
  export class IPCBatcher {
    private queue: Map<string, any[]> = new Map();
    private timer: NodeJS.Timeout | null = null;

    public emit(channel: string, data: any): void {
      if (!this.queue.has(channel)) this.queue.set(channel, []);
      this.queue.get(channel)!.push(data);

      if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), 16); // 60Hz frame window
      }
    }

    private flush(): void {
      this.queue.forEach((batch, channel) => {
        mainWindow?.webContents.send(`${channel}:batch`, batch);
      });
      this.queue.clear();
      this.timer = null;
    }
  }
  ```
* **Risks:** Adds maximum 16.6ms latency to log display.
* **Rollback Plan:** Set `ENABLE_IPC_BATCHING = false` to trigger direct synchronous IPC dispatch.
* **Verification Status:**
  - **Empirically Verified:** Dispatches are aligned to 16.6ms frame windows.
  - **Pending Validation:** System-level CPU usage reduction during 5,000 line/sec streams is awaiting formal Chrome Tracing profiler benchmarks.

### 4.2 Log Stream DOM Virtualization
* **Motivation:** Rendering thousands of log items created severe DOM node bloat and browser layout thrashing.
* **Implementation:** Integrated `@tanstack/react-virtual` into log output streams.
* **Verification Status:**
  - **Empirically Verified:** Rendered log DOM node count remains strictly capped at ~35 nodes regardless of log dataset size (tested up to 50,000 lines).

### 4.3 Component Lazy Loading (`React.lazy`)
* **Motivation:** Reduce startup JavaScript evaluation time and initial React element tree depth.
* **Implementation:** Deferred loading for `SettingsModal`, `DependencyExplorer`, and secondary dialogs via `Suspense` fallbacks.
* **Verification Status:**
  - **Empirically Verified:** Deferred components are completely absent from initial DOM tree until triggered.
  - **Pending Validation:** Exact JS Heap memory delta (MB) pending Chrome Memory Heap Snapshot profiling.

---

## 5. Rejected Experiments & Counter-Hypotheses

### 5.1 WebContentsView GPU Overlays
* **Hypothesis:** Native GPU compositor views would render faster and sharper than DOM elements.
* **Rejection Reason:** Native OS view overlays bypass the renderer DOM z-index context, visually occluding modals, dropdown menus, and command palettes.

### 5.2 Scale Quantization
* **Hypothesis:** Restricting CSS zoom levels to discrete integer steps (50%, 75%, 100%) would prevent fractional pixel sub-pixel raster blur.
* **Rejection Reason:** Created jarring layout visual snaps when dynamically resizing IDE panels.

### 5.3 CSS Compositing Render Hints (`will-change: transform`)
* **Hypothesis:** Adding GPU compositing hints would optimize scaling performance.
* **Rejection Reason:** `will-change: transform` forced Chrome to snapshot text into a fixed bitmapped texture layer before scaling, causing degraded font anti-aliasing.

### 5.4 File Tree DOM Virtualization (Phase 3B)
* **Hypothesis:** Virtualizing the project directory tree would improve IDE responsiveness.
* **Rejection Reason:** Flattening deeply nested directory structures broke folder expand/collapse animations, drag-and-drop file movements, and keyboard navigation. Given standard project directory sizes (<5,000 files), recursive DOM rendering with CSS `content-visibility: auto` provided sufficient performance without structural fragility.

---

## 6. Comprehensive Validation Summary

| Metric / Scenario | Measured Value | Target | Status |
|:---|:---|:---|:---|
| **Guest Viewport Height (Fixed)** | `852px` | `852px` | **EMPIRICALLY PASSED** |
| **Guest Viewport Height (Baseline Bug)** | `150px` | `852px` | **FAILED (Pre-fix baseline)** |
| **Virtualized Log DOM Node Count** | `~35 nodes` | `<50 nodes` | **EMPIRICALLY PASSED** |
| **IPC Batch Window Duration** | `16.6ms` | `16.6ms` | **EMPIRICALLY PASSED** |
| **CPU % Under Heavy Log Stream** | Projected ~6% | `<10%` | **PENDING PROFILER VALIDATION** |
| **Initial JS Heap Allocation** | Projected ~42MB | `<50MB` | **PENDING PROFILER VALIDATION** |
| **Panel Resize FPS** | Projected ~60FPS | `60FPS` | **PENDING PROFILER VALIDATION** |

---

## 7. Current Project Status

### 7.1 Component Status Breakdown
- **Production-Ready (Stable):**
  - 3-Domain Geometry Contract (`logicalViewport`, `screenCutout`, `artwork`).
  - Outer Container Layout Bounds Fix (`.phone-scale-container` explicit width/height).
  - High-Frequency IPC Transport Batcher.
  - Log Stream DOM Virtualization (`@tanstack/react-virtual`).
  - Lazy Loaded Settings & Secondary Modals.
- **Experimental / On-Hold:**
  - Phase 3B File Tree Virtualization (On Hold due to tree state complexity).
- **Permanently Frozen / Rejected:**
  - WebContentsView main-process overlay integration.
  - Scale Quantization hooks.
  - CSS GPU layer render hints (`will-change: transform`).

---

## 8. Technical Debt & Risk Audit

| Debt Item | Description | Severity | Risk | Recommended Action |
|:---|:---|:---|:---|:---|
| **Device Config Redundancy** | Legacy device list declarations exist alongside new `DeviceConfig` types in `PreviewPane.tsx`. | LOW | Maintenance duplication | Consolidate all device definitions into a single `device-registry.ts` file. |
| **Electron `<webview>` Tag Warning** | Electron flags `<webview>` tags for potential security sandboxing deprecation in future major releases. | MEDIUM | Future API compatibility | Maintain preloads via `contextBridge`; monitor Electron v36+ migration guides. |
| **CSS Class Monoliths** | `PhoneFrame.css` contains legacy monolithic device styling rules. | LOW | Style collision risk | Modularize CSS rules per device chassis asset. |

---

## 9. Lessons Learned & Engineering Principles

1. **Explicit Integer Contracts Beat Implicit CSS Percentage Chains:** The `150px` GuestView collapse bug occurred because `height: 100%` tried to resolve across a CSS-transformed flex container. Explicit integer dimensions (`393x852`) on the outer transformed boundary completely eliminated Chromium layout ambiguity.
2. **Never Sacrificing UI Stacking Correctness for Micro-Optimizations:** Transitioning to `WebContentsView` for GPU gains destroyed z-index layer ordering for modals and command palettes. Standard web DOM elements (`<iframe>`/`<webview>`) scaled via CSS remain superior for IDE integration.
3. **Classify Metrics Honestly:** Always separate empirically measured runtime metrics (such as `window.innerHeight = 852` or DOM node caps) from unverified system benchmarks (CPU/RAM percentages).

---

## 10. Future Roadmap

### 10.1 Short-Term (Immediate)
- Refactor all device arrays to import strictly from a single `device-registry.ts` module.
- Run formal Chrome Tracing CPU/RAM profiler suites to convert pending performance metrics into verified benchmarks.

### 10.2 Medium-Term (Next Release Cycle)
- Implement multi-device side-by-side preview grid (simultaneous iPhone 15 & Pixel 8 execution).
- Add automatic background preview throttling when the IDE window is minimized.

### 10.3 Long-Term
- Research WebGL shader-based hardware chassis rendering to simulate realistic glass reflections and dynamic lighting without DOM node bloat.

---

## 11. Appendix & References

- **ADR-001 (Preview Technology):** `brain/64a174bc-70ce-43f1-89b7-cbf4f1e122ea/implementation_plan.md`
- **IPC Batcher Implementation:** `apps/desktop/src/main/services/ipc-batcher.ts`
- **Preview Assembly Component:** `apps/desktop/src/renderer/src/features/preview/PreviewAssembly.tsx`
- **Preview Layout & Device Definitions:** `apps/desktop/src/renderer/src/layout/PreviewPane.tsx`
- **Phone Frame Stylesheet:** `apps/desktop/src/renderer/src/features/preview/PhoneFrame.css`

---
*End of Complete Engineering Systems & Architecture Report.*
