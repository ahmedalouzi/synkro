/**
 * The device frame as vector geometry at its FINAL on-screen size (no DOM, no CSS: tests load it).
 *
 * Why: the frame used to be CSS boxes laid out at the device's natural size and enlarged or shrunk with CSS zoom,
 * with the metal band drawn as 18 stacked inset box-shadows (one every half point). At a fractional zoom each ring
 * was about a third of a pixel wide and anti-aliased on its own, so their edges piled up into jagged corners; the
 * screen's corner was drawn twice (the clip and a bezel ring on top) with two different curves. Now:
 *
 * - every shape is an SVG path computed here in final CSS pixels (size × zoom), so the browser draws each edge once,
 *   at the screen's resolution;
 * - corners are continuous ("squircle", like a phone's), and the body, the glass and the screen use the same curve;
 * - the screen is clipped with the same path the bezel's opening uses (the bezel overlaps it by under a device
 *   pixel), so there is one edge around the app;
 * - small parts (the Dynamic Island, the camera) sit on whole device pixels (devicePixelRatio).
 *
 * Our own drawing, from public dimensions (devices.ts): no Apple artwork or fonts.
 */
import type { DeviceConfig, DeviceGeometry, Finish } from './devices';
import { deviceGeometry } from './devices';

// ── Continuous corners ───────────────────────────────────────────────────────

/** How much each corner blends into its sides (0 = a plain circular radius; phones are about 0.6). */
export const CORNER_SMOOTHING = 0.6;

interface CornerParams { a: number; b: number; c: number; d: number; p: number; arc: number; r: number }

function cornerParams(radius: number, smoothing: number, maxP: number): CornerParams {
  const r = Math.max(0, Math.min(radius, maxP));
  let s = smoothing;
  let p = (1 + s) * r;
  if (p > maxP) {
    // Not enough room for the full blend: less smoothing, the radius kept.
    s = r > 0 ? Math.max(0, maxP / r - 1) : 0;
    p = Math.min(p, maxP);
  }
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const arcMeasure = 90 * (1 - s);
  const arc = Math.sin(rad(arcMeasure / 2)) * r * Math.SQRT2;
  const alpha = (90 - arcMeasure) / 2;
  const p3ToP4 = r * Math.tan(rad(alpha / 2));
  const beta = 45 * s;
  const c = p3ToP4 * Math.cos(rad(beta));
  const d = c * Math.tan(rad(beta));
  const b = (p - arc - c - d) / 3;
  const a = 2 * b;
  return { a, b, c, d, p, arc, r };
}

const n = (v: number) => +v.toFixed(3);

/**
 * A rounded rectangle with continuous corners, as an SVG path (absolute start, relative curves). The corner's
 * reach along each side is (1 + smoothing) × radius, capped at half the shorter side. Radius 0: a plain rectangle.
 */
export function squirclePath(x: number, y: number, width: number, height: number, radius: number, smoothing = CORNER_SMOOTHING): string {
  if (width <= 0 || height <= 0) return '';
  if (radius <= 0) return `M${n(x)} ${n(y)}H${n(x + width)}V${n(y + height)}H${n(x)}Z`;
  const { a, b, c, d, p, arc, r } = cornerParams(radius, smoothing, Math.min(width, height) / 2);
  const abc = a + b + c;
  return [
    `M${n(x + width - p)} ${n(y)}`,
    `c${n(a)} 0 ${n(a + b)} 0 ${n(abc)} ${n(d)}`,
    `a${n(r)} ${n(r)} 0 0 1 ${n(arc)} ${n(arc)}`,
    `c${n(d)} ${n(c)} ${n(d)} ${n(b + c)} ${n(d)} ${n(abc)}`,
    `L${n(x + width)} ${n(y + height - p)}`,
    `c0 ${n(a)} 0 ${n(a + b)} ${n(-d)} ${n(abc)}`,
    `a${n(r)} ${n(r)} 0 0 1 ${n(-arc)} ${n(arc)}`,
    `c${n(-c)} ${n(d)} ${n(-(b + c))} ${n(d)} ${n(-abc)} ${n(d)}`,
    `L${n(x + p)} ${n(y + height)}`,
    `c${n(-a)} 0 ${n(-(a + b))} 0 ${n(-abc)} ${n(-d)}`,
    `a${n(r)} ${n(r)} 0 0 1 ${n(-arc)} ${n(-arc)}`,
    `c${n(-d)} ${n(-c)} ${n(-d)} ${n(-(b + c))} ${n(-d)} ${n(-abc)}`,
    `L${n(x)} ${n(y + p)}`,
    `c0 ${n(-a)} 0 ${n(-(a + b))} ${n(d)} ${n(-abc)}`,
    `a${n(r)} ${n(r)} 0 0 1 ${n(arc)} ${n(-arc)}`,
    `c${n(c)} ${n(-d)} ${n(b + c)} ${n(-d)} ${n(abc)} ${n(-d)}`,
    'Z',
  ].join('');
}

