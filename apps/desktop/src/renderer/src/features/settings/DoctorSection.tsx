import { useCallback, useEffect, useState } from 'react';
import type { DoctorCheck, DoctorFix, DoctorMainFix, DoctorReport } from '@peep/shared';
import { useI18n } from '../../i18n';

/**
 * Settings → Doctor: what this computer needs for Flutter and Expo, each with a safe one-click fix. The checks run
 * when the section opens and again on "Check again" or after a fix.
 */
export function DoctorSection({ projectPath, query, onOpenSdkSettings }: {
  projectPath: string | null;
  query: string;
  onOpenSdkSettings: () => void;
}) {
  const { t } = useI18n();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [running, setRunning] = useState(false);
  const [fixing, setFixing] = useState<DoctorFix | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!window.peep.runDoctor) return;
    setRunning(true);
    try {
      setReport(await window.peep.runDoctor(projectPath ?? undefined));
    } finally {
      setRunning(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void run();
  }, [run]);

  const applyFix = async (fix: DoctorFix) => {
    setFixError(null);
    if (fix === 'open-sdk-settings') return onOpenSdkSettings();
    if (fix === 'retry') return void run();
    if (!window.peep.fixDoctor) return;
    setFixing(fix);
    try {
      const result = await window.peep.fixDoctor(fix as DoctorMainFix, projectPath ?? undefined);
      if (!result.ok) setFixError(t('settings.doctor.fixFailed', { error: result.error ?? '' }));
      // After an install, check again; a page opened in the browser or Windows Settings is checked on "Check again".
      if (fix === 'install-project-deps') await run();
    } finally {
      setFixing(null);
    }
  };

  const message = (c: DoctorCheck) => {
    const base = `settings.doctor.checks.${c.id}`;
    // Some checks have a message per reason (e.g. the Flutter folder is synced vs has spaces).
    const variant = c.params?.reason ? `${c.status}_${c.params.reason}` : c.id === 'node' && c.status === 'fail' && !c.params?.version ? 'fail_missing' : c.status;
    return t(`${base}.${variant}`, c.params);
  };

  const visible = (report?.checks ?? []).filter((c) => {
    if (!query) return true;
    return `${t(`settings.doctor.checks.${c.id}.title`)} ${message(c)}`.toLowerCase().includes(query);
  });

  return (
    <>
      <div className="sx-card-group">
        <div className="sx-card">
          <div className="sx-row">
            <div className="sx-row__text">
              <div className="sx-row__title">{t('settings.doctor.title')}</div>
              <div className="sx-row__desc">{t('settings.doctor.intro')}</div>
            </div>
            <div className="sx-row__control">
              <button type="button" className="sx-btn" disabled={running} onClick={() => void run()}>
                {running ? t('settings.doctor.running') : t('settings.doctor.run')}
              </button>
            </div>
          </div>
        </div>
      </div>
      {fixError && <div className="sx-error" role="alert">{fixError}</div>}
      <div className="sx-card-group">
        <div className="sx-card">
          {visible.map((c) => (
            <div className="sx-row" key={c.id} data-check={c.id}>
              <div className="sx-row__text">
                <div className="sx-row__title">{t(`settings.doctor.checks.${c.id}.title`)}</div>
                <div className="sx-row__desc">{message(c)}</div>
              </div>
              <div className="sx-row__control">
                <span className={`sx-status sx-status--${c.status}`}>{t(`settings.doctor.status.${c.status}`)}</span>
                {c.fix && c.status !== 'ok' && c.status !== 'skip' && (
                  <button type="button" className="sx-btn" disabled={fixing !== null || running} onClick={() => void applyFix(c.fix!)}>
                    {fixing === c.fix ? t('settings.doctor.fixing') : t(`settings.doctor.fix.${c.fix}`)}
                  </button>
                )}
              </div>
            </div>
          ))}
          {!report && (
            <div className="sx-row">
              <div className="sx-row__text"><div className="sx-row__desc">{t('settings.doctor.running')}</div></div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
