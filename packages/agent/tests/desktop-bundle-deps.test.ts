import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The desktop's main and preload bundles must never pull in server code. electron-vite bundles the workspace
 * packages (@peep/*) into apps/desktop/out/main, and their own dependencies (pg, the server's Sentry SDK) are not
 * desktop dependencies, so a module with side effects that imports them ends up in the app: `pnpm dev` then dies
 * with "Could not resolve pg-native imported by pg" (#26 added the credit ledger to @peep/agent's main entry).
 *
 * This walks the real import graph (value imports and re-exports; `import type` is erased) from the desktop's entry
 * files, following relative paths and the @peep/* package entries, and fails with the import chain when it reaches
 * a forbidden package. It needs no build, so CI catches it.
 */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');

const FORBIDDEN = /^(pg|pg-native|pg-pool|pg-protocol|@sentry\/node|@sentry\/profiling-node|express|multer)(\/|$)/;

const ENTRIES = ['apps/desktop/src/main/index.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/preload/inspector.ts'];

function workspaceEntry(spec: string): string | null {
  const m = /^@peep\/([^/]+)(?:\/(.+))?$/.exec(spec);
  if (!m) return null;
  const dir = path.join(root, 'packages', m[1]);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const sub = m[2] ? `./${m[2]}` : '.';
  const target = pkg.exports?.[sub] ?? (sub === '.' ? pkg.main : pkg.exports?.['./*'] ? `./${m[2]}` : null);
  if (!target) throw new Error(`${spec}: not exported by ${pkg.name}`);
  return resolveFile(path.join(dir, target));
}

function tryResolve(base: string): string | null {
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base.replace(/\.js$/, '.ts'), base]) {
    if (/\.(tsx?|m?js)$/.test(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function resolveFile(base: string): string {
  const file = tryResolve(base);
  if (!file) throw new Error(`cannot resolve ${base}`);
  return file;
}

/** The value imports of a file: `import x from`, `import {a} from`, `import 'x'`, `export * from`, `export {a} from`, import(), require(). */
export function valueImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const specs: string[] = [];
  const statement = /\b(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of code.matchAll(statement)) {
    if (m[4]) {
      if (m[2]) continue; // import type / export type
      // `import { type A, type B } from` is erased too when every name is a type.
      const names = /^\{([\s\S]*)\}$/.exec(m[3].trim())?.[1];
      if (names && names.split(',').map((n) => n.trim()).filter(Boolean).every((n) => n.startsWith('type '))) continue;
      specs.push(m[4]);
    } else {
      specs.push(m[5] ?? m[6] ?? m[7]);
    }
  }
  return specs;
}

export function forbiddenChains(entries: string[]): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  const visit = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    const rel = path.relative(root, file).replace(/\\/g, '/');
    for (const spec of valueImports(fs.readFileSync(file, 'utf8'))) {
      // A relative path that is not a module here (logo.png, './App' inside the code the brand module generates for
      // the user's app) is skipped: a real broken import fails typecheck anyway.
      if (spec.startsWith('.')) {
        const next = tryResolve(path.resolve(path.dirname(file), spec));
        if (next) visit(next, [...chain, rel]);
      }
      else if (spec.startsWith('@peep/')) visit(workspaceEntry(spec)!, [...chain, rel]);
      else if (FORBIDDEN.test(spec)) problems.push([...chain, rel, spec].join('\n    → '));
    }
  };
  for (const entry of entries) visit(path.join(root, entry), []);
  return problems;
}

export default async function runTest() {
  console.log('  [desktop-bundle] The parser: value imports and re-exports count, type-only imports do not...');
  assert.deepEqual(valueImports([
    "import { a } from './a';",
    "import type { B } from './b';",
    "import { type C, type D } from './c';",
    "import { type E, f } from './e';",
    "export * from './g';",
    "export type { H } from './h';",
    "export { i } from './i';",
    "import './side-effect';",
    "const m = await import('./lazy');",
    "// import { x } from './commented';",
  ].join('\n')), ['./a', './e', './g', './i', './side-effect', './lazy']);

  console.log('  [desktop-bundle] The desktop main and preload never reach pg, the server Sentry SDK or express...');
  const problems = forbiddenChains(ENTRIES);
  assert.deepEqual(problems, [], `server-only packages reached from the desktop:\n  ${problems.join('\n  ')}`);

  // The guard itself works: the server entry does reach pg.
  const serverChains = forbiddenChains(['packages/agent/src/server.ts']);
  assert.ok(serverChains.some((c) => c.endsWith('→ pg')), 'the walker finds pg from @peep/agent/server');

  console.log('  [desktop-bundle] The build checks its own output too...');
  const desktopPkg = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'));
  assert.match(desktopPkg.scripts.build, /electron-vite build && node scripts\/check-main-bundle\.mjs/);
  console.log('  🟢 Passed');
}
