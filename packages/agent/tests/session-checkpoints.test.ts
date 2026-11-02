import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CheckpointService, CHECKPOINT_LIMITS } from '../../../apps/desktop/src/main/services/checkpoint-service';

/** Agent checkpoints are saved in the project and still restore after Atomvs restarts. */
export default async function run() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoints-'));
  const file = (rel: string) => path.join(project, rel);
  const dir = path.join(project, '.atomvs', 'checkpoints');
  try {
    fs.mkdirSync(file('src/screens'), { recursive: true });
    fs.writeFileSync(file('src/screens/HomeScreen.tsx'), 'original home');

    console.log('  [checkpoints] Saved to .atomvs/checkpoints, ignored by git...');
    const first = new CheckpointService(() => {});
    first.begin('msg-1', project);
    await first.capture(file('src/screens/HomeScreen.tsx'));
    await first.capture(file('src/screens/NewScreen.tsx')); // did not exist
    first.end();
    fs.writeFileSync(file('src/screens/HomeScreen.tsx'), 'agent rewrote home');
    fs.writeFileSync(file('src/screens/NewScreen.tsx'), 'agent added this');
    if (fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length !== 1) throw new Error('Checkpoint not written to disk');
    if (!/^\*$/m.test(fs.readFileSync(path.join(project, '.atomvs', '.gitignore'), 'utf8'))) throw new Error('.atomvs is not git-ignored');
    const stored = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((n) => n.endsWith('.json'))!), 'utf8');
    if (stored.includes(project.replace(/\\/g, '\\\\'))) throw new Error('Absolute paths stored (should be relative to the project)');

    console.log('  [checkpoints] After a restart: listed and restored from disk...');
    const counts: Record<string, number> = {};
    const second = new CheckpointService((id, n) => { counts[id] = n; });
    const list = await second.list(project);
    if (list.length !== 1 || list[0].id !== 'msg-1' || list[0].fileCount !== 2) throw new Error(`list: ${JSON.stringify(list)}`);
    const restored = await second.restore('msg-1');
    if (restored.length !== 2) throw new Error(`restored ${restored.length} files`);
    if (fs.readFileSync(file('src/screens/HomeScreen.tsx'), 'utf8') !== 'original home') throw new Error('File not restored');
    if (fs.existsSync(file('src/screens/NewScreen.tsx'))) throw new Error('A file the agent created was not removed');
    if (fs.readdirSync(dir).some((n) => n.endsWith('.json'))) throw new Error('Restored checkpoint still on disk');
    if (counts['msg-1'] !== 0) throw new Error('UI not told the checkpoint is gone');

    console.log('  [checkpoints] A tampered checkpoint cannot write outside the project...');
    const outside = path.join(os.tmpdir(), `checkpoint-escape-${Date.now()}.txt`);
    fs.writeFileSync(path.join(dir, `${String(Date.now()).padStart(15, '0')}-evil.json`), JSON.stringify({
      version: 1, id: 'evil', createdAt: Date.now(),
      files: [{ path: path.relative(project, outside), content: 'pwned' }, { path: outside, content: 'pwned' }, { path: 'ok.txt', content: 'inside' }],
    }));
    const third = new CheckpointService(() => {});
    await third.list(project);
    await third.restore('evil');
    if (fs.existsSync(outside)) throw new Error('Checkpoint wrote outside the project');
    if (fs.readFileSync(file('ok.txt'), 'utf8') !== 'inside') throw new Error('In-project file not restored');

    console.log('  [checkpoints] Limits: count and age drop the oldest first...');
    const fourth = new CheckpointService(() => {});
    const old = Date.now() - CHECKPOINT_LIMITS.maxAgeMs - 1000;
    fs.writeFileSync(path.join(dir, `${String(old).padStart(15, '0')}-ancient.json`), JSON.stringify({ version: 1, id: 'ancient', createdAt: old, files: [{ path: 'a.txt', content: 'x' }] }));
    const listed = await fourth.list(project);
    if (listed.some((c) => c.id === 'ancient') || fs.readdirSync(dir).some((n) => n.includes('ancient'))) throw new Error('Expired checkpoint kept');
    for (let i = 0; i < CHECKPOINT_LIMITS.maxCount + 3; i++) {
      fourth.begin(`m${i}`, project);
      await fourth.capture(file(`f${i}.txt`));
      fourth.end();
    }
    const kept = (await fourth.list(project)).map((c) => c.id);
    if (kept.length !== CHECKPOINT_LIMITS.maxCount || kept.includes('m0') || !kept.includes(`m${CHECKPOINT_LIMITS.maxCount + 2}`)) {
      throw new Error(`count limit: kept ${kept.length}, first ${kept[0]}`);
    }
    let jsonCount = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      jsonCount = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length;
      if (jsonCount === CHECKPOINT_LIMITS.maxCount) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (jsonCount !== CHECKPOINT_LIMITS.maxCount) throw new Error(`Disk not pruned to the limit: expected ${CHECKPOINT_LIMITS.maxCount}, found ${jsonCount}`);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
  console.log('  v Checkpoint persistence tests passed.');
}
