import React, { useEffect, useMemo, useRef } from 'react';
import { FrameSvg, SystemBars, type StatusOverride } from './PhoneFrame';
import { deviceGeometry, type DeviceConfig, type Finish } from './devices';
import { frameArt } from './frame-svg';
import type { SystemBarTones } from './usePreviewSafeArea';

interface PreviewAssemblyProps {
  device: DeviceConfig;
  landscape?: boolean;
  /** Icon colours for the status bar and the home indicator: dark over a light app, light over a dark one. */
  tone?: SystemBarTones;
  /** The app's background colour, shown under the iframe; black until the app reports it. */
  background?: string | null;
  /** iPhones: the metal band's finish (devices.ts); the device's default when absent. */
  finish?: Finish;
  /** Frame lab only: fixed status-bar time and signal for repeatable captures. */
  statusOverride?: StatusOverride;
  /** Device points → CSS px (Fit / 100 % / 125 %, from previewZoom). The frame is drawn at this size. */
  zoom?: number;
  /** window.devicePixelRatio: small parts (Dynamic Island, cameras) sit on whole device pixels. */
  dpr?: number;
  /** A small contact shadow only (the detached window is tight around the phone; a large shadow would be cut). */
  compactShadow?: boolean;
  /** The app (iframe or placeholder). It fills the whole screen. */
  children: React.ReactNode;
}

const DEFAULT_TONES: SystemBarTones = { top: 'light', bottom: 'light' };

/**
 * A device frame at its final on-screen size, edge to edge like a simulator:
 * - the frame is one SVG drawn at zoom × the device's size (frame-svg.ts), over the screen;
 * - the screen is clipped with the same continuous-corner path the frame's opening uses;
 * - inside it, the app and the system bars are laid out in the device's points and scaled with CSS zoom, which
 *   Chromium re-renders at the final size (sharp text, the page still sees e.g. 402 px), never a stretched bitmap.
 * No transform or will-change on the frame.
 */
export function PreviewAssembly({
  device, landscape = false, tone = DEFAULT_TONES, background, finish, statusOverride, zoom = 1, dpr, compactShadow = false, children,
}: PreviewAssemblyProps) {
  const finishUsed = finish ?? device.finishes?.[0];
  const ratio = dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  const rootRef = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  // A subtle 200 ms fade when the model or finish changes: opacity only (no scaling of the frame), on the existing
  // element, so the app's iframe is not remounted. None with reduced motion.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const el = rootRef.current;
    if (!el?.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    el.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }, [device.id, finishUsed?.id]);

  const art = useMemo(() => frameArt(device, landscape, zoom, ratio), [device, landscape, zoom, ratio]);
  const g = deviceGeometry(device, landscape);
  const underlay = background || '#000';

  return (
    <div ref={rootRef} className="device-assembly" style={{ position: 'relative', width: art.width, height: art.height }}>
      {/* Soft shadows under the body (blurred, so their own corner shape does not show). */}
      <div className={`pf-shadow${compactShadow ? ' pf-shadow--compact' : art.band > 0 ? ' pf-shadow--metal' : ''}`} style={{ borderRadius: art.outerRadius }} aria-hidden="true" />

      {/* The screen: clipped with the frame opening's own path, so there is one edge around the app. */}
      <div className="screen-mask" style={{
        position: 'absolute',
        left: art.screen.x,
        top: art.screen.y,
        width: art.screen.width,
        height: art.screen.height,
        overflow: 'hidden',
        clipPath: `path('${art.screen.clip}')`,
        background: underlay,
        ['--preview-app-bg' as string]: underlay,
        zIndex: 1,
      }}>
        <div className="screen-zoom" style={{ position: 'relative', width: g.screen.width, height: g.screen.height, zoom }}>
          <div className="screen-app" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
            {children}
          </div>
          <SystemBars device={device} geometry={g} landscape={landscape} tone={tone} override={statusOverride} />
          {/* The cover glass: a very faint diagonal reflection, over everything, never catching the pointer. */}
          {device.os === 'ios' && (
            <div className={`pf-glare${landscape ? ' pf-glare--landscape' : ''}`} style={{ borderRadius: device.screenRadius }} aria-hidden="true" />
          )}
        </div>
      </div>

      <FrameSvg art={art} finish={finishUsed} />
    </div>
  );
}
