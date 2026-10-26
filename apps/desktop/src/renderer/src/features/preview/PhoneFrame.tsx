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

/** Live clock — system time */
function useClock() {
  const fmt = () => {
    const now = new Date();
    const h = now.getHours();
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

/** Status-bar icons */
function BatteryIcon() {
  return (
    <div className="pf-icon-battery">
      <div className="pf-icon-battery-level" />
    </div>
  );
}

function WifiIcon() {
  return (
    <svg
      viewBox="0 0 24 18"
      fill="white"
      style={{ width: '16px', height: '12px' }}
    >
      {/* Three arcs + dot, same shape as iOS */}
      <path d="M12 14.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
      <path d="M12 10a6 6 0 0 1 4.24 1.76l1.42-1.42A8 8 0 0 0 4.34 10.34l1.42 1.42A6 6 0 0 1 12 10z" />
      <path d="M12 5.5a10.5 10.5 0 0 1 7.42 3.08l1.41-1.41A12.5 12.5 0 0 0 12 3a12.5 12.5 0 0 0-8.83 4.17l1.41 1.41A10.5 10.5 0 0 1 12 5.5z" />
    </svg>
  );
}

function CellularIcon() {
  return (
    <div className="pf-icon-cellular">
      <span /><span /><span /><span />
    </div>
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
              <span>{time}</span>
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
