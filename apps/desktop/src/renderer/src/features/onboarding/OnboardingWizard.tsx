import { useState, useEffect } from 'react';
import './OnboardingWizard.css';

interface OnboardingWizardProps {
  onComplete: () => void;
}

type Step = 'welcome' | 'sdk' | 'telemetry' | 'done';

interface SdkState {
  status: 'checking' | 'found' | 'missing';
  version?: string;
  path?: string;
}

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>('welcome');
  const [sdk, setSdk] = useState<SdkState>({ status: 'checking' });
  const [telemetryChoice, setTelemetryChoice] = useState<boolean | null>(null);
  const [sdkPath, setSdkPath] = useState('');
  const [isFinishing, setIsFinishing] = useState(false);

  useEffect(() => {
    void (async () => {
      const info = await window.peep.detectFlutterSdk();
      if (info) {
        setSdk({ status: 'found', version: info.version, path: info.path });
      } else {
        setSdk({ status: 'missing' });
      }
    })();
  }, []);

  const handleSdkBrowse = async () => {
    const chosen = await window.peep.selectFolder();
    if (chosen) setSdkPath(chosen);
  };

  const handleFinish = async () => {
    setIsFinishing(true);
    try {
      if (sdkPath) {
        await window.peep.setSettings({ flutterSdkPath: sdkPath });
      }
      if (telemetryChoice !== null) {
        await window.peep.setTelemetryEnabled(telemetryChoice);
      }
      await window.peep.completeOnboarding();
      onComplete();
    } catch {
      setIsFinishing(false);
    }
  };

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-card">
        {/* Progress dots */}
        <div className="onboarding-progress">
          {(['welcome', 'sdk', 'telemetry', 'done'] as Step[]).map((s) => (
            <div
              key={s}
              className={`onboarding-dot ${step === s ? 'active' : ''} ${
                ['welcome', 'sdk', 'telemetry', 'done'].indexOf(s) <
                ['welcome', 'sdk', 'telemetry', 'done'].indexOf(step)
                  ? 'passed'
                  : ''
              }`}
            />
          ))}
        </div>

        {/* ── Step: Welcome ── */}
        {step === 'welcome' && (
          <div className="onboarding-step">
            <div className="onboarding-logo">
              <span className="logo-icon">👁</span>
              <h1>Welcome to Synkro</h1>
            </div>
            <p className="onboarding-subtitle">
              The AI desktop IDE built for Flutter developers.
              <br />
              Let's get you set up in a few quick steps.
            </p>
            <ul className="onboarding-feature-list">
              <li>✦ Live phone-frame preview as you type</li>
              <li>✦ AI agent that reads, writes &amp; fixes your Flutter code</li>
              <li>✦ Monaco editor, Git UI, terminal — all in one place</li>
            </ul>
            <button className="onboarding-btn-primary" onClick={() => setStep('sdk')}>
              Get Started →
            </button>
          </div>
        )}

        {/* ── Step: Flutter SDK ── */}
        {step === 'sdk' && (
          <div className="onboarding-step">
            <h2>Flutter SDK</h2>
            <p className="onboarding-desc">
              Synkro needs the Flutter SDK to run previews, analyze code, and scaffold projects.
            </p>

            {sdk.status === 'checking' && (
              <div className="onboarding-status checking">
                <span className="spinner" /> Detecting Flutter SDK…
              </div>
            )}

            {sdk.status === 'found' && (
              <div className="onboarding-status found">
                <span className="status-icon">✓</span>
                <div>
                  <strong>Flutter {sdk.version} detected</strong>
                  <div className="sdk-path">{sdk.path}</div>
                </div>
              </div>
            )}

            {sdk.status === 'missing' && (
              <div className="onboarding-sdk-missing">
                <div className="onboarding-status missing">
                  <span className="status-icon">✗</span>
                  Flutter SDK not found in PATH
                </div>
                <p className="onboarding-desc small">
                  Point Synkro to your Flutter SDK folder, or{' '}
                  <a
                    href="https://docs.flutter.dev/get-started/install"
                    target="_blank"
                    rel="noreferrer"
                  >
                    install Flutter
                  </a>{' '}
                  and restart.
                </p>
                <div className="onboarding-sdk-row">
                  <input
                    className="onboarding-input"
                    placeholder="/path/to/flutter"
                    value={sdkPath}
                    onChange={(e) => setSdkPath(e.target.value)}
                  />
                  <button className="onboarding-btn-secondary" onClick={() => void handleSdkBrowse()}>
                    Browse…
                  </button>
                </div>
              </div>
            )}

            <div className="onboarding-actions">
              <button className="onboarding-btn-ghost" onClick={() => setStep('welcome')}>
                ← Back
              </button>
              <button
                className="onboarding-btn-primary"
                onClick={() => setStep('telemetry')}
                disabled={sdk.status === 'checking'}
              >
                Continue →
              </button>
            </div>
          </div>
        )}

        {/* ── Step: Telemetry ── */}
        {step === 'telemetry' && (
          <div className="onboarding-step">
            <h2>Privacy &amp; Analytics</h2>
            <p className="onboarding-desc">
              Help improve Synkro by sharing anonymous usage data. This is completely optional.
            </p>
            <div className="onboarding-telemetry-cards">
              <button
                className={`telemetry-card ${telemetryChoice === true ? 'selected' : ''}`}
                onClick={() => setTelemetryChoice(true)}
              >
                <span className="tc-icon">✓</span>
                <div>
                  <strong>Enable analytics</strong>
                  <p>Anonymous events stored locally only. No code or personal data is ever sent.</p>
                </div>
              </button>
              <button
                className={`telemetry-card ${telemetryChoice === false ? 'selected' : ''}`}
                onClick={() => setTelemetryChoice(false)}
              >
                <span className="tc-icon">✗</span>
                <div>
                  <strong>No thanks</strong>
                  <p>Fully offline. You can change this anytime in Settings.</p>
                </div>
              </button>
            </div>
            <div className="onboarding-actions">
              <button className="onboarding-btn-ghost" onClick={() => setStep('sdk')}>
                ← Back
              </button>
              <button
                className="onboarding-btn-primary"
                onClick={() => setStep('done')}
                disabled={telemetryChoice === null}
              >
                Continue →
              </button>
            </div>
          </div>
        )}

        {/* ── Step: Done ── */}
        {step === 'done' && (
          <div className="onboarding-step done-step">
            <div className="done-check">🚀</div>
            <h2>You're all set!</h2>
            <p className="onboarding-desc">
              Open an existing Flutter project or create a new one from a template or prompt.
            </p>
            <ul className="onboarding-tips">
              <li><kbd>Ctrl+P</kbd> — Quick file open</li>
              <li><kbd>Ctrl+S</kbd> — Save &amp; refresh preview</li>
              <li>Chat panel → ask the AI to add a screen</li>
            </ul>
            <button
              className="onboarding-btn-primary large"
              onClick={() => void handleFinish()}
              disabled={isFinishing}
            >
              {isFinishing ? 'Setting up…' : 'Open Synkro →'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
