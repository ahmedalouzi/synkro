import { webFrameMain, type WebContents } from 'electron';

/**
 * The app in the Preview pane runs in an <iframe> on its dev server's origin (Expo or Flutter web on
 * localhost), so the renderer cannot style it. Inside a device frame its scrollbars must not show: a
 * desktop scrollbar on a phone screen looks wrong and takes width from the app's viewport. Scrolling
 * itself is unchanged (wheel, trackpad, dragging a scroll view).
 */
const HIDE_SCROLLBARS = `(() => {
  if (document.getElementById('atomvs-preview-scrollbars')) return;
  const style = document.createElement('style');
  style.id = 'atomvs-preview-scrollbars';
  style.textContent = '* { scrollbar-width: none !important; } *::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }';
  (document.head || document.documentElement).appendChild(style);
})();`;

/** A local dev server (the preview), not the app's own UI or a remote page. */
export function isPreviewFrameUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (protocol === 'http:' || protocol === 'https:') && (hostname === 'localhost' || hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** sRGB channel (0–255) to linear light, for WCAG relative luminance. */
const LINEAR = Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

export interface Strip { x: number; y: number; width: number; height: number }

/** At most a few strips of sane size, in the window's CSS px; anything else is rejected. */
export function validStrips(value: unknown): Strip[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null;
  const ok = value.every((r) => r && typeof r === 'object'
    && ['x', 'y', 'width', 'height'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]))
    && r.x >= 0 && r.y >= 0 && r.width >= 1 && r.height >= 1 && r.width <= 4000 && r.height <= 400);
  return ok ? (value as Strip[]).map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) })) : null;
}

/**
 * What is actually drawn in strips of a window (e.g. the preview's status bar and home-indicator areas),
 * like a phone deciding its status-bar colour from the content behind it. The median luminance, so the
 * status-bar text and icons drawn over the strip (a minority of its pixels) don't sway it.
 */
export async function sampleStrips(contents: WebContents, strips: Strip[]) {
  return Promise.all(strips.map(async (rect) => {
    try {
      const image = await contents.capturePage(rect);
      const bitmap = image.toBitmap(); // BGRA
      const pixels = bitmap.length / 4;
      if (!pixels) return null;
      const luminances = new Float64Array(pixels);
      const sum = [0, 0, 0];
      for (let i = 0, p = 0; i < bitmap.length; i += 4, p++) {
        const b = bitmap[i], g = bitmap[i + 1], r = bitmap[i + 2];
        luminances[p] = 0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b];
        sum[0] += r; sum[1] += g; sum[2] += b;
      }
      luminances.sort();
      return {
        luminance: luminances[Math.floor(pixels / 2)],
        rgb: sum.map((s) => Math.round(s / pixels)) as [number, number, number],
      };
    } catch {
      return null;
    }
  }));
}

/** Hides scrollbars in every preview iframe this window loads. */
export function hideScrollbarsInPreviewFrames(contents: WebContents): void {
  contents.on('did-frame-finish-load', (_event, isMainFrame, frameProcessId, frameRoutingId) => {
    if (isMainFrame) return;
    const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
    if (!frame || !isPreviewFrameUrl(frame.url)) return;
    frame.executeJavaScript(HIDE_SCROLLBARS).catch(() => {});
  });
}
