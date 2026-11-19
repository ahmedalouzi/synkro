/**
 * Electron main for approval-ipc.test.ts: the real ApprovalService and registerApprovalIpc, the real preload, and a
 * window that renders the real ApprovalCard. Drives it with real DOM events and writes what happened to RESULT_FILE.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalService, registerApprovalIpc } from '../../../../../apps/desktop/src/main/services/approval-service';

const out = process.env.HARNESS_DIR!;
const resultFile = process.env.RESULT_FILE!;
const results: Record<string, unknown> = {};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(out, 'preload.js'), sandbox: false, contextIsolation: true, nodeIntegration: false },
  });
  const approvals = new ApprovalService((channel, payload) => win.webContents.send(channel, payload));
  registerApprovalIpc(ipcMain, approvals);
  const js = <T>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const until = async (code: string, what: string) => {
    for (let i = 0; i < 100; i++) {
      if (await js<boolean>(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out: ${what}`);
  };
  const card = (subject: string) => `[...document.querySelectorAll('.cx-approval')].find((c) => c.querySelector('.cx-approval__subject').textContent === ${JSON.stringify(subject)})`;
  const shown = (subject: string) => until(`!!${card(subject)}`, `card for ${subject}`);
  const gone = (subject: string) => until(`!${card(subject)}`, `card for ${subject} to go`);
  const key = (subject: string, k: string) => js(`${card(subject)}.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true })), true`);

  try {
    await win.loadFile(join(out, 'index.html'));
    await until('window.__harnessReady === true', 'renderer ready');

    // 1. Allow once with Enter.
    const r1 = approvals.request({ kind: 'command', subject: 'gradlew assembleDebug', reason: 'Not on the list.', alwaysAllowKey: 'gradlew assembleDebug' });
    await shown('gradlew assembleDebug');
    results.focusedOnShow = await js(`document.activeElement === ${card('gradlew assembleDebug')}`);
    results.alwaysButtonText = await js(`${card('gradlew assembleDebug')}.querySelectorAll('button')[1].textContent`);
    await key('gradlew assembleDebug', 'Enter');
    results.r1 = await r1;
    await gone('gradlew assembleDebug');

    // 2. Always allow (a click on the real button).
    const r2 = approvals.request({ kind: 'command', subject: 'git checkout main', reason: 'r', alwaysAllowKey: 'git checkout' });
    await shown('git checkout main');
    await js(`[...${card('git checkout main')}.querySelectorAll('button')].find((b) => b.textContent.includes('Always allow')).click(), true`);
    results.r2 = await r2;

    // 3. Deleting a file: no "Always" button; Esc rejects.
    const r3 = approvals.request({ kind: 'delete-file', subject: 'lib/old_screen.dart', reason: 'unused', alwaysAllowKey: null, reversible: true });
    await shown('lib/old_screen.dart');
    results.deleteButtons = await js(`[...${card('lib/old_screen.dart')}.querySelectorAll('button')].map((b) => b.textContent)`);
    results.deleteText = await js(`${card('lib/old_screen.dart')}.textContent`);
    await key('lib/old_screen.dart', 'Escape');
    results.r3 = await r3;

    // 4. No answer: a new message / Stop (cancelAll) ends it, and the card goes away.
    const r4 = approvals.request({ kind: 'command', subject: 'python tool.py', reason: 'interpreter', alwaysAllowKey: null });
    await shown('python tool.py');
    approvals.cancelAll();
    results.r4 = await r4;
    await gone('python tool.py');

    // 5. A reloaded window shows the cards still waiting (getPendingApprovals), and they still work.
    const r5 = approvals.request({ kind: 'command', subject: 'adb install app.apk', reason: 'r', alwaysAllowKey: 'adb install' });
    await shown('adb install app.apk');
    win.webContents.reload();
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await until('window.__harnessReady === true', 'renderer ready after reload');
    await shown('adb install app.apk');
    await key('adb install app.apk', 'Enter');
    results.r5 = await r5;

    // 6. The window cannot answer what was not asked, nor "always" where it was not offered.
    const r6 = approvals.request({ kind: 'command', subject: 'node x.js', reason: 'r', alwaysAllowKey: null });
    await shown('node x.js');
    const id6 = approvals.pending()[0].id;
    results.forgedAlways = await js(`window.peep.respondApproval(${JSON.stringify(id6)}, 'always')`);
    results.unknownId = await js(`window.peep.respondApproval('nope', 'allow-once')`);
    results.stillPending = approvals.pending().length;
    await key('node x.js', 'Escape');
    results.r6 = await r6;
  } catch (err) {
    results.error = String(err);
  }
  writeFileSync(resultFile, JSON.stringify(results));
  app.exit(0);
});
