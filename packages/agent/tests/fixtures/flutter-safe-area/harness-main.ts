/**
 * Electron main for flutter-safe-area.test.ts: a built Flutter web app (WEB_DIR) served on localhost, in an iframe
 * the size of each device's screen, with the real preload (its safe-area shim runs in preview frames). The host page
 * answers the shim's request with the device's insets, as the Preview pane does (usePreviewSafeArea). Records what
 * the Flutter app reports (MediaQuery and where its AppBar and NavigationBar are) per device; writes RESULT_FILE.
 */
import { app, BrowserWindow } from 'electron';
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const out = process.env.HARNESS_DIR!;
const webDir = process.env.WEB_DIR!;
const devices = JSON.parse(process.env.DEVICES!) as { id: string; width: number; height: number; insets: { top: number; right: number; bottom: number; left: number } }[];
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.otf': 'font/otf', '.ttf': 'font/ttf', '.frag': 'text/plain', '.bin': 'application/octet-stream' };

const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = normalize(join(webDir, url === '/' ? 'index.html' : url));
  if (!file.startsWith(normalize(webDir)) || !existsSync(file) || statSync(file).isDirectory()) file = join(webDir, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

app.whenReady().then(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const results: Record<string, unknown> = {};
  const win = new BrowserWindow({
    show: false, width: 1000, height: 1000,
    webPreferences: { preload: join(out, 'preload.js'), sandbox: false, contextIsolation: true, nodeIntegrationInSubFrames: true },
  });
  try {
    for (const device of devices) {
      await win.loadFile(join(out, 'host.html'), {
        query: { src: `http://127.0.0.1:${port}/`, w: String(device.width), h: String(device.height), insets: JSON.stringify(device.insets) },
      });
      // Flutter needs a moment to start; then the report must be stable.
      let last = '';
      let stable = 0;
      for (let i = 0; i < 120 && stable < 3; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const now = JSON.stringify(await win.webContents.executeJavaScript('window.__report || null'));
        stable = now !== 'null' && now === last ? stable + 1 : 0;
        last = now;
      }
      // The shim's runtime report, with the layout problems the agent reads (get_preview_logs).
      await new Promise((r) => setTimeout(r, 1500));
      results[device.id] = { ...JSON.parse(last), runtime: await win.webContents.executeJavaScript('window.__runtime || null') };
    }
  } catch (err) {
    results.error = String(err);
  }
  writeFileSync(process.env.RESULT_FILE!, JSON.stringify(results));
  server.close();
  app.exit(0);
});
