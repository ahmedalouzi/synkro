import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEVICES, deviceGeometry } from '../../../apps/desktop/src/renderer/src/features/preview/devices';
import {
  FIT_HEIGHT, ZOOM_STORAGE_KEY, cornerReach, frameArt, loadZoomMode, mixHex, previewZoom, saveZoomMode, squirclePath,
} from '../../../apps/desktop/src/renderer/src/features/preview/frame-svg';

const desktop = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../../apps/desktop');
const read = (rel: string) => fs.readFileSync(path.join(desktop, rel), 'utf8');

/** Walks a path made of M/L/H/V (absolute), c/a (relative) and Z: the end point of the last segment, and the box. */
function trace(d: string) {
  const tokens = d.match(/[MLHVcaZ]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let i = 0;
  let x = 0, y = 0, sx = 0, sy = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const num = () => Number(tokens[i++]);
  const see = () => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  let beforeClose = { x: 0, y: 0 };
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') { x = num(); y = num(); sx = x; sy = y; }
    else if (cmd === 'L') { x = num(); y = num(); }
    else if (cmd === 'H') { x = num(); }
    else if (cmd === 'V') { y = num(); }
    else if (cmd === 'c') { num(); num(); num(); num(); x += num(); y += num(); }
    else if (cmd === 'a') { num(); num(); num(); num(); num(); x += num(); y += num(); }
    else if (cmd === 'Z') { beforeClose = { x, y }; x = sx; y = sy; continue; }
    else throw new Error(`unexpected ${cmd}`);
    see();
  }
  return { start: { x: sx, y: sy }, end: beforeClose, box: { minX, minY, maxX, maxY } };
}

