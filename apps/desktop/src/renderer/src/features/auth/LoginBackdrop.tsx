import type { ReactNode } from 'react';
import './LoginBackdrop.css';
import './LoginPhone.css';

// Shared with the home page, which links stars only around the pointer.
export { ConstellationCanvas } from '../shared/ConstellationCanvas';

/** One orbit of the Synkro mark as a path electrons can travel along. */
const ORBIT_PATH = 'M 0 -44 A 16 44 0 1 1 0 44 A 16 44 0 1 1 0 -44';

/** Seconds each tail dot runs behind the head; close together so the tail reads as one streak. */
const TAIL = [0, 0.018, 0.036, 0.054, 0.072, 0.09, 0.108, 0.126, 0.144, 0.162];

/** Electron with a comet tail: copies of the dot running slightly behind it. */
function Electron({ duration, delay, color }: { duration: number; delay: number; color: string }) {
  return (
    <>
      {TAIL.map((lag, i) => (
        <circle key={lag} r={0.75 - i * 0.07} fill={i === 0 ? '#fff' : color} opacity={1 - i * 0.085}>
          <animateMotion dur={`${duration}s`} begin={`${delay - lag}s`} repeatCount="indefinite" path={ORBIT_PATH} />
        </circle>
      ))}
    </>
  );
}

/** The Synkro atom, huge, slowly turning behind the page. */
export function GiantAtom() {
  return (
    <div className="lx-atom" aria-hidden="true">
      <svg viewBox="-50 -50 100 100">
        <defs>
          <linearGradient id="lxAtomGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#60a5fa" />
            <stop offset="50%" stopColor="#a78bfa" />
            <stop offset="100%" stopColor="#f472b6" />
          </linearGradient>
          <radialGradient id="lxAtomCore">
            <stop offset="0%" stopColor="#e0e7ff" />
            <stop offset="35%" stopColor="#a78bfa" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#a78bfa" stopOpacity="0" />
          </radialGradient>
        </defs>
        <g className="lx-atom-spin">
          {[0, 60, 120].map((angle, i) => (
            <g key={angle} transform={`rotate(${angle})`}>
              <path d={ORBIT_PATH} fill="none" stroke="url(#lxAtomGrad)" strokeWidth="0.3" strokeOpacity="0.16" />
              <Electron duration={7 + i * 1.6} delay={-i * 2.2} color={['#93c5fd', '#c4b5fd', '#f9a8d4'][i]} />
            </g>
          ))}
        </g>
        <circle r="7" fill="url(#lxAtomCore)" opacity="0.3" className="lx-atom-core" />
      </svg>
    </div>
  );
}

const BUILT_WITH = [
  'Habit tracker',
  'Food delivery',
  'Fitness coach',
  'Crypto wallet',
  'Team chat',
  'Travel planner',
  'Meditation timer',
  'Recipe book',
  'Expense splitter',
  'Language flashcards',
  'Event tickets',
  'Plant care',
];

