import { app } from 'electron';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The app was renamed Peep → Synkro, which moves Electron's userData folder.
 * On first launch the old folder is moved over so settings, recent projects and
 * encrypted secrets survive. The whole folder moves because the key that decrypts
 * the stored secrets lives in its "Local State" file.
 *
 * Imported first in main/index.ts so it runs before anything touches userData.
 */

const STORE = 'peep-store.json';
/** Files that carry the user's data; caches are left behind. "Local State" must travel with the store. */
const ESSENTIALS = ['Local State', STORE, 'extensions', 'Local Storage', 'telemetry'];
const IMPORT_MARKER = '.legacy-projects-imported';

interface StoreFile {
  projects?: Array<{ path: string }>;
  [key: string]: unknown;
}

function copyEssentials(legacy: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const name of ESSENTIALS) {
    const from = join(legacy, name);
    if (!existsSync(from)) continue;
    try {
      cpSync(from, join(target, name), { recursive: true, force: true });
    } catch (err) {
      console.error(`[migrate-user-data] Could not copy ${name}:`, err);
    }
  }
}

/**
 * The new folder already exists (an earlier move failed, e.g. because the old app was
 * still running), so only recent projects are brought over — once, keeping the
 * current settings and sign-in untouched.
 */
function importLegacyProjects(legacy: string, target: string): void {
  const marker = join(target, IMPORT_MARKER);
  const legacyStore = join(legacy, STORE);
  const targetStore = join(target, STORE);
  if (existsSync(marker) || !existsSync(legacyStore) || !existsSync(targetStore)) return;
  try {
    const old = JSON.parse(readFileSync(legacyStore, 'utf8')) as StoreFile;
    const current = JSON.parse(readFileSync(targetStore, 'utf8')) as StoreFile;
    const known = new Set((current.projects ?? []).map((p) => p.path));
    const missing = (old.projects ?? []).filter((p) => p?.path && !known.has(p.path));
    if (missing.length > 0) {
      current.projects = [...(current.projects ?? []), ...missing];
      writeFileSync(targetStore, JSON.stringify(current, null, 2), 'utf-8');
      console.log(`[migrate-user-data] Imported ${missing.length} recent project(s) from ${legacy}`);
    }
    writeFileSync(marker, new Date().toISOString());
  } catch (err) {
    console.error('[migrate-user-data] Could not import legacy projects:', err);
  }
}

function migrateUserData(): void {
  const target = app.getPath('userData');
  const appData = app.getPath('appData');
  const legacy = [join(appData, 'Peep'), join(appData, '@peep', 'desktop')].find((dir) => existsSync(dir));
  if (!legacy || legacy === target) return;

  if (existsSync(target)) {
    importLegacyProjects(legacy, target);
    return;
  }

  try {
    renameSync(legacy, target);
    console.log(`[migrate-user-data] Moved ${legacy} → ${target}`);
  } catch (err) {
    // Usually a file still held open by another process; copy what matters instead.
    console.error('[migrate-user-data] Could not move legacy user data, copying it instead:', err);
    copyEssentials(legacy, target);
    writeFileSync(join(target, IMPORT_MARKER), new Date().toISOString());
  }
}

migrateUserData();
