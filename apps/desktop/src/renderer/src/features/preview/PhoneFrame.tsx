import './PhoneFrame.css';
// Inter (SIL Open Font License), Latin, weight 500 only: the iOS status bar's time (Inter's 500 has about the stroke
// weight of SF's Semibold, measured against the Simulator). Bundled with the app; no Apple fonts.
import '@fontsource/inter/latin-500.css';
import { useState, useEffect } from 'react';
import type { DeviceConfig, DeviceGeometry, Finish } from './devices';
import { bandRings, statusBarTime } from './frame-geometry';
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

const btn = (b?: [number, number]) => (b ? { top: b[0], height: b[1] } : undefined);

/** Space kept free at the outer end of each status-bar "ear" (the screen's rounded corner), in points. */
const EAR_OUTER_INSET = 10;

/** Fallback when a Dynamic Island device has no island in its config. */
const DEFAULT_ISLAND = { width: 126, height: 37.33, top: 11.33 };

/**
 * The chassis behind the screen, in portrait coordinates (the assembly rotates it for landscape):
 * the body, the side buttons and, on the iPhone SE, the speaker, camera and home button in the bezels.
 */
export function ChassisBack({ device, geometry, finish }: { device: DeviceConfig; geometry: DeviceGeometry; finish?: Finish }) {
  const { frame, screen } = geometry;
  const side = device.os === 'ios' ? 'ios' : 'android';
  const band = device.band ?? 0;
  return (
    <div
      className={`pf-body pf-body--${device.id}${band > 0 ? ' pf-body--metal' : ''}${finish?.dark ? ' pf-body--dark-metal' : ''}`}
      style={{
        width: frame.width, height: frame.height, borderRadius: device.frameRadius,
        ...(finish ? { ['--pf-metal' as string]: finish.metal } : {}),
        ...(band > 0 ? { ['--pf-band' as string]: `${band}px`, ['--pf-rings' as string]: bandRings(band) } : {}),
      }}
      data-finish={finish?.id}
    >
      {/* iPhones: a thin light metal band around a black glass border; the band is the body, this is the glass. */}
      {band > 0 && (
        <div className="pf-glass" style={{ inset: band, borderRadius: device.frameRadius - band }}>
          {/* Earpiece: a long, faint slit where the glass meets the band at the top (Dynamic Island iPhones). */}
          {device.cutout === 'dynamic-island' && <div className="pf-receiver" />}
        </div>
      )}
      {side === 'ios' ? (
        <>
          {!device.homeButton && <div className="pf-btn pf-btn--mute" style={btn(device.buttons?.action)} />}
          <div className="pf-btn pf-btn--vol-up" style={device.homeButton ? { top: 170 } : btn(device.buttons?.volUp)} />
          <div className="pf-btn pf-btn--vol-down" style={device.homeButton ? { top: 240 } : btn(device.buttons?.volDown)} />
          <div className="pf-btn pf-btn--power" style={device.homeButton ? { top: 170 } : btn(device.buttons?.power)} />
        </>
      ) : (
        <>
          <div className="pf-btn pf-btn--android-power" />
          <div className="pf-btn pf-btn--android-vol-up" />
          {!device.fold && <div className="pf-btn pf-btn--android-vol-down" />}
        </>
      )}

      {device.homeButton && (
        <>
          {/* Earpiece and front camera above the screen. */}
          <div className="pf-se-top" style={{ left: 0, right: 0, top: 0, height: screen.y }}>
            <div className="pf-se-cam" />
            <div className="pf-se-speaker" />
          </div>
          {/* Home button below the screen. */}
          <div className="pf-se-bottom" style={{ left: 0, right: 0, top: screen.y + screen.height, bottom: 0 }}>
            <div className="pf-se-home-ring" />
          </div>
        </>
      )}

      {device.fold && <div className="pf-fold-cam" style={{ top: screen.y / 2, left: frame.width - screen.x / 2 - 40 }} />}
    </div>
  );
}

/** Cut-outs over the screen, in portrait coordinates: Dynamic Island, punch-hole camera, the foldable's crease. */
export function ChassisFront({ device, geometry }: { device: DeviceConfig; geometry: DeviceGeometry }) {
  const { frame, screen, safe } = geometry;
  const island = device.island ?? DEFAULT_ISLAND;
  return (
    <div style={{ position: 'relative', width: frame.width, height: frame.height }}>
      {device.cutout === 'dynamic-island' && (
        <div
          className="pf-dynamic-island"
          style={{
            width: island.width, height: island.height, borderRadius: island.height / 2,
            left: screen.x + (screen.width - island.width) / 2, top: screen.y + island.top,
          }}
        >
          <div className="pf-di-cam" />
        </div>
      )}
      {device.cutout === 'punch-hole' && (
        <div className="pf-punchhole" style={{ left: screen.x + screen.width / 2 - 6.5, top: screen.y + safe.top / 2 - 6.5 }} />
      )}
      {device.fold && (
        <div className="pf-fold-hinge" style={{ left: screen.x + screen.width / 2 - 8, top: screen.y, height: screen.height }} />
      )}
    </div>
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
