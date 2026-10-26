import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileEntry } from '@peep/shared';

const IGNORED = new Set(['.git', 'node_modules', '.dart_tool', 'build', '.peep', '.idea', '.vscode']);

export async function searchFiles(rootPath: string, query: string, maxResults = 50, includeDirectories = false): Promise<FileEntry[]> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  const results: FileEntry[] = [];

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
        if (includeDirectories && entry.name.toLowerCase().includes(normalized)) {
          results.push({ name: entry.name, path: fullPath, type: 'directory' });
        }
        await walk(fullPath);
        continue;
      }

      if (entry.name.toLowerCase().includes(normalized)) {
        results.push({ name: entry.name, path: fullPath, type: 'file' });
      }
    }
  }

  await walk(rootPath);
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export async function collectAllFiles(rootPath: string, maxDepth = 6): Promise<FileEntry[]> {
  const results: FileEntry[] = [];

  async function walk(dirPath: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else {
        results.push({ name: entry.name, path: fullPath, type: 'file' });
      }
    }
  }

  await walk(rootPath, 0);
  return results;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
