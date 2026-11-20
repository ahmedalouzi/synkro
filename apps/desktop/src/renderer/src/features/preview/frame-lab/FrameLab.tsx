import './FrameLab.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PreviewAssembly } from '../PreviewAssembly';
import { DEVICES, deviceFinish, deviceGeometry, deviceTitle, type DeviceType } from '../devices';
import { usePreviewSafeArea, type SystemBarTones } from '../usePreviewSafeArea';
import type { DeviceConfig, DeviceGeometry } from '../devices';

/**
 * Frame lab (dev only): our device frames at a chosen zoom next to, or over, a screenshot of Xcode's Simulator,
 * to compare them pixel for pixel. Open /frame-lab.html on the renderer's dev server. The screenshot stays in this
 * page (an object URL); nothing is uploaded or saved.
 *
 * Scale: how many screenshot pixels make one point. A Simulator screenshot of the screen only (File > Save Screen)
 * is 3 px/pt on iPhone 15 / 15 Pro and 2 on the SE; a macOS window capture of the Simulator at "Point Accurate"
 * size is 2 on a Retina display. "Fit width" assumes the screenshot is cropped to the device's outer edge.
 */
type Mode = 'side' | 'overlay';

/** Start state from the URL, for repeatable captures: ?device=iphone-17-pro&finish=silver&zoom=1&app=%23000000&landscape=1
 *  &bare=1 (only the frame, no toolbar) &page=%23202024 (page background). */
const params = new URLSearchParams(window.location.search);
const BARE = params.get('bare') === '1';
/** ?appUrl=http://127.0.0.1:…/ : a real app in the screen, with the insets sent exactly as the Preview pane does. */
const APP_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(params.get('appUrl') ?? '') ? params.get('appUrl')! : null;

/** The app's iframe, as in PreviewPane: full screen, and usePreviewSafeArea sending the device's insets. */
function AppFrame({ url, device, geometry }: { url: string; device: DeviceConfig; geometry: DeviceGeometry }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const { onFrameLoad } = usePreviewSafeArea(ref, url, device, geometry);
  // A test fixture may report its own layout ({ type: 'fixture:report', … }); shown for headless checks (--dump-dom).
  const [report, setReport] = useState('');
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source === ref.current?.contentWindow && e.data?.type === 'fixture:report') setReport((prev) => JSON.stringify({ ...(prev ? JSON.parse(prev) : {}), ...e.data }));
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);
  return (
    <>
      <iframe ref={ref} className="preview-iframe" src={url} title="App" onLoad={onFrameLoad}
        style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} />
      <pre id="fixture-report" hidden>{report}</pre>
    </>
  );
}

function isLight(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 > 0.5;
}