/** How far each corner reaches along its sides (tests: it must equal the sum of its segments). Exported for tests. */
export function cornerReach(radius: number, width: number, height: number, smoothing = CORNER_SMOOTHING): { reach: number; segments: number } {
  const { a, b, c, d, p, arc } = cornerParams(radius, smoothing, Math.min(width, height) / 2);
  return { reach: p, segments: a + b + c + arc + d };
}

// ── Colours ──────────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((ch) => ch + ch).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

/** `a` mixed with `b` (`t` = share of b, 0..1), as #rrggbb. */
export function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

export interface MetalPalette { edge: string; lo: string; base: string; lit: string; hi: string; fall: string; deep: string }

/** The band's colours from one finish colour (the same recipe the CSS used, as plain colours). */
export function metalPalette(finish: Finish | undefined): MetalPalette {
  const base = finish?.metal ?? '#bdb7ad';
  const dark = !!finish?.dark;
  const light = dark ? '#ffffff' : '#fff3e2';
  return {
    edge: mixHex(base, '#000000', dark ? 0.55 : 0.45),
    lo: mixHex(base, '#000000', 0.22),
    base,
    lit: mixHex(base, light, dark ? 0.18 : 0.3),
    hi: mixHex(base, light, dark ? 0.38 : 0.68),
    fall: mixHex(base, '#000000', 0.48),
    deep: mixHex(base, '#000000', 0.8),
  };
}

// ── The frame at its final size ──────────────────────────────────────────────

/** A value on the device-pixel grid (CSS px). */
export function snap(value: number, dpr: number): number {
  return Math.round(value * dpr) / dpr;
}

export interface Rect { x: number; y: number; width: number; height: number }
export interface Circle { cx: number; cy: number; r: number }

export interface FrameArt {
  /** Final size of the whole frame, CSS px (in the current orientation). */
  width: number;
  height: number;
  /** The portrait art is turned a quarter to the left for landscape: this transform does it (or ''). */
  rotate: string;
  /** Portrait size (the art's own coordinate system). */
  portrait: { width: number; height: number };
  /** The body's outline, the glass inside the metal band, and the opening for the screen (all portrait). */
  body: string;
  glass: string;
  opening: string;
  /** iPhones: the band's centre line and thickness (its gradient stroke); 0 for Android. */
  bandPath: string;
  band: number;
  /** Side buttons (portrait), with the side they stick out of. */
  buttons: Array<Rect & { side: 'left' | 'right' }>;
  island: (Rect & { camera: Circle }) | null;
  punchHole: Circle | null;
  /** iPhone SE: earpiece, camera and home button in the bezels. */
  se: { speaker: Rect; camera: Circle; home: Circle } | null;
  /** Earpiece slit where the glass meets the band (Dynamic Island iPhones). */
  receiver: Rect | null;
  fold: { hinge: Rect; camera: Circle } | null;
  /** The screen: where it sits (current orientation) and its clip path, relative to its own box. */
  screen: Rect & { clip: string; radius: number };
  outerRadius: number;
}

const DEFAULT_ISLAND = { width: 126, height: 37.33, top: 11.33 };
const IOS_DEFAULT_BUTTONS = { action: [112, 32], volUp: [164, 60], volDown: [236, 60], power: [188, 86] } as const;

