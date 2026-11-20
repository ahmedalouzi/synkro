import { useEffect, useState } from 'react';

/**
 * window.devicePixelRatio, kept current: it changes when the window moves to a screen with another display scaling
 * (100 % ↔ 150 %) or when the user changes it, and no resize event has to follow. A media query on the current
 * ratio fires once it stops matching; then we listen for the new one.
 */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1));
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    let query: MediaQueryList | null = null;
    const onChange = () => {
      setDpr(window.devicePixelRatio || 1);
      listen();
    };
    const listen = () => {
      query?.removeEventListener('change', onChange);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query.addEventListener('change', onChange);
    };
    listen();
    return () => query?.removeEventListener('change', onChange);
  }, []);
  return dpr;
}
