import { useCallback, useEffect, useState } from 'react';
import type { DoctorCheckItem, DoctorFixKind, DoctorFixResult, DoctorReport, DoctorStatus } from '@peep/shared';
import { useI18n } from '../../i18n';

export interface DoctorCardProps {
  projectPath?: string;
  query?: string;
  initialReport?: DoctorReport | null;
  onRunDoctor?: (projectPath?: string) => Promise<DoctorReport>;
  onFixCheck?: (fixKind: DoctorFixKind, projectPath?: string) => Promise<DoctorFixResult>;
  onSdkUpdated?: () => void;
}

const STATUS_BADGE_CLASS: Record<DoctorStatus, string> = {
  ok: 'sx-status--ok',
  warn: 'sx-status--warn',
  error: 'sx-status--error',
};

const FIX_LABEL_KEYS: Record<DoctorFixKind, string> = {
  'choose-flutter-sdk': 'settings.doctor.fixes.chooseFlutterSdk',
  'release-startup-lock': 'settings.doctor.fixes.releaseStartupLock',
  'clean-atomvs-cache': 'settings.doctor.fixes.cleanAtomvsCache',
  'install-flutter-guide': 'settings.doctor.fixes.installFlutterGuide',
  'install-node-guide': 'settings.doctor.fixes.installNodeGuide',
  'install-android-guide': 'settings.doctor.fixes.installAndroidGuide',
};

const CHECK_TITLE_KEYS: Record<DoctorCheckItem['id'], string> = {
  'flutter-sdk': 'settings.doctor.checks.flutterSdk',
  'startup-lock': 'settings.doctor.checks.startupLock',
  'node-npm': 'settings.doctor.checks.nodeNpm',
  'android-toolchain': 'settings.doctor.checks.androidToolchain',
  'disk-space': 'settings.doctor.checks.diskSpace',
};

export function DoctorCard({
  projectPath,
  query = '',
  initialReport = null,
  onRunDoctor,
  onFixCheck,
  onSdkUpdated,
}: DoctorCardProps) {
  const { t } = useI18n();
  const [report, setReport] = useState<DoctorReport | null>(initialReport);
  const [running, setRunning] = useState(false);
  const [fixingId, setFixingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');

  const runCheck = useCallback(async () => {
    setRunning(true);
    setErrorMsg('');
    try {
      const runner = onRunDoctor ?? ((p?: string) => window.peep.runDoctor(p));
      const next = await runner(projectPath);
      setReport(next);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [onRunDoctor, projectPath]);

  useEffect(() => {
    if (initialReport) {
      setReport(initialReport);
      return;
    }
    void runCheck();
  }, [initialReport, runCheck]);

  const handleFix = async (item: DoctorCheckItem) => {
    if (!item.fixKind) return;
    setFixingId(item.id);
    setFeedback('');
    setErrorMsg('');
    try {
      const fixer = onFixCheck ?? ((kind: DoctorFixKind, p?: string) => window.peep.fixDoctorCheck(kind, p));
      const res = await fixer(item.fixKind, projectPath);
      setFeedback(res.message);
      if (res.report) {
        setReport(res.report);
      }
      if (item.fixKind === 'choose-flutter-sdk' && res.ok) {
        onSdkUpdated?.();
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setFixingId(null);
    }
  };

  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (text: string) => !normalizedQuery || text.toLowerCase().includes(normalizedQuery);
  const headerMatches = matchesQuery(`${t('settings.doctor.title')} ${t('settings.doctor.desc')} doctor`);
  const visibleChecks = (report?.checks ?? []).filter((item) => {
    if (!normalizedQuery || headerMatches) return true;
    const title = t(CHECK_TITLE_KEYS[item.id]);
    return matchesQuery(`${title} ${item.title} ${item.summary} ${item.detail ?? ''} ${item.path ?? ''}`);
  });

  if (normalizedQuery && !headerMatches && visibleChecks.length === 0) {
    return null;
  }

  const overallLabel = !report
    ? t('settings.doctor.checking')
    : report.overall === 'ok'
      ? t('settings.doctor.statusOk')
      : report.overall === 'warn'
        ? t('settings.doctor.statusWarn', { count: report.warnCount })
        : t('settings.doctor.statusError', { count: report.errorCount });

  return (
    <div id="atomvs-doctor-card" className="sx-card-group" data-testid="atomvs-doctor-card">
      <div className="sx-card-label">{t('settings.doctor.sectionLabel')}</div>
      <div className="sx-card">
        <div className="sx-row">
          <div className="sx-row__text">
            <div className="sx-row__title">{t('settings.doctor.title')}</div>
            <div className="sx-row__desc">{t('settings.doctor.desc')}</div>
          </div>
          <div className="sx-row__control">
            {report && (
              <span
                className={`sx-status ${STATUS_BADGE_CLASS[report.overall]}`}
                data-testid="doctor-overall-status"
              >
                {overallLabel}
              </span>
            )}
            <button
              type="button"
              className="sx-btn sx-btn--primary"
              data-testid="doctor-run-btn"
              disabled={running || fixingId !== null}
              onClick={() => void runCheck()}
            >
              {running ? t('settings.doctor.running') : t('settings.doctor.runCheck')}
            </button>
          </div>
        </div>

        {visibleChecks.map((item) => {
          const checkTitle = t(CHECK_TITLE_KEYS[item.id]);
          const fixLabel = item.fixKind ? t(FIX_LABEL_KEYS[item.fixKind]) : item.fixLabel;
          const isFixing = fixingId === item.id;
          return (
            <div
              key={item.id}
              className="sx-row sx-doctor-item"
              data-testid={`doctor-check-${item.id}`}
              data-status={item.status}
            >
              <div className="sx-row__text">
                <div className="sx-row__title sx-doctor-item__title">
                  <span className={`sx-doctor-dot sx-doctor-dot--${item.status}`} aria-hidden="true" />
                  <span>{checkTitle}</span>
                  <span className={`sx-status ${STATUS_BADGE_CLASS[item.status]}`}>· {item.summary}</span>
                </div>
                {item.detail && <div className="sx-row__desc">{item.detail}</div>}
                {item.path && (
                  <code className="sx-doctor-path" dir="ltr">
                    {item.path}
                  </code>
                )}
              </div>
              {item.fixKind && (
                <div className="sx-row__control">
                  <button
                    type="button"
                    className="sx-btn"
                    data-testid={`doctor-fix-${item.id}`}
                    disabled={running || fixingId !== null}
                    onClick={() => void handleFix(item)}
                  >
                    {isFixing ? t('settings.doctor.fixing') : fixLabel}
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {feedback && (
          <div className="sx-note" data-testid="doctor-feedback">
            {feedback}
          </div>
        )}
        {errorMsg && (
          <div className="sx-error" role="alert" data-testid="doctor-error">
            {errorMsg}
          </div>
        )}
      </div>
    </div>
  );
}

/** Helper for JSDOM tests: creates a DoctorCard React element with explicit props/handlers. */
export function renderDoctorCard(props: DoctorCardProps = {}) {
  return <DoctorCard {...props} />;
}
