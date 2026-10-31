import { FrameworkProvider } from './providers/base-provider';

export interface PlatformDetectionResult {
  provider: FrameworkProvider | null;
  projectRoot: string;
}

import { join } from 'node:path';

import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export class PlatformRegistry {
  private providers: FrameworkProvider[] = [];

  register(provider: FrameworkProvider) {
    this.providers.push(provider);
  }

  getProviders(): FrameworkProvider[] {
    return this.providers;
  }

  getProvider(id: string): FrameworkProvider {
    const provider = this.providers.find(p => p.id === id);
    if (!provider) throw new Error(`Provider not found: ${id}`);
    return provider;
  }

  async detect(root: string, options: { requireProject?: boolean; timeoutMs?: number } = {}): Promise<PlatformDetectionResult> {
    console.log(`[DEBUG_RUNTIME] PlatformRegistry.detect called with root: ${root} options:`, options);

    const timeoutMs = options.timeoutMs || 0;
    const startTime = Date.now();

    while (true) {
      const foundProjects: { provider: FrameworkProvider; projectRoot: string; depth: number }[] = [];

      // Helper to deeply scan for projects up to a given depth
      const scanForProject = async (currentPath: string, currentDepth: number, maxDepth: number): Promise<void> => {
        if (currentDepth > maxDepth) return;
        
        // Check current directory
        for (const provider of this.providers) {
          if (await provider.detect(currentPath)) {
            console.log(`[DEBUG_RUNTIME] Provider ${provider.id} detected project at: ${currentPath} (depth: ${currentDepth})`);
            foundProjects.push({ provider, projectRoot: currentPath, depth: currentDepth });
            break; // Stop checking other providers for this directory
          }
        }

        // Scan subdirectories
        try {
          if (existsSync(currentPath)) {
            const files = await readdir(currentPath, { withFileTypes: true });
            for (const file of files) {
              if (file.isDirectory() && file.name !== '.git' && file.name !== '.peep' && file.name !== '.atomvs' && file.name !== 'node_modules') {
                const subPath = join(currentPath, file.name);
                await scanForProject(subPath, currentDepth + 1, maxDepth);
              }
            }
          }
        } catch (err) {
          console.log(`[DEBUG_RUNTIME] Error scanning ${currentPath}:`, err);
        }
      };

      // 1. Try to find any valid project up to depth 3
      await scanForProject(root, 0, 3);
      
      if (foundProjects.length > 0) {
        // Sort by depth descending, so nested projects take precedence over the root
        foundProjects.sort((a, b) => b.depth - a.depth);
        const selected = foundProjects[0];
        console.log(`[DEBUG_RUNTIME] Selected project at depth ${selected.depth}: ${selected.projectRoot}`);
        return { provider: selected.provider, projectRoot: selected.projectRoot };
      }

      if (Date.now() - startTime >= timeoutMs) {
        break;
      }
      
      // Poll every 1000ms if not found yet
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log(`[DEBUG_RUNTIME] No project detected within depth 3. Proceeding to fallback.`);

    // If requireProject is strict, do NOT fall back to empty workspace logic
    if (options.requireProject) {
      return { provider: null, projectRoot: root };
    }

    // 3. Empty workspace fallback
    try {
      if (existsSync(root)) {
        const files = await readdir(root);
        const filtered = files.filter(f => f !== '.git' && f !== '.peep' && f !== '.atomvs' && f !== '.DS_Store');
        if (filtered.length === 0) {
          const managed = this.providers.find(p => p.id === 'react-native-managed');
          if (managed) return { provider: managed, projectRoot: root };
        }
      }
    } catch {
      // Ignore
    }

    return { provider: null, projectRoot: root };
  }
}
