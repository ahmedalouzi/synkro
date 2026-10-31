import { useEffect, useState, useRef, useCallback } from 'react';
import { PreviewAssembly } from './PreviewAssembly';
import './DetachedPreview.css';
import { DEVICES, deviceGeometry, fitZoom, type DeviceType } from './devices';
import { usePreviewSafeArea } from './usePreviewSafeArea';

export function DetachedPreview() {
  const query = new URLSearchParams(window.location.search);
  const deviceId = (query.get('deviceId') as DeviceType) || 'iphone-15';
  const device = DEVICES.find((d) => d.id === deviceId) || DEVICES[0];
  const landscape = query.get('landscape') === '1';
  const geometry = deviceGeometry(device, landscape);

  const [session, setSession] = useState<any>(null);
  const [iframeKey, setIframeKey]   = useState(0);
  const [scale, setScale]           = useState(0.6);
  const bodyRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const FRAME_W = geometry.frame.width;
  const FRAME_H = geometry.frame.height;

  useEffect(() => {
    void window.peep.getPreviewSession().then(setSession);
    const unsub = window.peep.onPreviewStatus((s) => {
      setSession(s);
      if (s.status === 'running') setIframeKey((p) => p + 1);
    });
    return () => unsub();
  }, []);

  const computeScale = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const availW = el.clientWidth  - 32;
    const availH = el.clientHeight - 32;
    if (availW <= 0 || availH <= 0) return;
    // zoom keeps the app sharp at any size, so it can grow beyond 1x.
    setScale(fitZoom(geometry, availW, availH, window.devicePixelRatio || 1, 0.2, 2));
  }, [deviceId, landscape]);

  useEffect(() => {
    computeScale();
    const ro = new ResizeObserver(computeScale);
    if (bodyRef.current) ro.observe(bodyRef.current);
    return () => ro.disconnect();
  }, [computeScale]);

  const isRunning = session?.status === 'running' && session.url;
  const { tone, background, onFrameLoad } = usePreviewSafeArea(iframeRef, session?.url, device, geometry);

  return (
    <div className="detached-stage">
      {/* Header */}
      <div className="detached-header" style={{ WebkitAppRegion: 'drag' } as any}>
        <div className="mac-dots" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <div className="mac-dot close" onClick={() => void window.peep.attachPreview()}></div>
          <div className="mac-dot min" onClick={() => void window.peep.minimizeWindow?.()}></div>
          <div className="mac-dot max" onClick={() => void window.peep.maximizeWindow?.()}></div>
        </div>
        
        <div className="detached-title-center">
          <div className="title-device">{device.label}</div>
          <div className="title-os">{device.id.includes('pixel') || device.id.includes('galaxy') ? 'Android 14.0' : 'iOS 17.0'}</div>
        </div>

        <div className="detached-actions" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <button type="button" className="detached-icon-btn" title="Home (restart at the app's first screen)" onClick={() => setIframeKey(p => p + 1)}>
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          </button>
          {isRunning && (
            <button type="button" className="detached-icon-btn" title="Refresh" onClick={() => { void window.peep.reloadPreview(); setIframeKey(p => p + 1); }}>
               <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M3.51 15A9 9 0 0 0 18.36 18.36L23 14"/></svg>
            </button>
          )}
          <button type="button" className="detached-icon-btn" title="Attach to IDE" onClick={() => void window.peep.attachPreview()}>
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h6v6"/><polyline points="9 21 21 9"/><path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/></svg>
          </button>
        </div>
      </div>

      {/* Body: phone frame centered */}
      <div className="detached-body" ref={bodyRef}>
        {/* CSS zoom (not transform: scale): the iframe is re-rendered at the zoomed
            size, so the app stays sharp while still seeing the device's logical width. */}
        <div
          className="detached-phone-slot"
          style={{ width: FRAME_W * scale, height: FRAME_H * scale }}
        >
          <div
            className="detached-phone-transform"
            style={{
              width: FRAME_W,
              height: FRAME_H,
              zoom: scale,
            }}
          >
            <PreviewAssembly device={device} landscape={landscape} tone={tone} background={background}>
              {session?.status === 'starting' && (
                <div className="preview-placeholder">
                  <span className="preview-placeholder__icon preview-placeholder__spinner">⏳</span>
                  <h3>Starting…</h3>
                  <p>Starting web server. This may take a minute.</p>
                </div>
              )}
              {session?.status === 'error' && (
                <div className="preview-placeholder preview-placeholder--error">
                  <span className="preview-placeholder__icon">⚠️</span>
                  <h3>Preview failed</h3>
                  <p>{session.error ?? 'Could not start preview.'}</p>
                </div>
              )}
              {isRunning && (
                  <iframe
                    key={iframeKey}
                    ref={iframeRef}
                    onLoad={onFrameLoad}
                    className="preview-iframe"
                    style={{
                      width: '100%',
                      height: '100%',
                      border: 'none',
                    }}
                    src={session.url}
                    title="Mobile Preview"
                  />
              )}
              {!session && (
                <div className="preview-placeholder">
                  <span className="preview-placeholder__icon">📱</span>
                  <h3>Live preview</h3>
                  <p>Open a project to start preview.</p>
                </div>
              )}
              {session?.status === 'stopped' && (
                <div className="preview-placeholder">
                  <span className="preview-placeholder__icon">⏹</span>
                  <h3>Preview stopped</h3>
                  <p>Launch the project preview from the IDE.</p>
                </div>
              )}
            </PreviewAssembly>
          </div>
        </div>
      </div>
    </div>
  );
}
