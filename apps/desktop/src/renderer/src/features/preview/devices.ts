/**
 * Device presets for the Preview pane: each phone's real CSS viewport, its safe-area insets and its chassis.
 *
 * The app (an iframe) fills the whole screen, edge to edge like a simulator: the status bar, Dynamic Island,
 * camera hole and home indicator are drawn on top of it. The app learns the safe-area insets through CSS
 * env(safe-area-inset-*) (and so react-native-safe-area-context), which the preview frame's shim maps to the
 * values sent from here (preload/preview-safe-area.ts), and keeps its own content clear of them.
 */

export type DeviceType = 'iphone-17-pro' | 'iphone-15' | 'iphone-15-pro' | 'iphone-se' | 'pixel-8' | 'pixel-fold' | 'galaxy-s24';

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface DeviceConfig {
  id: DeviceType;
  label: string;
  os: 'ios' | 'android';
  /** What is drawn into the screen's top area: Dynamic Island, punch-hole camera, or nothing (bezel camera). */
  cutout: 'dynamic-island' | 'punch-hole' | 'none';
  /** Home button in the bottom bezel (iPhone SE) instead of a gesture bar on the screen. */
  homeButton: boolean;
  /** Foldable: a faint crease down the middle of the inner screen. */
  fold: boolean;
  /** CSS px of the screen, portrait. */
  viewport: { width: number; height: number };
  /** Status bar on top, home indicator or gesture bar at the bottom. */
  safeArea: { portrait: Insets; landscape: Insets };
  /** Chassis around the screen, portrait. */
  bezel: { top: number; bottom: number; side: number };
  frameRadius: number;
  screenRadius: number;
  /** iPhones: the system version shown above the frame, as in Xcode's Simulator ("iPhone 17 Pro · iOS 26"). */
  osVersion?: string;
  /** iPhones: width of the metal band, the outer part of the bezel (the rest of it is the black glass border). */
  band?: number;
  /** Dynamic Island: size and offset from the top of the screen, in points. */
  island?: { width: number; height: number; top: number };
  /** Side buttons: [top, height] from the top of the body, in points (default positions when absent). */
  buttons?: { action: [number, number]; volUp: [number, number]; volDown: [number, number]; power: [number, number] };
  /** iPhones: colours of the metal band to pick from; the first is the default. */
  finishes?: Finish[];
}

/**
 * A finish of the metal band: one base colour, from which PhoneFrame.css derives the highlights and shadows
 * (color-mix). Our own approximations of the published colours, not Apple artwork.
 */
export interface Finish {
  id: string;
  name: string;
  /** Mid-tone of the band. */
  metal: string;
  /** Dark metals need a softer specular highlight. */
  dark?: boolean;
}

/** iPhone 17 Pro: aluminium unibody (no titanium), in its three published colours. */
const ALUMINIUM_17_PRO: Finish[] = [
  { id: 'silver', name: 'Silver', metal: '#d3d4d6' },
  { id: 'cosmic-orange', name: 'Cosmic Orange', metal: '#e48a55' },
  { id: 'deep-blue', name: 'Deep Blue', metal: '#3b4a63', dark: true },
];
const TITANIUM: Finish[] = [
  { id: 'natural', name: 'Natural Titanium', metal: '#bdb7ad' },
  { id: 'black', name: 'Black Titanium', metal: '#45443f', dark: true },
  { id: 'white', name: 'White Titanium', metal: '#dcdad5' },
];
const ALUMINIUM_15: Finish[] = [
  { id: 'black', name: 'Black', metal: '#3d4043', dark: true },
  { id: 'blue', name: 'Blue', metal: '#c9d6de' },
  { id: 'pink', name: 'Pink', metal: '#e5cbcc' },
];
const ALUMINIUM_SE: Finish[] = [
  { id: 'midnight', name: 'Midnight', metal: '#2f3238', dark: true },
  { id: 'starlight', name: 'Starlight', metal: '#e2ddd3' },
  { id: 'red', name: '(PRODUCT)RED', metal: '#b0202c', dark: true },
];

const inset = (top: number, right: number, bottom: number, left: number): Insets => ({ top, right, bottom, left });