/**
 * Everything the frame draws, in final CSS px for this zoom and devicePixelRatio. The screen's position comes
 * from deviceGeometry × zoom (previewZoom keeps the app's width on whole device pixels); the bezel's opening overlaps the screen by
 * under one device pixel, so the bezel's edge is the only edge the eye sees.
 */
export function frameArt(device: DeviceConfig, landscape: boolean, zoom: number, dpr: number): FrameArt {
  const z = zoom;
  const g: DeviceGeometry = deviceGeometry(device, landscape);
  const p: DeviceGeometry = deviceGeometry(device, false);
  const W = p.frame.width * z;
  const H = p.frame.height * z;
  const R = device.frameRadius * z;
  const r = device.screenRadius * z;
  const band = (device.band ?? 0) * z;
  const sx = p.screen.x * z;
  const sy = p.screen.y * z;
  const sw = p.screen.width * z;
  const sh = p.screen.height * z;
  const overlap = Math.min(0.75 / dpr, 0.75);

  const body = squirclePath(0, 0, W, H, R);
  const opening = squirclePath(sx + overlap, sy + overlap, sw - 2 * overlap, sh - 2 * overlap, Math.max(0, r - overlap));
  const glass = band > 0 ? squirclePath(band, band, W - 2 * band, H - 2 * band, Math.max(0, R - band)) : body;
  const bandPath = band > 0 ? squirclePath(band / 2, band / 2, W - band, H - band, Math.max(0, R - band / 2)) : '';

  // Side buttons, outside the body (the body is drawn over their inner ends).
  const buttons: FrameArt['buttons'] = [];
  if (device.os === 'ios') {
    const w = (band > 0 ? 2.25 : 5) * z;
    const cfg = device.buttons;
    const at = (v: readonly [number, number] | [number, number]) => ({ y: v[0] * z, height: v[1] * z });
    if (device.homeButton) {
      buttons.push({ side: 'left', x: -w, ...at([170, 60]), width: w + 1 });
      buttons.push({ side: 'left', x: -w, ...at([240, 60]), width: w + 1 });
      buttons.push({ side: 'right', x: W - 1, ...at([170, 86]), width: w + 1 });
    } else {
      const b = cfg ?? IOS_DEFAULT_BUTTONS;
      for (const v of [b.action, b.volUp, b.volDown]) buttons.push({ side: 'left', x: -w, ...at(v), width: w + 1 });
      buttons.push({ side: 'right', x: W - 1, ...at(b.power), width: w + 1 });
    }
  } else {
    const w = 5 * z;
    buttons.push({ side: 'right', x: W - 1, ...at2([142, 58], z), width: w + 1 });
    buttons.push({ side: 'left', x: -w, ...at2([112, 50], z), width: w + 1 });
    if (!device.fold) buttons.push({ side: 'left', x: -w, ...at2([170, 50], z), width: w + 1 });
  }

  // The Dynamic Island: a clean pill on whole device pixels, centred on the screen.
  let island: FrameArt['island'] = null;
  if (device.cutout === 'dynamic-island') {
    const i = device.island ?? DEFAULT_ISLAND;
    const iw = snap(i.width * z, dpr);
    const ih = snap(i.height * z, dpr);
    const ix = snap(sx + (sw - iw) / 2, dpr);
    const iy = snap(sy + i.top * z, dpr);
    // Front camera ~17 pt from the island's right end (measured, iPhone 17 Pro).
    island = { x: ix, y: iy, width: iw, height: ih, camera: { cx: snap(ix + iw - (11.5 + 5.5) * z, dpr), cy: iy + ih / 2, r: 5.5 * z } };
  }
  const punchHole = device.cutout === 'punch-hole'
    ? { cx: snap(sx + sw / 2, dpr), cy: snap(sy + (p.safe.top * z) / 2, dpr), r: 6.5 * z }
    : null;
  const se = device.homeButton
    ? {
      speaker: { x: W / 2 - 15.5 * z, y: sy / 2 - 3 * z, width: 60 * z, height: 6 * z },
      camera: { cx: W / 2 - 39 * z, cy: sy / 2, r: 5.5 * z },
      home: { cx: W / 2, cy: sy + sh + (H - sy - sh) / 2, r: 29 * z },
    }
    : null;
  const receiver = device.cutout === 'dynamic-island' && band > 0
    ? { x: band + (W - 2 * band) * 0.31, y: band - 1.25 * z, width: (W - 2 * band) * 0.38, height: 2 * z }
    : null;
  const fold = device.fold
    ? { hinge: { x: sx + sw / 2 - 8 * z, y: sy, width: 16 * z, height: sh }, camera: { cx: W - sx / 2 - 36 * z, cy: sy / 2, r: 4 * z } }
    : null;

  // The screen in the current orientation.
  const screen = { x: g.screen.x * z, y: g.screen.y * z, width: g.screen.width * z, height: g.screen.height * z };
  return {
    width: g.frame.width * z,
    height: g.frame.height * z,
    // Landscape: the top of the device on the left. (x, y) → (y, W − x).
    rotate: landscape ? `translate(0 ${n(W)}) rotate(-90)` : '',
    portrait: { width: W, height: H },
    body, glass, opening, bandPath, band, buttons, island, punchHole, se, receiver, fold,
    screen: { ...screen, radius: r, clip: squirclePath(0, 0, screen.width, screen.height, r) },
    outerRadius: R,
  };
}

