import { FlutterAnalyzer } from './framework-analyzers/flutter';
import { ReactNativeAnalyzer } from './framework-analyzers/react-native';
import type { ProjectIndex, ProjectAnalyzer } from './types';
import { DependencyGraphBuilder, isSecretFile } from './dependency-graph';
import * as fs from 'fs/promises';
import { existsSync, statSync } from 'fs';
import * as path from 'path';

export class ProjectIndexer {
  private index: ProjectIndex;
  private projectPath: string;
  private indexPath: string;
  private graphPath: string;
  private analyzer: ProjectAnalyzer;
  private graphBuilder: DependencyGraphBuilder;

  constructor(projectPath: string, framework: 'flutter' | 'react-native' | 'unknown') {
    this.projectPath = projectPath;
    this.indexPath = path.join(projectPath, '.peep', 'project.json');
    this.graphPath = path.join(projectPath, '.peep', 'graph.json');
    this.index = this.getEmptyIndex(framework);
    this.analyzer = framework === 'flutter' ? new FlutterAnalyzer() : new ReactNativeAnalyzer();
    this.graphBuilder = new DependencyGraphBuilder(projectPath);
  }

  private getEmptyIndex(framework: 'flutter' | 'react-native' | 'unknown'): ProjectIndex {
    return {
      version: 1,
      framework,
      entryPoints: [],
      routes: [],
      screens: [],
      components: [],
      services: [],
      models: [],
      stateManagement: { type: 'unknown', files: [] },
      theme: { files: [] },
      dependencies: [],
      files: [],
      relationships: {},
      fileHashes: {},
      graph: {
        imports: {},
        exports: {},
        dependents: {},
        fileHashes: {},
        unresolved: {},
        lastIndexedAt: new Date().toISOString(),
      },
    };
  }

  async loadIndex(): Promise<boolean> {
    try {
      if (existsSync(this.indexPath)) {
        const data = await fs.readFile(this.indexPath, 'utf-8');
        this.index = JSON.parse(data);
        if (this.index.graph) {
          this.graphBuilder = new DependencyGraphBuilder(this.projectPath, this.index.graph);
        }
        return true;
      }
    } catch {}
    return false;
  }

  async saveIndex(): Promise<void> {
    try {
      const peepDir = path.dirname(this.indexPath);
      if (!existsSync(peepDir)) {
        await fs.mkdir(peepDir, { recursive: true });
      }
      this.index.graph = this.graphBuilder.getGraph();
      await fs.writeFile(this.indexPath, JSON.stringify(this.index, null, 2));
      await fs.writeFile(this.graphPath, JSON.stringify(this.index.graph, null, 2));
    } catch (e) {
      console.error('Failed to save Project Intelligence Index', e);
    }
  }

  getIndex(): ProjectIndex {
    this.index.graph = this.graphBuilder.getGraph();
    return this.index;
  }

  getDependencyGraphBuilder(): DependencyGraphBuilder {
    return this.graphBuilder;
  }

  async fullIndex(): Promise<void> {
    this.index = this.getEmptyIndex(this.index.framework);
    await this.incrementalIndex();
  }

  async incrementalIndex(): Promise<void> {
    if (!this.index.fileHashes) this.index.fileHashes = {};

    const targetDir = this.index.framework === 'flutter' ? path.join(this.projectPath, 'lib') : path.join(this.projectPath, 'src');
    const scanDir = existsSync(targetDir) ? targetDir : this.projectPath;
    
    const currentFiles = new Set<string>();
    await this.scanDirectoryIncremental(scanDir, currentFiles);
    
    // Remove deleted files
    const previousFiles = Object.keys(this.index.fileHashes);
    for (const file of previousFiles) {
      if (!currentFiles.has(file)) {
        await this.removeFile(path.join(this.projectPath, file));
      }
    }
    
    if (this.index.graph) {
      this.index.graph.lastIndexedAt = new Date().toISOString();
    }
    await this.saveIndex();
  }