/**
 * iPhone proportions from public specs, in points (pt = CSS px here):
 * - iPhone 17 Pro: 402 × 874 pt (1206 × 2622 px @3x, 460 ppi, 1 pt = 0.1656 mm), body 71.9 × 150.0 mm → bezel 16 pt;
 *   display corner radius 62 pt; safe area 62 / 34 pt (status bar 54); Dynamic Island 125 × 37 pt, 14 pt below the
 *   top of the screen (sensor region 20.76 mm; on a public Simulator-bezel capture the hardware outline is
 *   125.7 × 36 pt at 14.3 pt, and the status bar's time and icons centre 1.4 pt lower than an island at 14: so 15).
 * - Screen: 393 × 852 pt (iPhone 15 / 15 Pro: 1179 × 2556 px @3x, 460 ppi, so 1 pt = 0.1657 mm); 375 × 667 pt
 *   (iPhone SE: 750 × 1334 px @2x, 326 ppi, 1 pt = 0.1558 mm). Display corner radius 55 pt; the SE's is square.
 * - Bezel = (body − screen) / 2, from the body size: 15 Pro 70.6 × 146.6 mm → 16.6 / 16.5 pt; 15 71.6 × 147.6 mm →
 *   19.6 / 19.5 pt; SE 67.3 × 138.4 mm → 28.4 / 110.6 pt. Rounded to whole points, so the screen sits on whole
 *   pixels (fitZoom). The body's corners are concentric with the screen's: radius = screen radius + bezel.
 * - Status bar 54 pt + 5 (safe area 59 pt); Dynamic Island 126 × 37.33 pt, 11.33 pt below the top of the screen;
 *   home indicator 134 × 5 pt, 8 pt above the bottom.
 */
const ISLAND_15 = { width: 126, height: 37.33, top: 11.33 };
const ISLAND_17_PRO = { width: 125, height: 37, top: 15 };

export const DEVICES: DeviceConfig[] = [
  {
    // The default iPhone: what Xcode 26's Simulator opens with.
    id: 'iphone-17-pro', label: 'iPhone 17 Pro', os: 'ios', cutout: 'dynamic-island', homeButton: false, fold: false,
    viewport: { width: 402, height: 874 },
    safeArea: { portrait: inset(62, 0, 34, 0), landscape: inset(20, 62, 20, 62) },
    bezel: { top: 16, bottom: 16, side: 16 }, frameRadius: 78, screenRadius: 62,
    osVersion: 'iOS 26', band: 9, island: ISLAND_17_PRO, finishes: ALUMINIUM_17_PRO,
    // Measured on the Simulator-bezel capture (left: Action, volume up/down; right: side button).
    buttons: { action: [197, 30], volUp: [269, 56], volDown: [356, 54], power: [317, 70] },
  },
  {
    id: 'iphone-15', label: 'iPhone 15', os: 'ios', cutout: 'dynamic-island', homeButton: false, fold: false,
    viewport: { width: 393, height: 852 },
    safeArea: { portrait: inset(59, 0, 34, 0), landscape: inset(0, 59, 21, 59) },
    bezel: { top: 20, bottom: 20, side: 20 }, frameRadius: 75, screenRadius: 55,
    osVersion: 'iOS 26', band: 8, island: ISLAND_15, finishes: ALUMINIUM_15,
  },
  {
    id: 'iphone-15-pro', label: 'iPhone 15 Pro', os: 'ios', cutout: 'dynamic-island', homeButton: false, fold: false,
    viewport: { width: 393, height: 852 },
    safeArea: { portrait: inset(59, 0, 34, 0), landscape: inset(0, 59, 21, 59) },
    bezel: { top: 17, bottom: 17, side: 17 }, frameRadius: 72, screenRadius: 55,
    osVersion: 'iOS 26', band: 8, island: ISLAND_15, finishes: TITANIUM,
  },
  {
    // iPhone SE (2nd/3rd gen): 20pt status bar, no bottom inset; the status bar is hidden in landscape.
    id: 'iphone-se', label: 'iPhone SE', os: 'ios', cutout: 'none', homeButton: true, fold: false,
    viewport: { width: 375, height: 667 },
    safeArea: { portrait: inset(20, 0, 0, 0), landscape: inset(0, 0, 0, 0) },
    bezel: { top: 110, bottom: 110, side: 28 }, frameRadius: 60, screenRadius: 0,
    osVersion: 'iOS 26', band: 6, finishes: ALUMINIUM_SE,
  },
  {
    id: 'pixel-8', label: 'Pixel 8', os: 'android', cutout: 'punch-hole', homeButton: false, fold: false,
    viewport: { width: 412, height: 915 },
    safeArea: { portrait: inset(36, 0, 24, 0), landscape: inset(24, 0, 16, 36) },
    bezel: { top: 14, bottom: 14, side: 14 }, frameRadius: 50, screenRadius: 38,
  },
  {
    // Inner (unfolded) screen, 2208 x 1840 px at 2.625 px per CSS px; the camera sits in the bezel.
    id: 'pixel-fold', label: 'Pixel Fold', os: 'android', cutout: 'none', homeButton: false, fold: true,
    viewport: { width: 841, height: 701 },
    safeArea: { portrait: inset(28, 0, 20, 0), landscape: inset(28, 0, 20, 0) },
    bezel: { top: 20, bottom: 20, side: 20 }, frameRadius: 34, screenRadius: 18,
  },
  {
    id: 'galaxy-s24', label: 'Galaxy S24', os: 'android', cutout: 'punch-hole', homeButton: false, fold: false,
    viewport: { width: 360, height: 780 },
    safeArea: { portrait: inset(32, 0, 24, 0), landscape: inset(24, 0, 16, 32) },
    bezel: { top: 12, bottom: 12, side: 12 }, frameRadius: 46, screenRadius: 36,
  },
];

