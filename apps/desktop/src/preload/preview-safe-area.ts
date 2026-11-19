import { webFrame } from 'electron';
import { isSafeAreaMessage, pageShim, rewriteSafeAreaEnv } from './preview-safe-area-page';

export { isSafeAreaMessage, rewriteSafeAreaEnv };

/**
 * Safe-area insets for the app in the Preview pane.
 *
 * The preview iframe shows the app edge to edge, under the status bar, Dynamic Island and home indicator,
 * like a simulator. On a phone the app learns how far to keep away from those through CSS
 * env(safe-area-inset-*), which react-native-safe-area-context reads on the web; a desktop browser always
 * reports 0. Electron 33 (Chromium 130) has no way to override them, so this shim rewrites every
 * env(safe-area-inset-*) the page sets into var(--atomvs-safe-area-inset-*), and the Preview pane sends the
 * device's values. CSS variables are live, so values that arrive after the app has rendered still apply.
 *
 * The only channel to the host is window.postMessage, both ways narrow and validated:
 *   in:  { type: 'atomvs:safe-area', insets: { top, right, bottom, left } } from window.parent, numbers 0–200
 *   out: { type: 'atomvs:safe-area-request' } once at start, and
 *        { type: 'atomvs:status-bar', declared: 'light' | 'dark' | null, source: string | null }
 *          (the status-bar icon tone the app declares, and where: e.g. 'expo-status-bar style=auto'), and
 *        { type: 'atomvs:screen-changed' } (the host re-samples the rendered status-bar and home-indicator strips)
 *        { type: 'atomvs:runtime', errors, rendered, textChars, overlay } (the app's runtime errors, and whether
 *          it shows anything; the host relays it to the agent's get_preview_logs)
 * Nothing is exposed to the page: no contextBridge API, no ipcRenderer.
 */

/** A preview iframe: the app on its local dev server, directly inside the Atomvs window. */
function isPreviewFrame(): boolean {
  try {
    const { protocol, hostname } = window.location;
    return window.parent === window.top && window.parent !== window
      && (protocol === 'http:' || protocol === 'https:') && (hostname === 'localhost' || hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** Called by the preload in sub-frames. Exposes nothing; only injects the shim into preview frames. */
export function installPreviewSafeArea(): void {
  if (!isPreviewFrame()) return;
  void webFrame.executeJavaScript(`(${pageShim.toString()})(${rewriteSafeAreaEnv.toString()}, ${isSafeAreaMessage.toString()});`);
}
