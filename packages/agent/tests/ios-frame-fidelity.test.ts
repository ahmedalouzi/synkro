import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEVICES,
  deviceFinish,
  deviceGeometry,
  deviceTitle,
  fitZoom,
} from '../../../apps/desktop/src/renderer/src/features/preview/devices';

/**
 * iPhone preview frames like Xcode's Simulator (feat/ios-frame-fidelity): each model's own proportions from public
 * specs, the Dynamic Island's size and offset, the device name with its iOS version, and no Apple artwork or fonts
 * in the app. No DOM needed.
 */
const desktop = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../../apps/desktop');
const read = (p: string) => fs.readFileSync(path.join(desktop, p), 'utf8');

/** Body size (mm) and screen (px, ppi) from Apple's tech specs. */
const SPECS: Record<string, { body: [number, number]; px: [number, number]; ppi: number; pt: [number, number] }> = {
  'iphone-17-pro': { body: [71.9, 150.0], px: [1206, 2622], ppi: 460, pt: [402, 874] },
  'iphone-15-pro': { body: [70.6, 146.6], px: [1179, 2556], ppi: 460, pt: [393, 852] },
  'iphone-15': { body: [71.6, 147.6], px: [1179, 2556], ppi: 460, pt: [393, 852] },
  'iphone-se': { body: [67.3, 138.4], px: [750, 1334], ppi: 326, pt: [375, 667] },
};

