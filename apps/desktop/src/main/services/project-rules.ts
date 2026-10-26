import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Project rules: standing instructions for the AI, read from every common format so
 * projects coming from other tools keep working:
 *   .synkro/rules.md, .synkro/rules/*.md   (Synkro)
 *   .cursorrules, .cursor/rules/*.mdc     (Cursor — honors alwaysApply / globs)
 *   AGENTS.md                              (open standard)
 */

const MAX_RULES_CHARS = 20_000;

interface RuleFile {
  source: string;
  body: string;
}

/** Minimal glob → RegExp (`**`, `*`, `?`, `{a,b}`), matched against a project-relative path. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += /[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}

/** Parses Cursor .mdc frontmatter; returns null when the rule doesn't apply to this request. */
export function applicableMdcBody(content: string, activeRelPath: string | null): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return content;
  const meta = match[1];
  const body = content.slice(match[0].length);
  if (/^alwaysApply:\s*true\s*$/m.test(meta)) return body;
  const globsLine = /^globs:\s*(.+)$/m.exec(meta)?.[1]?.trim();
  if (globsLine && activeRelPath) {
    const globs = globsLine.replace(/^\[|\]$/g, '').split(',').map((g) => g.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    if (globs.some((g) => globToRegExp(g).test(activeRelPath) || globToRegExp(`**/${g}`).test(activeRelPath))) return body;
  }
  // "Agent requested" / manual rules are not injected automatically.
  return null;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function listFiles(dir: string, ext: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(ext)).map((e) => join(dir, e.name)).sort();
  } catch {
    return [];
  }
}

export async function loadProjectRules(projectPath: string, activeFilePath?: string): Promise<string> {
  const activeRel = activeFilePath ? relative(projectPath, activeFilePath).replace(/\\/g, '/') : null;
  const rules: RuleFile[] = [];
  const add = (source: string, body: string | null) => {
    if (body && body.trim()) rules.push({ source, body: body.trim() });
  };

  add('.synkro/rules.md', await readIfExists(join(projectPath, '.synkro', 'rules.md')));
  for (const file of await listFiles(join(projectPath, '.synkro', 'rules'), '.md')) {
    add(relative(projectPath, file).replace(/\\/g, '/'), await readIfExists(file));
  }
  add('.cursorrules', await readIfExists(join(projectPath, '.cursorrules')));
  for (const file of await listFiles(join(projectPath, '.cursor', 'rules'), '.mdc')) {
    const content = await readIfExists(file);
    add(relative(projectPath, file).replace(/\\/g, '/'), content && applicableMdcBody(content, activeRel));
  }
  add('AGENTS.md', await readIfExists(join(projectPath, 'AGENTS.md')));

  if (rules.length === 0) return '';
  let text = rules.map((r) => `### ${r.source}\n${r.body}`).join('\n\n');
  if (text.length > MAX_RULES_CHARS) text = `${text.slice(0, MAX_RULES_CHARS)}\n… [rules truncated]`;
  return `\n\n[PROJECT RULES — instructions from the project's maintainers; follow them]\n${text}\n`;
}
