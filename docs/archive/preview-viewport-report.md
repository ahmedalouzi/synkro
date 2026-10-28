# Synkro Preview Viewport Technical Report

## 1. Overview of the Rendering Pipeline
The layout mismatch originates exclusively from the **Synkro Preview pipeline**, not the user's React Native project. The React Native application (`Synkro-Test`) is correctly using standard responsive techniques, but it is being rendered into a viewport that is significantly smaller than an actual iPhone 15 logical screen.

## 2. Step-by-Step Viewport Dimensions Trace

Based on the architectural analysis of `PreviewPane.tsx` and `PhoneFrame.css`, here is the exact trace of the viewport dimensions:

| Layer | CSS Width | CSS Height | Notes |
| :--- | :--- | :--- | :--- |
| **Preview Container (`.phone-scale-inner`)** | 290px | 600px | Hardcoded in `DEVICES` object (`w: 290, h: 600`). |
| **Phone Chassis (`.pf-iphone`)** | 290px | 600px | Padding is `6px` on all sides. |
| **Screen Bezel (`.pf-bezel`)** | 278px | 588px | `290px - 12px` padding. |
| **Electron WebView (`webview`)** | **278px** | **588px** | Inherits 100% of `.pf-bezel`. |

### Internal Web Viewport (Inside the React Native App)
Because the `webview` tag has a literal CSS width of 278px, and Expo Web injects `<meta name="viewport" content="width=device-width...">`, the browser sets the internal viewport to match the CSS size:

* **`window.innerWidth / innerHeight`**: ~ 278 / 588
* **`document.documentElement.clientWidth / clientHeight`**: 278 / 588
* **`document.body` dimensions**: 278 / 588
* **React Native Root View**: 278 / 588 (Assuming `flex: 1` is applied)
* **Target iPhone 15 Logical Dimensions (`lw`)**: **393 / 852**

## 3. Root Cause Analysis
The Synkro IDE hardcodes the visual representation of the phone (`w: 290`, `h: 600`) and passes that exact pixel dimension directly to the `webview`. 

A real iPhone 15 has a logical viewport of **393x852**. By forcing the `webview` to render at **278x588**, the React Native application is reacting to an ultra-narrow screen (equivalent to a tiny smartwatch-sized browser window).

Consequently, standard UI elements (such as a `56px` Floating Action Button, or `20px` padding) take up ~20% of the screen width instead of the intended ~14%, causing the UI to look massively scaled, clipped, and out of proportion.

## 4. Conclusion
The problem is **not** inside `App.tsx` or the mobile app's responsive layout. The layout is responding perfectly to a severely shrunken viewport. 

To fix this, the Synkro IDE's `PreviewPane` must be refactored to give the `webview` its true logical dimensions (`393x852`), and then use CSS `transform: scale()` to visually shrink the *entire* PhoneFrame down to fit inside the desktop IDE's pane.
