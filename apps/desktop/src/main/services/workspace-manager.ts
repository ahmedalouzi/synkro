import { readdir, readFile, writeFile, mkdir, stat, rename, rm } from 'node:fs/promises';
import { basename, join, relative, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileEntry, ProjectInfo } from '@peep/shared';
import type { DatabaseService } from './db';
import { shell } from 'electron';
import { createDirExclusive, createFileExclusive, renameNoReplace } from './safe-fs';

const IGNORED = new Set(['.git', 'node_modules', '.dart_tool', 'build', '.peep', '.atomvs', 'dist', '.next', '.expo', 'Pods', '.idea', '.vscode', '.keep', '.gitkeep']);

type PlatformType = 'flutter' | 'react-native' | 'expo' | 'unknown';

async function detectPlatformRecursively(dir: string, depth = 0): Promise<{ platform: PlatformType; path: string }> {
  if (depth > 3) return { platform: 'unknown', path: dir };

  // 1. Check Flutter pubspec.yaml
  try {
    await stat(join(dir, 'pubspec.yaml'));
    return { platform: 'flutter', path: dir };
  } catch {}

  // 2. Check React Native / Expo in package.json
  try {
    const rawPkg = await readFile(join(dir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(rawPkg) as Record<string, any>;
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    if ('expo' in deps) {
      return { platform: 'expo', path: dir };
    } else if ('react-native' in deps) {
      return { platform: 'react-native', path: dir };
    }
  } catch {}

  // 3. Scan subdirectories
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const name = entry.name;
        if (name === 'node_modules' || name === '.git' || name === '.expo' || name === 'build' || name === 'dist' || name === '.peep' || name === '.atomvs' || name === '.next' || name === 'Pods' || name === '.idea' || name === '.vscode') {
          continue;
        }
        const subResult = await detectPlatformRecursively(join(dir, name), depth + 1);
        if (subResult.platform !== 'unknown') {
          return subResult;
        }
      }
    }
  } catch {}

  return { platform: 'unknown', path: dir };
}

export class WorkspaceManager {
  private project: ProjectInfo | null = null;

  constructor(private db: DatabaseService) {}

  getProject(): ProjectInfo | null {
    return this.project;
  }

  async openFolder(folderPath: string): Promise<ProjectInfo> {
    const { platform, path: resolvedPath } = await detectPlatformRecursively(folderPath);
    const normalizedPath = resolvedPath.replace(/\\/g, '/');

    const project: ProjectInfo = {
      id: randomUUID(),
      path: normalizedPath,
      name: basename(resolvedPath),
      lastOpened: new Date().toISOString(),
      platform,
    };

    await this.db.upsertProject(project);
    this.project = project;
    return project;
  }

  getRecentProjects(): ProjectInfo[] {
    return this.db.getRecentProjects();
  }

  async listDir(dirPath: string, depth = 0, maxDepth = 3): Promise<FileEntry[]> {
    if (depth > maxDepth) return [];

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const promises = entries.map(async (entry) => {
        if (IGNORED.has(entry.name)) return null;

        const fullPath = join(dirPath, entry.name).replace(/\\/g, '/');
        const fileEntry: FileEntry = {
          name: entry.name,
          path: fullPath,
          type: entry.isDirectory() ? 'directory' : 'file',
        };

        if (entry.isDirectory()) {
          try {
            fileEntry.children = await this.listDir(fullPath, depth + 1, maxDepth);
          } catch {
            fileEntry.children = [];
          }
        }
        return fileEntry;
      });

      const resolved = await Promise.all(promises);
      const result = resolved.filter((entry): entry is FileEntry => entry !== null);

      return result.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch (err) {
      if (depth === 0) {
        throw err;
      }
      return [];
    }
  }

  async readFile(filePath: string): Promise<string> {
    return readFile(filePath, 'utf-8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });
    return writeFile(filePath, content, 'utf-8');
  }

  async atomicWriteFile(filePath: string, content: string): Promise<void> {
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });
    
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, content, 'utf-8');
      await rename(tempPath, filePath);
    } catch (err) {
      try {
        await rm(tempPath, { force: true });
      } catch {}
      throw err;
    }
  }

  async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
    await mkdir(dirPath, options);
  }

  /** `failIfExists`: a new folder from the Explorer, which must not reuse an existing one. */
  async createDir(dirPath: string, failIfExists = false): Promise<void> {
    if (failIfExists) return createDirExclusive(dirPath);
    await mkdir(dirPath, { recursive: true });
  }

  /** A new file: never replaces an existing one (writeFile is for saving files that are open). */
  async createFile(filePath: string, content = ''): Promise<void> {
    return createFileExclusive(filePath, content);
  }

  async renameItem(oldPath: string, newPath: string): Promise<void> {
    return renameNoReplace(oldPath, newPath);
  }

  async deleteItem(path: string): Promise<void> {
    try {
      await shell.trashItem(path);
    } catch {
      await rm(path, { recursive: true, force: true });
    }
  }

  async revealItem(path: string): Promise<void> {
    shell.showItemInFolder(path);
  }

  async ensurePeepDir(): Promise<string | null> {
    if (!this.project) return null;
    const peepDir = join(this.project.path, '.peep');
    await mkdir(peepDir, { recursive: true });
    return peepDir;
  }

  relativePath(filePath: string): string {
    if (!this.project) return filePath;
    return relative(this.project.path, filePath);
  }

  async fileExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
