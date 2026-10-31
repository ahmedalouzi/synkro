import { webFrame } from 'electron';

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

/** env(safe-area-inset-top[, fallback]) → var(--atomvs-safe-area-inset-top, fallback). Exported for tests. */
export function rewriteSafeAreaEnv(css: string): string {
  return css.replace(
    /\b(?:env|constant)\(\s*safe-area-inset-(top|right|bottom|left)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
    (_match, side: string, fallback?: string) => `var(--atomvs-safe-area-inset-${side}, ${fallback?.trim() || '0px'})`,
  );
}

/** Message the shim accepts from the host. Exported for tests. */
export function isSafeAreaMessage(data: unknown): data is { type: 'atomvs:safe-area'; insets: Record<'top' | 'right' | 'bottom' | 'left', number> } {
  if (!data || typeof data !== 'object' || (data as { type?: unknown }).type !== 'atomvs:safe-area') return false;
  const insets = (data as { insets?: unknown }).insets;
  if (!insets || typeof insets !== 'object') return false;
  return (['top', 'right', 'bottom', 'left'] as const).every((side) => {
    const value = (insets as Record<string, unknown>)[side];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 200;
  });
}

/**
 * Runs in the page's own world (it has to patch the page's CSSOM). Self-contained: it is serialised with
 * Function.prototype.toString, so it can only use its parameters and browser globals.
 */
function pageShim(rewrite: (css: string) => string, isInsets: (data: unknown) => boolean): void {
  if ((window as any).__atomvsSafeArea) return;
  Object.defineProperty(window, '__atomvsSafeArea', { value: true });
  const ENV = /\b(?:env|constant)\(\s*safe-area-inset-/;
  const fix = (value: unknown) => (typeof value === 'string' && ENV.test(value) ? rewrite(value) : value);

  // Inline styles: element.style.paddingTop = …, setProperty, cssText, setAttribute('style', …).
  const protos = [(window as any).CSSStyleProperties?.prototype, CSSStyleDeclaration.prototype].filter(Boolean);
  for (const proto of protos) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (!/^(padding|margin|inset|top|right|bottom|left|height|width|min|max|cssText|scroll|translate|transform)/i.test(name)) continue;
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || !d.set || !d.configurable) continue;
      Object.defineProperty(proto, name, { ...d, set(this: unknown, v: unknown) { d.set!.call(this, fix(v)); } });
    }
  }
  const setProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function (name: string, value: string | null, priority?: string) {
    return setProperty.call(this, name, fix(value) as string | null, priority);
  };
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name: string, value: string) {
    return setAttribute.call(this, name, String(name).toLowerCase() === 'style' ? (fix(value) as string) : value);
  };

  // Style sheets built through the CSSOM (react-native-web) or constructed ones.
  const insertRule = CSSStyleSheet.prototype.insertRule;
  CSSStyleSheet.prototype.insertRule = function (rule: string, index?: number) {
    return insertRule.call(this, fix(rule) as string, index);
  };
  const replaceSync = CSSStyleSheet.prototype.replaceSync;
  CSSStyleSheet.prototype.replaceSync = function (text: string) { return replaceSync.call(this, fix(text) as string); };
  const replace = CSSStyleSheet.prototype.replace;
  CSSStyleSheet.prototype.replace = function (text: string) { return replace.call(this, fix(text) as string); };

  // <style> sheets, and anything set before these patches ran. Rules are rewritten in place: replacing the
  // <style> text would build a new sheet and drop rules the page added with insertRule.
  const fixRules = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      const style = (rule as CSSStyleRule).style;
      if (style && ENV.test(style.cssText)) style.cssText = rewrite(style.cssText);
      if ((rule as CSSGroupingRule).cssRules) fixRules((rule as CSSGroupingRule).cssRules);
    }
  };
  const fixNode = (node: Node) => {
    if (node.nodeName === 'STYLE') {
      try { const sheet = (node as HTMLStyleElement).sheet; if (sheet) fixRules(sheet.cssRules); } catch { /* not readable */ }
    }
    if (node.nodeType === 1) {
      const style = (node as Element).getAttribute('style');
      if (style && ENV.test(style)) setAttribute.call(node as Element, 'style', rewrite(style));
    }
  };
  const observe = () => {
    document.querySelectorAll('style,[style]').forEach(fixNode);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') fixNode(r.target);
        else if (r.type === 'characterData') { if (r.target.parentNode) fixNode(r.target.parentNode); }
        else r.addedNodes.forEach((n) => { fixNode(n); if (n.nodeType === 1) (n as Element).querySelectorAll('style,[style]').forEach(fixNode); });
      }
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style'] });
  };
  if (document.documentElement) observe();
  else document.addEventListener('DOMContentLoaded', observe, { once: true });

  // The status-bar style the app declares, which a phone honours: expo-status-bar / react-native's StatusBar
  // first, else <meta name="theme-color">, else <meta name="color-scheme">. Both StatusBars render nothing on
  // the web, so their props are read from React's committed tree, through the DevTools hook React looks for
  // when it loads (this runs before the page's scripts). Without a declaration the host samples the rendered
  // pixels; this side then only says when the screen may have changed.
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
  const appScheme = () => (prefersDark.matches ? 'light' : 'dark'); // icon tone for 'auto'
  const roots = new Set<any>();
  const fromStatusBar = (): [string, string] | null => {
    let found: [string, string] | null = null;
    for (const root of roots) {
      let node = root.current;
      let steps = 0;
      // Pre-order, so the last StatusBar in the tree wins, as on a phone.
      while (node && steps++ < 100000) {
        const props = node.memoizedProps;
        let expo = false;
        if (props && typeof props === 'object') {
          const type = node.type;
          const name = typeof type === 'function' ? String(type.displayName || type.name || '') : '';
          if (props.barStyle === 'light-content' || props.barStyle === 'dark-content') {
            found = [props.barStyle === 'light-content' ? 'light' : 'dark', `StatusBar barStyle=${props.barStyle}`];
          } else if (/StatusBar/.test(name) && ['light', 'dark', 'auto', 'inverted'].includes(props.style)) {
            const auto = appScheme();
            found = [props.style === 'auto' ? auto : props.style === 'inverted' ? (auto === 'light' ? 'dark' : 'light') : props.style, `expo-status-bar style=${props.style}`];
            expo = true; // the react-native StatusBar it renders only restates this
          }
        }
        if (node.child && !expo) { node = node.child; continue; }
        while (node && !node.sibling) node = node.return;
        node = node ? node.sibling : null;
      }
    }
    return found;
  };
  const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const onCommit = (root: any) => { if (root && root.current) roots.add(root); schedule(); };
  if (hook && typeof hook.onCommitFiberRoot === 'function') {
    const original = hook.onCommitFiberRoot;
    hook.onCommitFiberRoot = function (this: unknown, id: unknown, root: any, ...rest: unknown[]) {
      onCommit(root);
      return original.call(this, id, root, ...rest);
    };
  } else if (!hook) {
    let nextId = 0;
    // Writable, so React DevTools or Fast Refresh can still wrap or replace it.
    Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
      configurable: true, writable: true, enumerable: false,
      value: {
        renderers: new Map(), supportsFiber: true, isDisabled: false,
        inject(renderer: unknown) { const id = ++nextId; this.renderers.set(id, renderer); return id; },
        onCommitFiberRoot(_id: unknown, root: any) { onCommit(root); },
        onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {}, checkDCE() {},
      },
    });
  }
  // A CSS colour's icon tone, via a detached canvas (it normalises any colour syntax without touching the DOM).
  const ctx = document.createElement('canvas').getContext('2d');
  const toneOfColor = (css: string): string | null => {
    if (!ctx) return null;
    ctx.fillStyle = '#010203';
    ctx.fillStyle = css;
    const value = String(ctx.fillStyle);
    if (value === '#010203' && !/^#010203$/i.test(css.trim())) return null;
    const m = value.startsWith('#') ? [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) : (value.match(/[\d.]+/g) || []).map(Number);
    if (m.length >= 4 && m[3] < 0.5) return null;
    const [r, g, b] = m.slice(0, 3).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // White or #1C1C1E (luminance 0.0117), whichever contrasts more.
    return 1.05 / (l + 0.05) >= (l + 0.05) / (0.0117 + 0.05) ? 'light' : 'dark';
  };
  const fromMeta = (): [string, string] | null => {
    for (const meta of Array.from(document.querySelectorAll('meta[name="theme-color"]'))) {
      const media = meta.getAttribute('media');
      if (media && !window.matchMedia(media).matches) continue;
      const tone = toneOfColor(meta.getAttribute('content') || '');
      if (tone) return [tone, 'theme-color'];
    }
    const scheme = (document.querySelector('meta[name="color-scheme"]')?.getAttribute('content') || '').toLowerCase().split(/\s+/);
    const dark = scheme.includes('dark');
    const light = scheme.includes('light');
    if (dark && light) return [appScheme(), 'color-scheme'];
    if (dark) return ['light', 'color-scheme'];
    if (light) return ['dark', 'color-scheme'];
    return null;
  };
  let lastDeclared = '';
  const report = () => {
    const bar = fromStatusBar();
    const [declared, source] = bar || fromMeta() || [null, null];
    const key = `${declared} ${source}`;
    if (key !== lastDeclared) {
      lastDeclared = key;
      window.parent.postMessage({ type: 'atomvs:status-bar', declared, source }, '*');
    }
    window.parent.postMessage({ type: 'atomvs:screen-changed' }, '*');
  };
  // The app's runtime state, for the agent's checks: errors it hits (a bundle that loads can still crash in
  // the browser, which never reaches the dev server's terminal) and whether it shows anything at all.
  const runtimeErrors: Array<{ kind: string; message: string }> = [];
  const describe = (value: unknown): string => {
    if (value instanceof Error) return `${value.name}: ${value.message}\n${(value.stack || '').split('\n').slice(1, 4).join('\n')}`;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const addError = (kind: string, message: string) => {
    runtimeErrors.push({ kind, message: message.slice(0, 1500) });
    if (runtimeErrors.length > 10) runtimeErrors.shift();
    schedule();
  };
  window.addEventListener('error', (event) => {
    addError('exception', event.error ? describe(event.error) : `${event.message} (${event.filename}:${event.lineno})`);
  });
  window.addEventListener('unhandledrejection', (event) => addError('unhandled-rejection', describe(event.reason)));
  const consoleError = console.error;
  console.error = function (...args: unknown[]) {
    try { addError('console.error', args.map(describe).join(' ')); } catch { /* never break the app's logging */ }
    return consoleError.apply(this, args);
  };
  const OVERLAY = /(Uncaught Error|Render Error|Syntax Error|Unable to resolve module|Failed to compile)/;
  let lastRuntime = '';
  const reportRuntime = () => {
    if (!document.body) return;
    const root = document.getElementById('root') || document.body;
    const text = (document.body.innerText || '').trim();
    const media = root.querySelectorAll('img,svg,canvas,video').length;
    const state = {
      type: 'atomvs:runtime',
      errors: runtimeErrors.slice(),
      rendered: root.childElementCount > 0 && (text.length > 0 || media > 0),
      textChars: text.length,
      overlay: OVERLAY.test(text) ? text.slice(0, 1500) : '',
    };
    const key = JSON.stringify(state);
    if (key !== lastRuntime) {
      lastRuntime = key;
      window.parent.postMessage(state, '*');
    }
  };
  window.addEventListener('load', () => window.setTimeout(reportRuntime, 1500));

  // Re-check on navigation, scroll, theme and animation changes, batched.
  let pending = 0;
  function schedule() { if (!pending) pending = window.setTimeout(() => { pending = 0; report(); reportRuntime(); }, 250); }
  new MutationObserver(schedule).observe(document, { subtree: true, childList: true, attributes: true });
  for (const type of ['scroll', 'transitionend', 'animationend']) window.addEventListener(type, schedule, { capture: true, passive: true });
  for (const type of ['resize', 'popstate', 'hashchange']) window.addEventListener(type, schedule);
  prefersDark.addEventListener('change', schedule);

  // Insets from the host.
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !isInsets(event.data)) return;
    const { insets } = event.data as { insets: Record<string, number> };
    for (const side of ['top', 'right', 'bottom', 'left']) {
      document.documentElement.style.setProperty(`--atomvs-safe-area-inset-${side}`, `${insets[side]}px`);
    }
    window.dispatchEvent(new Event('resize'));
    lastDeclared = '';
    schedule();
  });
  window.parent.postMessage({ type: 'atomvs:safe-area-request' }, '*');
}

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
