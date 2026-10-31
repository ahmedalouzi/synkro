import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Agent checkpoints (Cursor's "Restore Checkpoint"): before the agent first touches a
 * file during a message, its original content is saved. Restoring a checkpoint rolls
 * back that message and every later one.
 *
 * Covers the agent's file tools (edit/patch/delete/rename). Changes made by shell
 * commands the agent runs (e.g. `flutter create`) are not tracked.
 *
 * Checkpoints are also written to the project, one JSON file per message in .atomvs/checkpoints/ (which
 * ignores itself in git), so a restore still works after Atomvs restarts. Oldest are dropped past the limits.
 */

interface FileSnapshot {
  path: string;
  /** null = the file did not exist before (restoring deletes it). */
  content: string | null;
}

interface Checkpoint {
  id: string;
  projectPath: string;
  createdAt: number;
  files: FileSnapshot[];
}

/** On disk: paths relative to the project. */
interface StoredCheckpoint {
  version: 1;
  id: string;
  createdAt: number;
  files: Array<{ path: string; content: string | null }>;
}

export const CHECKPOINT_LIMITS = {
  /** Per project. */
  maxCount: 100,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxTotalBytes: 50 * 1024 * 1024,
};

const DIR = join('.atomvs', 'checkpoints');
const ID = /^[\w-]{1,100}$/;

function checkpointDir(projectPath: string): string {
  return join(projectPath, DIR);
}

function fileName(cp: { createdAt: number; id: string }): string {
  return `${String(cp.createdAt).padStart(15, '0')}-${cp.id}.json`;
}

/** A path from a checkpoint file, only if it stays inside the project (the file could have been edited). */
function insideProject(projectPath: string, relPath: string): string | null {
  if (isAbsolute(relPath)) return null;
  const full = resolve(projectPath, relPath);
  const rel = relative(resolve(projectPath), full);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? full : null;
}

export class CheckpointService {
  private checkpoints: Checkpoint[] = [];
  private current: Checkpoint | null = null;
  /** Projects whose checkpoints were read from disk. */
  private loaded = new Set<string>();
  private writes = Promise.resolve();

  constructor(private onChange: (id: string, fileCount: number) => void) {}

  /** Starts recording for one agent message. */
  begin(id: string, projectPath: string): void {
    this.current = { id, projectPath, createdAt: Date.now(), files: [] };
    this.checkpoints.push(this.current);
  }

  end(): void {
    this.current = null;
  }

  /** Saves a file's original content the first time the agent is about to change it. */
  async capture(path: string): Promise<void> {
    const cp = this.current;
    if (!cp || cp.files.some((f) => f.path === path)) return;
    let content: string | null = null;
    try {
      content = await readFile(path, 'utf-8');
    } catch {
      content = null;
    }
    // Re-check: another capture may have run while reading.
    if (cp.files.some((f) => f.path === path)) return;
    cp.files.push({ path, content });
    this.onChange(cp.id, cp.files.length);
    await this.persist(cp);
  }

  fileCount(id: string): number {
    return this.checkpoints.find((c) => c.id === id)?.files.length ?? 0;
  }

  /** The project's checkpoints (read from disk the first time), oldest first, for the chat's restore buttons. */
  async list(projectPath: string): Promise<Array<{ id: string; fileCount: number }>> {
    await this.load(projectPath);
    return this.checkpoints
      .filter((c) => c.projectPath === projectPath && c.files.length > 0)
      .map((c) => ({ id: c.id, fileCount: c.files.length }));
  }

  /** Restores files to their state before checkpoint `id`; returns the affected paths. */
  async restore(id: string): Promise<string[]> {
    const index = this.checkpoints.findIndex((c) => c.id === id);
    if (index < 0) throw new Error('Checkpoint not found (it may have been removed after 30 days or past the size limit).');
    if (this.current && this.checkpoints.indexOf(this.current) >= index) {
      throw new Error('Stop the agent before restoring a checkpoint.');
    }

    const { projectPath } = this.checkpoints[index];
    // Only this project's checkpoints from that point on (another open project's are untouched).
    const later = this.checkpoints.slice(index).filter((c) => c.projectPath === projectPath);
    const affected = new Set<string>();
    // Newest first, so each file ends at its oldest saved state.
    for (const cp of [...later].reverse()) {
      for (const file of [...cp.files].reverse()) {
        if (file.content === null) {
          await unlink(file.path).catch(() => undefined);
        } else {
          await mkdir(dirname(file.path), { recursive: true });
          await writeFile(file.path, file.content, 'utf-8');
        }
        affected.add(file.path);
      }
    }
    this.checkpoints = this.checkpoints.filter((c) => !later.includes(c));
    for (const cp of later) {
      this.onChange(cp.id, 0);
      await unlink(join(checkpointDir(projectPath), fileName(cp))).catch(() => undefined);
    }
    return [...affected];
  }

  /** Reads a project's saved checkpoints once, dropping what is past the limits. */
  private async load(projectPath: string): Promise<void> {
    if (this.loaded.has(projectPath)) return;
    this.loaded.add(projectPath);
    const dir = checkpointDir(projectPath);
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return; // none yet
    }
    const known = new Set(this.checkpoints.map((c) => c.id));
    const fromDisk: Checkpoint[] = [];
    for (const name of names) {
      try {
        const stored = JSON.parse(await readFile(join(dir, name), 'utf-8')) as StoredCheckpoint;
        if (stored.version !== 1 || !ID.test(stored.id) || !Number.isFinite(stored.createdAt) || !Array.isArray(stored.files)) continue;
        if (known.has(stored.id)) continue;
        const files: FileSnapshot[] = [];
        for (const f of stored.files) {
          const full = typeof f?.path === 'string' ? insideProject(projectPath, f.path) : null;
          if (full && (typeof f.content === 'string' || f.content === null)) files.push({ path: full, content: f.content });
        }
        fromDisk.push({ id: stored.id, projectPath, createdAt: stored.createdAt, files });
      } catch {
        // A damaged file: skip it.
      }
    }
    // Saved ones are older than anything recorded in this session.
    this.checkpoints = [...fromDisk, ...this.checkpoints];
    await this.prune(projectPath);
  }

  private persist(cp: Checkpoint): Promise<void> {
    // One write at a time, in order (captures can overlap).
    this.writes = this.writes.then(async () => {
      try {
        const dir = checkpointDir(cp.projectPath);
        await mkdir(dir, { recursive: true });
        await writeFile(join(cp.projectPath, '.atomvs', '.gitignore'), '# Atomvs local data (agent checkpoints)\n*\n', { flag: 'wx' })
          .catch(() => undefined);
        const stored: StoredCheckpoint = {
          version: 1,
          id: cp.id,
          createdAt: cp.createdAt,
          files: cp.files.map((f) => ({ path: relative(cp.projectPath, f.path), content: f.content })),
        };
        const target = join(dir, fileName(cp));
        const temp = `${target}.tmp`;
        await writeFile(temp, JSON.stringify(stored), 'utf-8');
        await rename(temp, target);
        await this.prune(cp.projectPath);
      } catch (err) {
        // The in-memory checkpoint still works for this session.
        console.warn('[checkpoints] could not save to disk:', (err as Error).message);
      }
    });
    return this.writes;
  }

  /** Drops the oldest of a project's checkpoints past the count, age and size limits (memory and disk). */
  private async prune(projectPath: string): Promise<void> {
    const dir = checkpointDir(projectPath);
    const mine = this.checkpoints.filter((c) => c.projectPath === projectPath);
    const sizes = new Map<Checkpoint, number>();
    for (const cp of mine) {
      sizes.set(cp, await stat(join(dir, fileName(cp))).then((s) => s.size, () => 0));
    }
    const now = Date.now();
    let total = [...sizes.values()].reduce((a, b) => a + b, 0);
    const drop: Checkpoint[] = [];
    for (const cp of mine) {
      if (cp === this.current) break; // never the one being recorded
      const remaining = mine.length - drop.length;
      if (remaining > CHECKPOINT_LIMITS.maxCount || now - cp.createdAt > CHECKPOINT_LIMITS.maxAgeMs || total > CHECKPOINT_LIMITS.maxTotalBytes) {
        drop.push(cp);
        total -= sizes.get(cp) ?? 0;
      } else {
        break; // oldest first: the rest are newer and within limits
      }
    }
    if (drop.length === 0) return;
    this.checkpoints = this.checkpoints.filter((c) => !drop.includes(c));
    for (const cp of drop) {
      this.onChange(cp.id, 0);
      await unlink(join(dir, fileName(cp))).catch(() => undefined);
    }
  }
}
