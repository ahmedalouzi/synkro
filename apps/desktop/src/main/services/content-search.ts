import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const IGNORED = new Set(['.git', 'node_modules', '.dart_tool', 'build', '.peep', '.atomvs', 'dist', '.next', '.expo', 'ios', 'android', 'coverage', '__pycache__', '.venv']);
const TEXT_EXTENSIONS = new Set([
  '.dart', '.yaml', '.yml', '.json', '.md', '.txt', '.html', '.css', '.xml',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.swift', '.kt', '.java', '.sh', '.env',
  '.toml', '.ini', '.conf', '.gradle', '.rs', '.go', '.rb', '.php', '.vue', '.svelte',
]);

export interface ContentMatch {
  file: string;
  line: number;
  col: number;
  text: string;
}

export interface SearchContentOptions {
  projectPath: string;
  query: string;
  caseSensitive?: boolean;
  isRegex?: boolean;
  maxResults?: number;
}

export async function searchContent(
  rootPath: string,
  query: string,
  maxResults?: number,
): Promise<ContentMatch[]>;
export async function searchContent(
  opts: SearchContentOptions,
): Promise<ContentMatch[]>;
export async function searchContent(
  rootPathOrOpts: string | SearchContentOptions,
  queryArg?: string,
  maxResultsArg = 200,
): Promise<ContentMatch[]> {
  let rootPath: string;
  let query: string;
  let caseSensitive = false;
  let isRegex = false;
  let maxResults = maxResultsArg;

  if (typeof rootPathOrOpts === 'string') {
    rootPath = rootPathOrOpts;
    query = queryArg ?? '';
  } else {
    rootPath = rootPathOrOpts.projectPath;
    query = rootPathOrOpts.query;
    caseSensitive = rootPathOrOpts.caseSensitive ?? false;
    isRegex = rootPathOrOpts.isRegex ?? false;
    maxResults = rootPathOrOpts.maxResults ?? 200;
  }

  if (!query.trim()) return [];

  let regex: RegExp;
  try {
    const pattern = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = caseSensitive ? 'g' : 'gi';
    regex = new RegExp(pattern, flags);
  } catch {
    return [];
  }

  const results: ContentMatch[] = [];

  async function walk(dirPath: string): Promise<void> {
    if (results.length >= maxResults) return;

    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (IGNORED.has(entry.name)) continue;

      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      const ext = extname(entry.name).toLowerCase();
      const isAllowed = TEXT_EXTENSIONS.has(ext) 
        || entry.name.startsWith('.env') 
        || entry.name === 'Dockerfile' 
        || entry.name.startsWith('.git');
      if (!isAllowed) continue;

      let content: string;
      try {
        content = await readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= maxResults) break;
        const match = regex.exec(lines[i]);
        if (match) {
          results.push({
            file: fullPath,
            line: i + 1,
            col: match.index + 1,
            text: lines[i].trim(),
          });
          regex.lastIndex = 0; // reset for non-global flags
        }
      }
    }
  }

  await walk(rootPath);
  return results;
}
