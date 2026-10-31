import React, { useEffect, useId, useRef, useState } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { useI18n } from '../../i18n';
import { BuiltWithTicker, ConstellationCanvas, DemoPhone, GiantAtom, ShootingStars } from './LoginBackdrop';
import './LoginScreen.css';

/** What the showcase "agent" does on a loop: one typed prompt, then steps that tick off. */
const DEMO_PROMPT = 'Build a habit tracker with streaks and dark mode';
const DEMO_STEPS = [
  'Planning 4 screens',
  'Created app/(tabs)/index.tsx',
  'Created components/StreakRing.tsx',
  'Installed react-native-reanimated',
  'Running on iPhone 16 Pro',
];

type DemoState = { typed: number; steps: number; done: boolean };

/** Drives the showcase terminal: types the prompt, reveals steps one by one, then restarts. */
function useAgentDemo(): DemoState {
  const [state, setState] = useState<DemoState>({ typed: 0, steps: 0, done: false });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const run = (s: DemoState) => {
      setState(s);
      if (s.typed < DEMO_PROMPT.length) {
        timer = setTimeout(() => run({ ...s, typed: s.typed + 1 }), 38 + Math.random() * 40);
      } else if (s.steps < DEMO_STEPS.length) {
        timer = setTimeout(() => run({ ...s, steps: s.steps + 1 }), s.steps === 0 ? 500 : 900);
      } else if (!s.done) {
        timer = setTimeout(() => run({ ...s, done: true }), 900);
      } else {
        timer = setTimeout(() => run({ typed: 0, steps: 0, done: false }), 5600);
      }
    };
    run({ typed: 0, steps: 0, done: false });
    return () => clearTimeout(timer);
  }, []);

  return state;
}

function SynkroMark({ size = 44 }: { size?: number }) {
  // Unique per instance: a gradient inside a hidden copy (the showcase on small windows) can't be referenced.
  const gradientId = `lxMarkGrad${useId().replace(/:/g, '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <g stroke={`url(#${gradientId})`} strokeWidth="1.8" fill="none" strokeLinecap="round">
        <ellipse cx="16" cy="16" rx="5" ry="10.5" />
        <ellipse cx="16" cy="16" rx="5" ry="10.5" transform="rotate(60 16 16)" />
        <ellipse cx="16" cy="16" rx="5" ry="10.5" transform="rotate(120 16 16)" />
      </g>
      <circle cx="16" cy="16" r="1.8" fill="#bfdbfe" />
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#60a5fa" />
          <stop offset="50%" stopColor="#a78bfa" />
          <stop offset="100%" stopColor="#ec4899" />
        </linearGradient>
      </defs>
    </svg>
  );
}

const MailIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="m4 7 8 6 8-6" />
  </svg>
);

const LockIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </svg>
);

const EyeIcon = ({ open }: { open: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
    {!open && <path d="m4 4 16 16" />}
  </svg>
);

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.57-5.17 3.57-8.82Z" />
    <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.91l-3.88-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.95H1.27v3.1A12 12 0 0 0 12 24Z" />
    <path fill="#FBBC05" d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58v-3.1H1.27a12 12 0 0 0 0 10.78l4-3.1Z" />
    <path fill="#EA4335" d="M12 4.76c1.76 0 3.35.61 4.6 1.8l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.27 6.61l4 3.1C6.22 6.87 8.87 4.76 12 4.76Z" />
  </svg>
);

const GitHubIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.26 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .5Z" />
  </svg>
);

const ArrowIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export function LoginScreen() {
  const { t } = useI18n();
  const { login } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const parallaxFrame = useRef(0);
  const demo = useAgentDemo();

  // Background layers drift against the pointer (--px/--py in -1..1) for depth.
  const handleParallax = (e: React.PointerEvent) => {
    const el = containerRef.current;
    if (!el || parallaxFrame.current) return;
    const { clientX, clientY } = e;
    parallaxFrame.current = requestAnimationFrame(() => {
      parallaxFrame.current = 0;
      el.style.setProperty('--px', ((clientX / window.innerWidth) * 2 - 1).toFixed(3));
      el.style.setProperty('--py', ((clientY / window.innerHeight) * 2 - 1).toFixed(3));
    });
  };
  useEffect(() => () => cancelAnimationFrame(parallaxFrame.current), []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');

    const res = await login(email, password, mode);
    setBusy(false);

    if (!res.success) {
      setError(res.error || t('login.authFailed'));
    }
  };

  const switchMode = (next: 'signin' | 'signup') => {
    setMode(next);
    setError('');
    setNotice('');
  };

  // Placeholders until the server supports OAuth sign-in.
  const handleOAuth = (provider: 'Google' | 'GitHub') => {
    setError('');
    setNotice(t('login.oauthComingSoon', { provider }));
  };

  // Spotlight that follows the pointer across the card.
  const handlePointerMove = (e: React.PointerEvent) => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    card.style.setProperty('--my', `${e.clientY - rect.top}px`);
  };

  const trackCapsLock = (e: React.KeyboardEvent) => setCapsLock(e.getModifierState('CapsLock'));

  return (
    <div ref={containerRef} className="login-container" onPointerMove={handleParallax}>
      {/* The window is frameless: this strip lets the user drag it (window buttons sit on its right). */}
      <div className="login-dragbar" />

      <div className="lx-aurora" aria-hidden="true">
        <span className="lx-blob lx-blob-1" />
        <span className="lx-blob lx-blob-2" />
        <span className="lx-blob lx-blob-3" />
      </div>
      <div className="lx-beam" aria-hidden="true" />
      <div className="lx-grid" aria-hidden="true" />
      <GiantAtom />
      <ConstellationCanvas />
      <div className="lx-stars" aria-hidden="true" />
      <ShootingStars />
      <div className="lx-spotlight" aria-hidden="true" />

      <div className="lx-shell">
        <section className="lx-showcase" aria-hidden="true">
          <div className="lx-brand">
            <span className="lx-brand-mark">
              <span className="lx-brand-halo" />
              <SynkroMark size={40} />
            </span>
            <span className="lx-brand-name">ATOMVS</span>
            <span className="lx-badge">
              <span className="lx-badge-dot" />
              {t('login.privateBeta')}
            </span>
          </div>

          <h2 className="lx-headline">
            {['Describe', 'it.'].map((word, i) => (
              <span key={word} className="lx-word" style={{ animationDelay: `${0.15 + i * 0.12}s` }}>{word} </span>
            ))}
            <br />
            {['Watch', 'it', 'ship.'].map((word, i) => (
              <span key={word} className="lx-word lx-gradient-text" style={{ animationDelay: `${0.45 + i * 0.12}s` }}>{word} </span>
            ))}
          </h2>
          <p className="lx-sub">
            An AI engineer that writes, runs and previews your mobile app in real time.
          </p>

          <div className="lx-stage">
            <div className="lx-terminal">
              <div className="lx-terminal-bar">
                <span className="lx-dot" style={{ background: '#ff5f57' }} />
                <span className="lx-dot" style={{ background: '#febc2e' }} />
                <span className="lx-dot" style={{ background: '#28c840' }} />
                <span className="lx-terminal-title">agent — atomvs</span>
              </div>
              <div className="lx-terminal-body">
                <div className="lx-line lx-prompt">
                  <span className="lx-chevron">›</span>
                  <span>{DEMO_PROMPT.slice(0, demo.typed)}</span>
                  {demo.typed < DEMO_PROMPT.length && <span className="lx-caret" />}
                </div>
                {DEMO_STEPS.slice(0, demo.steps).map((step, i) => {
                  const running = i === demo.steps - 1 && !demo.done && demo.steps <= DEMO_STEPS.length;
                  return (
                    <div key={step} className="lx-line lx-step">
                      {running ? <span className="lx-step-spin" /> : <span className="lx-step-ok">✓</span>}
                      <span>{step}</span>
                    </div>
                  );
                })}
                {demo.done && (
                  <div className="lx-line lx-ready">
                    <span className="lx-ready-pulse" />
                    Ready in 38s — live on your device
                  </div>
                )}
              </div>
            </div>
            <DemoPhone steps={demo.steps} done={demo.done} />
          </div>

          <div className="lx-chips">
            <span className="lx-chip">Flutter</span>
            <span className="lx-chip">React Native</span>
            <span className="lx-chip">Expo</span>
            <span className="lx-chip">Live preview</span>
            <span className="lx-chip">Cloud builds</span>
          </div>
        </section>

        <section className="lx-panel">
          <div ref={cardRef} className="lx-card" onPointerMove={handlePointerMove}>
            <div className="lx-card-header">
              <div className="lx-orb">
                <span className="lx-orb-ring" />
                <SynkroMark size={36} />
              </div>
              <h1 className="lx-title">{mode === 'signin' ? t('login.welcomeBack') : t('login.createAccount')}</h1>
              <p className="lx-caption">
                {mode === 'signin' ? t('login.signInSubtitle') : t('login.signUpSubtitle')}
              </p>
            </div>

            <div className="lx-tabs" role="tablist">
              <span className={`lx-tab-indicator ${mode === 'signup' ? 'is-right' : ''}`} />
              <button type="button" role="tab" aria-selected={mode === 'signin'} className={`lx-tab ${mode === 'signin' ? 'is-active' : ''}`} onClick={() => switchMode('signin')} disabled={busy}>
                {t('login.signIn')}
              </button>
              <button type="button" role="tab" aria-selected={mode === 'signup'} className={`lx-tab ${mode === 'signup' ? 'is-active' : ''}`} onClick={() => switchMode('signup')} disabled={busy}>
                {t('login.signUp')}
              </button>
            </div>

            <div className="lx-oauth">
              <button type="button" className="lx-oauth-btn" onClick={() => handleOAuth('Google')} disabled={busy}>
                <GoogleIcon />
                Google
              </button>
              <button type="button" className="lx-oauth-btn" onClick={() => handleOAuth('GitHub')} disabled={busy}>
                <GitHubIcon />
                GitHub
              </button>
            </div>

            <div className="lx-divider">
              <span>{t('login.orContinueWithEmail')}</span>
            </div>

            {notice && !error && (
              <div className="lx-notice" role="status">
                {notice}
              </div>
            )}

            {error && (
              <div className="login-error-alert" role="alert">
                <span className="login-error-icon">⚠️</span>
                <span className="login-error-text">{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="login-form">
              <label className="lx-field">
                <span className="lx-label">{t('login.email')}</span>
                <span className="lx-input-wrap">
                  <span className="lx-input-icon"><MailIcon /></span>
                  <input
                    id="email"
                    type="email"
                    placeholder={t('login.emailPlaceholder')}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={busy}
                    autoFocus
                    autoComplete="email"
                    className="lx-input"
                  />
                </span>
              </label>

              <label className="lx-field">
                <span className="lx-label">
                  {t('login.password')}
                  {capsLock && <span className="lx-caps">{t('login.capsLockOn')}</span>}
                </span>
                <span className="lx-input-wrap">
                  <span className="lx-input-icon"><LockIcon /></span>
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder={mode === 'signup' ? t('login.passwordPlaceholderSignUp') : t('login.passwordPlaceholderSignIn')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyUp={trackCapsLock}
                    onKeyDown={trackCapsLock}
                    required
                    disabled={busy}
                    minLength={8}
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    className="lx-input"
                  />
                  <button
                    type="button"
                    className="lx-eye"
                    onClick={() => setShowPassword((v) => !v)}
                    title={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                    aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                    tabIndex={-1}
                  >
                    <EyeIcon open={showPassword} />
                  </button>
                </span>
              </label>

              <button type="submit" className="lx-submit" disabled={busy}>
                <span className="lx-submit-shine" />
                {busy ? (
                  <span className="login-spinner"></span>
                ) : (
                  <>
                    {mode === 'signin' ? t('login.signIn') : t('login.createAccountBtn')}
                    <ArrowIcon />
                  </>
                )}
              </button>
            </form>

          </div>
        </section>
      </div>

      <BuiltWithTicker />
    </div>
  );
}
