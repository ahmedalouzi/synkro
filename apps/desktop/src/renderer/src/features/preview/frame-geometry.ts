/**
 * Pure helpers for the device frame (no DOM, no CSS imports), so tests can load them: the status bar's time format
 * and the metal band's concentric rings. Used by PhoneFrame.tsx.
 */

/** Whether this machine's locale uses a 24-hour clock (iOS follows the same setting). */
const USES_24H = (() => {
  try {
    const cycle = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return cycle === 'h23' || cycle === 'h24';
  } catch {
    return false;
  }
})();

/** Live local time in status-bar format, like iOS: "2:56" (12-hour, no AM/PM) or "09:41" (24-hour). */
export function statusBarTime(now: Date, h24 = USES_24H): string {
  const m = now.getMinutes().toString().padStart(2, '0');
  return h24 ? `${now.getHours().toString().padStart(2, '0')}:${m}` : `${now.getHours() % 12 || 12}:${m}`;
}

/**
 * The metal band's cross-section, from the outer edge (0) to the glass (1), as measured on the Simulator's frame:
 * the colour brightens inwards to a light crest around the middle, then falls off steeply through a dark bevel.
 */
const BAND_PROFILE: [number, string][] = [
  [0, '--pf-m-edge'], [0.07, '--pf-m-lo'], [0.2, '--pf-metal'], [0.42, '--pf-m-lit'], [0.55, '--pf-m-hi'],
  [0.68, '--pf-m-hi'], [0.75, '--pf-m-fall'], [0.86, '--pf-m-deep'], [1, '--pf-m-deep'],
];

/**
 * The band as concentric rings (inset box-shadows follow the body's rounded corners exactly, where gradients cannot),
 * one every half point, each a mix of the two profile colours around it. Static, painted once.
 */
export function bandRings(band: number, step = 0.5): string {
  const rings: string[] = [];
  for (let s = step; s <= band + 1e-9; s += step) {
    const t = (s - step / 2) / band;
    const i = Math.max(0, BAND_PROFILE.findIndex(([at]) => at >= t) - 1);
    const [t0, c0] = BAND_PROFILE[i];
    const [t1, c1] = BAND_PROFILE[Math.min(i + 1, BAND_PROFILE.length - 1)];
    const k = t1 > t0 ? Math.round(((t - t0) / (t1 - t0)) * 100) : 0;
    const color = c0 === c1 || k <= 0 ? `var(${c0})` : k >= 100 ? `var(${c1})` : `color-mix(in oklab, var(${c1}) ${k}%, var(${c0}))`;
    rings.push(`inset 0 0 0 ${+s.toFixed(2)}px ${color}`);
  }
  return rings.join(', ');
}
