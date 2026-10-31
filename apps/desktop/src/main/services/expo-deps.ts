import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** An Expo project: `expo` among its dependencies. */
export async function isExpoProject(projectRoot: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf-8'));
    return Boolean(pkg.dependencies?.expo || pkg.devDependencies?.expo);
  } catch {
    return false;
  }
}

// One plain command: no chaining, pipes, redirects or substitutions (those are left as they are).
const SIMPLE = /^[^&|;<>`$()]+$/;
const ADD = /^\s*(?:npm\s+(?:install|i|add)|yarn\s+add|pnpm\s+(?:add|install|i)|bun\s+add)\s+(.+)$/i;
const DEV_FLAG = /^(-D|--save-dev|--dev)$/;
const HARMLESS_FLAG = /^(-S|--save|-E|--save-exact)$/;

/**
 * `npm install <pkg>` (or yarn/pnpm/bun add) in an Expo project, as `npx expo install <pkg>`: npm picks the
 * latest version, which often needs a newer Expo SDK (expo-font 58 on SDK 51 crashed the app with
 * "registerWebModule is not a function"); expo install picks the version that matches the project's SDK.
 * Null when there is nothing to rewrite: no package named, a global install, other flags, or a compound command.
 * Exported for tests.
 */
export function toExpoInstall(command: string): string | null {
  if (!SIMPLE.test(command)) return null;
  const match = ADD.exec(command);
  if (!match) return null;
  const tokens = match[1].trim().split(/\s+/);
  const packages = tokens.filter((t) => !t.startsWith('-'));
  const flags = tokens.filter((t) => t.startsWith('-'));
  if (packages.length === 0 || flags.some((f) => !DEV_FLAG.test(f) && !HARMLESS_FLAG.test(f))) return null;
  // Package names only (scoped, with an optional version that expo install then replaces).
  if (!packages.every((p) => /^(@[\w.-]+\/)?[\w.-]+(@[\w.^~<>=*-]+)?$/.test(p))) return null;
  const names = packages.map((p) => p.replace(/(?<=.)@.*$/, ''));
  return `npx expo install ${names.join(' ')}${flags.some((f) => DEV_FLAG.test(f)) ? ' -- --save-dev' : ''}`;
}

/** A command that adds, removes or installs packages (not expo's own --check / --fix). Exported for tests. */
export function changesDependencies(command: string): boolean {
  return /\b(npm|pnpm|yarn|bun)\s+(install|i|ci|add|remove|uninstall|rm)\b|\bexpo\s+install\b/i.test(command)
    && !/--check\b|--fix\b/.test(command);
}

/**
 * Why edits would not reach the web preview, or null. On the web, Fast Refresh comes from @expo/metro-runtime,
 * which only expo-router imports by itself; an app without the router must import it at the top of its entry.
 * (Projects Atomvs creates do; older ones and other templates may not.)
 */
export async function fastRefreshHint(projectRoot: string): Promise<string | null> {
  let pkg: { main?: string; dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
  if (pkg.dependencies?.['expo-router']) return null;
  const main = pkg.main && !/expo\/AppEntry/.test(pkg.main) ? pkg.main : null;
  let entry: string | null = null;
  for (const candidate of main ? [main, `${main}.js`, `${main}.ts`, `${main}.tsx`, `${main}.jsx`] : []) {
    try {
      entry = await readFile(join(projectRoot, candidate), 'utf-8');
      break;
    } catch { /* next */ }
  }
  if (entry !== null && /['"]@expo\/metro-runtime['"]/.test(entry)) return null;
  return `[atomvs] Fast Refresh is off in the web preview: the app's entry (${main ?? 'expo/AppEntry'}) does not import `
    + `'@expo/metro-runtime', so edits only show after a restart. Fix: make the entry index.js with `
    + `"import '@expo/metro-runtime';" as its first line, then registerRootComponent(App), and set "main": "index.js".`;
}

/** The command that checks an Expo project's dependencies against its SDK. */
export const EXPO_DEPS_CHECK = 'npx expo install --check';
