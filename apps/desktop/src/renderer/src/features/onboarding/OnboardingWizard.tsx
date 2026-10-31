import { useState, useEffect } from 'react';
import { useI18n } from '../../i18n';
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
  const { t } = useI18n();
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
              className={`onboarding-dot ${step === s ? 'active' : ''} ${['welcome', 'sdk', 'telemetry', 'done'].indexOf(s) <
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
              <h1>{t('onboarding.welcomeTitle')}</h1>
            </div>
            <p className="onboarding-subtitle">
              The AI desktop IDE built for Flutter developers.
              <br />
              Let's get you set up in a few quick steps.
            </p>
            <ul className="onboarding-feature-list">
              <li>✦ {t('onboarding.feature1')}</li>
              <li>✦ {t('onboarding.feature2')}</li>
              <li>✦ {t('onboarding.feature3')}</li>
            </ul>
            <button className="onboarding-btn-primary" onClick={() => setStep('sdk')}>
              {t('onboarding.getStarted')}
            </button>
          </div>
        )}

        {/* ── Step: Flutter SDK ── */}
        {step === 'sdk' && (
          <div className="onboarding-step">
            <h2>{t('onboarding.sdkTitle')}</h2>
            <p className="onboarding-desc">
              {t('onboarding.sdkDesc')}
            </p>

            {sdk.status === 'checking' && (
              <div className="onboarding-status checking">
                <span className="spinner" /> {t('onboarding.sdkDetecting')}
              </div>
            )}

            {sdk.status === 'found' && (
              <div className="onboarding-status found">
                <span className="status-icon">✓</span>
                <div>
                  <strong>{t('onboarding.sdkDetected', { version: sdk.version || '' })}</strong>
                  <div className="sdk-path">{sdk.path}</div>
                </div>
              </div>
            )}

            {sdk.status === 'missing' && (
              <div className="onboarding-sdk-missing">
                <div className="onboarding-status missing">
                  <span className="status-icon">✗</span>
                  {t('onboarding.sdkMissing')}
                </div>
                <p className="onboarding-desc small">
                  {t('onboarding.sdkHelp')}{' '}
                  <a
                    href="https://docs.flutter.dev/get-started/install"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('onboarding.sdkInstall')}
                  </a>{' '}
                  {t('onboarding.sdkHelpEnd')}
                </p>
                <div className="onboarding-sdk-row">
                  <input
                    className="onboarding-input"
                    placeholder={t('onboarding.sdkPlaceholder')}
                    value={sdkPath}
                    onChange={(e) => setSdkPath(e.target.value)}
                  />
                  <button className="onboarding-btn-secondary" onClick={() => void handleSdkBrowse()}>
                    {t('onboarding.sdkBrowse')}
                  </button>
                </div>
              </div>
            )}

            <div className="onboarding-actions">
              <button className="onboarding-btn-ghost" onClick={() => setStep('welcome')}>
                {t('onboarding.back')}
              </button>
              <button
                className="onboarding-btn-primary"
                onClick={() => setStep('telemetry')}
                disabled={sdk.status === 'checking'}
              >
                {t('onboarding.continue')}
              </button>
            </div>
          </div>
        )}

        {/* ── Step: Telemetry ── */}
        {step === 'telemetry' && (
          <div className="onboarding-step">
            <h2>{t('onboarding.privacyTitle')}</h2>
            <p className="onboarding-desc">
              {t('onboarding.privacyDesc')}
            </p>
            <div className="onboarding-telemetry-cards">
              <button
                className={`telemetry-card ${telemetryChoice === true ? 'selected' : ''}`}
                onClick={() => setTelemetryChoice(true)}
              >
                <span className="tc-icon">✓</span>
                <div>
                  <strong>{t('onboarding.enableAnalyticsTitle')}</strong>
                  <p>{t('onboarding.enableAnalyticsDesc')}</p>
                </div>
              </button>
              <button
                className={`telemetry-card ${telemetryChoice === false ? 'selected' : ''}`}
                onClick={() => setTelemetryChoice(false)}
              >
                <span className="tc-icon">✗</span>
                <div>
                  <strong>{t('onboarding.disableAnalyticsTitle')}</strong>
                  <p>{t('onboarding.disableAnalyticsDesc')}</p>
                </div>
              </button>
            </div>
            <div className="onboarding-actions">
              <button className="onboarding-btn-ghost" onClick={() => setStep('sdk')}>
                {t('onboarding.back')}
              </button>
              <button
                className="onboarding-btn-primary"
                onClick={() => setStep('done')}
                disabled={telemetryChoice === null}
              >
                {t('onboarding.continue')}
              </button>
            </div>
          </div>
        )}

        {/* ── Step: Done ── */}
        {step === 'done' && (
          <div className="onboarding-step done-step">
            <div className="done-check">🚀</div>
            <h2>{t('onboarding.doneTitle')}</h2>
            <p className="onboarding-desc">
              {t('onboarding.doneDesc')}
            </p>
            <ul className="onboarding-tips">
              <li><kbd>Ctrl+P</kbd> — {t('onboarding.tip1')}</li>
              <li><kbd>Ctrl+S</kbd> — {t('onboarding.tip2')}</li>
              <li>{t('onboarding.tip3')}</li>
            </ul>
            <button
              className="onboarding-btn-primary large"
              onClick={() => void handleFinish()}
              disabled={isFinishing}
            >
              {isFinishing ? t('onboarding.settingUp') : t('onboarding.openAtomvs')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