/** The name shown above the frame: "iPhone 15 Pro · iOS 18" for iPhones, like Xcode's Simulator; Android: the model. */
export function deviceTitle(device: DeviceConfig): string {
  return device.osVersion ? `${device.label} · ${device.osVersion}` : device.label;
}

export interface DeviceGeometry {
  /** Outer chassis. */
  frame: { width: number; height: number };
  /** The screen inside the chassis. */
  screen: { x: number; y: number; width: number; height: number };
  /** Safe-area insets inside the screen, sent to the app. */
  safe: Insets;
  /** The app's viewport: the whole screen. */
  app: { width: number; height: number };
}

/**
 * Where everything goes for a device in portrait or landscape. Landscape is the phone turned a quarter to the
 * left: the top of the device (Dynamic Island, camera, SE speaker) is on the left, the SE home button on the right.
 */
export function deviceGeometry(device: DeviceConfig, landscape: boolean): DeviceGeometry {
  const { viewport: v, bezel: b } = device;
  const screenW = landscape ? v.height : v.width;
  const screenH = landscape ? v.width : v.height;
  const edges = landscape
    ? { top: b.side, bottom: b.side, left: b.top, right: b.bottom }
    : { top: b.top, bottom: b.bottom, left: b.side, right: b.side };
  const safe = landscape ? device.safeArea.landscape : device.safeArea.portrait;
  return {
    frame: { width: screenW + edges.left + edges.right, height: screenH + edges.top + edges.bottom },
    screen: { x: edges.left, y: edges.top, width: screenW, height: screenH },
    safe,
    app: { width: screenW, height: screenH },
  };
}

/**
 * The CSS zoom that fits the frame into the available space. The app's iframe is laid out at
 * size × zoom × devicePixelRatio physical pixels, rounded, and its page sees that divided back, so a zoom
 * that does not make the app's size a whole number of pixels shows the page as e.g. 392 instead of 393 px
 * wide. Pick the largest zoom up to the fitting one at which the width is exact and the height and the
 * screen's offset in the frame are closest to exact (a fractional offset puts the screen's edge mid-pixel).
 */
export function fitZoom(
  geometry: DeviceGeometry, availWidth: number, availHeight: number, dpr = 1, min = 0.2, max = 1,
): number {
  const fit = Math.min(max, Math.max(min, Math.min(availWidth / geometry.frame.width, availHeight / geometry.frame.height)));
  const width = geometry.app.width * dpr;
  const height = geometry.app.height * dpr;
  let best = fit;
  let bestError = Number.POSITIVE_INFINITY;
  for (let px = Math.floor(fit * width); px > 0 && px >= Math.floor(fit * width) - 24; px--) {
    const zoom = px / width;
    if (zoom < min) break;
    const off = (v: number) => Math.abs(v * zoom - Math.round(v * zoom));
    const error = off(height) + off(geometry.screen.x * dpr) + off(geometry.screen.y * dpr);
    if (error < bestError - 1e-9) {
      best = zoom;
      bestError = error;
    }
    if (error < 1e-6) break;
  }
  return best;
}

/** The device's finish with this id, or its default (first) one; undefined for devices without finishes. */
export function deviceFinish(device: DeviceConfig, finishId?: string | null): Finish | undefined {
  return device.finishes?.find((f) => f.id === finishId) ?? device.finishes?.[0];
}
