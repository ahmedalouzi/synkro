/** Electron main for review-changes.test.ts: measures the real DiffViewer's cards; optional screenshot (SHOT_FILE). */
import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.env.HARNESS_DIR!;
const result: Record<string, unknown> = {};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: false, contextIsolation: true } });
  try {
    for (const files of [3, 15, 40]) {
      await win.loadFile(join(out, 'index.html'), { query: { files: String(files) } });
      for (let i = 0; i < 100 && !(await win.webContents.executeJavaScript('window.__harnessReady === true')); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 200));
      result[files] = await win.webContents.executeJavaScript(`(() => {
        const cards = [...document.querySelectorAll('.diff-card')];
        const list = document.querySelector('.diff-viewer__list');
        return {
          cards: cards.length,
          heights: cards.map((c) => Math.round(c.getBoundingClientRect().height)),
          headerVisible: cards.map((c) => { const h = c.querySelector('.diff-card__header'); return h.getBoundingClientRect().height <= c.getBoundingClientRect().height; }),
          patchShown: cards.map((c) => Math.round(c.querySelector('.diff-card__patch').getBoundingClientRect().height)),
          listScrolls: list.scrollHeight > list.clientHeight,
        };
      })()`);
      if (files === 15 && process.env.SHOT_FILE) writeFileSync(process.env.SHOT_FILE, (await win.webContents.capturePage()).toPNG());
    }
  } catch (err) {
    result.error = String(err);
  }
  writeFileSync(process.env.RESULT_FILE!, JSON.stringify(result));
  app.exit(0);
});
