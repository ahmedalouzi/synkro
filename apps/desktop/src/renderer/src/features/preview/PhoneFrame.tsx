import './PhoneFrame.css';
// Inter (SIL Open Font License), Latin, weight 500 only: the iOS status bar's time (Inter's 500 has about the stroke
// weight of SF's Semibold, measured against the Simulator). Bundled with the app; no Apple fonts.
import '@fontsource/inter/latin-500.css';
import { useState, useEffect, useId } from 'react';
import type { DeviceConfig, DeviceGeometry, Finish } from './devices';
import { statusBarTime } from './frame-geometry';
import { metalPalette, squirclePath, type FrameArt } from './frame-svg';
import type { SystemBarTones } from './usePreviewSafeArea';

export type { DeviceType } from './devices';

function useClock() {
  const fmt = () => statusBarTime(new Date());
  const [time, setTime] = useState(fmt);
  useEffect(() => {
    // One update at each minute boundary (plus when the window comes back, e.g. after sleep): no per-second renders.
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setTime(fmt());
      const now = new Date();
      timer = setTimeout(tick, 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 20);
    };
    tick();
    const onVisible = () => { if (document.visibilityState === 'visible') { clearTimeout(timer); tick(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return time;
}

/* ── Status-bar glyphs, drawn by us at the iOS status bar's point sizes ──────────────────
   Cellular 19.2 × 12.23, Wi-Fi 17.14 × 12.33, battery 27.33 × 13 pt (no Apple artwork is used). */

/** A ring sector of the Wi-Fi fan, opening upward from its point at the bottom. */
function wifiBand(inner: number, outer: number): string {
  const cx = 8.57, cy = 11.75, a0 = (-135 * Math.PI) / 180, a1 = (-45 * Math.PI) / 180;
  const pt = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  if (inner === 0) return `M${cx} ${cy}L${pt(outer, a0)}A${outer} ${outer} 0 0 1 ${pt(outer, a1)}Z`;
  return `M${pt(inner, a0)}L${pt(outer, a0)}A${outer} ${outer} 0 0 1 ${pt(outer, a1)}L${pt(inner, a1)}A${inner} ${inner} 0 0 0 ${pt(inner, a0)}Z`;
}
/** Three bold bands with narrow gaps, like iOS 16+. */
const WIFI_BANDS = [wifiBand(0, 3.5), wifiBand(5.35, 7.75), wifiBand(9.6, 11.8)];

/**
 * The cellular slot. `none`: no service, as the Simulator shows it (it has no cellular radio): four small dots on
 * the baseline where the bars would be. `full`: four bars of rising height.
 */
export function CellularIcon({ signal = 'none' }: { signal?: 'none' | 'full' }) {
  const xs = [0, 5.33, 10.67, 16];
  return (
    <svg className="pf-glyph pf-glyph--cell" viewBox="0 0 19.2 12.23" width="19.2" height="12.23" aria-hidden="true">
      {signal === 'full'
        ? [4.1, 6.4, 8.9, 12.23].map((h, i) => <rect key={i} x={xs[i]} y={12.23 - h} width="3.2" height={h} rx="1.1" />)
        : xs.map((x) => <circle key={x} cx={x + 1.6} cy={10.6} r={1.6} />)}
    </svg>
  );
}

export function WifiIcon() {
  return (
    <svg className="pf-glyph" viewBox="0 0 17.14 12.33" width="17.14" height="12.33" aria-hidden="true">
      {/* Rounded joins soften the sector corners like Apple's glyph. */}
      {WIFI_BANDS.map((d) => <path key={d} d={d} stroke="currentColor" strokeWidth="0.35" strokeLinejoin="round" />)}
    </svg>
  );
}

/** The battery, filled solid to its level (the Simulator shows it full), with the small cap on the right. */
export function BatteryIcon({ level = 1 }: { level?: number }) {
  return (
    <svg className="pf-glyph" viewBox="0 0 27.33 13" width="27.33" height="13" aria-hidden="true">
      <rect x="0.5" y="0.5" width="24" height="12" rx="4" fill="none" stroke="currentColor" strokeOpacity="0.35" />
      <rect x="2" y="2" width={Math.max(1.5, 21 * Math.min(1, Math.max(0, level)))} height="9" rx="2.5" />
      <path d="M26 4.5v4a2.1 2.1 0 0 0 1.33-2 2.1 2.1 0 0 0-1.33-2Z" fillOpacity="0.55" />
    </svg>
  );
}


/** Space kept free at the outer end of each status-bar "ear" (the screen's rounded corner), in points. */
const EAR_OUTER_INSET = 10;

/** Fallback when a Dynamic Island device has no island in its config. */
const DEFAULT_ISLAND = { width: 126, height: 37.33, top: 11.33 };

/**
 * The device frame as one inline SVG at its final size (frame-svg.ts computes every shape in final CSS px): the
 * body and the metal band, the black glass with the screen's opening, the side buttons, the Dynamic Island, the
 * camera hole, and the SE's bezel parts. Each edge is drawn once, at the screen's resolution. Laid out in portrait;
 * `art.rotate` turns it for landscape. Over the screen (the opening overlaps the app's edge by under a device pixel),
 * never catching the pointer. Our own drawing: no Apple artwork.
 */
export function FrameSvg({ art, finish }: { art: FrameArt; finish?: Finish }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const id = (name: string) => `pf-${uid}-${name}`;
  const metal = art.band > 0;
  const pal = metalPalette(finish);
  const { width: W, height: H } = art.portrait;
  const R = art.outerRadius;
  const band = art.band;
  // Lines a hair wider than a device pixel stay solid at any zoom.
  const hairline = 0.9;
  const lens = `url(#${id('lens')})`;
  return (
    <svg className="pf-svg" width={art.width} height={art.height} viewBox={`0 0 ${art.width} ${art.height}`} aria-hidden="true" focusable="false">
      <defs>
        {/* The band's light: brighter top-left, falling off to the bottom-right (around the perimeter). */}
        <linearGradient id={id('band')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={pal.hi} />
          <stop offset="0.28" stopColor={pal.lit} />
          <stop offset="0.55" stopColor={pal.base} />
          <stop offset="0.8" stopColor={pal.lit} />
          <stop offset="1" stopColor={pal.lo} />
        </linearGradient>
        {/* A thin specular line along the top edge. */}
        <linearGradient id={id('spec')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity={finish?.dark ? 0.35 : 0.55} />
          <stop offset="0.06" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={id('btn-l')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={metal ? pal.base : '#2a2a2c'} />
          <stop offset="0.45" stopColor={metal ? pal.hi : '#1e1e20'} />
          <stop offset="1" stopColor={metal ? pal.lit : '#1a1a1c'} />
        </linearGradient>
        <linearGradient id={id('btn-r')} x1="1" y1="0" x2="0" y2="0">
          <stop offset="0" stopColor={metal ? pal.base : '#2a2a2c'} />
          <stop offset="0.45" stopColor={metal ? pal.hi : '#1e1e20'} />
          <stop offset="1" stopColor={metal ? pal.lit : '#1a1a1c'} />
        </linearGradient>
        <radialGradient id={id('lens')} cx="0.38" cy="0.34" r="0.7">
          <stop offset="0" stopColor="#0a2a4a" />
          <stop offset="0.35" stopColor="#061420" />
          <stop offset="0.6" stopColor="#020808" />
          <stop offset="1" stopColor="#010404" />
        </radialGradient>
        <linearGradient id={id('hinge')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0" />
          <stop offset="0.5" stopColor="#000" stopOpacity="0.07" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g transform={art.rotate || undefined}>
        {/* Side buttons first: the body covers their inner ends. */}
        {art.buttons.map((b, i) => (
          <rect key={i} x={b.x} y={b.y} width={b.width} height={b.height}
            rx={Math.min(b.width / 2, metal ? 1.25 : 3)} fill={`url(#${id(b.side === 'left' ? 'btn-l' : 'btn-r')})`} />
        ))}

        {/* The body (with the screen's opening). */}
        <path className="pf-hit" d={art.body + art.opening} fillRule="evenodd" fill={metal ? pal.deep : '#111113'} />
        {metal && (
          <>
            {/* The metal band: one gradient stroke along its centre line, then the crest, the bevel into the glass,
                the outer edge and the specular line, each a single path. */}
            <path d={art.bandPath} fill="none" stroke={`url(#${id('band')})`} strokeWidth={band} />
            <path d={squirclePath(band * 0.45, band * 0.45, W - band * 0.9, H - band * 0.9, Math.max(0, R - band * 0.45))}
              fill="none" stroke={pal.hi} strokeOpacity={finish?.dark ? 0.45 : 0.7} strokeWidth={band * 0.18} />
            <path d={squirclePath(band * 0.86, band * 0.86, W - band * 1.72, H - band * 1.72, Math.max(0, R - band * 0.86))}
              fill="none" stroke={pal.fall} strokeWidth={band * 0.28} />
            <path d={art.body} fill="none" stroke={pal.edge} strokeWidth={hairline} />
            <path d={art.body} fill="none" stroke={`url(#${id('spec')})`} strokeWidth={hairline * 1.4} />
          </>
        )}
        {!metal && <path d={art.body} fill="none" stroke="#2a2a2c" strokeWidth={hairline} />}

        {/* The black glass around the screen, with its faint 1 px edge. */}
        {metal && (
          <>
            <path d={art.glass + art.opening} fillRule="evenodd" fill="#000" />
            <path d={art.glass} fill="none" stroke="rgba(255,255,255,0.17)" strokeWidth={0.75} />
          </>
        )}
        {art.receiver && <rect {...art.receiver} rx={art.receiver.height / 2} fill="#000" />}

        {art.se && (
          <>
            <rect {...art.se.speaker} rx={art.se.speaker.height / 2} fill="#151517" stroke="#1f1f22" strokeWidth={hairline} />
            <circle {...art.se.camera} fill={lens} stroke="#000" strokeWidth={hairline} />
            <circle {...art.se.home} fill="#050506" stroke="#3a3a3e" strokeWidth={Math.max(1, art.se.home.r / 15)} />
          </>
        )}
        {art.island && (
          <>
            <rect x={art.island.x} y={art.island.y} width={art.island.width} height={art.island.height} rx={art.island.height / 2} fill="#000" />
            <circle {...art.island.camera} fill={lens} />
          </>
        )}
        {art.punchHole && <circle {...art.punchHole} fill={lens} stroke="#000" strokeWidth={art.punchHole.r * 0.3} />}
        {art.fold && (
          <>
            <rect {...art.fold.hinge} fill={`url(#${id('hinge')})`} />
            <circle {...art.fold.camera} fill={lens} />
          </>
        )}
      </g>
    </svg>
  );
}

/**
 * System bars drawn over the app, upright in the current orientation: a transparent status bar in the top
 * safe area and the home indicator / gesture bar in the bottom one. `tone` is the colour the app's background
 * behind each calls for (dark over light content), as reported by the preview frame.
 */
/** Fixed status-bar contents, like `xcrun simctl status_bar override` (the frame lab's captures); the app never sets it. */
export interface StatusOverride {
  time?: string;
  signal?: 'none' | 'full';
}

export function SystemBars({ device, geometry, landscape, tone, override }: {
  device: DeviceConfig; geometry: DeviceGeometry; landscape: boolean; tone: SystemBarTones; override?: StatusOverride;
}) {
  const clock = useClock();
  const time = override?.time ?? clock;
  const { screen, safe } = geometry;
  const icons = (
    <div className={`pf-status-icons${device.os === 'ios' ? ' pf-status-icons--ios' : ''}`}>
      <CellularIcon signal={override?.signal ?? (device.os === 'ios' ? 'none' : 'full')} />
      <WifiIcon />
      <BatteryIcon level={device.os === 'ios' ? 1 : 0.8} />
    </div>
  );

  let status: React.ReactNode = null;
  if (safe.top > 0) {
    if (device.cutout === 'dynamic-island') {
      // Time and icons centred in the "ears" on either side of the island, vertically on the island's centre.
      const island = device.island ?? DEFAULT_ISLAND;
      const sideWidth = (screen.width - island.width) / 2;
      // Each group sits centred in its ear minus EAR_OUTER_INSET at the outer edge, so a little towards the
      // island (measured on iPhone 17 Pro / iOS 26: about 5 pt off the ear's centre on both sides).
      status = (
        <div className="pf-status pf-status--island" style={{ top: island.top, height: island.height }}>
          <span className="pf-status-time" style={{ width: sideWidth, paddingLeft: EAR_OUTER_INSET, boxSizing: 'border-box' }}>{time}</span>
          <div style={{ width: sideWidth, paddingRight: EAR_OUTER_INSET, boxSizing: 'border-box', display: 'flex', justifyContent: 'center' }}>{icons}</div>
        </div>
      );
    } else if (device.os === 'ios') {
      status = (
        <div className="pf-status pf-status--classic" style={{ top: 0, height: safe.top }}>
          <span className="pf-status-carrier"><CellularIcon signal="none" /><WifiIcon /></span>
          <span className="pf-status-time pf-status-time--small">{time}</span>
          <span className="pf-status-battery"><BatteryIcon /></span>
        </div>
      );
    } else {
      status = (
        <div className="pf-status pf-status--android" style={{ top: 0, height: safe.top }}>
          <span className="pf-status-time pf-status-time--android">{time}</span>
          {icons}
        </div>
      );
    }
  }

  return (
    <div className="pf-bars" aria-hidden="true">
      <div className={`pf-tone pf-tone--${tone.top}`}>{status}</div>
      {safe.bottom > 0 && (
        <div
          className={`${device.os === 'ios' ? 'pf-home-indicator' : 'pf-android-bar'} pf-tone pf-tone--${tone.bottom}`}
          // iOS: 8pt above the bottom edge. Android: the gesture handle centred in its bar.
          style={{ bottom: device.os === 'ios' ? (landscape ? 6 : 8) : (safe.bottom - 4) / 2 }}
        />
      )}
    </div>
  );
}