export function FrameLab() {
  const [deviceId, setDeviceId] = useState<DeviceType>((params.get('device') as DeviceType) || 'iphone-17-pro');
  const [landscape, setLandscape] = useState(params.get('landscape') === '1');
  const [zoom, setZoom] = useState(Number(params.get('zoom')) || 1);
  const initialBg = params.get('app') || '#ffffff';
  const [appBg, setAppBg] = useState(initialBg);
  const [tone, setTone] = useState<SystemBarTones['top']>(isLight(initialBg) ? 'dark' : 'light');
  const [shot, setShot] = useState<{ url: string; w: number; h: number } | null>(null);
  const [scale, setScale] = useState(3);
  const [mode, setMode] = useState<Mode>('side');
  const [opacity, setOpacity] = useState(0.5);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const fileRef = useRef<HTMLInputElement>(null);
  const [finishId, setFinishId] = useState<string | null>(params.get('finish'));

  const device = DEVICES.find((d) => d.id === deviceId)!;
  const finish = deviceFinish(device, finishId);
  const g = useMemo(() => deviceGeometry(device, landscape), [device, landscape]);

  const load = useCallback((file: File | null | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setShot((old) => {
      if (old) URL.revokeObjectURL(old.url);
      return { url, w: img.naturalWidth, h: img.naturalHeight };
    });
    img.src = url;
  }, []);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => load(Array.from(e.clipboardData?.files ?? [])[0]);
    // Arrow keys nudge the screenshot by one point (Shift: ten) to line it up.
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d) { e.preventDefault(); setOffset((o) => ({ x: o.x + d[0], y: o.y + d[1] })); }
    };
    window.addEventListener('paste', onPaste);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('paste', onPaste); window.removeEventListener('keydown', onKey); };
  }, [load]);

  const setBg = (bg: string) => {
    setAppBg(bg);
    // Like the app: dark icons over a light background, light over a dark one.
    setTone(isLight(bg) ? 'dark' : 'light');
  };

  const shotStyle = shot && {
    width: (shot.w / scale) * zoom,
    height: (shot.h / scale) * zoom,
  };

  const frame = (
    <div className="fl-frame" style={{ width: g.frame.width * zoom, height: g.frame.height * zoom }}>
      <div>
        <PreviewAssembly device={device} landscape={landscape} zoom={zoom} tone={{ top: tone, bottom: tone }} background={appBg} finish={finish}
          statusOverride={params.get('time') || params.get('signal') ? { time: params.get('time') ?? undefined, signal: (params.get('signal') as 'none' | 'full' | null) ?? undefined } : undefined}>
          {APP_URL ? <AppFrame url={APP_URL} device={device} geometry={g} /> : (
            <div className="fl-app" style={{ background: appBg, color: tone === 'dark' ? '#000' : '#fff' }}>
              <div className="fl-app-title">Frame lab</div>
            </div>
          )}
        </PreviewAssembly>
      </div>
    </div>
  );

  if (BARE) {
    return (
      <div className="fl-bare" style={{ background: params.get('page') || '#202024' }} data-ready="1">
        {frame}
      </div>
    );
  }

  return (
    <div
      className="fl-root"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); load(e.dataTransfer.files[0]); }}
    >
      <header className="fl-bar">
        <strong>Frame lab</strong>
        <label>Device
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value as DeviceType)}>
            {DEVICES.map((d) => <option key={d.id} value={d.id}>{deviceTitle(d)}</option>)}
          </select>
        </label>
        {device.finishes && (
          <label>Finish
            <select value={finish?.id} onChange={(e) => setFinishId(e.target.value)}>
              {device.finishes.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
        )}
        <label><input type="checkbox" checked={landscape} onChange={(e) => setLandscape(e.target.checked)} /> Landscape</label>
        <label>Zoom
          <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
            {[0.5, 0.75, 1, 1.5, 2, 3].map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
          </select>
        </label>
        <label>App
          <select value={appBg} onChange={(e) => setBg(e.target.value)}>
            <option value="#ffffff">White (dark status bar)</option>
            <option value="#f2f2f7">iOS grouped (dark)</option>
            <option value="#000000">Black (light status bar)</option>
            <option value="#1c1c1e">iOS dark (light)</option>
          </select>
        </label>
        <span className="fl-sep" />
        <button type="button" onClick={() => fileRef.current?.click()}>Xcode screenshot…</button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => load(e.target.files?.[0])} />
        {shot && (
          <>
            <label>px/pt <input type="number" min={0.25} step={0.05} value={scale} onChange={(e) => setScale(Number(e.target.value) || 1)} /></label>
            <button type="button" onClick={() => setScale(shot.w / g.frame.width)}>Fit width</button>
            <label>
              <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                <option value="side">Side by side</option>
                <option value="overlay">Overlay</option>
              </select>
            </label>
            {mode === 'overlay' && (
              <label>Opacity <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} /></label>
            )}
            <span className="fl-hint">offset {offset.x}, {offset.y} pt (arrow keys, Shift ×10)</span>
            <button type="button" onClick={() => setOffset({ x: 0, y: 0 })}>Reset</button>
          </>
        )}
      </header>

      <div className="fl-meta">
        {deviceTitle(device)} — frame {g.frame.width} × {g.frame.height} pt, screen {g.screen.width} × {g.screen.height} pt at
        ({g.screen.x}, {g.screen.y}), bezel {device.bezel.side} pt (band {device.band ?? 0}), screen radius {device.screenRadius} pt
        {device.island && <>, island {device.island.width} × {device.island.height} pt at {device.island.top} pt</>}
        {shot && <> · screenshot {shot.w} × {shot.h} px = {(shot.w / scale).toFixed(1)} × {(shot.h / scale).toFixed(1)} pt</>}
        {!shot && <> · drop, paste or pick an Xcode Simulator screenshot to compare</>}
      </div>

      <main className={`fl-stage fl-stage--${shot ? mode : 'side'}`}>
        <figure>
          <figcaption>Atomvs</figcaption>
          <div className="fl-cell">
            {frame}
            {shot && mode === 'overlay' && (
              <img
                className="fl-shot fl-shot--over"
                src={shot.url}
                alt="Xcode Simulator"
                style={{ ...shotStyle!, opacity, left: offset.x * zoom, top: offset.y * zoom }}
              />
            )}
          </div>
        </figure>
        {shot && mode === 'side' && (
          <figure>
            <figcaption>Xcode Simulator</figcaption>
            <div className="fl-cell">
              <img className="fl-shot" src={shot.url} alt="Xcode Simulator" style={{ ...shotStyle!, transform: `translate(${offset.x * zoom}px, ${offset.y * zoom}px)` }} />
            </div>
          </figure>
        )}
      </main>
    </div>
  );
}
