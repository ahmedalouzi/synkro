import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePreviewRuntimeReport, tabBarLayoutIssues, type TabBarMeasurement } from '@peep/shared';
import { formatPreviewReport } from '../../../apps/desktop/src/main/services/preview-log';
import { FLUTTER_SYSTEM_PROMPT } from '../src/prompts/flutter-system';

/**
 * A bottom tab bar that ignores the safe area (a user's Expo app: tabBarStyle { height: 60, paddingBottom: 8 }, labels
 * squashed to 5 px under the home indicator) is caught in the preview and reported to the agent, which is told to fix it:
 * the check itself, its report through get_preview_logs, the shim wiring, and the agent's rule.
 */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');

// Measured on iPhone 17 Pro (874 pt tall, bottom inset 34) in the frame lab, from a copy of the user's app.
const BROKEN: TabBarMeasurement = {
  innerHeight: 874, insetBottom: 34,
  bars: [{ top: 815, bottom: 866, items: [{ top: 823, bottom: 866 }, { top: 823, bottom: 866 }], labels: [{ height: 5, scrollHeight: 15 }, { height: 5, scrollHeight: 15 }, { height: 24, scrollHeight: 24 }] }],
};
// The same app with the fixed height and padding removed (React Navigation adds the inset).
const FIXED: TabBarMeasurement = {
  innerHeight: 874, insetBottom: 34,
  bars: [{ top: 791, bottom: 840, items: [{ top: 792, bottom: 840 }, { top: 792, bottom: 840 }], labels: [{ height: 13, scrollHeight: 14 }, { height: 24, scrollHeight: 24 }] }],
};

export default async function run() {
  console.log('  [layout] A tab bar under the home indicator, with squashed labels, is caught...');
  const issues = tabBarLayoutIssues(BROKEN);
  assert.deepEqual(issues.map((i) => i.kind), ['tab-bar-under-home-indicator', 'tab-labels-clipped']);
  assert.match(issues[0].message, /8 px from the bottom.*34 px/);
  assert.match(issues[1].message, /2 bottom tab label\(s\).*5 px tall where the text needs 15 px/);
  for (const i of issues) assert.match(i.message, /useSafeAreaInsets\(\).*height: 60 \+ insets\.bottom/, 'says how to fix it');

  console.log('  [layout] ...and a correct one is not (no false positives)...');
  assert.deepEqual(tabBarLayoutIssues(FIXED), [], 'tabs end at the inset, labels whole (1 px of font metrics is not a cut)');
  assert.deepEqual(tabBarLayoutIssues({ innerHeight: 874, insetBottom: 34, bars: [] }), [], 'no tab bar');
  assert.deepEqual(tabBarLayoutIssues({ ...BROKEN, insetBottom: 0, bars: [{ ...BROKEN.bars[0], labels: [] }] }), [],
    'no inset (e.g. the iPhone SE): a tab bar at the very bottom is right');
  assert.deepEqual(tabBarLayoutIssues({ ...BROKEN, insetBottom: 0 }).map((i) => i.kind), ['tab-labels-clipped'],
    'squashed labels are a problem with or without an inset');
  const many = { ...BROKEN, bars: Array(6).fill(BROKEN.bars[0]) };
  assert.equal(tabBarLayoutIssues(many).length, 5, 'at most 5 issues');

  console.log('  [layout] The check runs on its own in the page (serialised with toString)...');
  const inPage = new Function(`return (${tabBarLayoutIssues.toString()})`)() as typeof tabBarLayoutIssues;
  assert.deepEqual(inPage(BROKEN), issues, 'no references outside the function');

  console.log('  [layout] Reports from the page: validated, old ones still accepted...');
  const base = { errors: [], rendered: true, textChars: 120, overlay: '' };
  assert.deepEqual(parsePreviewRuntimeReport(base)?.layout, [], 'a report without layout (older shim) is fine');
  assert.deepEqual(parsePreviewRuntimeReport({ ...base, layout: issues })?.layout, issues);
  assert.equal(parsePreviewRuntimeReport({ ...base, layout: [{ kind: 'run-this', message: 'x' }] }), null, 'unknown kinds rejected');
  assert.equal(parsePreviewRuntimeReport({ ...base, layout: 'tab-bar' }), null);
  assert.equal(parsePreviewRuntimeReport({ ...base, layout: [{ kind: 'tab-labels-clipped', message: 'x'.repeat(5000) }] })!.layout[0].message.length, 600);

  console.log('  [layout] get_preview_logs tells the agent, as a failure to fix...');
  const session = { status: 'running', url: 'http://localhost:8081' } as any;
  const text = formatPreviewReport(session, '', parsePreviewRuntimeReport({ ...base, layout: issues }));
  assert.match(text, /Layout problems on screen \(2\), fix these before saying it works:\n\[tab-bar-under-home-indicator\]/);
  assert.doesNotMatch(formatPreviewReport(session, '', parsePreviewRuntimeReport(base)), /Layout problems/);

  console.log('  [layout] The preview shim measures tab bars and sends the check into the page...');
  // The preload (injection) and the page shim it injects (preview-safe-area-page.ts, shared with the frame lab).
  const shim = ['preview-safe-area.ts', 'preview-safe-area-page.ts']
    .map((f) => fs.readFileSync(path.join(root, 'apps/desktop/src/preload', f), 'utf8')).join('\n');
  assert.match(shim, /\$\{tabBarLayoutIssues\.toString\(\)\}/, 'the check is injected with the shim');
  assert.match(shim, /querySelectorAll\('\[role="tablist"\]'\)/, 'React Navigation tab bars ([role=tablist])');
  assert.match(shim, /layout: \(\(\) => \{ try \{ return tabBarIssues\(measureTabBars\(\)\)/, 'reported with the runtime state, never throwing');

  console.log('  [layout] The agent is told how to build tab bars that respect the safe area...');
  assert.match(FLUTTER_SYSTEM_PROMPT, /\*\*SAFE AREAS \(React Native \/ Expo\)\*\*/);
  assert.match(FLUTTER_SYSTEM_PROMPT, /never set a fixed height or paddingBottom in tabBarStyle/);
  assert.match(FLUTTER_SYSTEM_PROMPT, /tabBarStyle: \{ height: 60 \+ insets\.bottom, paddingBottom: insets\.bottom \+ 8 \}/);
  assert.match(FLUTTER_SYSTEM_PROMPT, /On Expo SDK 51 use React Navigation 6/);
  assert.match(FLUTTER_SYSTEM_PROMPT, /no "Layout problems on screen"/, 'part of verify-before-claiming');

  console.log('  🟢 Preview layout check tests passed.');
}