function at2(v: [number, number], z: number) {
  return { y: v[0] * z, height: v[1] * z };
}

// ── Size: Fit, 100 %, 125 % ──────────────────────────────────────────────────

export type PreviewZoomMode = 'fit' | '100' | '125';
export const ZOOM_MODES: PreviewZoomMode[] = ['fit', '100', '125'];
/** Fit: the phone takes about this share of the stage's height. */
export const FIT_HEIGHT = 0.92;
/** The largest Fit zoom (the phone is drawn as vectors and the app re-laid out, so going above 1× stays sharp). */
export const FIT_MAX = 1.6;

/**
 * The zoom for a mode: Fit fills ~92 % of the stage height (and its width); 100 % and 125 % are the device's
 * points at 1× and 1.25×. Every result keeps the app's width (and as close as possible its height and the screen's
 * offset) on whole device pixels, so the page sees its exact logical width.
 */
export function previewZoom(mode: PreviewZoomMode, geometry: DeviceGeometry, stageWidth: number, stageHeight: number, dpr: number): number {
  // The largest zoom up to the target at which the app's width is whole device pixels (the page then sees its exact
  // width). fitZoom also hunts for an exact height and screen offset, up to 24 px lower, which made the phone up to
  // 6 % smaller (125 % came out as 120 %); the frame's opening now covers a sub-pixel screen edge, so it need not.
  const target = mode === 'fit'
    ? Math.min(FIT_MAX, stageWidth / geometry.frame.width, (stageHeight * FIT_HEIGHT) / geometry.frame.height)
    : mode === '125' ? 1.25 : 1;
  return exactZoom(target, geometry, dpr);
}

/** The largest zoom up to `target` at which the app's width is a whole number of device pixels (at least 0.2). */
export function exactZoom(target: number, geometry: DeviceGeometry, dpr: number): number {
  const px = geometry.app.width * dpr;
  return Math.max(0.2, Math.floor(target * px + 1e-9) / px);
}

export const ZOOM_STORAGE_KEY = 'atomvs.preview.zoom';

/** The saved zoom mode (Fit when none, or when storage is unavailable). */
export function loadZoomMode(storage: Pick<Storage, 'getItem'> | null | undefined): PreviewZoomMode {
  try {
    const v = storage?.getItem(ZOOM_STORAGE_KEY);
    return v === '100' || v === '125' || v === 'fit' ? v : 'fit';
  } catch {
    return 'fit';
  }
}

export function saveZoomMode(storage: Pick<Storage, 'setItem'> | null | undefined, mode: PreviewZoomMode): void {
  try {
    storage?.setItem(ZOOM_STORAGE_KEY, mode);
  } catch {
    // Private mode / blocked storage: kept for this session only.
  }
}
