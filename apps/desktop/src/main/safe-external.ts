import { shell, type WebContents } from 'electron';
import log from 'electron-log/main';
import { isSafeExternalUrl, urlScheme } from './safe-external-url';

/** Opens a web or mailto link in the user's browser / mail app; anything else is refused and logged (scheme only). */
export function openExternalSafely(url: string): void {
  if (isSafeExternalUrl(url)) {
    void shell.openExternal(url);
  } else {
    log.warn(`[external-link] refused to open a ${urlScheme(url)} link`);
  }
}

/**
 * window.open in these contents never opens an Electron window: allowed links go to the browser, the rest is
 * refused. Covers the preview iframe too (it shares its page's contents).
 */
export function handleWindowOpenSafely(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });
}
