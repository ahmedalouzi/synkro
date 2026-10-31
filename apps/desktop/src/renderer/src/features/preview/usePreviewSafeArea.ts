import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { parsePreviewRuntimeReport } from '@peep/shared';
import type { DeviceConfig, DeviceGeometry } from './devices';

export type StatusBarTone = 'light' | 'dark';
/** Icon colour for the status bar (and Dynamic Island area) and for the home indicator / gesture bar. */
export interface SystemBarTones { top: StatusBarTone; bottom: StatusBarTone }

/** Where the frame may say a status-bar style came from; anything else is ignored. */
const SOURCES = [
  'expo-status-bar style=light', 'expo-status-bar style=dark', 'expo-status-bar style=auto', 'expo-status-bar style=inverted',
  'StatusBar barStyle=light-content', 'StatusBar barStyle=dark-content', 'theme-color', 'color-scheme',
] as const;
type Source = (typeof SOURCES)[number];
interface Sampled { tone: StatusBarTone; luminance: number }

/** Dynamic Island width (pt), kept out of the status-bar sample: it is black whatever the app draws. */
const ISLAND_WIDTH = 126;
/** Margin (pt) kept from the screen's edges and the strips' ends: the bezel overlaps the screen there. */
const MARGIN = 4;

/** White or #1C1C1E (relative luminance 0.0117), whichever contrasts more with a background of luminance l. */
export function toneForLuminance(l: number): StatusBarTone {
  return 1.05 / (l + 0.05) >= (l + 0.05) / (0.0117 + 0.05) ? 'light' : 'dark';
}

type Rect = { x: number; y: number; width: number; height: number };

/** The strips behind the status bar (either side of a Dynamic Island) and the home indicator, in app px. */
function stripsFor(device: DeviceConfig, geometry: DeviceGeometry): { statusBar: Rect[]; homeArea: Rect[] } {
  const { width, height } = geometry.app;
  const { top, bottom } = geometry.safe;
  const statusBar: Rect[] = [];
  if (top >= 8) {
    const h = top - 2 * MARGIN;
    if (device.cutout === 'dynamic-island') {
      const side = (width - ISLAND_WIDTH) / 2 - 2 * MARGIN;
      statusBar.push({ x: MARGIN, y: MARGIN, width: side, height: h });
      statusBar.push({ x: (width + ISLAND_WIDTH) / 2 + MARGIN, y: MARGIN, width: side, height: h });
    } else {
      statusBar.push({ x: MARGIN, y: MARGIN, width: width - 2 * MARGIN, height: h });
    }
  }
  const homeArea: Rect[] = bottom >= 8
    ? [{ x: MARGIN, y: height - bottom + 2, width: width - 2 * MARGIN, height: bottom - 2 - MARGIN }]
    : [];
  return { statusBar, homeArea };
}

/**
 * The host side of the preview iframe's channel (preload/preview-safe-area.ts): sends the device's insets to
 * the app, and decides the system-bar icon colours like a phone does:
 *   1. the status-bar style the app declares (expo-status-bar / StatusBar, else meta theme-color / color-scheme),
 *      as reported by the frame;
 *   2. otherwise the rendered pixels behind the status bar, sampled from this window (median luminance).
 * The home indicator / gesture bar always follows the pixels behind it. The status-bar strip's average colour
 * is the screen's underlay (null until sampled). Only messages from this iframe's window are read.
 */
