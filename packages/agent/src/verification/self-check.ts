import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { escapedDartInterpolations, DART_PRICE_PATTERN, type ValidationResult } from '@peep/shared';

const TS_ERROR = /error TS\d+:/;
const ANALYZE_ERROR = /^\s*error\s*•/;

/**
 * The compile errors in a validate_project result, one line each: a check's own error list (flutter analyze), else
 * the tsc / analyzer error lines in its output, else (a failed check with nothing recognisable) its last lines.
 * Exported for tests.
 */
export function selfCheckErrors(result: ValidationResult): string[] {
  const errors: string[] = [];
  for (const check of result.checks ?? []) {
    if (check.success) continue;
    if (Array.isArray(check.errors) && check.errors.length && check.errors.every((e) => typeof e === 'string')) {
      errors.push(...(check.errors as string[]));
      continue;
    }
    const lines = `${check.stdout ?? ''}\n${check.stderr ?? ''}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const found = lines.filter((l) => TS_ERROR.test(l) || ANALYZE_ERROR.test(l));
    if (found.length) errors.push(...found);
    else if (lines.length) errors.push(`${check.type} failed: ${lines.slice(-8).join(' | ')}`.slice(0, 1200));
    else errors.push(`${check.type} failed (exit code ${check.exitCode ?? 'unknown'})`);
  }
  if (!result.success && errors.length === 0) errors.push(result.message || `${result.errorCategory}: the project check failed`);
  return [...new Set(errors)];
}

async function dartFiles(dir: string, out: string[] = [], limit = 600): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= limit) break;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await dartFiles(path, out, limit);
    else if (entry.name.endsWith('.dart')) out.push(path);
  }
  return out;
}

/**
 * Dart strings with `\${` under lib/ (the price shows as `${total.toStringAsFixed(2)}`): one error line each, like the
 * analyzer's. The analyzer accepts them, so the self-check adds them. Exported for tests.
 */
export async function dartStringIssues(projectRoot: string): Promise<string[]> {
  const issues: string[] = [];
  for (const file of await dartFiles(join(projectRoot, 'lib'))) {
    let source: string;
    try {
      source = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(projectRoot, file).replace(/\\/g, '/');
    for (const hit of escapedDartInterpolations(source)) {
      issues.push(`${rel}:${hit.line}: error: \`\\\${…}\` in a string shows the text literally, not the value. `
        + `Remove the backslash before \${ (a price with a dollar sign: ${DART_PRICE_PATTERN}). Line: ${hit.text}`);
    }
  }
  return issues;
}
