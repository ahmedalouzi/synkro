import { useI18n } from '../i18n';
import { useState, useEffect, useRef, useCallback } from 'react';
import { usePreviewStore } from '../stores/preview-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { PreviewAssembly } from '../features/preview/PreviewAssembly';
import { DeviceType } from '../features/preview/PhoneFrame';
import { useComposerStore } from '../stores/composer-store';
import './PreviewPane.css';
import { SkyBackdrop } from '../features/shared/SkyBackdrop';

export type DeviceConfig = {
  id: string;
  label: string;
  logicalViewport: { width: number; height: number };
  artwork: { frameAsset: string };
  screenCutout: { x: number; y: number; width: number; height: number; cornerRadius: number };
};

export const DEVICES: DeviceConfig[] = [
  {
    id: 'iphone-15',
    label: 'iPhone 15',
    logicalViewport: { width: 393, height: 852 },
    artwork: { frameAsset: 'pf-iphone' },
    screenCutout: { x: 16, y: 16, width: 393, height: 852, cornerRadius: 42 }
  },
  {
    id: 'iphone-15-pro',
    label: 'iPhone 15 Pro',
    logicalViewport: { width: 393, height: 852 },
    artwork: { frameAsset: 'pf-iphone pf-iphone--pro' },
    screenCutout: { x: 16, y: 16, width: 393, height: 852, cornerRadius: 42 }
  },
  {
    id: 'iphone-se',
    label: 'iPhone SE',
    logicalViewport: { width: 375, height: 667 },
    artwork: { frameAsset: 'pf-iphone-se' },
    screenCutout: { x: 12, y: 92, width: 375, height: 667, cornerRadius: 0 }
  },
  {
    id: 'pixel-8',
    label: 'Pixel 8',
    logicalViewport: { width: 412, height: 892 },
    artwork: { frameAsset: 'pf-pixel' },
    screenCutout: { x: 14, y: 14, width: 412, height: 892, cornerRadius: 36 }
  },
  {
    id: 'pixel-fold',
    label: 'Pixel Fold',
    logicalViewport: { width: 840, height: 768 },
    artwork: { frameAsset: 'pf-pixel-fold' },
    screenCutout: { x: 18, y: 18, width: 840, height: 768, cornerRadius: 24 }
  },
  {
    id: 'galaxy-s24',
    label: 'Galaxy S24',
    logicalViewport: { width: 360, height: 780 },
    artwork: { frameAsset: 'pf-galaxy' },
    screenCutout: { x: 12, y: 12, width: 360, height: 780, cornerRadius: 28 }
  }
];

function getPlatformLabel(p: string) {
  if (p === 'react-native') return 'RN';
  if (p === 'expo') return 'Expo';
  if (p === 'flutter') return 'Flutter';
  return 'Web / Other';
}
function getPlatformColor(p: string) {
  if (p === 'flutter') return '#2d7dd2';
  if (p === 'react-native') return '#7c5cbf';
  if (p === 'expo') return '#4630eb';
  return '#10b981';
}
function getIdleMsg(p: string) {
  if (p === 'react-native' || p === 'expo') {
    return 'Open a React Native project to auto-start Expo Web preview, or press Start.';
  }
  if (p === 'flutter') {
    return 'Open a Flutter project to auto-start preview, or press Start.';
  }
  return 'Web or general project opened. Automated previews are not supported for this project type.';
}
function getStartingMsg(p: string) {
  if (p === 'react-native' || p === 'expo') {
    return 'Running npm install and starting Expo Web… This may take a minute.';
  }
  if (p === 'flutter') {
    return 'Running flutter pub get and web server. This may take a minute.';
  }
  return 'Starting preview…';
}
function getStoppedMsg(p: string) {
  if (p === 'react-native' || p === 'expo') {
    return 'Press Start to launch Expo Web again.';
  }
  if (p === 'flutter') {
    return 'Press Start to launch Flutter Web again.';
  }
  return 'Preview stopped.';
}

