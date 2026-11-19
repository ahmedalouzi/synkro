import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEVICES, deviceGeometry } from '../../../apps/desktop/src/renderer/src/features/preview/devices';

/**
 * A bottom tab bar in the preview sits above the home indicator / gesture bar with its labels whole, on every device.
 *
 * Always: each device's bottom inset is what the platform reserves (iPhone home indicator 34 pt, iPhone SE none,
 * Android gesture bar ~20-24 dp).
 *
 * With SYNKRO_RUN_FRAME_TESTS=1 and Chrome installed: starts the frame lab (apps/desktop/frame-lab.vite.config.mts),
 * opens the tab-bar fixture (frame-lab-fixtures/tab-bar.html: the real preview shim, insets measured the way
 * react-native-safe-area-context does, a React Navigation-style tab bar) in each device's frame, portrait and
 * landscape, in real time over the DevTools protocol, and checks where the tab bar and its labels ended up.
 */
const desktop = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../../apps/desktop');
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && fs.existsSync(p));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens `url` in headless Chrome and returns the fixture's report shown by the frame lab, after `waitMs` of real time. */
async function reportFor(port: number, url: string, waitMs: number): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const target = (await res.json()) as { id: string; webSocketDebuggerUrl: string };
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(String(m.data));
    if (d.id && pending.has(d.id)) { pending.get(d.id)!(d.result); pending.delete(d.id); }
  });
  const send = (method: string, params = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  let report: any = null;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(500);
    const r = await send('Runtime.evaluate', { expression: "document.getElementById('fixture-report')?.textContent || ''", returnByValue: true });
    const text = r?.result?.value as string;
    if (text) {
      report = JSON.parse(text);
      // Settled: insets received and the tab bar laid out for them.
      if (report.insets && report.tabbar && Date.now() > deadline - waitMs + 2500) break;
    }
  }
  ws.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
  return report;
}

export default async function run() {
  console.log('  [tab-bar] Bottom insets reserve the home indicator / gesture bar on every device...');
  for (const d of DEVICES) {
    const bottom = d.safeArea.portrait.bottom;
    if (d.os === 'ios') assert.equal(bottom, d.homeButton ? 0 : 34, `${d.id}: iPhone home indicator area`);
    else assert.ok(bottom >= 16 && bottom <= 48, `${d.id}: Android gesture bar ${bottom} dp`);
    if (!d.homeButton) assert.ok(d.safeArea.landscape.bottom > 0, `${d.id}: landscape keeps a bottom inset`);
  }

  if (process.env.SYNKRO_RUN_FRAME_TESTS !== '1' || !CHROME) {
    console.log(`  (skipped the browser part: ${!CHROME ? 'no Chrome found' : 'set SYNKRO_RUN_FRAME_TESTS=1'})`);
    console.log('  🟢 Preview tab bar tests passed.');
    return;
  }

  const labPort = 5180 + Math.floor(Math.random() * 15);
  const cdpPort = 9400 + Math.floor(Math.random() * 50);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-lab-chrome-'));
  const procs: ChildProcess[] = [];
  try {
    procs.push(spawn(process.execPath, [path.join(desktop, 'node_modules/vite/bin/vite.js'), '--config', 'frame-lab.vite.config.mts'], {
      cwd: desktop, env: { ...process.env, FRAME_LAB_PORT: String(labPort) }, stdio: 'ignore',
    }));
    procs.push(spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`, '--window-size=1400,1200', 'about:blank'], { stdio: 'ignore' }));
    for (let i = 0; i < 120; i++) {
      const lab = await fetch(`http://127.0.0.1:${labPort}/frame-lab.html`).then((r) => r.ok).catch(() => false);
      const cdp = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then((r) => r.ok).catch(() => false);
      if (lab && cdp) break;
      await sleep(500);
    }

    const fixture = `http://127.0.0.1:${labPort}/frame-lab-fixtures/tab-bar.html`;
    for (const d of DEVICES) {
      for (const landscape of [false, true]) {
        const g = deviceGeometry(d, landscape);
        const url = `http://127.0.0.1:${labPort}/frame-lab.html?bare=1&device=${d.id}${landscape ? '&landscape=1' : ''}&appUrl=${encodeURIComponent(fixture)}`;
        const r = await reportFor(cdpPort, url, 8000);
        const where = `${d.id}${landscape ? ' landscape' : ''}`;
        assert.ok(r, `${where}: the fixture reported its layout`);
        assert.equal(r.innerWidth, g.app.width, `${where}: the app sees the screen's width`);
        assert.equal(r.innerHeight, g.app.height, `${where}: the app sees the screen's height`);
        assert.deepEqual(r.insets, { top: g.safe.top, bottom: g.safe.bottom }, `${where}: the app received the device's insets`);
        assert.ok(Math.abs(r.tabbar.bottom - g.app.height) <= 1, `${where}: the tab bar's background reaches the bottom edge`);
        const homeTop = g.app.height - g.safe.bottom;
        for (const tab of r.tabs) assert.ok(tab.bottom <= homeTop + 0.5, `${where}: tabs end above the home indicator (${tab.bottom} > ${homeTop})`);
        r.labels.forEach((l: any, i: number) => {
          const tab = r.tabs[i];
          // Not squashed (the bug: labels shrunk to 5 px by a tab bar too short for them) and inside its tab (whose
          // overflow is hidden), so nothing of it is cut off.
          assert.ok(l.height >= 12.5, `${where}: label not squashed (${l.height} px)`);
          assert.ok(l.top >= tab.top - 0.5 && l.bottom <= tab.bottom + 0.5, `${where}: label inside its tab (${l.top}-${l.bottom} in ${tab.top}-${tab.bottom})`);
          assert.ok(l.bottom <= homeTop + 0.5, `${where}: label above the home indicator (${l.bottom} > ${homeTop})`);
        });
        console.log(`  [tab-bar] ${where}: tabs end at ${r.tabs[0].bottom} (home area from ${homeTop}), labels ${r.labels[0].height}px`);
      }
    }
  } finally {
    for (const p of procs) {
      try { if (process.platform === 'win32' && p.pid) spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); else p.kill(); } catch { /* gone */ }
    }
    await sleep(1000);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* Chrome may still hold it; a temp dir */ }
  }
  console.log('  🟢 Preview tab bar tests passed.');
}