/** Endless strip of the kinds of apps people build. */
export function BuiltWithTicker() {
  const items = [...BUILT_WITH, ...BUILT_WITH];
  return (
    <div className="lx-ticker" aria-hidden="true">
      <span className="lx-ticker-label">Built with Synkro</span>
      <div className="lx-ticker-track">
        <div className="lx-ticker-row">
          {items.map((name, i) => (
            <span key={i} className="lx-ticker-item">
              <span className="lx-ticker-dot" />
              {name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Occasional meteors streaking across the sky. */
export function ShootingStars() {
  return (
    <div className="lx-meteors" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className={`lx-meteor lx-meteor-${i}`} />
      ))}
    </div>
  );
}

/** Shows `children` once the agent reached `at`, a shimmering placeholder of the same size before. */
function Build({ at, steps, className, children }: { at: number; steps: number; className?: string; children: ReactNode }) {
  return steps >= at ? (
    <div className={`lx-built ${className ?? ''}`}>{children}</div>
  ) : (
    <div className={`lx-sk ${className ?? ''}`} />
  );
}

const WEEK = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const HABITS: Array<{ name: string; meta: string; color: string; icon: string; done: boolean }> = [
  { name: 'Drink water', meta: '8 / 8 glasses', color: '#38bdf8', icon: '💧', done: true },
  { name: 'Read 20 min', meta: 'Atomic Habits', color: '#a78bfa', icon: '📖', done: true },
  { name: 'Workout', meta: '6:30 PM', color: '#f472b6', icon: '🏃', done: false },
];

/**
 * A titanium iPhone whose app assembles piece by piece as the showcase agent works,
 * then goes live. Tilts in 3D with the pointer (--px/--py from the login container).
 */
export function DemoPhone({ steps, done }: { steps: number; done: boolean }) {
  return (
    <div className={`lx-iphone ${done ? 'is-live' : ''}`} aria-hidden="true">
      <span className="lx-iphone-btn lx-iphone-action" />
      <span className="lx-iphone-btn lx-iphone-vol-up" />
      <span className="lx-iphone-btn lx-iphone-vol-down" />
      <span className="lx-iphone-btn lx-iphone-power" />
      <div className="lx-iphone-bezel">
        <div className="lx-iphone-screen">
          {/* Expands into a Live Activity once the app is running. */}
          <div className="lx-iphone-island">
            {done && <span className="lx-live-pill"><i />Live</span>}
            <span className="lx-iphone-cam" />
          </div>
          <div className="lx-iphone-status">
            <span>9:41</span>
            <span className="lx-iphone-icons">
              <svg width="15" height="10" viewBox="0 0 18 12"><rect x="0" y="7.5" width="3" height="4.5" rx="1" /><rect x="5" y="5.3" width="3" height="6.7" rx="1" /><rect x="10" y="2.8" width="3" height="9.2" rx="1" /><rect x="15" y="0" width="3" height="12" rx="1" /></svg>
              <svg width="20" height="10" viewBox="0 0 27.5 13"><rect x="0.5" y="0.5" width="24" height="12" rx="3.8" fill="none" stroke="currentColor" strokeOpacity="0.4" /><rect x="2" y="2" width="17" height="9" rx="2.3" /><path d="M26 4.4v4.2a2.2 2.2 0 0 0 0-4.2Z" opacity="0.4" /></svg>
            </span>
          </div>

          <div className="lx-app">
            <Build at={1} steps={steps} className="lx-app-header">
              <div>
                <span className="lx-app-hello">Good morning</span>
                <span className="lx-app-title">Your habits</span>
              </div>
              <span className="lx-app-avatar" />
            </Build>

            <Build at={2} steps={steps} className="lx-app-hero">
              <div className="lx-hero-text">
                <span className="lx-hero-label">Current streak</span>
                <span className="lx-hero-value">12 days 🔥</span>
                <span className="lx-hero-sub">Best: 21 days</span>
              </div>
              <div className="lx-hero-ring">
                <svg viewBox="0 0 44 44">
                  <circle cx="22" cy="22" r="18" className="lx-hero-ring-track" />
                  <circle cx="22" cy="22" r="18" className="lx-hero-ring-fill" />
                </svg>
                <span>75%</span>
              </div>
            </Build>

            <Build at={3} steps={steps} className="lx-app-week">
              {WEEK.map((day, i) => (
                <span key={i} className={`lx-day ${i < 5 ? 'is-done' : ''} ${i === 4 ? 'is-today' : ''}`}>
                  <i>{day}</i>
                </span>
              ))}
            </Build>

            <Build at={4} steps={steps} className="lx-app-habits">
              {HABITS.map((h, i) => (
                <div key={h.name} className="lx-habit-row" style={{ animationDelay: `${i * 0.1}s` }}>
                  <span className="lx-habit-icon" style={{ background: `${h.color}26`, color: h.color }}>{h.icon}</span>
                  <span className="lx-habit-text">
                    <b>{h.name}</b>
                    <small>{h.meta}</small>
                  </span>
                  <span className={`lx-habit-tick ${h.done ? 'is-done' : ''}`} style={h.done ? { background: h.color } : undefined}>
                    {h.done ? '✓' : ''}
                  </span>
                </div>
              ))}
            </Build>

            <Build at={5} steps={steps} className="lx-app-tabs">
              <span className="is-active" />
              <span />
              <span />
              <span />
            </Build>
          </div>

          <div className="lx-iphone-home" />
          <div className="lx-iphone-glare" />
        </div>
      </div>
    </div>
  );
}