export function PreviewPane() {
  const { t } = useI18n();
  const project = useWorkspaceStore((s) => s.project);
  const [scale, setScale] = useState(0.55);
  const [connectedDevices, setConnectedDevices] = useState<any[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('browser');

  useEffect(() => {
    if (project?.path) {
      (window.peep as any).getConnectedDevices().then((devs: any) => {
        setConnectedDevices(devs || []);
      });
    }
  }, [project?.path]);

  const [isInspectorActive, setIsInspectorActive] = useState(false);
  // Use HTMLIFrameElement — we use <iframe> instead of <webview> so the renderer
  // process shares the same Chromium context as the host, giving correct viewport
  // dimensions even when the frame is inside a CSS transform.
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const handleToggleInspector = () => {
    const nextActive = !isInspectorActive;
    setIsInspectorActive(nextActive);
    // Send toggle message via postMessage to the iframe content
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'peep:toggle-inspector', active: nextActive },
      '*'
    );
  };

  const selectedElement = usePreviewStore((s) => s.selectedElement);
  const setSelectedElement = usePreviewStore((s) => s.setSelectedElement);
  const promptInput = usePreviewStore((s) => s.promptInput);
  const setPromptInput = usePreviewStore((s) => s.setPromptInput);

  const handleSendToAgent = () => {
    if (!selectedElement) return;
    const { setOpen, stageFile, setPrompt } = useComposerStore.getState();
    const workspaceStore = useWorkspaceStore.getState();

    const handleOpenSource = async () => {
      if (selectedElement.sourceFile) {
        try {
          const content = await window.peep.readFile(selectedElement.sourceFile);
          const name = selectedElement.sourceFile.split(/[\\/]/).pop() || 'File';
          workspaceStore.openFile({ path: selectedElement.sourceFile, name, content, dirty: false });
          stageFile(selectedElement.sourceFile);
        } catch {}
      }
    };
    handleOpenSource();

    setPrompt(`[SELECTED ELEMENT CONTEXT]
- Framework: ${selectedElement.framework}
- Component: ${selectedElement.componentName}
- Source File: ${selectedElement.sourceFile || 'Unknown'}
- Location: Line ${selectedElement.sourceLine || '?'}, Column ${selectedElement.sourceColumn || '?'}
- Component Hierarchy: ${selectedElement.componentHierarchy?.join(' → ') || 'None'}
- Props / Styles: ${JSON.stringify(selectedElement.props || {}, null, 2)}
- Selected Element: Tag <${selectedElement.elementInfo?.tagName || ''}>, Text: "${selectedElement.elementInfo?.text || ''}"

Please modify the selected element and its corresponding component files as follows: ${promptInput}`);
    setOpen(true);
    setSelectedElement(null);
    setPromptInput('');
  };

  const session = usePreviewStore((s) => s.session);
  const isRunning = session?.status === 'running' && session.url;
  const [iframeError, setIframeError] = useState(false);

  // Clear error when session starts running
  useEffect(() => {
    if (isRunning) {
      setIframeError(false);
    }
  }, [isRunning, session?.url]);

  // Listen for postMessage events from the iframe (inspector + element-selected)
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (!e.data || typeof e.data !== 'object') return;

      if (e.data.type === 'peep:element-selected') {
        const metadata = e.data.metadata;
        setIsInspectorActive(false);
        setSelectedElement(metadata);

        const workspaceStore = useWorkspaceStore.getState();
        const { stageFile } = useComposerStore.getState();

        const autoOpen = async () => {
          if (metadata.sourceFile) {
            try {
              const content = await window.peep.readFile(metadata.sourceFile);
              const name = metadata.sourceFile.split(/[\\/]/).pop() || 'File';
              workspaceStore.openFile({ path: metadata.sourceFile, name, content, dirty: false });
              stageFile(metadata.sourceFile);

              setTimeout(() => {
                window.dispatchEvent(
                  new CustomEvent('peep:go-to-line', {
                    detail: { line: metadata.sourceLine || 1, col: metadata.sourceColumn || 1 }
                  })
                );
              }, 120);
            } catch (err) {
              console.error('Auto open failed', err);
            }
          }
        };
        autoOpen();
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [setSelectedElement]);

  const [isDetached, setIsDetached] = useState(false);

  const iframeKey = usePreviewStore((s) => s.iframeKey);
  const deviceId = usePreviewStore((s) => s.deviceId) as DeviceType;
  const setDeviceId = usePreviewStore((s) => s.setDeviceId);

  /* ── Refs ── */
  const paneRef = useRef<HTMLElement>(null);
  const deviceRef = useRef(deviceId);

  useEffect(() => { deviceRef.current = deviceId; }, [deviceId]);

  const setPreviewPaneOpen = useWorkspaceStore((s) => s.setPreviewPaneOpen);

  const platform = project?.platform ?? 'flutter';
  const platColor = getPlatformColor(platform);
  const device = DEVICES.find((d) => d.id === deviceId) ?? DEVICES[0]!;

  /* ── Scale: fit the phone into the stage below the header ── */
  const stageBodyRef = useRef<HTMLDivElement>(null);
  const fitScale = useCallback(() => {
    const el = stageBodyRef.current;
    if (!el) return;
    const d = DEVICES.find((x) => x.id === deviceRef.current) ?? DEVICES[0]!;
    // Stage padding (14px top/bottom, 12px sides) + device label row with its gap.
    const availW = el.clientWidth - 24;
    const availH = el.clientHeight - 28 - 26;
    if (availW < 10 || availH < 10) return;
    const outerW = d.logicalViewport.width + d.screenCutout.x * 2;
    const outerH = d.logicalViewport.height + d.screenCutout.y * 2;
    const s = Math.min(availW / outerW, availH / outerH);
    setScale(Math.min(Math.max(s, 0.2), 1.0));
  }, []);

  useEffect(() => {
    fitScale();
    const el = stageBodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(fitScale);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitScale]);

  // Recompute when device changes
  useEffect(() => {
    deviceRef.current = deviceId;
    fitScale();
  }, [deviceId, fitScale]);

  /* ── Detach listener ── */
  useEffect(() => {
    void window.peep.isPreviewDetached().then(setIsDetached);
    const unsub = window.peep.onPreviewStatus(() => {
      void window.peep.isPreviewDetached().then(setIsDetached);
    });
    return () => unsub();
  }, []);

  const handleStart = () => {
    if (!project) return;
    if (selectedDeviceId !== 'browser') {
      void (window.peep as any).startDeviceRun(selectedDeviceId, platform, project.path);
      usePreviewStore.getState().setSession({
        url: '',
        processId: 9999,
        status: 'running',
      });
    } else {
      if (platform === 'react-native' || platform === 'expo') {
        void window.peep.rnStartPreview(project.path);
      } else {
        void window.peep.startPreview(project.path);
      }
    }
  };
  const handleRefresh = () => {
    if (platform === 'react-native' || platform === 'expo') {
      if (session?.processId) {
        void window.peep.rnReloadPreview(session.processId);
      }
    } else {
      void window.peep.reloadPreview();
    }
    usePreviewStore.getState().bumpIframe();
  };
  const handleStop = () => {
    if (platform === 'react-native' || platform === 'expo') {
      if (session?.processId) {
        void window.peep.rnStopPreview(session.processId);
      }
    } else {
      void window.peep.stopPreview();
    }
  };

  /* ── Run menu commands (Start / Reload / Stop Preview) ── */
  const runHandlersRef = useRef({ handleStart, handleRefresh, handleStop });
  runHandlersRef.current = { handleStart, handleRefresh, handleStop };
  useEffect(() => {
    const onStart = () => runHandlersRef.current.handleStart();
    const onReload = () => runHandlersRef.current.handleRefresh();
    const onStop = () => runHandlersRef.current.handleStop();
    window.addEventListener('peep:preview-start', onStart);
    window.addEventListener('peep:preview-reload', onReload);
    window.addEventListener('peep:preview-stop', onStop);
    return () => {
      window.removeEventListener('peep:preview-start', onStart);
      window.removeEventListener('peep:preview-reload', onReload);
      window.removeEventListener('peep:preview-stop', onStop);
    };
  }, []);
  const handleDetach = () => void window.peep.detachPreview(deviceId, {
    width: device.logicalViewport.width + device.screenCutout.x * 2,
    height: device.logicalViewport.height + device.screenCutout.y * 2,
  });

  // Switching device while detached: resize the detached window and show the new device.
  const lastDetachedDeviceRef = useRef(deviceId);
  useEffect(() => {
    if (!isDetached || lastDetachedDeviceRef.current === deviceId) return;
    lastDetachedDeviceRef.current = deviceId;
    handleDetach();
  }, [deviceId, isDetached]);
  useEffect(() => {
    if (isDetached) lastDetachedDeviceRef.current = deviceId;
  }, [isDetached]);
  const handleAutoHeal = () => {
    if (!project || !session?.error) return;
    const { agentPaneOpen, toggleAgentPane } = useWorkspaceStore.getState();
    if (!agentPaneOpen) {
      toggleAgentPane();
    }
    window.dispatchEvent(
      new CustomEvent('peep:trigger-agent', {
        detail: {
          message: "The application build failed to compile or run. Please examine the codebase, find the bug causing this build failure, and fix the file(s). Make the code changes directly without asking for confirmation.",
          previewError: session.error,
        },
      })
    );
  };

  return (
    <section className="preview-panel" ref={paneRef}>

      {/* ── Header ── */}
      <div className="preview-header">
        <div className="preview-header__left">
          <span className="preview-header__title">{t('preview.title')}</span>
          {project && (
            <span className="preview-header__platform"
              style={{ '--plat-color': platColor } as React.CSSProperties}>
              <span className="preview-header__platform-dot" />
              {platform === 'flutter' ? 'FLUTTER' : platform === 'react-native' ? 'RN' : platform === 'expo' ? 'EXPO' : t('preview.webOther')}
            </span>
          )}
        </div>

        <div className="preview-header__actions">
          {isDetached ? (
            <button type="button" className="preview-action-btn preview-action-btn--primary"
              onClick={() => void window.peep.attachPreview()}>
              📥 Attach
            </button>
          ) : (
            <>
              <select
                className="preview-device-select"
                value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
                title="Select running target"
                style={{ marginRight: '8px' }}
              >
                <option value="browser">🌐 Web Browser</option>
                {connectedDevices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.platform === 'android' ? '🤖' : '🍎'} {d.name}
                  </option>
                ))}
              </select>

              {selectedDeviceId === 'browser' && (
                <select
                  className="preview-device-select"
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value as DeviceType)}
                  title="Device frame"
                >
                  {DEVICES.map((d) => (
                    <option key={d.id} value={d.id}>{d.label}</option>
                  ))}
                </select>
              )}

              {isRunning && selectedDeviceId === 'browser' && (
                <button
                  type="button"
                  className={`preview-action-btn ${isInspectorActive ? 'preview-action-btn--primary' : ''}`}
                  style={isInspectorActive ? { background: 'var(--gold)', color: '#000', borderColor: 'var(--gold)' } : {}}
                  onClick={handleToggleInspector}
                  title="Select element to inspect/edit style"
                >
                  🔍 {isInspectorActive ? 'Inspecting…' : 'Inspect'}
                </button>
              )}
              {isRunning ? (
                <>
                  <button type="button" className="preview-action-btn" onClick={handleRefresh} title="Hot reload">
                    ↺ Refresh
                  </button>
                  <button type="button" className="preview-action-btn" onClick={handleStop} title="Stop preview">
                    ⏹ Stop
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="preview-action-btn preview-action-btn--start"
                  onClick={handleStart}
                  disabled={!project || platform === 'unknown'}
                  title={platform === 'unknown' ? 'Previews are not supported' : `Start ${getPlatformLabel(platform)} preview`}
                >
                  ▶ {t('preview.start')}
                </button>
              )}

              <button
                type="button"
                className="preview-action-btn"
                onClick={handleDetach}
                title="Detach preview to floating window"
              >
                ↗ {t('preview.detach')}
              </button>
            </>
          )}
          <button type="button" className="preview-action-btn preview-action-btn--close"
            onClick={() => setPreviewPaneOpen(false)}>✕</button>
        </div>
      </div>

      <div className="preview-body" style={{
        flex: 1, position: 'relative', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <SkyBackdrop />

        {/* ── Body ── */}
        <div className="panel-body preview-pane__body" ref={stageBodyRef}>
          {isDetached ? (
            <div className="preview-placeholder">
              <span className="preview-placeholder__icon">↗️</span>
              <h3>Preview detached</h3>
              <p>The preview is running in a separate floating window.</p>
              <button type="button" className="preview-retry-btn"
                onClick={() => void window.peep.attachPreview()}>
                Attach Back
              </button>
            </div>
          ) : (
            <div className="preview-stage">
              <div className="preview-device-label">{device.label}</div>
              {/* CSS zoom (not transform: scale): Chromium re-renders the iframe at the
                  zoomed size so the app stays sharp, while it still sees the device's
                  logical width (e.g. 393px). transform would stretch a 1x bitmap. */}
              <div className={`phone-scale-container${isRunning ? ' is-running' : ''}`} style={{
                width: device.logicalViewport.width + device.screenCutout.x * 2,
                height: device.logicalViewport.height + device.screenCutout.y * 2,
                zoom: scale,
                flexShrink: 0,
                boxSizing: 'border-box',
                paddingLeft: device.screenCutout.x,
                paddingTop: device.screenCutout.y,
              }}>
                <PreviewAssembly device={device}>
                  {session?.status === 'starting' && (
                    <div className="preview-placeholder">
                      <span className="preview-placeholder__icon preview-placeholder__spinner">⏳</span>
                      <h3>Starting…</h3>
                      <p>{getStartingMsg(platform)}</p>
                    </div>
                  )}
                  {session?.status === 'error' && (
                    <div className="preview-placeholder preview-placeholder--error">
                      <span className="preview-placeholder__icon">⚠️</span>
                      <h3>Preview failed</h3>
                      <p>{session.error ?? `Could not start ${getPlatformLabel(platform)} preview.`}</p>
                      <button type="button" className="preview-retry-btn"
                        onClick={handleStart} disabled={!project}>Retry</button>
                      <button type="button" className="preview-retry-btn"
                        onClick={handleAutoHeal} disabled={!project}
                        style={{ marginLeft: '8px', background: 'var(--gold)', color: '#000', borderColor: 'var(--gold)' }}
                      >
                        ✨ Auto-Fix Build
                      </button>
                    </div>
                  )}
                  {selectedDeviceId !== 'browser' && isRunning && (
                    <div className="preview-placeholder preview-placeholder--native" style={{ padding: '20px', textAlign: 'center' }}>
                      <span className="preview-placeholder__icon" style={{ fontSize: '32px' }}>📲</span>
                      <h3 style={{ margin: '12px 0 6px 0', fontSize: '15px' }}>Natively Deploying</h3>
                      <p style={{ fontSize: '11px', color: '#8b949e', marginBottom: '8px' }}>
                        Running app on target device:
                      </p>
                      <code style={{ display: 'block', padding: '4px 8px', background: 'rgba(255,255,255,0.06)', borderRadius: '4px', fontSize: '10px', wordBreak: 'break-all' }}>
                        {selectedDeviceId}
                      </code>
                      <p style={{ fontSize: '10px', color: 'var(--gold)', marginTop: '16px' }}>
                        Check the logs panel below to inspect native compiler output.
                      </p>
                    </div>
                  )}
                  {selectedDeviceId === 'browser' && isRunning && iframeError && (
                    <div className="preview-placeholder preview-placeholder--error" style={{ position: 'absolute', inset: 0, zIndex: 10, background: 'var(--bg-pane)' }}>
                      <span className="preview-placeholder__icon">⚠️</span>
                      <h3>Preview Load Error</h3>
                    </div>
                  )}
                  {selectedDeviceId === 'browser' && isRunning && (
                    /* ─────────────────────────────────────────────────────────────────
                       Use <iframe> (same-process) instead of <webview> (OOP iframe).
                       An OOP webview inside a CSS transform reports a scaled-down
                       window.innerHeight to the guest page, causing layouts like Expo
                       bottom-tabs to position themselves at the top of the screen.
                       A same-process <iframe> always sees its own DOM dimensions
                       regardless of parent transforms, matching the detached window.
                    ───────────────────────────────────────────────────────────────── */
                    <iframe
                      key={iframeKey}
                      ref={iframeRef}
                      className="preview-iframe"
                      src={session.url}
                      title="Mobile Preview"
                      style={{
                        width: '100%',
                        height: '100%',
                        border: 'none',
                        display: iframeError ? 'none' : 'block',
                      }}
                      onError={() => setIframeError(true)}
                    />
                  )}
                  {!session && (
                    <div className="preview-placeholder">
                      <span className="preview-placeholder__icon">📱</span>
                      <h3>{t('preview.livePreview')}</h3>
                      <p>{getIdleMsg(platform)}</p>
                    </div>
                  )}
                  {session?.status === 'stopped' && (
                    <div className="preview-placeholder">
                      <span className="preview-placeholder__icon">⏹</span>
                      <h3>Preview stopped</h3>
                      <p>{getStoppedMsg(platform)}</p>
                    </div>
                  )}
                </PreviewAssembly>
              </div>
            </div>
          )}
        </div>
      </div>
      {selectedElement && (
        <div style={{
          position: 'absolute',
          bottom: '20px',
          left: '20px',
          right: '20px',
          background: '#1f2428',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '12px',
          zIndex: 1000,
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '11.5px', color: 'var(--gold)', fontWeight: 600 }}>
              ✨ Ask AI to modify: {selectedElement.componentName}
            </span>
            <button
              onClick={() => setSelectedElement(null)}
              style={{ background: 'transparent', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: '12px' }}
            >
              ✕
            </button>
          </div>
          <div style={{ fontSize: '10px', color: '#8b949e' }}>
            Source: {selectedElement.sourceFile?.split(/[\\/]/).pop() || 'Unknown'} (Line {selectedElement.sourceLine || '?'})
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="text"
              placeholder="e.g. Make this card more premium, change the background color..."
              value={promptInput}
              onChange={(e) => setPromptInput(e.target.value)}
              style={{
                flex: 1,
                background: '#24292e',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                padding: '6px 10px',
                color: '#fff',
                fontSize: '11px'
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSendToAgent();
                }
              }}
            />
            <button
              onClick={handleSendToAgent}
              style={{
                background: 'var(--gold)',
                color: '#000',
                border: 'none',
                borderRadius: '4px',
                padding: '6px 12px',
                fontSize: '11.5px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Submit
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
