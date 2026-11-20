// Runs after `electron-vite build`: the main and preload bundles must not contain server-only code. pg (and its
// pg-native) is bundled when a module with side effects that imports it is reachable from the desktop through
// @peep/agent; `pnpm dev` then dies at startup with "Could not resolve pg-native imported by pg".
// The import-graph test (packages/agent/tests/desktop-bundle-deps.test.ts) catches the cause in CI; this checks the
// real output of every build, including the release builds.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = fileURLToPath(new URL('../out', import.meta.url));

// Text that only pg's own code contains (it is inlined, so there is no require("pg") to look for).
const MARKERS = [
  ['pg-native', 'pg (native bindings)'],
  ['Client has already been connected', 'pg'],
  ['pg-pool', 'pg-pool'],
  ['pg-connection-string', 'pg-connection-string'],
];

function jsFiles(dir) {
  let files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files = files.concat(jsFiles(path));
    else if (/\.(c|m)?js$/.test(name)) files.push(path);
  }
  return files;
}

const found = [];
for (const part of ['main', 'preload']) {
  let files;
  try {
    files = jsFiles(join(outDir, part));
  } catch {
    console.error(`[check-main-bundle] out/${part} is missing: run electron-vite build first.`);
    process.exit(1);
  }
  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    for (const [marker, what] of MARKERS) {
      if (code.includes(marker)) found.push(`${relative(outDir, file)}: ${what} ("${marker}")`);
    }
  }
}

if (found.length > 0) {
  console.error('[check-main-bundle] Server-only code is in the desktop bundle:');
  for (const line of found) console.error(`  ${line}`);
  console.error('Find the import chain with: pnpm test (desktop-bundle-deps). The desktop must not import server modules.');
  process.exit(1);
}
console.log('[check-main-bundle] OK: no pg / server-only code in out/main and out/preload.');
