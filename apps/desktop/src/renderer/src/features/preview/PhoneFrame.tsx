import './PhoneFrame.css';
import { useState, useEffect } from 'react';
import { DeviceConfig } from '../../layout/PreviewPane';

export type DeviceType =
  | 'iphone-15'
  | 'iphone-15-pro'
  | 'iphone-se'
  | 'pixel-8'
  | 'pixel-fold'
  | 'galaxy-s24';

/** Live clock in iOS status-bar format: 12-hour, no leading zero, no AM/PM ("2:56"). */
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

/** Chassis background (the dark body behind the screen) */
export function FrameBackground({ device }: { device: DeviceConfig }) {
  if (!device.artwork.frameAsset) return null;
  return (
    <div
      className={`pf ${device.artwork.frameAsset}`}
      style={{ width: '100%', height: '100%' }}
    />
  );
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

/** Foreground overlay (Dynamic Island, status bar, buttons) */
export function FrameForeground({ device }: { device: DeviceConfig }) {
  const time = useClock();

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {children}
    </div>
  );

  /* ── iPhone 15 / 15 Pro ───────────────────────────────────────── */
  if (device.id.startsWith('iphone-15')) {
    return (
      <Wrapper>
        {/* Physical side buttons */}
        <div className="pf-btn pf-btn--mute" />
        <div className="pf-btn pf-btn--vol-up" />
        <div className="pf-btn pf-btn--vol-down" />
        <div className="pf-btn pf-btn--power" />

        {/* Top-edge specular highlight — removed (pure black chassis) */}

        {/* Foreground HUD — sits over the screen */}
        <div className="pf-bezel">
          {/* Status bar — time left, icons right, Dynamic Island centred */}
          <div className="pf-status-bar">
            <div className="pf-status-left">
              <span className="pf-status-time">{time}</span>
            </div>
            <div className="pf-status-right">
              <CellularIcon />
              <WifiIcon />
              <BatteryIcon />
            </div>
          </div>

          {/* Dynamic Island — pill-shaped, centred at top */}
          <div className="pf-dynamic-island">
            <div className="pf-di-cam" />
            <div className="pf-di-speaker" />
          </div>

          {/* Home indicator bar at bottom */}
          <div className="pf-home-indicator" />
        </div>

      </Wrapper>
    );
  }

  /* ── iPhone SE ──────────────────────────────────────────────────── */
  if (device.id === 'iphone-se') {
    return (
      <Wrapper>
        <div className="pf-btn pf-btn--vol-up" style={{ top: '96px' }} />
        <div className="pf-btn pf-btn--vol-down" style={{ top: '160px' }} />
        <div className="pf-btn pf-btn--power" style={{ top: '86px' }} />

        <div className="pf-bezel">
          {/* Top bar: speaker + front cam */}
          <div className="pf-se-topbar">
            <div className="pf-se-speaker" />
            <div className="pf-se-cam" />
          </div>

          {/* Home button */}
          <div className="pf-se-home-btn">
            <div className="pf-se-home-ring" />
          </div>
        </div>

        <div className="pf-shine" />
      </Wrapper>
    );
  }

  /* ── Pixel 8 ─────────────────────────────────────────────────────── */
  if (device.id === 'pixel-8') {
    return (
      <Wrapper>
        <div className="pf-btn pf-btn--power pf-btn--android-power" />
        <div className="pf-btn pf-btn--vol-up pf-btn--android-vol-up" />
        <div className="pf-btn pf-btn--vol-down pf-btn--android-vol-down" />

        <div className="pf-bezel pf-bezel--android">
          <div className="pf-punchhole" />
          <div className="pf-android-bar" />
        </div>

      </Wrapper>
    );
  }

  /* ── Pixel Fold ──────────────────────────────────────────────────── */
  if (device.id === 'pixel-fold') {
    return (
      <Wrapper>
        <div className="pf-btn pf-btn--power pf-btn--android-power" />
        <div className="pf-btn pf-btn--vol-up pf-btn--android-vol-up" />

        <div className="pf-bezel pf-bezel--fold">
          {/* Inner-screen camera sits in the bezel on the real device, not over the content. */}
          <div className="pf-fold-hinge" />
          <div className="pf-android-bar" />
        </div>

      </Wrapper>
    );
  }

  /* ── Galaxy S24 ──────────────────────────────────────────────────── */
  if (device.id === 'galaxy-s24') {
    return (
      <Wrapper>
        <div className="pf-btn pf-btn--samsung-power" />
        <div className="pf-btn pf-btn--samsung-vol-up" />
        <div className="pf-btn pf-btn--samsung-vol-down" />

        <div className="pf-bezel pf-bezel--samsung">
          <div className="pf-punchhole pf-punchhole--samsung" />
          <div className="pf-android-bar" />
        </div>

      </Wrapper>
    );
  }

  return null;
}
