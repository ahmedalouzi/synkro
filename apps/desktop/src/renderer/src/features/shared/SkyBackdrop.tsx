import { ConstellationCanvas } from './ConstellationCanvas';
import './SkyBackdrop.css';

const STAR_COLORS = ['255, 255, 255', '221, 214, 254', '196, 181, 253'];

/**
 * Very dark violet night sky with faint stars.
 * Sits behind its parent's content: the parent needs `position: relative` (or absolute)
 * and `isolation: isolate` so the backdrop's negative z-index stays inside it.
 * `interactive` adds drifting stars that link up around the pointer; without it the stars are static.
 * `subtle` dims it for use behind code.
 */
export function SkyBackdrop({ subtle = false, interactive = true }: { subtle?: boolean; interactive?: boolean }) {
  return (
    <div className={`sky-backdrop ${subtle ? 'sky-backdrop--subtle' : ''}`} aria-hidden="true">
      {interactive && (
        <ConstellationCanvas
          links="pointer"
          colors={STAR_COLORS}
          areaPerStar={14000}
          maxStars={140}
          linkDistance={120}
          speed={0.12}
          starAlpha={0.55}
          className="sky-backdrop__canvas"
        />
      )}
    </div>
  );
}
