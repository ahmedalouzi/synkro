import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import simpleGit from 'simple-git';
import type { AgentMention, Diagnostic } from '@peep/shared';

/**
 * Turns `@` mentions from the chat into a context block appended to the user
 * message (like Cursor's attached context). Everything is size-capped so a
 * single mention can't blow the model's context window.
 */

const MAX_FILE_CHARS = 60_000;
const MAX_TOTAL_CHARS = 200_000;
const MAX_FOLDER_ENTRIES = 300;
const MAX_FOLDER_DEPTH = 4;
const IGNORED = new Set(['.git', 'node_modules', '.dart_tool', 'build', '.peep', '.idea', '.vscode', 'dist', 'out', '.expo']);

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]` : text;
}

/** Resolves a path and rejects anything outside the project (e.g. `../../secrets`). */
function insideProject(projectPath: string, target: string): string | null {
  const full = isAbsolute(target) ? target : join(projectPath, target);
  const rel = relative(projectPath, full);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return full;
}

const rel = (projectPath: string, p: string) => relative(projectPath, p).replace(/\\/g, '/') || '.';

async function describeFile(projectPath: string, path: string): Promise<string> {
  const full = insideProject(projectPath, path);
  if (!full) return `### @${path}\n(skipped: outside the project)`;
  try {
    const content = await readFile(full, 'utf-8');
    if (content.includes('\u0000')) return `### @${rel(projectPath, full)}\n(skipped: binary file)`;
    return `### @${rel(projectPath, full)}\n\`\`\`\n${truncate(content, MAX_FILE_CHARS)}\n\`\`\``;
  } catch (err) {
    return `### @${rel(projectPath, full)}\n(could not read: ${(err as Error).message})`;
  }
}

async function describeFolder(projectPath: string, path: string): Promise<string> {
  const root = insideProject(projectPath, path);
  if (!root) return `### @${path}/\n(skipped: outside the project)`;
  const lines: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_FOLDER_DEPTH || lines.length >= MAX_FOLDER_ENTRIES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (lines.length >= MAX_FOLDER_ENTRIES) {
        lines.push('  '.repeat(depth) + '…');
        return;
      }
      if (IGNORED.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        lines.push(`${'  '.repeat(depth)}${entry.name}/`);
        await walk(full, depth + 1);
      } else {
        const size = await stat(full).then((s) => s.size).catch(() => 0);
        lines.push(`${'  '.repeat(depth)}${entry.name} (${size} B)`);
      }
    }
  }

  await walk(root, 0);
  return `### @${rel(projectPath, root)}/\nFolder structure (use read_file for contents):\n\`\`\`\n${lines.join('\n') || '(empty)'}\n\`\`\``;
}

function describeProblems(projectPath: string, diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return '### @Problems\nNo problems reported.';
  const list = diagnostics
    .slice(0, 100)
    .map((d) => `- ${d.severity.toUpperCase()} ${rel(projectPath, d.file)}:${d.line}:${d.column ?? 1} ${d.message}`)
    .join('\n');
  return `### @Problems\n${list}`;
}

async function describeGitDiff(projectPath: string): Promise<string> {
  try {
    const git = simpleGit(projectPath);
    const [staged, unstaged] = await Promise.all([git.diff(['--cached']), git.diff()]);
    const diff = [staged && `# Staged\n${staged}`, unstaged && `# Unstaged\n${unstaged}`].filter(Boolean).join('\n');
    return `### @Git Diff (working tree)\n\`\`\`diff\n${truncate(diff || 'No changes.', MAX_FILE_CHARS)}\n\`\`\``;
  } catch (err) {
    return `### @Git Diff\n(unavailable: ${(err as Error).message})`;
  }
}

export async function resolveMentions(
  projectPath: string,
  mentions: AgentMention[],
  diagnostics: Diagnostic[] = [],
): Promise<string> {
  const sections: string[] = [];
  let total = 0;

  for (const mention of mentions) {
    let section: string;
    switch (mention.kind) {
      case 'file':
        section = await describeFile(projectPath, mention.path);
        break;
      case 'folder':
        section = await describeFolder(projectPath, mention.path);
        break;
      case 'code':
        section = `### @${rel(projectPath, mention.filePath)} (lines ${mention.startLine}-${mention.endLine})\n\`\`\`\n${truncate(mention.text, MAX_FILE_CHARS)}\n\`\`\``;
        break;
      case 'problems':
        section = describeProblems(projectPath, diagnostics);
        break;
      case 'terminal':
        section = `### @Terminal (recent output)\n\`\`\`\n${truncate(mention.text, MAX_FILE_CHARS)}\n\`\`\``;
        break;
      case 'gitDiff':
        section = await describeGitDiff(projectPath);
        break;
      default:
        continue;
    }
    if (total + section.length > MAX_TOTAL_CHARS) {
      sections.push(`(remaining attachments omitted: context limit of ${MAX_TOTAL_CHARS} characters reached)`);
      break;
    }
    total += section.length;
    sections.push(section);
  }

  if (sections.length === 0) return '';
  return `\n\n[ATTACHED CONTEXT — the user referenced these with @]\n${sections.join('\n\n')}`;
}
