/** Electron main for chat-design.test.ts: renders the real AgentRun and reads what the user would see. */
import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.env.HARNESS_DIR!;
app.whenReady().then(async () => {
  const result: Record<string, unknown> = {};
  const win = new BrowserWindow({ show: false, width: 500, height: 900, webPreferences: { sandbox: false, contextIsolation: true } });
  const js = <T>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  try {
    await win.loadFile(join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await js<boolean>('window.__harnessReady === true')); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    Object.assign(result, await js(`(() => {
      const q = (s) => [...document.querySelectorAll(s)];
      return {
        thought: document.querySelector('.ar-thought')?.textContent,
        plan: document.querySelector('.ar-plan')?.textContent,
        steps: q('.ar-step').map((s) => s.textContent),
        fileCards: q('.ar-files').length,
        perFileCards: q('.ar-edit').length,
        filesHead: document.querySelector('.ar-files__head')?.textContent,
        rowsClosed: q('.ar-files__row').length,
        buttons: q('.ar-files .ar-edit__actions button').map((b) => b.textContent),
        approvalCards: q('.cx-approval').length,
      };
    })()`));
    await js(`document.querySelector('.ar-files__head').click(), true`);
    await new Promise((r) => setTimeout(r, 100));
    result.rowsOpen = await js(`document.querySelectorAll('.ar-files__row').length`);
    await js(`[...document.querySelectorAll('.ar-files .ar-edit__actions button')].forEach((b) => b.click()), true`);
    result.calls = await js('window.__calls');
  } catch (err) {
    result.error = String(err);
  }
  writeFileSync(process.env.RESULT_FILE!, JSON.stringify(result));
  app.exit(0);
});
