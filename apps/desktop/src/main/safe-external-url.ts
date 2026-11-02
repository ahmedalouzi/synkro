/**
 * Which links Atomvs hands to the operating system (shell.openExternal). Only web pages and e-mail: a file://
 * link or an OS protocol handler (ms-msdt:, search-ms:, a custom app scheme, …) can run or open things on the
 * user's machine, and window.open can come from code we do not control (the app in the preview iframe, a page in
 * a <webview>). No Electron import, so it can be tested on its own.
 */
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** The scheme only, for logs (a full URL can carry a token). */
export function urlScheme(url: unknown): string {
  try {
    return new URL(String(url)).protocol;
  } catch {
    return '(invalid url)';
  }
}
