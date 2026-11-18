import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CloudBuildJob } from '@peep/shared';
import { useBuildStore } from '../../stores/build-store';
import { buildApi } from '../../services/build-api';
import { useI18n } from '../../i18n';
import { SpaceQrPopup } from './SpaceQrPopup';
import { BUILD_STAGES, buildNotices, buildStage, estimateProgress, failureKind, type BuildStage } from './build-progress';

/**
 * The Cloud Build experience. Pressing Build APK opens a full-screen page over the IDE in the space/atom style of
 * SpaceQrPopup: friendly stages (read from the "[STEP]" lines of the build log, build-progress.ts) instead of logs,
 * and an orbit ring that fills as the build goes. "Continue working" shrinks it to a pill in the corner; the build
 * keeps running on the server (it uses the uploaded snapshot, so edits do not change it). When the build ends the
 * page comes back: a short celebration, then the QR / download (SpaceQrPopup); or, on failure, a calm explanation
 * with "View details" (the raw log).
 *
 * It also drives the build while it runs (status polling), whether or not the Build panel is open.
 * Light by design: CSS and SVG only. prefers-reduced-motion: no movement, the ring and a soft glow still change.
 */

const POLL_MS = 3000;
const PROGRESS_TICK_MS = 500;
const RING_R = 108;
const RING_C = 2 * Math.PI * RING_R;
const ORBIT = 'M 190 120 A 70 26 0 1 1 50 120 A 70 26 0 1 1 190 120';

type View = 'progress' | 'celebrate' | 'qr' | 'failed';

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const q = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!q) return;
    const update = () => setReduced(q.matches);
    q.addEventListener('change', update);
    return () => q.removeEventListener('change', update);
  }, []);
  return reduced;
}

const isActive = (b: CloudBuildJob | null) => b?.status === 'queued' || b?.status === 'running';

function stageLabel(t: (k: string) => string, stage: BuildStage) {
  return t(`buildFlow.stage.${stage}`);
}

/** The atom with the progress ring around it (SVG). */
function Atom({ progress, reduced, done }: { progress: number; reduced: boolean; done?: boolean }) {
  return (
    <svg className={`bx-atom${done ? ' is-done' : ''}`} viewBox="0 0 240 240" aria-hidden="true">
      <defs>
        <linearGradient id="bx-ring-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
        <radialGradient id="bx-nucleus" cx="40%" cy="35%" r="65%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.35" stopColor="#c7d2fe" />
          <stop offset="1" stopColor="#6366f1" />
        </radialGradient>
      </defs>
      <circle className="bx-ring-track" cx="120" cy="120" r={RING_R} />
      <circle
        className="bx-ring-progress"
        cx="120" cy="120" r={RING_R}
        strokeDasharray={RING_C}
        strokeDashoffset={RING_C * (1 - progress)}
        transform="rotate(-90 120 120)"
      />
      <g className={`bx-orbits${reduced ? '' : ' is-spinning'}`}>
        {[0, 60, 120].map((angle, i) => (
          <g key={angle} transform={`rotate(${angle} 120 120)`}>
            <path className="bx-orbit" d={ORBIT} />
            {reduced ? (
              // Still: each electron rests at its own point of the orbit.
              <circle className={`bx-electron bx-electron--${i}`} r="4.5" cx={[190, 50, 120][i]} cy={[120, 120, 94][i]} />
            ) : (
              // animateMotion moves the circle from (0,0) along the orbit.
              <circle className={`bx-electron bx-electron--${i}`} r="4.5">
                <animateMotion path={ORBIT} dur={`${3.2 + i * 0.7}s`} begin={`-${i}s`} repeatCount="indefinite" />
              </circle>
            )}
          </g>
        ))}
      </g>
      <circle className="bx-nucleus-glow" cx="120" cy="120" r="30" />
      <circle className="bx-nucleus" cx="120" cy="120" r="15" fill="url(#bx-nucleus)" />
    </svg>
  );
}

/** Brings back the full screen of a queued or running build (the title-bar "Building…" button). */
export function reopenBuildExperience(): void {
  const { currentBuild, setExperienceMode } = useBuildStore.getState();
  if (isActive(currentBuild)) setExperienceMode('full');
}

