import React from 'react';
import { ChassisBack, ChassisFront, SystemBars } from './PhoneFrame';
import { deviceGeometry, type DeviceConfig } from './devices';
import type { SystemBarTones } from './usePreviewSafeArea';

interface PreviewAssemblyProps {
  device: DeviceConfig;
  landscape?: boolean;
  /** Icon colours for the status bar and the home indicator: dark over a light app, light over a dark one. */
  tone?: SystemBarTones;
  /** The app's background colour, shown under the iframe; black until the app reports it. */
  background?: string | null;
  /** The app (iframe or placeholder). It fills the whole screen. */
  children: React.ReactNode;
}

const DEFAULT_TONES: SystemBarTones = { top: 'light', bottom: 'light' };

/** How far the bezel reaches over the screen's edge (CSS px), so its anti-aliased edge never shows. */
const BEZEL_OVERLAP = 2;
/** How far the bezel ring reaches outward, over the chassis (same colour), to cover any sub-pixel gap. */
const BEZEL_OUTSET = 2;

/**
 * A device frame at its natural size (the frame's CSS px; the caller zooms it to fit), edge to edge like a
 * simulator: the app fills the screen, and the status bar, home indicator, Dynamic Island and camera hole are
 * drawn over it. The chassis art is laid out in portrait and rotated as a whole for landscape.
 */
export function PreviewAssembly({ device, landscape = false, tone = DEFAULT_TONES, background, children }: PreviewAssemblyProps) {
  const g = deviceGeometry(device, landscape);
  const portrait = deviceGeometry(device, false);
  const r = device.screenRadius;
  const underlay = background || '#000';

  // The chassis art in portrait coordinates, turned a quarter to the left for landscape.
  const art = (layer: React.ReactNode, z: number) => (
    <div style={{
      position: 'absolute',
      width: portrait.frame.width,
      height: portrait.frame.height,
      left: (g.frame.width - portrait.frame.width) / 2,
      top: (g.frame.height - portrait.frame.height) / 2,
      transform: landscape ? 'rotate(-90deg)' : undefined,
      pointerEvents: 'none',
      zIndex: z,
    }}>
      {layer}
    </div>
  );

  return (
    <div className="device-assembly" style={{ position: 'relative', width: g.frame.width, height: g.frame.height }}>
      {art(<ChassisBack device={device} geometry={portrait} />, 0)}

      {/* The screen: the app edge to edge, the system bars over it. */}
      <div className="screen-mask" style={{
        position: 'absolute',
        left: g.screen.x,
        top: g.screen.y,
        width: g.screen.width,
        height: g.screen.height,
        overflow: 'hidden',
        borderRadius: r,
        clipPath: `inset(0 round ${r}px)`,
        background: underlay,
        ['--preview-app-bg' as string]: underlay,
        zIndex: 1,
      }}>
        <div className="screen-app" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
          {children}
        </div>
        <SystemBars device={device} geometry={g} landscape={landscape} tone={tone} />
      </div>

      {/* The bezel's inner edge, laid over the screen's edge: a ring in the chassis colour, concentric with
          the screen's corners, covering the last BEZEL_OVERLAP px of the screen so no seam shows there. */}
      <div className="screen-bezel-edge" style={{
        position: 'absolute',
        left: g.screen.x - BEZEL_OUTSET,
        top: g.screen.y - BEZEL_OUTSET,
        width: g.screen.width + 2 * BEZEL_OUTSET,
        height: g.screen.height + 2 * BEZEL_OUTSET,
        boxSizing: 'border-box',
        border: `${BEZEL_OUTSET + BEZEL_OVERLAP}px solid #000`,
        borderRadius: r > 0 ? r + BEZEL_OUTSET : 0,
        pointerEvents: 'none',
        zIndex: 2,
      }} />

      {art(<ChassisFront device={device} geometry={portrait} />, 2)}
    </div>
  );
}
