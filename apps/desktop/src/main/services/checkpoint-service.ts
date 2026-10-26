import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Agent checkpoints (Cursor's "Restore Checkpoint"): before the agent first touches a
 * file during a message, its original content is saved. Restoring a checkpoint rolls
 * back that message and every later one.
 *
 * Covers the agent's file tools (edit/patch/delete/rename). Changes made by shell
 * commands the agent runs (e.g. `flutter create`) are not tracked.
 */

interface FileSnapshot {
  path: string;
  /** null = the file did not exist before (restoring deletes it). */
  content: string | null;
}

interface Checkpoint {
  id: string;
  projectPath: string;
  files: FileSnapshot[];
}

const MAX_CHECKPOINTS = 100;

export class CheckpointService {
  private checkpoints: Checkpoint[] = [];
  private current: Checkpoint | null = null;

  constructor(private onChange: (id: string, fileCount: number) => void) {}

  /** Starts recording for one agent message. */
  begin(id: string, projectPath: string): void {
    this.current = { id, projectPath, files: [] };
    this.checkpoints.push(this.current);
    if (this.checkpoints.length > MAX_CHECKPOINTS) this.checkpoints.shift();
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
  }

  fileCount(id: string): number {
    return this.checkpoints.find((c) => c.id === id)?.files.length ?? 0;
  }

  /** Restores files to their state before checkpoint `id`; returns the affected paths. */
  async restore(id: string): Promise<string[]> {
    const index = this.checkpoints.findIndex((c) => c.id === id);
    if (index < 0) throw new Error('Checkpoint not found (checkpoints are kept for the current session).');
    if (this.current && this.checkpoints.indexOf(this.current) >= index) {
      throw new Error('Stop the agent before restoring a checkpoint.');
    }

    const affected = new Set<string>();
    // Newest first, so each file ends at its oldest saved state.
    for (const cp of this.checkpoints.slice(index).reverse()) {
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
    const removed = this.checkpoints.splice(index);
    for (const cp of removed) this.onChange(cp.id, 0);
    return [...affected];
  }
}