export function usePreviewSafeArea(
  iframeRef: RefObject<HTMLIFrameElement | null>, url: string | undefined, device: DeviceConfig, geometry: DeviceGeometry,
) {
  const [declared, setDeclared] = useState<{ tone: StatusBarTone; source: Source } | null>(null);
  const [sampledTop, setSampledTop] = useState<Sampled | null>(null);
  const [sampledBottom, setSampledBottom] = useState<Sampled | null>(null);
  const [background, setBackground] = useState<string | null>(null);
  const { top, right, bottom, left } = geometry.safe;

  // The iframe element that has loaded the app. Before that its window is about:blank, and a message with the
  // app's origin as targetOrigin is refused with an origin-mismatch error (the insets then arrive on load).
  const loadedFrame = useRef<HTMLIFrameElement | null>(null);
  const send = useCallback(() => {
    const iframe = iframeRef.current;
    const target = iframe?.contentWindow;
    if (!iframe || !target || !url || loadedFrame.current !== iframe) return;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }
    target.postMessage({ type: 'atomvs:safe-area', insets: { top, right, bottom, left } }, origin);
  }, [iframeRef, url, top, right, bottom, left]);

  // Sample the rendered strips; one capture at a time, and at most every 150 ms.
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The callers build geometry on every render; read the latest from a ref so the sampler stays stable.
  const current = useRef({ device, geometry });
  current.current = { device, geometry };
  const sample = useCallback(async () => {
    const iframe = iframeRef.current;
    const { device, geometry } = current.current;
    if (!iframe || busy.current) return;
    const rect = iframe.getBoundingClientRect();
    if (rect.width < 1) return;
    const k = rect.width / geometry.app.width; // the frame's zoom
    const { statusBar, homeArea } = stripsFor(device, geometry);
    const rects = [...statusBar, ...homeArea].map((s) => ({
      x: Math.max(0, rect.left + s.x * k), y: Math.max(0, rect.top + s.y * k), width: s.width * k, height: s.height * k,
    }));
    if (!rects.length || !window.peep?.samplePreviewStrips) return;
    busy.current = true;
    try {
      const results = await window.peep.samplePreviewStrips(rects);
      const average = (list: typeof results) => {
        const ok = list.filter((r): r is NonNullable<typeof r> => !!r);
        if (!ok.length) return null;
        const luminance = ok.reduce((s, r) => s + r.luminance, 0) / ok.length;
        const rgb = [0, 1, 2].map((i) => Math.round(ok.reduce((s, r) => s + r.rgb[i], 0) / ok.length));
        return { luminance, rgb };
      };
      const t = average(results.slice(0, statusBar.length));
      const b = average(results.slice(statusBar.length));
      if (t) {
        setSampledTop({ tone: toneForLuminance(t.luminance), luminance: t.luminance });
        setBackground(`rgb(${t.rgb[0]}, ${t.rgb[1]}, ${t.rgb[2]})`);
      } else if (!statusBar.length) {
        setSampledTop(null);
      }
      setSampledBottom(b ? { tone: toneForLuminance(b.luminance), luminance: b.luminance } : null);
    } finally {
      busy.current = false;
    }
  }, [iframeRef]);
  const scheduleSample = useCallback((delay = 150) => {
    if (timer.current) return;
    timer.current = setTimeout(() => { timer.current = null; void sample(); }, delay);
  }, [sample]);

  // New device or orientation: the app gets the new insets (and re-measures), then the strips are re-sampled.
  const { width: appWidth, height: appHeight } = geometry.app;
  useEffect(() => { send(); scheduleSample(300); }, [send, scheduleSample, device.id, appWidth, appHeight]);

  // A slow fallback, for changes the frame can't see (e.g. a canvas or video redrawing).
  useEffect(() => {
    const id = setInterval(() => scheduleSample(0), 1500);
    return () => clearInterval(id);
  }, [scheduleSample]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const data = event.data as { type?: unknown; declared?: unknown; source?: unknown } | null;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'atomvs:safe-area-request') {
        // Sent by the shim from the app's own page, so the iframe is on the app's origin now (before 'load').
        loadedFrame.current = iframeRef.current;
        send();
      }
      else if (data.type === 'atomvs:screen-changed') scheduleSample();
      else if (data.type === 'atomvs:runtime') {
        // Relayed for the agent's get_preview_logs (main validates it again).
        const report = parsePreviewRuntimeReport(data);
        if (report) window.peep?.reportPreviewRuntime?.(report);
      }
      else if (data.type === 'atomvs:status-bar') {
        const tone = data.declared;
        const source = data.source as Source;
        setDeclared((tone === 'light' || tone === 'dark') && SOURCES.includes(source) ? { tone, source } : null);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [iframeRef, send, scheduleSample]);

  // Another app: nothing known about it yet (black underlay, dark icons until sampled).
  useEffect(() => {
    setDeclared(null);
    setSampledTop(null);
    setSampledBottom(null);
    setBackground(null);
  }, [url]);

  const topTone: StatusBarTone = declared?.tone ?? sampledTop?.tone ?? 'dark';
  const bottomTone: StatusBarTone = sampledBottom?.tone ?? topTone;

  // Dev: say why, whenever the decision changes.
  const logged = useRef('');
  useEffect(() => {
    if (!import.meta.env.DEV || !url) return;
    const followsSystem = declared && /auto|inverted|color-scheme/.test(declared.source)
      ? ` (follows the system's ${window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'} mode)` : '';
    const why = declared
      ? `declared: ${declared.source}${followsSystem}`
      : sampledTop ? `sampled, luminance ${sampledTop.luminance.toFixed(3)}` : 'nothing known yet';
    const bottomWhy = sampledBottom ? `sampled, luminance ${sampledBottom.luminance.toFixed(3)}` : 'same as status bar';
    const key = `${topTone} ${declared?.source ?? (sampledTop ? 'sampled' : '-')} ${bottomTone}`;
    if (key === logged.current) return;
    logged.current = key;
    console.info(`[preview] ${device.label}: status bar ${topTone === 'light' ? 'white' : 'dark'} icons (${why}); `
      + `home indicator ${bottomTone === 'light' ? 'white' : 'dark'} (${bottomWhy})`);
  }, [url, device.label, declared, sampledTop, sampledBottom, topTone, bottomTone]);

  /** Call from the iframe's onLoad: a reloaded app starts without insets. */
  const onFrameLoad = useCallback((event?: { currentTarget: HTMLIFrameElement }) => {
    loadedFrame.current = event?.currentTarget ?? iframeRef.current;
    send();
    scheduleSample(400);
  }, [iframeRef, send, scheduleSample]);

  return { tone: { top: topTone, bottom: bottomTone } as SystemBarTones, background, onFrameLoad };
}
