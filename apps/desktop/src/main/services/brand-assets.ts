import { BrowserWindow } from 'electron';

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

/** The TTF URL of each weight in a Google Fonts css2 stylesheet. Exported for tests. */
export function ttfUrls(css: string): Map<number, string> {
  const urls = new Map<number, string>();
  for (const block of css.split('@font-face').slice(1)) {
    const weight = Number(/font-weight:\s*(\d+)/.exec(block)?.[1]);
    const url = /src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+\.ttf)\)/.exec(block)?.[1];
    // The first block per weight is the full (latin) set when the stylesheet has no unicode-range splits.
    if (weight && url && !urls.has(weight)) urls.set(weight, url);
  }
  return urls;
}

const MAX_FONT_BYTES = 5 * 1024 * 1024;

/**
 * One weight of a Google Font as TTF (OFL / Apache licensed), for bundling in the app. Only the family name is
 * sent. A plain user agent makes Google Fonts serve TTF, which Flutter and expo-font load.
 */
export async function fetchGoogleFont(family: string, weight: number): Promise<Buffer> {
  const query = `family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${weight}`;
  const res = await fetch(`https://fonts.googleapis.com/css2?${query}`, { headers: { 'User-Agent': 'Mozilla/4.0' } });
  if (!res.ok) throw new Error(`Google Fonts answered ${res.status}`);
  const url = ttfUrls(await res.text()).get(weight);
  if (!url) throw new Error(`no TTF for weight ${weight}`);
  const font = await fetch(url);
  if (!font.ok) throw new Error(`font download answered ${font.status}`);
  const data = Buffer.from(await font.arrayBuffer());
  if (data.length === 0 || data.length > MAX_FONT_BYTES) throw new Error('unexpected font size');
  // TrueType / OpenType signatures.
  const magic = data.subarray(0, 4).toString('hex');
  if (!['00010000', '4f54544f', '74727565'].includes(magic)) throw new Error('not a TTF/OTF file');
  return data;
}
