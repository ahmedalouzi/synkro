# Device library — spec sheet (research, not code)

Collected 2026-11-18 for the device library (v0.1.3+, Trello: "Device library"). The remote catalog follows DEC-12 (HTTPS + strict schema, no signature for now).
Each value has a source tag; the source list is at the bottom.

**Confidence:**
- ✅ official (Apple / Samsung / Google), or measured by us;
- 🟡 reputable third party, or derived by arithmetic from official numbers;
- ⚠️ estimate or conflicting sources: to verify before it ships (see "Open items").

**Notes on the columns:**
- **Points:** iOS points or Android CSS px (dp), portrait.
- **Body:** H × W × D in mm.
- **Px / ppi:** native pixels and pixel density.
- **Radius:** display corner radius, in points.
- **Safe:** safe-area insets, portrait `top/bottom`, landscape `top/bottom/left/right`.

---

## iPhones (iOS 26, Dynamic Island unless noted, iOS status bar)

| Device | Points | Px / ppi | Body H×W×D | Radius | Safe portrait / landscape | Finishes (pick 2–3) |
|---|---|---|---|---|---|---|
| **iPhone 17 Pro** | 402×874 ✅[UYL17] | 1206×2622 @460 ✅[A-17P] | 150.0×71.9×8.75 ✅[A-17P] | 62 🟡[DG] | 62/34 · 20/20/62/62 🟡[UYL17] | Silver, Cosmic Orange, Deep Blue ✅[A-17P] |
| **iPhone 17 Pro Max** | 440×956 ✅[UYL17] | 1320×2868 @460 ✅[A-17PM] | 163.4×78.0×8.75 ✅[A-17PM] | 62 🟡[DG] | 62/34 · 20/20/62/62 🟡[UYL17] | Silver, Cosmic Orange, Deep Blue ✅[A-17P] |
| **iPhone 17** | 402×874 ✅[UYL17] | 1206×2622 @460 ✅[A-17] | 149.6×71.5×7.95 ✅[A-17] | 62 🟡[DG] | 62/34 · 20/20/62/62 🟡[UYL17] | Black, White, Mist Blue, Sage, Lavender ✅[A-17] |
| **iPhone Air** | 420×912 ✅[UYL17] | 1260×2736 @460 ✅[A-AIR] | 156.2×74.7×5.64 ✅[A-AIR] | 62 🟡[DG] | **68**/34 · 20/29/68/68 🟡[UYL17] | Space Black, Cloud White, Light Gold, Sky Blue ✅[A-AIR] |
| **iPhone 16** | 393×852 ✅[UYL16] | 1179×2556 @460 🟡[UYL16] | 147.6×71.6×7.80 🟡(already in our tests) | 55 🟡[DG] | 59/34 · 0/21/59/59 🟡[UYL16] | Black, White, Pink, Teal, Ultramarine ⚠️ (Apple's iPhone 16 page not checked) |
| **iPhone 15 Pro** | 393×852 (already in the app) | 1179×2556 @460 | 146.6×70.6×8.25 | 55 🟡[DG] | 59/34 · 0/21/59/59 | Natural / Black / White Titanium (already in the app) |
| **iPhone SE (3rd gen)** | 375×667 ✅[UYL16] | 750×1334 @326 | 138.4×67.3×7.3 (already in the app) | 0 🟡[DG] | 20/0 · 0/0/0/0 (status bar hidden in landscape) | Midnight, Starlight, (PRODUCT)RED (already in the app) |

**Derived bezel (pt):** body divided by the pt size (from px/ppi), minus the screen, then halved. 🟡
- 17 Pro: 16 / 16.
- 17 Pro Max: (78.0 / 0.1656 − 440) / 2 ≈ **15.5**; height (163.4 / 0.1656 − 956) / 2 ≈ **15.3**.
- 17: (71.5 / 0.1656 − 402) / 2 ≈ **14.9**; height ≈ **14.7**.
- Air: (74.7 / 0.1656 − 420) / 2 ≈ **15.5**; height (156.2 / 0.1656 − 912) / 2 ≈ **15.6**.
- 16: (71.6 / 0.1657 − 393) / 2 ≈ **19.6** (same as 15).

**Dynamic Island:**
- 17 Pro: 125×37 at 15pt from the top (measured by us against a Simulator-bezel capture, plus the 20.76 mm sensor region ✅[MR]).
- 17, 17 Pro Max: assumed the same (same safe-area 62) ⚠️.
- Air: top safe area 68, so the island probably sits lower (~+6pt) ⚠️, to measure.
- 16 / 15 Pro: 126×37.33 at 11.33pt (already in the app).

**Buttons:** 17 Pro measured (Action 197/30, vol 269/56, 356/54, side 317/70 pt from the top). The others ⚠️ scale from the dimensional drawings (Apple accessory PDFs, text layer readable with `pdftotext`) ✅[A-DWG].

---

## iPads (iPadOS 26, iPadOS status bar: time + date left, icons right; no cutout, front camera in the bezel)

| Device | Points | Px / ppi | Body H×W×D | Radius | Finishes |
|---|---|---|---|---|---|
| **iPad Pro 13" (M5)** | 1032×1376 🟡[PS] | 2064×2752 @264 ✅[A-IPP] | 281.6×215.5×5.1 ✅[A-IPP] | 30 🟡[DG] | Silver, Space Black ✅[A-IPP] |
| **iPad Pro 11" (M5)** | 834×1210 🟡[PS] | 1668×2420 @264 ✅[A-IPP] | 249.7×177.5×5.3 ✅[A-IPP] | 30 🟡[DG] | Silver, Space Black ✅[A-IPP] |
| **iPad Air 11" (M4)** | 820×1180 🟡[PS] | 1640×2360 @264 ✅[A-IPA] | 247.6×178.5×6.1 ✅[A-IPA] | 18 🟡[DG] (7th gen value; M4 assumed the same ⚠️) | Blue, Purple, Starlight, Space Gray ✅[A-IPA] |
| **iPad mini (A20 Pro)** | **756×1158** 🟡 (from 1512×2316 @2x) | 1512×2316 @326 ✅[A-IPM] | 195.3×132.6×5.4 ✅[A-IPM] | 21.5 🟡[DG] (7th gen value) ⚠️ | Midnight, Starlight ✅[A-IPM] |

**Notes:**
- apple.com now lists the newer iPad mini (A20 Pro, 2316×1512) and iPad Air (M4), not the A17 Pro mini / M3 Air. I've taken the current models. The A17 Pro mini was 744×1133.
- **iPad safe areas** (status bar 24pt, home-indicator area 20pt, both orientations) ⚠️: widely used values, but I found no source for iPadOS 26.

---

## Samsung (One UI 8, One UI status bar; centred punch-hole unless noted)

| Device | Points (dp) | Px / ppi | Body H×W×D | Finishes (pick 2–3) |
|---|---|---|---|---|
| **Galaxy S25 Ultra** | **412×891** 🟡[YV, SSC] / 480×1040 ⚠️[WIMSS] | 1440×3120 @~498 🟡[YV] | 162.8×77.6×8.2 ✅[S-S25U] | Titanium Silverblue, Titanium Black, Titanium Grey, Titanium Whitesilver ✅[S-S25U] |
| **Galaxy S25** | 360×780 🟡[YV, SSC] | 1080×2340 @~416 🟡[YV] | 146.9×70.5×7.2 🟡[YV] | Navy, Icy Blue, Silver Shadow, Mint ✅[S-S25U] |
| **Galaxy A56** | 360×780 ⚠️ (1080×2340 @ DPR 3, like the S25) | 1080×2340, 6.7" 🟡[GSMA-S] | ⚠️ (7.4 mm thick 🟡; height/width not confirmed) | ⚠️ (not fetched: samsung.com UK page 404) |
| **Galaxy Z Fold7, unfolded** | **750×832** ⚠️ (1968×2184 @2.625) / 984×1092 ⚠️[YV] (DPR 2, unlikely) | 1968×2184, 8.0" 🟡[YV, 91M] | 158.4×143.2×4.2 🟡[GSMA-S] | Blue Shadow, Silver Shadow, Jetblack, Mint ✅[S-ZF7] |
| **Galaxy Z Fold7, folded (cover)** | ⚠️ (6.5" ✅[S-ZF7], resolution unconfirmed) | ⚠️ | 158.4×72.8×8.9 🟡[GSMA-S] | same |
| **Galaxy Z Flip7, unfolded (main)** | ⚠️ (6.9" ✅[S-NEWS], resolution unconfirmed) | ⚠️ | 166.7×75.2×6.5 🟡[FI] | Blue Shadow, Jetblack, Coralred, Mint ✅[S-ZFL7] |
| **Galaxy Tab S10** | see note | | | Moonstone Gray, Platinum Silver ✅[S-TAB] |

**Tab S10:** there's **no plain "Tab S10"**. There are the S10+ (12.4", 1752×2800, 285.4×185.4×5.6 🟡) and the S10 Ultra (14.6", 1848×2960, 326.4×208.6×5.4 🟡) [TAB3P], plus the S10 FE. I suggest the **S10+**. ⚠️ Its dp needs density (at Samsung's usual 1.75: ~1001×1600) ⚠️. Your choice: S10+ or S10 Ultra.

**Fold7 hinge:** a soft vertical crease in the middle of the inner screen. We already draw one on the Pixel Fold.

---

## Google Pixel (Android 16, Pixel status bar; centred punch-hole)

| Device | Points (dp) | Px / ppi | Body H×W×D | Finishes |
|---|---|---|---|---|
| **Pixel 9 Pro** | **410×914** 🟡[SSC] (DPR 3.125) | 1280×2856 @495 ✅[G-SPEC] | 152.8×72.0×8.5 ✅[G-SPEC] | Obsidian, Porcelain, Hazel, Rose Quartz ✅[G-SPEC] |
| **Pixel 9a** | ⚠️ ~411×923 (1080×2424 @2.625) | 1080×2424 @422 ✅[G-SPEC] | 154.7×73.3×8.9 ✅[G-SPEC] | Obsidian, Porcelain, Iris, Peony ✅[G-SPEC] |

---

## Not published anywhere (we derive or measure; ⚠️ for all)

- **Android display corner radius**:
  - not in any spec;
  - read from the emulator skins/definitions below (numbers only, never their images);
  - or measured on public front renders, the way I measured the 17 Pro.
- **Punch-hole diameter and position** (S25/S25 Ultra/A56/Pixel, Fold7 cover, Flip7 main): same as above.
- **Android status/navigation bar heights**: Android 15+ apps are edge-to-edge. Typical values are 24–48dp top and the gesture bar 24–48dp ⚠️. The emulator definitions give exact values.
- **Buttons** on Samsung/Google: scale from public renders.

---

## Decisions (Ahmad, 2026-11-18)

- **Galaxy Tab: S10+ (12.4")**: 1752×2800, 285.4×185.4×5.6 mm 🟡, Moonstone Gray / Platinum Silver ✅.
- **Android dp/density:** take only the numbers from the official emulator definitions (Samsung Galaxy emulator skins, Android Studio hardware profiles), never their images.
- **Unpublished values** (corner radius, camera/punch-hole position and size, buttons): measure them like the 17 Pro, and mark each one ⚠️ in the catalog's source notes.

## Open items before implementation (in order)

1. **Android dp sizes:** the third-party sites compute them, and they disagree (S25 Ultra 412×891 vs 480×1040). Proposal: take density and resolution from the **official device definitions**, numbers only, with nothing bundled from them:
   - Samsung's Galaxy emulator skins (developer.samsung.com) for the Samsung devices;
   - Android Studio's built-in hardware profiles for the Pixels.

   dp = px / (dpi/160).
2. **Fold7 cover / Flip7 main resolutions:** confirm from the official Samsung specs table, which didn't load through my fetch tool. GSMArena is behind a paid bot gate (tollbit), so I didn't use it directly.
3. **iPad safe areas for iPadOS 26.**
4. **Island position on iPhone Air** (safe area 68 vs 62).
5. ~~Galaxy Tab S10+ or S10 Ultra~~: decided, **S10+** (see Decisions).

---

## Sources

- [UYL17] useyourloaf, *iPhone 17 Screen Sizes*: https://useyourloaf.com/blog/iphone-17-screen-sizes/
- [UYL16] useyourloaf, *iPhone 16 Screen Sizes*: https://useyourloaf.com/blog/iphone-16-screen-sizes/
- [DG] device_geometry (pub.dev), display corner radii by model identifier: https://pub.dev/documentation/device_geometry/0.0.5/platforms_ios/IosDeviceGeometry/geometry.html
- [A-17P] Apple, iPhone 17 Pro tech specs: https://support.apple.com/en-us/125090
- [A-17PM] Apple, iPhone 17 Pro Max tech specs: https://support.apple.com/125091
- [A-17] Apple, iPhone 17 specs: https://www.apple.com/iphone-17/specs/
- [A-AIR] Apple, iPhone Air specs: https://www.apple.com/iphone-air/specs/
- [A-DWG] Apple accessory dimensional drawings (e.g. iPhone 17 Pro): https://developer.apple.com/download/files/accessories/dimensional-drawings/iphone-17-pro.pdf
- [MR] MacRumors (pdfu), 17 Pro sensor region 20.76 mm: https://www.macrumors.com/2026/09/09/leaked-video-shows-iphone-18-pro-dynamic-island/
- [A-IPP] Apple, iPad Pro specs: https://www.apple.com/ipad-pro/specs/
- [A-IPA] Apple, iPad Air specs: https://www.apple.com/ipad-air/specs/
- [A-IPM] Apple, iPad mini specs: https://www.apple.com/ipad-mini/specs/
- [PS] picturesizes, iPad quick reference (points): https://picturesizes-com.pages.dev/specs/devices/ipad
- [S-S25U] Samsung NZ, Galaxy S25 Ultra specs (also lists S25 colours): https://www.samsung.com/nz/smartphones/galaxy-s25-ultra/specs/
- [S-ZF7] Samsung Levant, Galaxy Z Fold7 specs: https://www.samsung.com/levant/smartphones/galaxy-z-fold7/specs/
- [S-ZFL7] Samsung UK, Galaxy Z Flip7 specs (colours): https://www.samsung.com/uk/smartphones/galaxy-z-flip7/specs/
- [S-NEWS] Samsung Newsroom India, Z Flip7 6.9" main display: https://news.samsung.com/in/samsung-galaxy-z-flip7-a-pocket-sized-ai-powerhouse-with-a-new-edge-to-edge-flexwindow
- [S-TAB] Samsung UAE, Tab S10 series colours/dimensions: https://www.samsung.com/ae/support/mobile-devices/galaxy-tab-s10-series-colors-dimensions-and-weight
- [TAB3P] Tab S10+/Ultra dimensions (third-party, to confirm on samsung.com): https://www.phonearena.com/phones/Samsung-Galaxy-Tab-S10-Ultra_id12418
- [G-SPEC] Google, Pixel phone hardware tech specs: https://support.google.com/pixelphone/answer/7158570
- [YV] yesviz device pages (computed viewport): https://yesviz.com/devices/samsung-s25-ultra/ · https://yesviz.com/devices/samsung-s25/ · https://yesviz.com/devices/samsung-z-fold7/
- [SSC] screensizechecker, Android viewport sizes (says "not independently verified"): https://screensizechecker.com/devices/android-viewport-sizes
- [WIMSS] whatismyscreensize, Android CSS viewport sizes (computed): https://www.whatismyscreensize.com/blog/android-css-viewport-sizes
- [GSMA-S] GSMArena figures as quoted in search results (site blocks direct fetch): https://m.gsmarena.com/samsung_galaxy_z_fold7-13826.php · https://m.gsmarena.com/samsung_galaxy_a56-13603.php
- [91M] 91mobiles, Z Fold7 specs: https://www.91mobiles.com/samsung-galaxy-z-fold-7-price-in-india?ty=specs
- [FI] Google Fi, Z Flip7 specs: https://fi.google.com/about/phones/samsung-galaxy-z-flip7-specs
