/**
 * Device presets for the Preview pane: each phone's real CSS viewport, its safe-area insets and its chassis.
 *
 * The app (an iframe) fills the whole screen, edge to edge like a simulator: the status bar, Dynamic Island,
 * camera hole and home indicator are drawn on top of it. The app learns the safe-area insets through CSS
 * env(safe-area-inset-*) (and so react-native-safe-area-context), which the preview frame's shim maps to the
 * values sent from here (preload/preview-safe-area.ts), and keeps its own content clear of them.
 */

export type DeviceType = 'iphone-15' | 'iphone-15-pro' | 'iphone-se' | 'pixel-8' | 'pixel-fold' | 'galaxy-s24';

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
}

const inset = (top: number, right: number, bottom: number, left: number): Insets => ({ top, right, bottom, left });

export const DEVICES: DeviceConfig[] = [
  {
    id: 'iphone-15', label: 'iPhone 15', os: 'ios', cutout: 'dynamic-island', homeButton: false, fold: false,
    viewport: { width: 393, height: 852 },
    safeArea: { portrait: inset(59, 0, 34, 0), landscape: inset(0, 59, 21, 59) },
    bezel: { top: 16, bottom: 16, side: 16 }, frameRadius: 62, screenRadius: 48,
  },
  {
    id: 'iphone-15-pro', label: 'iPhone 15 Pro', os: 'ios', cutout: 'dynamic-island', homeButton: false, fold: false,
    viewport: { width: 393, height: 852 },
    safeArea: { portrait: inset(59, 0, 34, 0), landscape: inset(0, 59, 21, 59) },
    bezel: { top: 14, bottom: 14, side: 14 }, frameRadius: 60, screenRadius: 48,
  },
  {
    // iPhone SE (2nd/3rd gen): 20pt status bar, no bottom inset; the status bar is hidden in landscape.
    id: 'iphone-se', label: 'iPhone SE', os: 'ios', cutout: 'none', homeButton: true, fold: false,
    viewport: { width: 375, height: 667 },
    safeArea: { portrait: inset(20, 0, 0, 0), landscape: inset(0, 0, 0, 0) },
    bezel: { top: 96, bottom: 96, side: 18 }, frameRadius: 56, screenRadius: 0,
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
