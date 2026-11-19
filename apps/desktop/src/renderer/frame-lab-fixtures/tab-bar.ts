/**
 * Test fixture for the frame lab (dev only, not in the app build): an app with a bottom tab bar, as React Navigation
 * lays it out on the web, receiving the device's safe-area insets through the real preview shim.
 *
 * 1. The shim the preload injects into preview frames (preload/preview-safe-area-page.ts), run first, as there.
 * 2. Insets measured the way react-native-safe-area-context does on the web: a hidden element whose padding is set
 *    to env(safe-area-inset-*) through the camelCase style properties (which the shim cannot intercept directly),
 *    re-read on its padding transition and on resize.
 * 3. The tab bar: 49 pt of tabs plus the bottom inset as padding (React Navigation's default), icons and labels.
 * 4. Reports where the tab bar and its labels ended up ({ type: 'fixture:report' } to the frame lab).
 */
import { isSafeAreaMessage, pageShim, rewriteSafeAreaEnv } from '../../preload/preview-safe-area-page';

pageShim(rewriteSafeAreaEnv, isSafeAreaMessage);

const TAB_HEIGHT = 49;
const TABS: [string, string][] = [['⌂', 'Ana Sayfa'], ['★', 'Etkinlikler'], ['✉', 'Duyurular'], ['●', 'Profil']];

const tabbar = document.getElementById('tabbar')!;
const screen = document.getElementById('screen')!;
for (const [icon, label] of TABS) {
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.setAttribute('role', 'tab');
  tab.innerHTML = '<span class="icon"></span><span class="label"></span>';
  (tab.firstElementChild as HTMLElement).textContent = icon;
  (tab.lastElementChild as HTMLElement).textContent = label;
  tabbar.appendChild(tab);
}

// As react-native-safe-area-context's NativeSafeAreaProvider.web does.
const probe = document.createElement('div');
const { style } = probe;
style.position = 'fixed';
style.left = '0';
style.top = '0';
style.width = '0';
style.height = '0';
style.zIndex = '-1';
style.overflow = 'hidden';
style.visibility = 'hidden';
style.transitionDuration = '0.05s';
style.transitionProperty = 'padding';
style.transitionDelay = '0s';
style.paddingTop = 'env(safe-area-inset-top)';
style.paddingBottom = 'env(safe-area-inset-bottom)';
document.body.appendChild(probe);

let insets = { top: 0, bottom: 0 };
const layout = () => {
  const cs = getComputedStyle(probe);
  insets = { top: parseInt(cs.paddingTop, 10) || 0, bottom: parseInt(cs.paddingBottom, 10) || 0 };
  tabbar.style.height = `${TAB_HEIGHT + insets.bottom}px`;
  tabbar.style.paddingBottom = `${insets.bottom}px`;
  screen.style.top = `${insets.top}px`;
  screen.style.bottom = `${TAB_HEIGHT + insets.bottom}px`;
};
probe.addEventListener('webkitTransitionEnd', layout);
probe.addEventListener('transitionend', layout);
window.addEventListener('resize', layout);
layout();

const round = (v: number) => Math.round(v * 10) / 10;
setInterval(() => {
  const bar = tabbar.getBoundingClientRect();
  const labels = Array.from(tabbar.querySelectorAll<HTMLElement>('.label')).map((el) => {
    const r = el.getBoundingClientRect();
    return { top: round(r.top), bottom: round(r.bottom), height: round(r.height), needed: el.scrollHeight };
  });
  const tabs = Array.from(tabbar.querySelectorAll<HTMLElement>('.tab')).map((el) => {
    const r = el.getBoundingClientRect();
    return { top: round(r.top), bottom: round(r.bottom) };
  });
  window.parent.postMessage({
    type: 'fixture:report', innerWidth: window.innerWidth, innerHeight: window.innerHeight, insets,
    tabbar: { top: round(bar.top), bottom: round(bar.bottom) }, tabs, labels,
  }, '*');
}, 300);
