import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_TEMPLATES } from '@peep/flutter-adapter';
import { createManagedFlutterProject } from './providers/flutter-managed';
import type { CreateProjectOptions, ProjectTemplateInfo } from '@peep/shared';
import type { PlatformRegistry } from './platform-registry';
import type { WorkspaceManager } from './workspace-manager';

export function sanitizeProjectName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

export function isValidProjectName(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(name);
}

export class ProjectService {
  constructor(
    private registry: PlatformRegistry,
    _workspace: WorkspaceManager,
  ) {}

  listTemplates(): ProjectTemplateInfo[] {
    return PROJECT_TEMPLATES.map(({ id, name, description }) => ({ id, name, description }));
  }

  async createFromTemplate(options: CreateProjectOptions): Promise<string> {
    const name = sanitizeProjectName(options.name);
    if (!isValidProjectName(name)) {
      throw new Error('Project name must start with a letter and contain only lowercase letters, numbers, and underscores.');
    }

    const projectPath = join(options.parentPath, name);
    if (existsSync(projectPath)) {
      throw new Error(`Folder already exists: ${projectPath}`);
    }

    const mode = options.mode || 'beginner';
    const framework = options.framework || 'react-native';
    try {
      if (mode === 'advanced') {
        const provider = this.registry.getProvider(framework === 'flutter' ? 'flutter-local' : 'react-native-local');
        return await provider.createProject(name, options.parentPath, options.templateId);
      }
      // Managed: no local SDK. Flutter projects are written directly; React Native ones are Expo projects.
      if (framework === 'flutter') {
        return await createManagedFlutterProject(name, options.parentPath, options.templateId);
      }
      return await this.registry.getProvider('react-native-managed').createProject(name, options.parentPath, options.templateId);
    } catch (err) {
      // The folder did not exist before this call: remove what was half-created so the next try can use the name.
      // On Windows a file can still be locked for a moment (a package manager exiting, an antivirus scan), so retry.
      const removed = await rm(projectPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
        .then(() => true, () => false);
      if (!removed && err instanceof Error) {
        err.message += `\nThe half-created folder could not be removed: ${projectPath}. Delete it before trying again.`;
      }
      throw err;
    }
  }
}
