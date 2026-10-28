import { useEffect } from 'react';
import './SignInBurst.css';

/** How long the overlay stays mounted; keep in sync with the longest animation in SignInBurst.css. */
export const SIGN_IN_BURST_MS = 1100;

/**
 * Quick "warp" played once right after signing in: the Synkro atom flies at the viewer,
 * a shockwave and speed lines burst out, then the overlay fades to reveal the app.
 */
export function SignInBurst({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, SIGN_IN_BURST_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div className="sib" aria-hidden="true">
      <div className="sib-warp" />
      <div className="sib-ring" />
      <div className="sib-ring sib-ring-2" />
      <svg className="sib-atom" viewBox="0 0 32 32" fill="none">
        <defs>
          <linearGradient id="sibGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#60a5fa" />
            <stop offset="50%" stopColor="#a78bfa" />
            <stop offset="100%" stopColor="#f472b6" />
          </linearGradient>
        </defs>
        <g stroke="url(#sibGrad)" strokeWidth="1.6" strokeLinecap="round">
          <ellipse cx="16" cy="16" rx="5" ry="10.5" />
          <ellipse cx="16" cy="16" rx="5" ry="10.5" transform="rotate(60 16 16)" />
          <ellipse cx="16" cy="16" rx="5" ry="10.5" transform="rotate(120 16 16)" />
        </g>
        <circle cx="16" cy="16" r="1.9" fill="#fff" />
      </svg>
      <div className="sib-flash" />
    </div>
  );
}
