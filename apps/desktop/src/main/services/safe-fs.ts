import { lstat, mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

/**
 * File operations for the Explorer that never replace what is already there. Node's writeFile and rename both
 * replace an existing file silently: New File "HomeScreen.tsx" next to an existing one emptied it, and renaming
 * another file to that name overwrote it.
 */

export class AlreadyExistsError extends Error {
  readonly code = 'EEXIST';
  constructor(path: string) {
    super(`"${basename(path)}" already exists in this folder. Choose a different name.`);
  }
}

async function statOrNull(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** A new file; fails if anything (file or folder) exists at the path. */
export async function createFileExclusive(filePath: string, content = ''): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  try {
    // 'wx': create, fail if it exists (atomic, no check-then-write race).
    await writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new AlreadyExistsError(filePath);
    throw err;
  }
}

/** A new folder; fails if anything exists at the path. */
export async function createDirExclusive(dirPath: string): Promise<void> {
  await mkdir(dirname(dirPath), { recursive: true });
  try {
    await mkdir(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new AlreadyExistsError(dirPath);
    throw err;
  }
}

/**
 * Renames, but never onto something else that exists. Renaming a file to the same name in a different case
 * ("home.tsx" to "Home.tsx" on Windows or macOS) finds the file itself at the target, and is allowed.
 */
export async function renameNoReplace(oldPath: string, newPath: string): Promise<void> {
  const [source, target] = await Promise.all([statOrNull(oldPath), statOrNull(newPath)]);
  if (!source) throw new Error(`"${basename(oldPath)}" no longer exists.`);
  if (target && !(target.ino === source.ino && target.dev === source.dev)) throw new AlreadyExistsError(newPath);
  await rename(oldPath, newPath);
}
