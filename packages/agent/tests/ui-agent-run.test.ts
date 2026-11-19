import type { AgentTimelineActivity } from '@peep/shared';
import { detectMessageLanguage, replyLanguageInstruction } from '../src/prompts/reply-language';
import { buildAgentContext } from '../src/context/builder';
import { runItems, sameFile, thoughtSeconds } from '../../../apps/desktop/src/renderer/src/features/agent-run/run-model';
import { parseBundled } from '../../../apps/desktop/src/renderer/src/stores/run-events-store';
import { lineChanges } from '../../../apps/desktop/src/renderer/src/features/editor/line-changes';
import { Typewriter } from '../../../apps/desktop/src/renderer/src/stores/stream-typewriter';

/** The chat as on the website's LiveDemo: language, the run timeline, Fast Refresh, follow-mode line changes. */
export default async function run() {
  console.log('  [language] Reply in the language of the latest message...');
  const langs: Array<[string, string | null]> = [
    ['اريد اللوان فاتحه التطبيق كله غامق', 'ar'],
    ['add a spaced repetition screen with types and mock data', 'en'],
    ['Uygulamaya bir ayarlar sayfası ekle', 'tr'],
    ['bu ekranı daha güzel yap', 'tr'],
    ['اضف شاشة جديدة في src/screens/HomeScreen.tsx', 'ar'], // path does not make it English
    // Grammar words decide, not the English tech terms in the request.
    ['bana bir login page yapa bilirmisin', 'tr'],
    ['login button ekle', 'tr'],
    ['home screen için dark mode yapar mısın', 'tr'],
    ['settings screen e bir toggle button koy lütfen', 'tr'],
    ['اعمل login page مع button', 'ar'],
    ['ضيف dark mode للـ settings screen', 'ar'],
    ['add a login button to the home screen', 'en'],
    ['make the controller handle regular users', 'en'],
    ['can you translate مرحبا to English', 'en'],
    ['login page', null],
    ['`npm run build`', null],
    ['👍', null],
  ];
  for (const [text, want] of langs) {
    const got = detectMessageLanguage(text);
    if (got !== want) throw new Error(`detectMessageLanguage(${text}) = ${got}, expected ${want}`);
  }
  // The interface language no longer wins over the message (it answered Arabic in Turkish).
  const arabicOnTurkishUi = replyLanguageInstruction('اريد شاشة جديدة', 'tr');
  if (!arabicOnTurkishUi.includes('Arabic') || arabicOnTurkishUi.includes('Turkish')) throw new Error(`Arabic message on a Turkish UI: ${arabicOnTurkishUi}`);
  const englishOnArabicUi = replyLanguageInstruction('add a login screen', 'ar');
  if (!englishOnArabicUi.includes('in English')) throw new Error('English message on an Arabic UI');
  if (!replyLanguageInstruction('`git status`', 'tr').includes('Turkish')) throw new Error('No-language message should fall back to the UI language');

  console.log('  [prompt] Final answers are 1-3 sentences, no lists of changes...');
  const prompt = buildAgentContext({ userMessage: 'x' });
  if (!prompt.includes('FINAL message is 1-3 short sentences') || !prompt.includes('no bullet lists')) throw new Error('Short-answer rule missing');

  console.log('  [run] Timeline items, file cards and "Thought for"...');
  const t0 = Date.parse('2026-11-03T10:00:00Z');
  const ev = (id: string, type: AgentTimelineActivity['type'], status: AgentTimelineActivity['status'], dt: number, extra: Partial<AgentTimelineActivity> = {}): AgentTimelineActivity =>
    ({ id, runId: 'r', type, status, message: '', timestamp: new Date(t0 + dt).toISOString(), ...extra } as AgentTimelineActivity);
  const acts = [
    ev('r:understanding', 'understanding', 'in_progress', 0),
    ev('r:i0:c1:in_progress', 'reading', 'in_progress', 1400, { file: 'app/(tabs)/_layout.tsx' }),
    ev('r:i0:c1:resolved', 'reading', 'completed', 1500, { file: 'app/(tabs)/_layout.tsx' }),
    ev('r:i1:c2:resolved', 'validating', 'completed', 1600, { message: 'Running manage_plan…' }),
    // The agent's bookkeeping under .peep/ never shows.
    ev('r:i1:c3:in_progress', 'editing', 'in_progress', 1700, { file: '.peep/plan.md' }),
    ev('r:i1:c5:resolved', 'reading', 'completed', 1750, { file: 'C:\\p\\.peep\\walkthrough.md' }),
    ev('r:i1:c6:resolved', 'validating', 'completed', 1760, { message: 'Updated .peep/plan.json' }),
    ev('r:i2:c4:in_progress', 'editing', 'in_progress', 1800, { file: 'app/(tabs)/classes.tsx' }),
  ];
  const items = runItems(acts);
  const kinds = items.map((i) => `${i.kind}:${i.a.file ?? i.a.message}`).join(' | ');
  if (kinds !== 'step:app/(tabs)/_layout.tsx | file:app/(tabs)/classes.tsx') throw new Error(`runItems: ${kinds}`);
  if (items[0].a.status !== 'completed') throw new Error('Resolved event did not replace its in-progress twin');
  if (thoughtSeconds(acts) !== 1) throw new Error(`thoughtSeconds: ${thoughtSeconds(acts)}`);
  if (!sameFile('C:\\p\\app\\(tabs)\\classes.tsx', 'app/(tabs)/classes.tsx') || sameFile('C:/p/app/a.tsx', 'b.tsx')) throw new Error('sameFile');

  console.log('  [refresh] Real Metro numbers: Fast Refresh vs full reload...');
  const hot = parseBundled('Web Bundled 412ms C:\\p\\my_app\\index.js (1 module)');
  const full = parseBundled('\u001b[32mWeb Bundled 932ms\u001b[39m C:\\p\\my_app\\index.js (336 modules)');
  if (hot?.ms !== 412 || hot.modules !== 1 || full?.ms !== 932 || full.modules !== 336) throw new Error('parseBundled');
  if (parseBundled('Starting Metro Bundler') !== null) throw new Error('parseBundled matched a non-bundle line');

  console.log('  [follow] Removed and added line ranges for the editor animation...');
  const before = 'a\nb\nc\nd\n';
  const after = 'a\nB1\nB2\nc\nd\ne\n';
  const ch = lineChanges(before, after);
  if (JSON.stringify(ch) !== JSON.stringify({ removed: [[2, 2]], added: [[2, 3], [6, 6]] })) throw new Error(`lineChanges: ${JSON.stringify(ch)}`);
  if (JSON.stringify(lineChanges('', 'x\ny\n').added) !== JSON.stringify([[1, 2]])) throw new Error('new file');
  // A CRLF buffer and the agent's LF text differ only where the agent changed something.
  const eol = lineChanges('a\r\nb\r\n', 'a\nb\nc\n');
  if (JSON.stringify(eol) !== JSON.stringify({ removed: [], added: [[3, 3]] })) throw new Error(`lineChanges CRLF: ${JSON.stringify(eol)}`);

  console.log('  [stream] The reply types out from a buffer, finish waits for it...');
  const frames: Array<(t: number) => void> = [];
  let shown = '';
  const tw = new Typewriter({ render: (x) => { shown = x; }, schedule: (cb) => frames.push(cb), cancel: () => {} });
  const tick = (time: number) => { const f = frames.shift(); if (f) f(time); };
  const reply = 'Done. The login screen is ready 👍 and saves the session.';
  tw.push(reply); // one burst, as Gemini sends a short answer
  if (shown !== '') throw new Error('Typewriter rendered before the first frame');
  let t = 0;
  tick((t += 16));
  if (!shown || shown.length >= reply.length) throw new Error(`First frame showed ${shown.length}/${reply.length} chars`);
  let done = false;
  tw.finish(() => { done = true; });
  if (done) throw new Error('finish() completed before the text was typed out');
  for (let i = 0; i < 200 && frames.length; i++) {
    tick((t += 16));
    const last = shown.charCodeAt(shown.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) throw new Error('Typewriter split a surrogate pair');
  }
  if (shown !== reply || !done || tw.typing) throw new Error(`Typewriter did not finish: ${shown}`);
  if (t < 150 || t > 1200) throw new Error(`Typewriter pace: ${t}ms for ${reply.length} chars`);
  let flushed = '';
  const tw2 = new Typewriter({ render: (x) => { flushed = x; }, schedule: (cb) => frames.push(cb), cancel: () => { frames.length = 0; } });
  tw2.push('first part, ');
  tw2.flush();
  if (flushed !== 'first part, ') throw new Error('flush() did not show everything');
  let instant = '';
  const tw3 = new Typewriter({ render: (x) => { instant = x; }, reduceMotion: () => true, schedule: (cb) => frames.push(cb) });
  tw3.push('Hello ');
  tw3.push('world');
  let done3 = false;
  tw3.finish(() => { done3 = true; });
  if (instant !== 'Hello world' || !done3) throw new Error('Reduce motion should show text as it arrives');

  console.log('  v Agent run UI tests passed.');
}
