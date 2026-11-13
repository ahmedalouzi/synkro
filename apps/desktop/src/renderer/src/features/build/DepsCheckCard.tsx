import { useBuildStore } from '../../stores/build-store';
import { fixBuildDependencies, startCloudBuild } from './start-build';
import { askAgent } from '../chat/ask-agent';
import { useI18n } from '../../i18n';

/** Shown problems; the rest are summarised as "+N more". */
const SHOWN = 6;

/**
 * The dependency check before a Cloud Build upload: "Checking dependencies…", or the packages the server's
 * `npm ci` would reject with Fix dependencies (npx expo install --fix) / Build anyway, and, when the fix leaves
 * some (a library expo install does not know), Ask Atomvs to fix.
 */
export function DepsCheckCard() {
  const { t } = useI18n();
  const depsCheck = useBuildStore((s) => s.depsCheck);
  if (!depsCheck) return null;

  if (depsCheck.state === 'checking' || depsCheck.state === 'fixing') {
    return (
      <div id="build-deps-card" className="build-deps-card is-busy" data-state={depsCheck.state}>
        <span className="build-deps-spinner" aria-hidden="true" />
        <span className="build-deps-title">{depsCheck.state === 'checking' ? t('build.depsChecking') : t('build.depsFixing')}</span>
      </div>
    );
  }

  const askFix = () => {
    askAgent(t('build.depsAskMessage', { problems: depsCheck.problems.map((p) => `- ${p}`).join('\n') }));
  };

  return (
    <div id="build-deps-card" className="build-deps-card" data-state="problems">
      <div className="build-deps-title">{depsCheck.afterFix ? t('build.depsStillTitle') : t('build.depsTitle')}</div>
      <div className="build-deps-hint">{depsCheck.afterFix ? t('build.depsStillHint') : t('build.depsHint')}</div>
      <ul className="build-deps-list">
        {depsCheck.problems.slice(0, SHOWN).map((p) => <li key={p}>{p}</li>)}
        {depsCheck.problems.length > SHOWN && <li className="build-deps-more">{t('build.depsMore', { count: String(depsCheck.problems.length - SHOWN) })}</li>}
      </ul>
      {depsCheck.fixError && <pre className="build-deps-error">{depsCheck.fixError}</pre>}
      <div className="build-deps-actions">
        {depsCheck.afterFix ? (
          <button id="build-deps-ask" className="is-primary" onClick={askFix}>{t('build.depsAskAgent')}</button>
        ) : (
          <button id="build-deps-fix" className="is-primary" onClick={() => void fixBuildDependencies()}>{t('build.depsFix')}</button>
        )}
        <button id="build-deps-anyway" onClick={() => void startCloudBuild({ skipDepsCheck: true })}>{t('build.depsBuildAnyway')}</button>
        <button id="build-deps-dismiss" onClick={() => useBuildStore.getState().setDepsCheck(null)}>{t('build.depsDismiss')}</button>
      </div>
    </div>
  );
}