export function BuildExperience() {
  const { t, dir } = useI18n();
  const build = useBuildStore((s) => s.currentBuild);
  const mode = useBuildStore((s) => s.experienceMode);
  const setMode = useBuildStore((s) => s.setExperienceMode);
  const updateCurrentBuild = useBuildStore((s) => s.updateCurrentBuild);
  const reduced = usePrefersReducedMotion();

  const [view, setView] = useState<View>('progress');
  const [progress, setProgress] = useState(0);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);
  const seenActive = useRef<Set<string>>(new Set());
  const endedShown = useRef<Set<string>>(new Set());
  const stageRef = useRef<{ stage: BuildStage; since: number } | null>(null);
  const mainBtnRef = useRef<HTMLButtonElement>(null);

  const active = isActive(build);
  const stage: BuildStage | null = build && active ? buildStage(build, build.errorLog) : null;

  // Poll the build while it runs (independent of the Build panel).
  useEffect(() => {
    if (!build || !active) return;
    const id = build.id;
    const timer = setInterval(async () => {
      try {
        updateCurrentBuild(await buildApi.getBuild(id));
      } catch (e) {
        console.error('Failed to poll build status', e);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [build?.id, active, updateCurrentBuild]);

  // A build that starts opens the full screen; when one this session saw running ends, the screen comes back.
  useEffect(() => {
    if (!build) return;
    if (active && !seenActive.current.has(build.id)) {
      seenActive.current.add(build.id);
      stageRef.current = null;
      setProgress(0);
      setView('progress');
      setConfirmCancel(false);
      setShowDetails(false);
      setMode('full');
      return;
    }
    if (!active && seenActive.current.has(build.id) && !endedShown.current.has(build.id)) {
      endedShown.current.add(build.id);
      setConfirmCancel(false);
      if (build.status === 'success') {
        setProgress(1);
        setView('celebrate');
        setMode('full');
      } else if (build.status === 'failed') {
        setView('failed');
        setMode('full');
      } else {
        setMode('hidden');
      }
    }
  }, [build?.id, build?.status, active, setMode]);

  // Celebration, then the QR / download.
  useEffect(() => {
    if (view !== 'celebrate') return;
    const timer = setTimeout(() => setView('qr'), reduced ? 900 : 1900);
    return () => clearTimeout(timer);
  }, [view, reduced]);

  // Progress: eases forward inside each stage, never backwards.
  useEffect(() => {
    if (!build || !active || !stage) return;
    if (!stageRef.current || stageRef.current.stage !== stage) stageRef.current = { stage, since: Date.now() };
    const tick = () => {
      const s = stageRef.current!;
      setProgress((prev) => estimateProgress({
        stage: s.stage,
        stageElapsedSeconds: (Date.now() - s.since) / 1000,
        framework: build.framework,
        queueEtaSeconds: build.queueEtaSeconds,
        previous: prev,
      }));
    };
    tick();
    const timer = setInterval(tick, PROGRESS_TICK_MS);
    return () => clearInterval(timer);
  }, [build?.id, build?.framework, build?.queueEtaSeconds, active, stage]);

  // Focus the main action when the full screen opens; Esc minimizes (or closes a finished screen).
  useEffect(() => {
    if (mode !== 'full' || view === 'qr') return;
    mainBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (confirmCancel) setConfirmCancel(false);
      else setMode(active ? 'pill' : 'hidden');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, view, active, confirmCancel, setMode]);

  const cancelBuild = useCallback(async () => {
    if (!build) return;
    try {
      updateCurrentBuild(await buildApi.cancelBuild(build.id));
    } catch (e) {
      console.error('Failed to cancel build', e);
    }
    setConfirmCancel(false);
    setMode('hidden');
  }, [build, updateCurrentBuild, setMode]);

  const copyDetails = useCallback(() => {
    void navigator.clipboard.writeText(build?.errorLog ?? '').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [build?.errorLog]);

  if (!build || mode === 'hidden') return null;

  const percent = Math.round(progress * 100);

  // ── Minimized: a pill in the corner ──
  if (mode === 'pill') {
    if (!active || !stage) return null;
    return createPortal(
      <button
        id="build-pill"
        type="button"
        className={`bx-pill${reduced ? ' is-reduced' : ''}`}
        dir={dir}
        onClick={() => setMode('full')}
        aria-label={`${t('buildFlow.reopen')}: ${stageLabel(t, stage)}, ${percent}%`}
      >
        <svg className="bx-pill-ring" viewBox="0 0 36 36" aria-hidden="true">
          <circle className="bx-pill-track" cx="18" cy="18" r="16" />
          <circle className="bx-pill-progress" cx="18" cy="18" r="16" strokeDasharray={2 * Math.PI * 16} strokeDashoffset={2 * Math.PI * 16 * (1 - progress)} transform="rotate(-90 18 18)" />
          <g className={`bx-pill-atom${reduced ? '' : ' is-spinning'}`}>
            {[0, 60, 120].map((angle) => (
              <ellipse key={angle} cx="18" cy="18" rx="9.5" ry="3.6" transform={`rotate(${angle} 18 18)`} />
            ))}
          </g>
          <circle className="bx-pill-dot" cx="18" cy="18" r="2.6" />
        </svg>
        <span className="bx-pill-text">
          <span className="bx-pill-stage">{stageLabel(t, stage)}</span>
          <span className="bx-pill-percent">{percent}%</span>
        </span>
      </button>,
      document.body,
    );
  }

  // ── Success, after the celebration: the QR / download flow ──
  if (view === 'qr') {
    return (
      <SpaceQrPopup
        jobId={build.id}
        initialShortUrl={build.shortUrl}
        initialExpiresAt={build.shortExpiresAt}
        onClose={() => setMode('hidden')}
        onShortLinkUpdated={(url, expiresAt) => updateCurrentBuild({ shortUrl: url, shortExpiresAt: expiresAt })}
      />
    );
  }

  const kind = view === 'failed' ? failureKind(build.errorLog) : null;
  const notes = buildNotices(build.errorLog).map((n) => (
    <p key={n} id={`build-note-${n}`} className="bx-note" role="note">{t(`buildFlow.notice.${n}`)}</p>
  ));

  return createPortal(
    <div
      id="build-experience"
      className={`bx-overlay${reduced ? ' is-reduced' : ''}${view === 'failed' ? ' is-failed' : ''}`}
      dir={dir}
      role="dialog"
      aria-modal="true"
      aria-labelledby="bx-title"
    >
      <div className="bx-stars bx-stars--far" aria-hidden="true" />
      <div className="bx-stars bx-stars--mid" aria-hidden="true" />
      <div className="bx-stars bx-stars--near" aria-hidden="true" />
      <div className="bx-nebula bx-nebula--purple" aria-hidden="true" />
      <div className="bx-nebula bx-nebula--blue" aria-hidden="true" />

      <div className="bx-content">
        {view === 'progress' && stage && (
          <>
            <div className="bx-stage-visual">
              <Atom progress={progress} reduced={reduced} />
              <div className="bx-percent" aria-hidden="true">{percent}%</div>
            </div>
            <h2 id="bx-title" className="bx-title" aria-live="polite">{stageLabel(t, stage)}</h2>
            <ol className="bx-steps" aria-label={t('buildFlow.stepsLabel')}>
              {BUILD_STAGES.map((s, i) => {
                const current = BUILD_STAGES.indexOf(stage);
                const state = i < current ? 'done' : i === current ? 'current' : 'next';
                return (
                  <li key={s} className={`bx-step is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
                    <span className="bx-step-dot" aria-hidden="true" />
                    <span className="bx-step-label">{stageLabel(t, s)}</span>
                  </li>
                );
              })}
            </ol>
            <p className="bx-hint">{t('buildFlow.hint')}</p>
            {notes}
            <div className="bx-actions">
              <button ref={mainBtnRef} id="build-continue-btn" type="button" className="bx-btn bx-btn--secondary" onClick={() => setMode('pill')}>
                {t('buildFlow.continueWorking')}
              </button>
            </div>
            <div className="bx-cancel">
              {confirmCancel ? (
                <span className="bx-cancel-confirm" role="alertdialog" aria-label={t('buildFlow.cancelConfirm')}>
                  <span>{t('buildFlow.cancelConfirm')}</span>
                  <button id="build-cancel-yes" type="button" className="bx-link bx-link--danger" onClick={() => void cancelBuild()}>{t('buildFlow.cancelYes')}</button>
                  <button id="build-cancel-no" type="button" className="bx-link" onClick={() => setConfirmCancel(false)}>{t('buildFlow.cancelNo')}</button>
                </span>
              ) : (
                <button id="build-cancel-link" type="button" className="bx-link" onClick={() => setConfirmCancel(true)}>{t('buildFlow.cancel')}</button>
              )}
            </div>
          </>
        )}

        {view === 'celebrate' && (
          <>
            <div className="bx-stage-visual">
              {!reduced && <div className="bx-burst" aria-hidden="true" />}
              {!reduced && <div className="bx-burst bx-burst--late" aria-hidden="true" />}
              <Atom progress={1} reduced={reduced} done />
              <svg className="bx-check" viewBox="0 0 52 52" aria-hidden="true"><path d="M14 27l8 8 16-17" /></svg>
            </div>
            <h2 id="bx-title" className="bx-title bx-title--success">{t('buildFlow.successTitle')}</h2>
            <p className="bx-hint">{t('buildFlow.successSubtitle')}</p>
          </>
        )}

        {view === 'failed' && kind && (
          <>
            <div className="bx-failed-icon" aria-hidden="true">
              <svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" /><path d="M24 14v13M24 33v.5" /></svg>
            </div>
            <h2 id="bx-title" className="bx-title">{t('buildFlow.failedTitle')}</h2>
            <p className="bx-explain">{t(`buildFlow.failed.${kind}`)}</p>
            {notes}
            <div className="bx-actions">
              <button ref={mainBtnRef} id="build-view-details" type="button" className="bx-btn" onClick={() => setShowDetails((v) => !v)} aria-expanded={showDetails}>
                {showDetails ? t('buildFlow.hideDetails') : t('buildFlow.viewDetails')}
              </button>
              <button id="build-failed-close" type="button" className="bx-btn bx-btn--secondary" onClick={() => setMode('hidden')}>
                {t('buildFlow.close')}
              </button>
            </div>
            {showDetails && (
              <div className="bx-details">
                <button type="button" className="bx-link bx-details-copy" onClick={copyDetails}>{copied ? t('buildFlow.copied') : t('buildFlow.copy')}</button>
                <pre id="build-failed-log" className="bx-details-log" dir="ltr">{build.errorLog || ''}</pre>
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
