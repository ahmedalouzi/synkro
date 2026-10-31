import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { useBuildStore } from '../../stores/build-store';
import { buildApi } from '../../services/build-api';
import { CloudBuildJob } from '@peep/shared';
import { useI18n, t as i18nT } from '../../i18n';
// Styles (BuildPanel.css, xterm.css) are imported by BottomPanel.tsx: this module is also
// loaded by the Node test harness, which can't import CSS. (An unused `?inline` import here
// was silently dropped by the TypeScript transform, so the panel rendered unstyled.)

function Icon({ d }: { d: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const ICON = {
  copy: 'M8 8h12v12H8zM4 16V4h12',
  check: 'M20 6 9 17l-5-5',
  stop: 'M6 6h12v12H6z',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  build: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z',
};

export function BuildPanel() {
  const { t } = useI18n();
  const currentBuild = useBuildStore((s) => s.currentBuild);
  const updateCurrentBuild = useBuildStore((s) => s.updateCurrentBuild);
  const termRef = useRef<HTMLDivElement>(null);
  const termInstance = useRef<Terminal | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  // Status polling timer
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    if (currentBuild?.status === 'running' || currentBuild?.status === 'queued') {
      timer = setInterval(async () => {
        try {
          const updated = await buildApi.getBuild(currentBuild.id);
          updateCurrentBuild(updated);
        } catch (e) {
          console.error('Failed to poll build status', e);
        }
      }, 3000);
    }
    return () => clearInterval(timer);
  }, [currentBuild?.id, currentBuild?.status, updateCurrentBuild]);

  // Elapsed time counter
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    if (currentBuild?.status === 'running' && currentBuild.startedAt) {
      timer = setInterval(() => {
        const start = new Date(currentBuild.startedAt!).getTime();
        setElapsed(Math.floor((Date.now() - start) / 1000));
      }, 1000);
    } else if (
      currentBuild?.status === 'success' ||
      currentBuild?.status === 'failed' ||
      currentBuild?.status === 'cancelled'
    ) {
      if (currentBuild.buildDurationMs) {
        setElapsed(Math.floor(currentBuild.buildDurationMs / 1000));
      }
    } else {
      setElapsed(0);
    }
    return () => clearInterval(timer);
  }, [currentBuild?.status, currentBuild?.startedAt, currentBuild?.buildDurationMs]);

  // Terminal setup & log streaming
  useEffect(() => {
    if (!termRef.current) return;

    if (!termInstance.current) {
      const term = new Terminal({
        theme: {
          background: '#0f0f12',
          foreground: '#e2e8f0',
          cursor: 'transparent'
        },
        fontSize: 12,
        lineHeight: 1.35,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        convertEol: true,
        disableStdin: true,
      });
      // xterm has no copyOnSelect option; VS Code implements it on selection change too.
      term.onSelectionChange(() => {
        if (term.hasSelection()) void navigator.clipboard.writeText(term.getSelection());
      });
      term.open(termRef.current);
      termInstance.current = term;
    }

    const term = termInstance.current;
    term.clear();

    if (currentBuild) {
      const unsub = buildApi.streamLogs(currentBuild.id, (chunk) => {
        term.write(chunk);
      });
      return () => unsub();
    }
  }, [currentBuild?.id]);

  // ── Handlers — defined unconditionally (Rules of Hooks: no hooks after early return) ──
  const isActive = currentBuild?.status === 'queued' || currentBuild?.status === 'running';

  const handleCancel = useCallback(() => {
    if (currentBuild) buildApi.cancelBuild(currentBuild.id);
  }, [currentBuild]);

  const handleDownload = useCallback(() => {
    if (currentBuild?.artifactUrl) window.open(currentBuild.artifactUrl, '_blank');
  }, [currentBuild]);

  const handleCopyLog = useCallback(() => {
    const term = termInstance.current;
    if (!term) return;
    const selection = term.getSelection();
    // If the user has already selected text, copy just that; otherwise copy entire buffer.
    const textToCopy = selection.length > 0 ? selection : (() => {
      const lines: string[] = [];
      for (let i = 0; i < term.buffer.active.length; i++) {
        lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? '');
      }
      return lines.join('\n').trimEnd();
    })();
    navigator.clipboard.writeText(textToCopy).then(() => {
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus('idle'), 1500);
    }).catch(() => {
      setCopyStatus('failed');
      setTimeout(() => setCopyStatus('idle'), 1500);
    });
  }, []);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  if (!currentBuild) {
    return (
      <div id="build-panel-empty" className="build-panel empty">
        <div className="build-empty-icon"><Icon d={ICON.build} /></div>
        <div className="build-empty-title">{t('build.noActiveBuild')}</div>
        <div className="build-empty-hint">{t('build.emptyHintPre')} <strong>{t('build.buildApk')}</strong> {t('build.emptyHintMid')} <kbd>Ctrl+Shift+B</kbd> {t('build.emptyHintPost')}</div>
      </div>
    );
  }


  return (
    <div id="build-panel" className="build-panel">
      <div className="build-header">
        <div className="build-info">
          <span id="build-status-badge" className={`status-badge ${currentBuild.status || 'unknown'}`} data-status={currentBuild.status || 'unknown'}>
            {(currentBuild.status || 'unknown').toUpperCase()}
          </span>
          <span id="build-target-label" className="build-target">
            {currentBuild.framework || 'unknown'} • {(currentBuild.target || 'apk').toUpperCase()}
          </span>
          {(currentBuild.status === 'running' || elapsed > 0) && (
            <span id="build-elapsed" className="build-time">{timeStr}</span>
          )}
        </div>
        <div className="build-actions">
          <button id="build-copy-btn" className="btn-copy" onClick={handleCopyLog} title="Copy the build log (or the selected text)">
            <Icon d={copyStatus === 'copied' ? ICON.check : ICON.copy} />
            {copyStatus === 'copied' ? t('build.copied') : copyStatus === 'failed' ? t('build.failed') : t('build.copyLog')}
          </button>
          {isActive && (
            <button id="build-cancel-btn" className="btn-cancel" onClick={handleCancel}>
              <Icon d={ICON.stop} />
              {t('build.cancelBuild')}
            </button>
          )}
          {currentBuild.status === 'success' && currentBuild.artifactUrl && (
            <button id="build-download-btn" className="btn-download" onClick={handleDownload}>
              <Icon d={ICON.download} />
              {t('build.downloadTarget', { target: (currentBuild.target || 'apk').toUpperCase() })}
            </button>
          )}
        </div>
      </div>

      {isActive && <div className="build-progress" aria-hidden="true" />}

      {currentBuild.status === 'failed' && currentBuild.errorLog && (
        <div id="build-error-banner" className="build-error-banner">
          <div className="error-title">{t('build.buildFailed')}</div>
          <pre id="build-error-log" className="error-log">{currentBuild.errorLog}</pre>
        </div>
      )}

      <div id="build-logs-container" className="build-logs-container" ref={termRef} />
    </div>
  );
}

