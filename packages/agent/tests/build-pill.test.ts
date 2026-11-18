import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

/**
 * BuildExperience rendered for real (React + the build store, in jsdom): a running build opens the full screen,
 * "Continue working" minimizes it to the pill, the pill reopens it, and the title-bar "Building…" button reopens it.
 * The pill was missing after "Continue working" on a real build (production, Nov 17).
 */
export default async function run() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const g = globalThis as any;
  const saved: Record<string, unknown> = {};
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'SVGElement', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT']) saved[key] = g[key];
  const win = dom.window as any;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  Object.assign(g, {
    window: win, document: win.document, HTMLElement: win.HTMLElement, Node: win.Node, Element: win.Element, SVGElement: win.SVGElement,
    getComputedStyle: win.getComputedStyle.bind(win), requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(g, 'navigator', { value: win.navigator, configurable: true });

  const React = await import('react');
  const { act } = React as any;
  // tsx compiles the component's JSX with the classic runtime (React.createElement); the app's Vite build does not need this.
  saved.React = g.React;
  g.React = React;
  const { createRoot } = await import('react-dom/client');
  const { useBuildStore } = await import('../../../apps/desktop/src/renderer/src/stores/build-store');
  const { BuildExperience, reopenBuildExperience } = await import('../../../apps/desktop/src/renderer/src/features/build/BuildExperience');

  const root = createRoot(win.document.getElementById('root'));
  const q = (sel: string) => win.document.querySelector(sel) as HTMLElement | null;
  const click = async (el: HTMLElement | null) => {
    assert.ok(el, 'element to click exists');
    await act(async () => { el!.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); });
  };
  try {
    await act(async () => { root.render(React.createElement(BuildExperience)); });
    await act(async () => {
      useBuildStore.getState().setCurrentBuild({
        id: 'job-1', userId: 'u', projectId: 'p', framework: 'react-native', target: 'apk', status: 'running',
        createdAt: new Date(), startedAt: new Date(), errorLog: '[STEP] npm install 0m41s\n[STEP] expo prebuild 0m38s\n',
      } as any);
    });

    console.log('  [pill] A running build opens the full screen...');
    assert.equal(useBuildStore.getState().experienceMode, 'full');
    assert.ok(q('#build-experience'), 'full screen rendered');
    assert.equal(q('#build-pill'), null);

    console.log('  [pill] "Continue working" minimizes to the pill, which is rendered...');
    await click(q('#build-continue-btn'));
    assert.equal(useBuildStore.getState().experienceMode, 'pill');
    assert.equal(q('#build-experience'), null, 'full screen closed');
    const pill = q('#build-pill');
    assert.ok(pill, 'the pill is in the DOM');
    assert.equal(pill!.parentElement, win.document.body, 'portalled to <body>, above every panel');
    assert.match(pill!.textContent ?? '', /Compiling for Android/);
    assert.match(pill!.textContent ?? '', /\d+%/);
    assert.ok(pill!.querySelector('.bx-pill-atom'), 'shows the atom icon');

    console.log('  [pill] The pill reopens the full screen...');
    await click(pill);
    assert.equal(useBuildStore.getState().experienceMode, 'full');
    assert.ok(q('#build-experience'));

    console.log('  [pill] The title-bar "Building…" button reopens it too...');
    await click(q('#build-continue-btn'));
    assert.ok(q('#build-pill'));
    await act(async () => { reopenBuildExperience(); });
    assert.equal(useBuildStore.getState().experienceMode, 'full');
    assert.ok(q('#build-experience'));

    console.log('  [pill] CSS: at the top under the title bar, end side, above every other layer of the IDE...');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const srcDir = new URL('../../../apps/desktop/src/renderer/src/', import.meta.url);
    const css = fs.readFileSync(new URL('features/build/BuildExperience.css', srcDir), 'utf8');
    const rule = /\.bx-pill \{([^}]*)\}/.exec(css)?.[1] ?? '';
    assert.match(rule, /top: calc\(env\(titlebar-area-height, 35px\) \+ 8px\)/, 'just under the title bar / window buttons');
    assert.match(rule, /inset-inline-end:/, 'end side: right, or left in RTL');
    assert.doesNotMatch(rule, /\bbottom:/, 'not at the bottom any more');
    const pillZ = Number(/z-index: (\d+)/.exec(rule)?.[1]);
    // Every other z-index in the renderer's CSS, except the build page (99990) and the QR popup (100000) above it.
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e: any) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.css') ? [path.join(dir, e.name)] : []);
    const others = walk(path.resolve(new URL('.', srcDir).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
      .filter((f) => !f.endsWith('BuildExperience.css') && !f.endsWith('SpaceQrPopup.css'))
      .flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1])));
    assert.ok(others.length > 0);
    assert.ok(pillZ > Math.max(...others), `pill z-index ${pillZ} must be above ${Math.max(...others)}`);

    console.log('  🟢 Build pill tests passed.');
  } finally {
    await act(async () => { root.unmount(); });
    useBuildStore.getState().setCurrentBuild(null);
    useBuildStore.getState().setExperienceMode('hidden');
    for (const [key, value] of Object.entries(saved)) {
      if (key === 'navigator') Object.defineProperty(g, 'navigator', { value, configurable: true });
      else g[key] = value;
    }
    dom.window.close();
  }
}
