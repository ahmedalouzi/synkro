import './PhoneFrame.css';
import { useState, useEffect } from 'react';
import type { DeviceConfig, DeviceGeometry } from './devices';
import type { SystemBarTones } from './usePreviewSafeArea';

export type { DeviceType } from './devices';

/** Live clock in status-bar format: 12-hour, no leading zero, no AM/PM ("2:56"). */
function useClock() {
  const fmt = () => {
    const now = new Date();
    const h = now.getHours() % 12 || 12;
    const m = now.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
  };
  const [time, setTime] = useState(fmt);
  useEffect(() => {
    const id = setInterval(() => setTime(fmt()), 1000);
    return () => clearInterval(id);
  }, []);
  return time;
}

/* ── Status-bar glyphs, drawn at iOS 17's point sizes ─────────────────── */

/** A ring sector of the Wi-Fi fan, opening upward from (8, 11.6). */
function wifiBand(inner: number, outer: number): string {
  const cx = 8, cy = 11.6, a0 = (-135 * Math.PI) / 180, a1 = (-45 * Math.PI) / 180;
  const pt = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  if (inner === 0) return `M${cx} ${cy}L${pt(outer, a0)}A${outer} ${outer} 0 0 1 ${pt(outer, a1)}Z`;
  return `M${pt(inner, a0)}L${pt(outer, a0)}A${outer} ${outer} 0 0 1 ${pt(outer, a1)}L${pt(inner, a1)}A${inner} ${inner} 0 0 0 ${pt(inner, a0)}Z`;
}
const WIFI_BANDS = [wifiBand(0, 3.7), wifiBand(5.2, 7.9), wifiBand(9.4, 11.6)];

function CellularIcon() {
  return (
    <svg className="pf-glyph" viewBox="0 0 18 12" width="18" height="12" aria-hidden="true">
      <rect x="0" y="7.5" width="3" height="4.5" rx="1" />
      <rect x="5" y="5.3" width="3" height="6.7" rx="1" />
      <rect x="10" y="2.8" width="3" height="9.2" rx="1" />
      <rect x="15" y="0" width="3" height="12" rx="1" />
    </svg>
  );
}

function WifiIcon() {
  return (
    <svg className="pf-glyph" viewBox="0 0 16 12" width="16" height="12" aria-hidden="true">
      {/* Rounded joins soften the sector corners like Apple's glyph. */}
      {WIFI_BANDS.map((d) => <path key={d} d={d} stroke="currentColor" strokeWidth="0.9" strokeLinejoin="round" />)}
    </svg>
  );
}

function BatteryIcon({ level = 0.8 }: { level?: number }) {
  return (
    <svg className="pf-glyph" viewBox="0 0 27.5 13" width="27.5" height="13" aria-hidden="true">
      <rect x="0.5" y="0.5" width="24" height="12" rx="3.8" fill="none" stroke="currentColor" strokeOpacity="0.35" />
      <rect x="2" y="2" width={Math.max(1, 21 * level)} height="9" rx="2.3" />
      <path d="M26 4.4v4.2a2.2 2.2 0 0 0 1.3-2.1 2.2 2.2 0 0 0-1.3-2.1Z" fillOpacity="0.4" />
    </svg>
  );
}

/** Dynamic Island size and its offset from the top of the screen, in points. */
const ISLAND = { width: 126, height: 37, top: 11 };

/**
 * The chassis behind the screen, in portrait coordinates (the assembly rotates it for landscape):
 * the body, the side buttons and, on the iPhone SE, the speaker, camera and home button in the bezels.
 */
export function ChassisBack({ device, geometry }: { device: DeviceConfig; geometry: DeviceGeometry }) {
  const { frame, screen } = geometry;
  const side = device.os === 'ios' ? 'ios' : 'android';
  return (
    <div className={`pf-body pf-body--${device.id}`} style={{ width: frame.width, height: frame.height, borderRadius: device.frameRadius }}>
      {side === 'ios' ? (
        <>
          {!device.homeButton && <div className="pf-btn pf-btn--mute" />}
          <div className="pf-btn pf-btn--vol-up" style={device.homeButton ? { top: 170 } : undefined} />
          <div className="pf-btn pf-btn--vol-down" style={device.homeButton ? { top: 240 } : undefined} />
          <div className="pf-btn pf-btn--power" style={device.homeButton ? { top: 170 } : undefined} />
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
  return (
    <div style={{ position: 'relative', width: frame.width, height: frame.height }}>
      {device.cutout === 'dynamic-island' && (
        <div
          className="pf-dynamic-island"
          style={{ width: ISLAND.width, height: ISLAND.height, left: screen.x + (screen.width - ISLAND.width) / 2, top: screen.y + ISLAND.top }}
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
export function SystemBars({ device, geometry, landscape, tone }: {
  device: DeviceConfig; geometry: DeviceGeometry; landscape: boolean; tone: SystemBarTones;
}) {
  const time = useClock();
  const { screen, safe } = geometry;
  const icons = (
    <div className="pf-status-icons">
      <CellularIcon />
      <WifiIcon />
      <BatteryIcon />
    </div>
  );

  let status: React.ReactNode = null;
  if (safe.top > 0) {
    if (device.cutout === 'dynamic-island') {
      // Time and icons centred in the space on either side of the island, at the island's height.
      const sideWidth = (screen.width - ISLAND.width) / 2;
      status = (
        <div className="pf-status pf-status--island" style={{ top: ISLAND.top, height: ISLAND.height }}>
          <span className="pf-status-time" style={{ width: sideWidth }}>{time}</span>
          <div style={{ width: sideWidth, display: 'flex', justifyContent: 'center' }}>{icons}</div>
        </div>
      );
    } else if (device.os === 'ios') {
      status = (
        <div className="pf-status pf-status--classic" style={{ top: 0, height: safe.top }}>
          <span className="pf-status-carrier"><CellularIcon /><WifiIcon /></span>
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
