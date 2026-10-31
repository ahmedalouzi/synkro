import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDirExclusive, createFileExclusive, renameNoReplace } from '../../../apps/desktop/src/main/services/safe-fs';

async function rejects(fn: () => Promise<unknown>, pattern: RegExp, label: string) {
  try {
    await fn();
  } catch (err) {
    if (!pattern.test((err as Error).message)) throw new Error(`${label}: wrong error: ${(err as Error).message}`);
    return;
  }
  throw new Error(`${label}: did not refuse`);
}

/** Explorer file operations never replace an existing file or folder (New File emptied HomeScreen.tsx). */
export default async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-fs-'));
  try {
    const home = path.join(dir, 'src', 'screens', 'HomeScreen.tsx');
    const login = path.join(dir, 'src', 'screens', 'LoginScreen.tsx');

    console.log('  [safe-fs] New File: creates a missing file (and its folders), refuses an existing one...');
    await createFileExclusive(home, 'export const HomeScreen = 1;\n');
    await rejects(() => createFileExclusive(home, ''), /"HomeScreen\.tsx" already exists/, 'New File over a file');
    if (fs.readFileSync(home, 'utf8') !== 'export const HomeScreen = 1;\n') throw new Error('Existing file was changed');
    await rejects(() => createFileExclusive(path.join(dir, 'src'), ''), /already exists/, 'New File over a folder');

    console.log('  [safe-fs] New Folder: refuses an existing name...');
    await createDirExclusive(path.join(dir, 'src', 'components'));
    await rejects(() => createDirExclusive(path.join(dir, 'src', 'components')), /already exists/, 'New Folder over a folder');
    await rejects(() => createDirExclusive(home), /already exists/, 'New Folder over a file');

    console.log('  [safe-fs] Rename: refuses an existing target, keeps both files, allows a case-only rename...');
    fs.writeFileSync(login, 'export const LoginScreen = 2;\n');
    await rejects(() => renameNoReplace(login, home), /"HomeScreen\.tsx" already exists/, 'Rename onto a file');
    if (fs.readFileSync(home, 'utf8') !== 'export const HomeScreen = 1;\n' || !fs.existsSync(login)) {
      throw new Error('Refused rename still changed a file');
    }
    await renameNoReplace(login, path.join(dir, 'src', 'screens', 'SignInScreen.tsx'));
    if (fs.existsSync(login)) throw new Error('Rename did not move the file');
    const signIn = path.join(dir, 'src', 'screens', 'SignInScreen.tsx');
    await renameNoReplace(signIn, path.join(dir, 'src', 'screens', 'signinscreen.tsx')); // same file, other case
    await rejects(() => renameNoReplace(path.join(dir, 'missing.tsx'), path.join(dir, 'x.tsx')), /no longer exists/, 'Rename a missing file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('  v Safe file operation tests passed.');
}
