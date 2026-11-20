import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

/**
 * The brand's logo as a PNG, square, transparent, the mark centred at 70% (room for Android 12's round splash
 * mask). Drawn by Chromium in a hidden, sandboxed window: the SVG goes through an <img>, so even a hostile SVG runs
 * nothing (and brandProblems has already refused scripts and external references).
 */
export async function rasterizeSvg(svg: string, size: number): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false, width: size, height: size,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadURL('about:blank');
    const src = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
    const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const size = ${size};
        const c = document.createElement('canvas');
        c.width = size; c.height = size;
        const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
        const box = size * 0.7, scale = box / Math.max(w, h);
        c.getContext('2d').drawImage(img, (size - w * scale) / 2, (size - h * scale) / 2, w * scale, h * scale);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('the logo SVG could not be drawn'));
      img.src = ${JSON.stringify(src)};
    })`) as string;
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  } finally {
    win.destroy();
  }
}

/**
 * The fonts bundled with Atomvs (resources/brand-fonts, see scripts/fetch-brand-fonts.mjs): inside the installed app
 * they are next to app.asar (electron-builder extraResources); in development they are in apps/desktop/resources.
 */
export function bundledFontsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'brand-fonts') : join(app.getAppPath(), 'resources', 'brand-fonts');
}