  private async scanDirectoryIncremental(dir: string, currentFiles: Set<string>): Promise<void> {
    if (!existsSync(dir)) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['.git', 'node_modules', 'build', '.dart_tool', 'dist', '.peep', '.atomvs'].includes(entry.name)) {
          await this.scanDirectoryIncremental(fullPath, currentFiles);
        }
      } else {
        if (fullPath.endsWith('.dart') || fullPath.endsWith('.ts') || fullPath.endsWith('.tsx') || fullPath.endsWith('.js') || fullPath.endsWith('.jsx')) {
          const relPath = path.relative(this.projectPath, fullPath).replace(/\\/g, '/');
          currentFiles.add(relPath);
          await this.updateFileIncremental(fullPath, relPath);
        }
      }
    }
  }

  async updateFileIncremental(filePath: string, relPath?: string): Promise<void> {
    const relativePath = relPath || path.relative(this.projectPath, filePath).replace(/\\/g, '/');
    if (isSecretFile(relativePath)) return;

    try {
      const stat = statSync(filePath);
      const hash = `${stat.mtimeMs}-${stat.size}`;
      
      if (!this.index.fileHashes) this.index.fileHashes = {};
      if (this.index.fileHashes[relativePath] === hash) {
        return; // Unchanged
      }
      
      this.index.fileHashes[relativePath] = hash;
      const content = await fs.readFile(filePath, 'utf-8');
      
      const partial = this.analyzer.analyzeFile(relativePath, content);
      this.mergePartial(relativePath, partial);
      this.graphBuilder.updateFileGraph(filePath, content);
    } catch {}
  }

  async updateFile(filePath: string, autoSave = true): Promise<void> {
    await this.updateFileIncremental(filePath);
    if (autoSave) await this.saveIndex();
  }

  async removeFile(filePath: string): Promise<void> {
    const relFile = path.relative(this.projectPath, filePath).replace(/\\/g, '/');
    this.index.files = this.index.files.filter((f) => f !== relFile);
    this.index.entryPoints = this.index.entryPoints.filter((f) => f !== relFile);
    this.index.routes = this.index.routes.filter((r) => r.file !== relFile);
    this.index.screens = this.index.screens.filter((s) => s.file !== relFile);
    this.index.components = this.index.components.filter((c) => c.file !== relFile);
    this.index.services = this.index.services.filter((s) => s.file !== relFile);
    this.index.models = this.index.models.filter((m) => m.file !== relFile);
    this.index.theme.files = this.index.theme.files.filter((f) => f !== relFile);
    this.index.stateManagement.files = this.index.stateManagement.files.filter((f) => f !== relFile);
    
    this.graphBuilder.removeFile(filePath);
    
    if (this.index.fileHashes) {
      delete this.index.fileHashes[relFile];
    }
  }

  private mergePartial(filePath: string, partial: Partial<ProjectIndex>) {
    if (!this.index.files.includes(filePath)) this.index.files.push(filePath);

    // Filter out old entries for this file before merging new ones
    this.index.routes = this.index.routes.filter((r) => r.file !== filePath);
    this.index.screens = this.index.screens.filter((s) => s.file !== filePath);
    this.index.components = this.index.components.filter((c) => c.file !== filePath);
    this.index.services = this.index.services.filter((s) => s.file !== filePath);
    this.index.models = this.index.models.filter((m) => m.file !== filePath);

    if (partial.entryPoints?.length) {
      for (const ep of partial.entryPoints) {
        if (!this.index.entryPoints.includes(ep)) this.index.entryPoints.push(ep);
      }
    }

    if (partial.routes) this.index.routes.push(...partial.routes);
    if (partial.screens) this.index.screens.push(...partial.screens);
    if (partial.components) this.index.components.push(...partial.components);
    if (partial.services) this.index.services.push(...partial.services);
    if (partial.models) this.index.models.push(...partial.models);

    if (partial.theme?.files.length) {
      for (const tf of partial.theme.files) {
        if (!this.index.theme.files.includes(tf)) this.index.theme.files.push(tf);
      }
    }

    if (partial.stateManagement && partial.stateManagement.type !== 'unknown') {
      this.index.stateManagement.type = partial.stateManagement.type;
      for (const smf of partial.stateManagement.files) {
        if (!this.index.stateManagement.files.includes(smf)) this.index.stateManagement.files.push(smf);
      }
    }
  }
}