// ─── Pure-DOM test harness (no React, no xterm) ──────────────────────────────
// Mirrors the conditional render logic of the BuildPanel React component above.
// Used by build-panel.test.ts via JSDOM — no React, no xterm.js required.
//
// ⚠️  SYNC WARNING: This function is a manually-maintained DOM mirror of
// BuildPanel()'s JSX render. If you change which elements are shown/hidden
// in the real component (status conditions, button visibility, error banner
// logic), you MUST update renderBuildPanel() here to match, or tests will
// silently diverge from actual component behaviour.

export interface BuildPanelOpts {
  currentBuild: CloudBuildJob | null;
  onCancel?: () => void;
  onDownload?: () => void;
}

export function renderBuildPanel(opts: BuildPanelOpts, doc: Document): HTMLElement {
  const { currentBuild, onCancel, onDownload } = opts;

  if (!currentBuild) {
    const empty = doc.createElement('div');
    empty.id = 'build-panel-empty';
    empty.className = 'build-panel empty';
    const emptyTitle = doc.createElement('div');
    emptyTitle.className = 'build-empty-title';
    emptyTitle.textContent = i18nT('build.noActiveBuild');
    empty.append(emptyTitle);
    return empty;
  }

  const root = doc.createElement('div');
  root.id = 'build-panel';
  root.className = 'build-panel';

  // Header
  const header = doc.createElement('div');
  header.className = 'build-header';

  const info = doc.createElement('div');
  info.className = 'build-info';

  const badge = doc.createElement('span');
  badge.id = 'build-status-badge';
  badge.className = `status-badge ${currentBuild.status}`;
  badge.textContent = currentBuild.status.toUpperCase();
  info.append(badge);

  const targetLabel = doc.createElement('span');
  targetLabel.id = 'build-target-label';
  targetLabel.className = 'build-target';
  targetLabel.textContent = `${currentBuild.framework} • ${currentBuild.target.toUpperCase()}`;
  info.append(targetLabel);

  header.append(info);

  const actions = doc.createElement('div');
  actions.className = 'build-actions';

  const isActive = currentBuild.status === 'queued' || currentBuild.status === 'running';
  if (isActive) {
    const cancelBtn = doc.createElement('button');
    cancelBtn.id = 'build-cancel-btn';
    cancelBtn.className = 'btn-cancel';
    cancelBtn.textContent = i18nT('build.cancelBuild');
    cancelBtn.onclick = () => onCancel?.();
    actions.append(cancelBtn);
  }

  if (currentBuild.status === 'success' && currentBuild.artifactUrl) {
    const downloadBtn = doc.createElement('button');
    downloadBtn.id = 'build-download-btn';
    downloadBtn.className = 'btn-download';
    downloadBtn.textContent = i18nT('build.downloadTarget', { target: currentBuild.target.toUpperCase() });
    downloadBtn.onclick = () => onDownload?.();
    actions.append(downloadBtn);
  }

  header.append(actions);
  root.append(header);

  if (isActive) {
    const progress = doc.createElement('div');
    progress.className = 'build-progress';
    root.append(progress);
  }

  // Error banner (only when failed AND errorLog is set)
  if (currentBuild.status === 'failed' && currentBuild.errorLog) {
    const banner = doc.createElement('div');
    banner.id = 'build-error-banner';
    banner.className = 'build-error-banner';

    const errTitle = doc.createElement('div');
    errTitle.className = 'error-title';
    errTitle.textContent = 'Build Failed';
    banner.append(errTitle);

    const errLog = doc.createElement('pre');
    errLog.id = 'build-error-log';
    errLog.className = 'error-log';
    errLog.textContent = currentBuild.errorLog;
    banner.append(errLog);

    root.append(banner);
  }

  // Log container (xterm target in real React; a <div> in test harness)
  const logsContainer = doc.createElement('div');
  logsContainer.id = 'build-logs-container';
  logsContainer.className = 'build-logs-container';
  root.append(logsContainer);

  return root;
}