export default async function run() {
  const iphones = DEVICES.filter((d) => d.os === 'ios');
  assert.deepEqual(iphones.map((d) => d.id).sort(), Object.keys(SPECS).sort(), 'every iPhone we offer has specs here');

  console.log('  [ios-frame] Each iPhone has its own real proportions...');
  for (const d of iphones) {
    const s = SPECS[d.id];
    assert.deepEqual([d.viewport.width, d.viewport.height], s.pt, `${d.id}: screen in points`);
    const mmPerPt = (s.px[0] / s.ppi) * 25.4 / s.pt[0];
    const g = deviceGeometry(d, false);
    // Body size in points from the spec; ours within 1 pt per side (bezels are whole points).
    const bodyPt = [s.body[0] / mmPerPt, s.body[1] / mmPerPt];
    assert.ok(Math.abs(g.frame.width - bodyPt[0]) <= 2, `${d.id}: width ${g.frame.width} vs ${bodyPt[0].toFixed(1)} pt`);
    assert.ok(Math.abs(g.frame.height - bodyPt[1]) <= 2, `${d.id}: height ${g.frame.height} vs ${bodyPt[1].toFixed(1)} pt`);
    assert.ok(Number.isInteger(g.screen.x) && Number.isInteger(g.screen.y), `${d.id}: screen on whole points`);
    // The band includes its dark bevel into the glass (measured on the Simulator's frame: ~9 of 16 pt on the 17 Pro).
    assert.ok((d.band ?? 0) > 0 && (d.band ?? 0) <= d.bezel.side * 0.6, `${d.id}: metal band, then black glass`);
    assert.equal(deviceTitle(d), `${d.label} · iOS 26`, `${d.id}: name with iOS version, like Xcode`);
  }

  console.log('  [ios-frame] Dynamic Island, display corners and concentric body...');
  for (const d of iphones.filter((x) => x.cutout === 'dynamic-island')) {
    const is17 = d.id === 'iphone-17-pro';
    assert.equal(d.screenRadius, is17 ? 62 : 55, `${d.id}: display corner radius`);
    assert.equal(d.frameRadius, d.screenRadius + d.bezel.side, `${d.id}: body corners concentric with the screen's`);
    assert.deepEqual(d.island, is17 ? { width: 125, height: 37, top: 15 } : { width: 126, height: 37.33, top: 11.33 }, `${d.id}: island`);
    assert.equal(d.safeArea.portrait.top, is17 ? 62 : 59);
    assert.equal(d.safeArea.portrait.bottom, 34);
  }
  assert.equal(DEVICES[0].id, 'iphone-17-pro', 'iPhone 17 Pro is the first (default) device');
  assert.deepEqual(DEVICES.find((d) => d.id === 'iphone-17-pro')!.finishes!.map((f) => f.name), ['Silver', 'Cosmic Orange', 'Deep Blue']);
  const storeSrc = read('src/renderer/src/stores/preview-store.ts');
  assert.match(storeSrc, /deviceId: 'iphone-17-pro'/, 'the Preview opens on iPhone 17 Pro');
  assert.match(read('src/main/ipc/index.ts'), /currentDetachedDeviceId = 'iphone-17-pro'/, 'so does the detached window');
  const se = DEVICES.find((d) => d.id === 'iphone-se')!;
  assert.equal(se.screenRadius, 0, 'SE: square screen');
  assert.equal(se.safeArea.portrait.top, 20, 'SE: 20 pt status bar');

  console.log('  [ios-frame] Different models are not one size scaled...');
  const ratio = (id: string) => { const g = deviceGeometry(DEVICES.find((d) => d.id === id)!, false); return g.frame.width / g.frame.height; };
  assert.notEqual(ratio('iphone-15'), ratio('iphone-15-pro'));
  // The SE's body has about the 15's aspect ratio (67.3/138.4 vs 71.6/147.6) but a far smaller screen in it.
  const geo = (id: string) => deviceGeometry(DEVICES.find((d) => d.id === id)!, false);
  assert.ok(geo('iphone-se').screen.y > 5 * geo('iphone-15').screen.y, 'SE: tall top and bottom bezels');
  assert.ok(geo('iphone-se').screen.height / geo('iphone-se').frame.height < 0.8, 'SE: the screen is ~75% of its height');
  assert.ok(geo('iphone-15').screen.height / geo('iphone-15').frame.height > 0.95, '15: nearly all screen');

  console.log('  [ios-frame] Frames still fit at whole pixels...');
  for (const d of iphones) {
    for (const landscape of [false, true]) {
      const g = deviceGeometry(d, landscape);
      const z = fitZoom(g, 420, 800, 2);
      assert.ok(z > 0.2 && z <= 1, `${d.id}${landscape ? ' landscape' : ''}: zoom ${z}`);
      assert.ok(Number.isInteger(Math.round(g.app.width * z * 2 * 1e6) / 1e6), `${d.id}: app width whole pixels`);
    }
  }
  assert.equal(deviceTitle(DEVICES.find((d) => d.id === 'pixel-8')!), 'Pixel 8', 'Android: name only, unchanged');

  console.log('  [ios-frame] Our own drawing, an open font, no Apple assets...');
  const frameTsx = read('src/renderer/src/features/preview/PhoneFrame.tsx');
  assert.match(frameTsx, /import '@fontsource\/inter\/latin-500\.css';/, 'Inter (OFL) for the time');
  assert.equal((frameTsx.match(/@fontsource\/inter\//g) ?? []).length, 1, 'one weight only');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.dependencies['@fontsource/inter'], 'Inter is a dependency of the app');
  const css = read('src/renderer/src/features/preview/PhoneFrame.css');
  assert.match(css, /font-family: "Inter"/, 'Inter first, so the time looks the same on every machine');
  assert.doesNotMatch(css + frameTsx, /url\([^)]*\.(png|jpe?g|webp)|\.(otf|ttf)\b|SF-?Pro[^"]*\.woff/i, 'no bitmap bezels or font files in the frame');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'node_modules' || e.name === 'out' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]);
  const fontFiles = walk(path.join(desktop, 'src')).filter((f) => /\.(otf|ttf|woff2?)$/i.test(f));
  assert.deepEqual(fontFiles, [], 'no font files committed to the app source');

  console.log('  [ios-frame] Finishes: 2-3 per iPhone, default first, unknown ids fall back...');
  for (const d of iphones) {
    const f = d.finishes ?? [];
    assert.ok(f.length >= 2 && f.length <= 3, `${d.id}: ${f.length} finishes`);
    assert.equal(new Set(f.map((x) => x.id)).size, f.length, `${d.id}: unique finish ids`);
    assert.ok(f.every((x) => /^#[0-9a-f]{6}$/i.test(x.metal)), `${d.id}: finish colours`);
    assert.equal(deviceFinish(d)?.id, f[0].id, `${d.id}: default finish`);
    assert.equal(deviceFinish(d, f[1].id)?.id, f[1].id);
    assert.equal(deviceFinish(d, 'no-such-finish')?.id, f[0].id, `${d.id}: a stale saved id falls back`);
  }
  assert.ok(DEVICES.find((d) => d.id === 'iphone-15-pro')!.finishes!.some((f) => f.name === 'Natural Titanium'));
  assert.equal(deviceFinish(DEVICES.find((d) => d.id === 'pixel-8')!), undefined, 'Android: no finishes');

  console.log('  [ios-frame] The choice is remembered, even without storage...');
  const store = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  const { usePreviewStore } = await import(`../../../apps/desktop/src/renderer/src/stores/preview-store.ts?t=${Date.now()}`);
  usePreviewStore.getState().setFinish('iphone-15-pro', 'black');
  assert.deepEqual(JSON.parse(store.get('atomvs.preview.frameFinish')!), { 'iphone-15-pro': 'black' });
  (globalThis as any).localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  usePreviewStore.getState().setFinish('iphone-se', 'red');
  assert.equal(usePreviewStore.getState().finishes['iphone-se'], 'red', 'kept for the session when storage throws');
  delete (globalThis as any).localStorage;

  console.log('  [ios-frame] Premium look stays cheap: static layers, no filters, glass never takes the pointer...');
  assert.match(css, /\.pf-glare \{[^}]*pointer-events: none/s, 'glare ignores the pointer');
  assert.match(css, /\.pf-glare \{[^}]*rgba\(255, 255, 255, 0\.0[0-9]+\)/s, 'glare is faint');
  assert.doesNotMatch(css, /filter:|backdrop-filter|@keyframes/, 'no filters or keyframe animations on the frame');
  assert.match(css, /--pf-metal/, 'band colours from the finish');
  const assembly = read('src/renderer/src/features/preview/PreviewAssembly.tsx');
  const anim = /el\.animate\(\s*\[([^\]]*)\]/s.exec(assembly)?.[1] ?? '';
  assert.ok(anim && !/width|height|left|top|filter/.test(anim), 'the morph animates only opacity and transform');
  assert.match(assembly, /duration: 200/);
  assert.match(assembly, /prefers-reduced-motion/);
  assert.match(frameTsx, /60_000 - /, 'the clock updates on the minute, not every second');

  console.log('  [ios-frame] Status bar time like iOS, band rings follow the corners...');
  const { statusBarTime, bandRings } = await import('../../../apps/desktop/src/renderer/src/features/preview/frame-geometry');
  assert.equal(statusBarTime(new Date(2026, 0, 1, 9, 41), false), '9:41');
  assert.equal(statusBarTime(new Date(2026, 0, 1, 14, 5), false), '2:05');
  assert.equal(statusBarTime(new Date(2026, 0, 1, 0, 7), false), '12:07');
  assert.equal(statusBarTime(new Date(2026, 0, 1, 9, 41), true), '09:41');
  assert.equal(statusBarTime(new Date(2026, 0, 1, 23, 59), true), '23:59');
  const rings = bandRings(9).split(/, (?=inset)/);
  assert.equal(rings.length, 18, 'one ring every half point across a 9 pt band');
  assert.ok(rings.every((r) => /^inset 0 0 0 [\d.]+px (var\(--pf-m-[a-z]+\)|var\(--pf-metal\)|color-mix\(in oklab, var\(--pf-[a-z-]+\) \d+%, var\(--pf-[a-z-]+\)\))$/.test(r)), rings[0]);
  assert.match(rings[0], /--pf-m-edge|--pf-m-lo/, 'dark outer edge');
  assert.match(rings[rings.length - 1], /--pf-m-deep\)$/, 'deep bevel into the glass');
  assert.match(css, /var\(--pf-rings/, 'the band is drawn from the rings');

  console.log('  [ios-frame] The frame lab is dev only...');
  assert.ok(fs.existsSync(path.join(desktop, 'src/renderer/frame-lab.html')));
  assert.doesNotMatch(read('electron.vite.config.ts'), /frame-lab/, 'not an input of the app build');

  console.log('  🟢 iOS frame fidelity tests passed.');
}
