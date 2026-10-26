import React, { useState } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import './LoginScreen.css';

export function LoginScreen() {
  const { login, settings } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');

    const res = await login(email, password, mode);
    setBusy(false);

    if (!res.success) {
      setError(res.error || 'Authentication failed');
    }
  };

  const handleDevBypass = async () => {
    setBusy(true);
    setError('');
    const res = await login('dev@synkro.local', 'password123', 'signin');
    setBusy(false);
    if (!res.success) {
      setError(res.error || 'Bypass failed');
    }
  };

  return (
    <div className="login-container">
      {/* The window is frameless: this strip lets the user drag it (window buttons sit on its right). */}
      <div className="login-dragbar" />
      {/* Background glow effects */}
      <div className="login-bg-glow glow-1"></div>
      <div className="login-bg-glow glow-2"></div>

      <div className="login-card">
        {/* Logo/Brand Header */}
        <div className="login-header">
          <div className="login-logo-container">
            <svg 
              width="48" 
              height="48" 
              viewBox="0 0 32 32" 
              fill="none"
              className="login-logo-svg"
            >
              <circle cx="16" cy="16" r="15" fill="#15151b" />
              <g stroke="url(#logoGrad)" strokeWidth="1.8" fill="none" strokeLinecap="round">
                <ellipse cx="16" cy="16" rx="5" ry="10.5" transform="rotate(0 16 16)" />
                <ellipse cx="16" cy="16" rx="5" ry="10.5" transform="rotate(60 16 16)" />
                <ellipse cx="16" cy="16" rx="5" ry="10.5" transform="rotate(120 16 16)" />
              </g>
              <circle cx="16" cy="16" r="1.5" fill="#93c5fd" />
              <defs>
                <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#60a5fa" />
                  <stop offset="50%" stopColor="#a78bfa" />
                  <stop offset="100%" stopColor="#ec4899" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <h1 className="login-brand-title">SYNKRO</h1>
          <p className="login-brand-tagline">Next-Generation Autonomous Coding Workspace</p>
        </div>

        {error && (
          <div className="login-error-alert">
            <span className="login-error-icon">⚠️</span>
            <span className="login-error-text">{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-input-group">
            <label htmlFor="email">Email Address</label>
            <input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={busy}
              autoFocus
              className="login-input"
            />
          </div>

          <div className="login-input-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              placeholder="••••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={busy}
              minLength={8}
              className="login-input"
            />
          </div>

          <button type="submit" className="login-submit-btn" disabled={busy}>
            {busy ? (
              <span className="login-spinner"></span>
            ) : mode === 'signin' ? (
              'Sign In'
            ) : (
              'Create Account'
            )}
          </button>
        </form>

        <div className="login-toggle-mode">
          {mode === 'signin' ? (
            <>
              Don't have an account?{' '}
              <button 
                type="button" 
                onClick={() => { setMode('signup'); setError(''); }}
                disabled={busy}
                className="login-link-btn"
              >
                Sign Up
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button 
                type="button" 
                onClick={() => { setMode('signin'); setError(''); }}
                disabled={busy}
                className="login-link-btn"
              >
                Sign In
              </button>
            </>
          )}
        </div>
        
        {settings?.isDevBypassActive && (
          <div style={{ marginTop: '16px', padding: '10px', background: 'rgba(239, 68, 68, 0.08)', borderRadius: '6px', border: '1px dashed rgba(239, 68, 68, 0.3)', textAlign: 'center' }}>
            <div style={{ fontSize: '11px', color: '#fca5a5', fontWeight: 'bold', marginBottom: '8px' }}>⚠️ DEVELOPMENT BYPASS DETECTED</div>
            <button
              type="button"
              onClick={handleDevBypass}
              disabled={busy}
              style={{
                width: '100%',
                padding: '8px',
                background: '#ef4444',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                fontSize: '12px',
                fontWeight: 'bold',
                cursor: 'pointer',
                transition: 'background 0.2s'
              }}
            >
              Bypass and Log In
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