// ─── Pure-DOM test harness for TitleBar Build APK button ───────────────────
//
// ⚠️  SYNC WARNING: This function is a manually-maintained DOM mirror of
// the BUILD APK <button> rendered inside TitleBar.tsx. If you change the
// disabled condition, the onClick guard, or the platform check in TitleBar,
// you MUST update renderBuildButton() here to match.

export interface BuildButtonOpts {
  platform: string | null;
  activeBuildStatus: 'queued' | 'running' | null;
  onBuildApk: () => void;
}

export function renderBuildButton(opts: BuildButtonOpts, doc: Document): HTMLElement | null {
  const { platform, activeBuildStatus, onBuildApk } = opts;

  if (platform !== 'flutter' && platform !== 'react-native') return null;

  const isBuilding = activeBuildStatus === 'queued' || activeBuildStatus === 'running';

  const btn = doc.createElement('button');
  btn.id = 'build-apk-btn';
  btn.title = isBuilding ? 'Build already in progress' : 'Build Android APK (Ctrl+Shift+B)';
  btn.disabled = isBuilding;
  btn.className = 'topbar__build';
  btn.textContent = isBuilding ? 'Building…' : 'Build APK';
  btn.onclick = () => {
    if (!isBuilding) onBuildApk();
  };
  return btn;
}