export default async function runTest() {
  console.log('  [frame-hd] Continuous corners: each corner adds up, every path closes on itself inside its box...');
  for (const [r, w, h] of [[62, 402, 874], [78, 434, 906], [55, 393, 852], [18, 841, 701], [200, 300, 300], [5, 40, 20]]) {
    const { reach, segments } = cornerReach(r, w, h);
    assert.ok(Math.abs(reach - segments) < 1e-9, `r ${r}: ${reach} vs ${segments}`);
    assert.ok(reach <= Math.min(w, h) / 2 + 1e-9, `r ${r}: the corner fits`);
    const t = trace(squirclePath(10, 20, w, h, r));
    // The last corner ends where the top side starts; Z draws that side back to the start.
    assert.ok(Math.abs(t.end.x - (10 + reach)) < 0.01 && Math.abs(t.end.y - t.start.y) < 0.01, `r ${r}: closes (${t.end.x},${t.end.y})`);
    assert.ok(t.box.minX >= 10 - 0.01 && t.box.minY >= 20 - 0.01 && t.box.maxX <= 10 + w + 0.01 && t.box.maxY <= 20 + h + 0.01, `r ${r}: inside its box`);
  }
  assert.equal(squirclePath(0, 0, 10, 20, 0), 'M0 0H10V20H0Z', 'radius 0: a plain rectangle (iPhone SE screen)');
  assert.equal(squirclePath(0, 0, 0, 20, 5), '');
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');

  console.log('  [frame-hd] Every device, both orientations, every zoom and display scaling...');
  for (const device of DEVICES) {
    for (const landscape of [false, true]) {
      const g = deviceGeometry(device, landscape);
      for (const zoom of [0.55, 0.9, 1, 1.25]) {
        for (const dpr of [1, 1.25, 1.5, 2]) {
          const art = frameArt(device, landscape, zoom, dpr);
          const tag = `${device.id}${landscape ? ' landscape' : ''} z${zoom} dpr${dpr}`;
          assert.ok(Math.abs(art.width - g.frame.width * zoom) < 1e-9 && Math.abs(art.height - g.frame.height * zoom) < 1e-9, `${tag}: final size`);
          assert.equal(art.rotate !== '', landscape, `${tag}: the portrait art turned for landscape`);
          // The screen and its clip: the same continuous corner as the frame's opening, at the final size.
          assert.ok(Math.abs(art.screen.width - g.screen.width * zoom) < 1e-9, `${tag}: screen width`);
          const clip = trace(art.screen.clip);
          assert.ok(clip.box.maxX <= art.screen.width + 0.01 && clip.box.maxY <= art.screen.height + 0.01, `${tag}: clip inside the screen`);
          // Concentric corners: the body's radius is the screen's plus the bezel.
          assert.equal(art.outerRadius, device.frameRadius * zoom);
          assert.equal(art.screen.radius, device.screenRadius * zoom);
          for (const b of art.buttons) {
            assert.ok(b.x < 0 || b.x >= art.portrait.width - 1, `${tag}: buttons stick out of the body`);
          }
          if (device.cutout === 'dynamic-island') {
            const island = art.island!;
            const p = deviceGeometry(device, false);
            const sx = p.screen.x * zoom, sy = p.screen.y * zoom, sw = p.screen.width * zoom;
            for (const v of [island.x, island.y, island.width, island.height]) {
              assert.ok(Math.abs(v * dpr - Math.round(v * dpr)) < 1e-6, `${tag}: island on whole device pixels (${v})`);
            }
            assert.ok(island.x >= sx && island.x + island.width <= sx + sw && island.y > sy, `${tag}: island inside the screen`);
            assert.ok(Math.abs(island.width - device.island!.width * zoom) <= 1 / dpr, `${tag}: island proportions`);
            assert.ok(Math.abs(island.x + island.width / 2 - (sx + sw / 2)) <= 1 / dpr, `${tag}: island centred`);
            assert.ok(island.camera.cx + island.camera.r < island.x + island.width, `${tag}: camera inside the island`);
          } else {
            assert.equal(art.island, null);
          }
          assert.equal(!!art.punchHole, device.cutout === 'punch-hole', `${tag}: camera hole`);
          assert.equal(!!art.se, device.homeButton, `${tag}: SE bezel parts`);
          assert.equal((art.band > 0), (device.band ?? 0) > 0, `${tag}: metal band on iPhones`);
        }
      }
    }
  }

  console.log('  [frame-hd] Size: Fit fills ~92 % of the stage; 100 % and 125 %; the app on whole pixels...');
  for (const device of DEVICES) {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      const g = deviceGeometry(device, false);
      const fit = previewZoom('fit', g, 900, 1000, dpr);
      assert.ok(g.frame.height * fit <= 1000 * FIT_HEIGHT + 1e-6 && g.frame.width * fit <= 900 + 1e-6, `${device.id} dpr${dpr}: Fit fits`);
      assert.ok(g.frame.height * fit >= 1000 * FIT_HEIGHT - 40 || g.frame.width * fit >= 900 - 40, `${device.id} dpr${dpr}: Fit is not small (${fit})`);
      const z100 = previewZoom('100', g, 10, 10, dpr);
      const z125 = previewZoom('125', g, 10, 10, dpr);
      assert.ok(z100 <= 1 && z100 > 0.95, `${device.id}: 100 % (${z100})`);
      assert.ok(z125 <= 1.25 && z125 > 1.2, `${device.id}: 125 % (${z125})`);
      for (const z of [fit, z100, z125]) {
        assert.ok(Math.abs(g.app.width * z * dpr - Math.round(g.app.width * z * dpr)) < 1e-6, `${device.id} dpr${dpr}: app width whole pixels at ${z}`);
      }
    }
  }
  // Bigger than before: the old docked fit stopped at 1× (natural size); a tall pane now fills it.
  assert.ok(previewZoom('fit', deviceGeometry(DEVICES[0], false), 1400, 1300, 1) > 1.2);

  console.log('  [frame-hd] The zoom choice is remembered; broken storage falls back to Fit...');
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  assert.equal(loadZoomMode(storage), 'fit', 'Fit by default');
  saveZoomMode(storage, '125');
  assert.equal(store.get(ZOOM_STORAGE_KEY), '125');
  assert.equal(loadZoomMode(storage), '125');
  store.set(ZOOM_STORAGE_KEY, '300');
  assert.equal(loadZoomMode(storage), 'fit', 'an unknown value');
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(loadZoomMode(broken), 'fit');
  assert.doesNotThrow(() => saveZoomMode(broken, '100'));
  assert.equal(loadZoomMode(null), 'fit');

  console.log('  [frame-hd] Wiring: vectors at the final size, no bitmap scaling, a transparent live detached window...');
  const assembly = read('src/renderer/src/features/preview/PreviewAssembly.tsx');
  assert.match(assembly, /clipPath: `path\('\$\{art\.screen\.clip\}'\)`/, 'the screen clipped with the frame\'s own path');
  assert.match(assembly, /<FrameSvg art=\{art\} finish=\{finishUsed\} \/>/);
  const pane = read('src/renderer/src/layout/PreviewPane.tsx');
  assert.match(pane, /width: geometry\.frame\.width \* scale,\s+height: geometry\.frame\.height \* scale,/, 'sized by real width and height');
  assert.doesNotMatch(pane, /zoom: scale/, 'no CSS zoom on the frame');
  assert.match(pane, /previewZoom\(zoomModeRef\.current/);
  assert.match(pane, /saveZoomMode\(safeLocalStorage\(\), mode\)/);
  assert.match(pane, /\}, \[zoomMode, dpr, fitScale\]\);/, 'refit on a display-scaling change');
  const detached = read('src/renderer/src/features/preview/DetachedPreview.tsx');
  assert.match(detached, /zoom=\{scale\} dpr=\{dpr\}/);
  assert.match(detached, /<iframe/, 'the live preview, not an image');
  assert.doesNotMatch(detached, /capturePage|toDataURL|<img/);
  assert.match(detached, /\}, \[deviceId, landscape, dpr\]\);/);
  const ipc = read('src/main/ipc/index.ts');
  const detach = ipc.slice(ipc.indexOf('previewWindow = new BrowserWindow({'), ipc.indexOf('previewWindow = new BrowserWindow({') + 900);
  assert.match(detach, /transparent: true,/, 'only the phone floats on the desktop');
  assert.match(detach, /hasShadow: false,/, 'no window shadow around the transparent rectangle');
  assert.match(ipc, /const chromeW = 8;\s+const chromeH = 6 \+ 44 \+ 6 \+ 4;/, 'the window is tight around the phone and its header');
  // Clicks outside the phone's shape go through to the desktop; only the detached window can ask for it.
  assert.match(ipc, /IPC_CHANNELS\.PREVIEW_CLICK_THROUGH, \(event, through: unknown\) => \{\s+if \(!previewWindow \|\| previewWindow\.isDestroyed\(\) \|\| event\.sender !== previewWindow\.webContents\) return;\s+if \(through === true\) previewWindow\.setIgnoreMouseEvents\(true, \{ forward: true \}\);/);
  assert.match(detached, /window\.peep\.setPreviewClickThrough\?\.\(next\)/);
  assert.match(detached, /compactShadow>/, 'a compact shadow (a large one would be cut at the window edge)');
  assert.match(detached, /exactZoom\(Math\.min\(2, availW \/ FRAME_W, availH \/ FRAME_H\)/);
  const detachedCss = read('src/renderer/src/features/preview/DetachedPreview.css');
  assert.match(detachedCss, /\.detached-stage \{[^}]*background: transparent;/s);
  assert.match(detachedCss, /\.detached-stage \.pf-hit \{\s*pointer-events: auto;/s, 'the bezel counts as the phone');
  assert.match(read('src/renderer/src/features/preview/PhoneFrame.tsx'), /className="pf-hit" d=\{art\.body \+ art\.opening\} fillRule="evenodd"/, 'the body path, without the screen opening');
  for (const rel of ['src/renderer/src/features/preview/PhoneFrame.css', 'src/renderer/src/features/preview/PhoneFrame.tsx', 'src/renderer/src/features/preview/PreviewAssembly.tsx', 'src/renderer/src/layout/PreviewPane.css']) {
    assert.doesNotMatch(read(rel), /will-change\s*:|willChange/, `${rel}: no will-change`);
  }
  for (const lang of ['en', 'ar', 'tr']) {
    const t = JSON.parse(read(`src/renderer/src/i18n/locales/${lang}.json`));
    assert.ok(t.preview.zoom && t.preview.zoomFit, `${lang}: zoom strings`);
  }
  console.log('  🟢 Passed');
}
