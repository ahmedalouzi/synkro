/**
 * Pure helpers for the device frame (no DOM, no CSS imports), so tests can load them: the status bar's time format.
 * Used by PhoneFrame.tsx (the frame itself: frame-svg.ts).
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
