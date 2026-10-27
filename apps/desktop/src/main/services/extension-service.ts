import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { AgentInfo, ExtensionInfo, ExtensionSearchResult } from '@peep/shared';

const execAsync = promisify(exec);

export const CLAUDE_CODE_ID = 'Anthropic.claude-code';

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

interface AgentDefinition {
  extensionId: string;
  name: string;
  /** Where the extension ships its CLI, given the unpacked `extension/` folder. */
  bundledCli: (extensionDir: string) => string | null;
  /** Arguments the bundled CLI needs to run on its own, outside the extension. */
  args?: string[];
}

/** Coding agents whose VS Code extensions bundle a CLI that Synkro can run in an editor tab. */
const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    extensionId: CLAUDE_CODE_ID,
    name: 'Claude Code',
    bundledCli: (dir) => path.join(dir, 'resources', 'native-binary', exe('claude')),
  },
  {
    extensionId: 'openai.chatgpt',
    name: 'Codex',
    // bin/<os>-<arch>/codex, e.g. bin/windows-x86_64/codex.exe
    bundledCli: (dir) => {
      const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
      const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      return path.join(dir, 'bin', `${os}-${arch}`, exe('codex'));
    },
    // The extension's build has no background-server package of its own.
    args: ['--no-daemon'],
  },
];

export class ExtensionService {
  private extensionsDir: string;
  private readonly VSX_API_BASE = 'https://open-vsx.org/api';

  constructor() {
    // Store extensions in ~/.peep/extensions or similar
    // Actually, app.getPath('userData')/extensions is standard for Electron apps
    this.extensionsDir = path.join(app.getPath('userData'), 'extensions');
    if (!fs.existsSync(this.extensionsDir)) {
      fs.mkdirSync(this.extensionsDir, { recursive: true });
    }
  }

  public async searchExtensions(query: string, offset = 0, size = 20): Promise<ExtensionSearchResult> {
    const url = query.trim()
      ? `${this.VSX_API_BASE}/-/search?query=${encodeURIComponent(query)}&offset=${offset}&size=${size}`
      : `${this.VSX_API_BASE}/-/search?sortBy=downloadCount&offset=${offset}&size=${size}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch from Open VSX: ${response.statusText}`);
    }

    const data = await response.json() as any;
    const installedList = await this.getInstalledExtensions();
    const installedIds = new Set(installedList.map(e => e.id.toLowerCase()));

    const extensions: ExtensionInfo[] = data.extensions.map((ext: any) => {
      const id = `${ext.namespace}.${ext.name}`;
      return {
        id,
        name: ext.name,
        namespace: ext.namespace,
        version: ext.version,
        displayName: ext.displayName,
        description: ext.description,
        iconUrl: ext.files.icon,
        downloadCount: ext.downloadCount,
        averageRating: ext.averageRating,
        downloadUrl: ext.files.download,
        installed: installedIds.has(id.toLowerCase()),
      };
    });

    return {
      extensions,
      totalSize: data.totalSize,
      offset: data.offset,
    };
  }

  public async getExtensionDetails(extensionId: string): Promise<any> {
    const [namespace, name] = extensionId.split('.');
    const url = `${this.VSX_API_BASE}/${namespace}/${name}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch extension details: ${response.statusText}`);
    }
    return await response.json();
  }

  public async getInstalledExtensions(): Promise<ExtensionInfo[]> {
    if (!fs.existsSync(this.extensionsDir)) return [];

    const dirs = fs.readdirSync(this.extensionsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    const installed: ExtensionInfo[] = [];

    for (const dirName of dirs) {
      try {
        const packageJsonPath = path.join(this.extensionsDir, dirName, 'extension', 'package.json');
        if (fs.existsSync(packageJsonPath)) {
          const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          const id = `${pkg.publisher}.${pkg.name}`;
          installed.push({
            id,
            name: pkg.name,
            namespace: pkg.publisher,
            version: pkg.version,
            displayName: pkg.displayName || pkg.name,
            description: pkg.description,
            iconUrl: pkg.icon ? `file://${path.join(this.extensionsDir, dirName, 'extension', pkg.icon)}` : undefined,
            installed: true,
          });
        }
      } catch (err) {
        console.error(`Failed to read extension metadata from ${dirName}:`, err);
      }
    }

    return installed;
  }

  /**
   * Download URL of the build for this machine. Extensions with native parts (Claude Code, Python,
   * ...) publish one .vsix per platform, and the search result's default link can be any of them.
   */
  private async resolveDownloadUrl(extensionId: string): Promise<string | undefined> {
    const [namespace, name] = extensionId.split('.');
    const target = `${process.platform}-${process.arch}`;
    for (const url of [`${this.VSX_API_BASE}/${namespace}/${name}/${target}`, `${this.VSX_API_BASE}/${namespace}/${name}`]) {
      const response = await fetch(url);
      if (!response.ok) continue;
      const details = await response.json() as any;
      if (details.files?.download) return details.files.download;
    }
    return undefined;
  }

  public async installExtension(extensionId: string, fallbackUrl?: string): Promise<void> {
    const downloadUrl = (await this.resolveDownloadUrl(extensionId).catch(() => undefined)) ?? fallbackUrl;
    if (!downloadUrl) {
      throw new Error('No download URL found for extension');
    }

    const tempVsixPath = path.join(app.getPath('temp'), `${extensionId}.vsix`);
    
    // 1. Download .vsix using streams to avoid memory issues with large files
    const response = await fetch(downloadUrl);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download vsix: ${response.statusText}`);
    }
    
    // Web Streams API in Node.js fetch can be converted to Node streams
    const fileStream = fs.createWriteStream(tempVsixPath);
    const { pipeline } = require('stream/promises');
    const { Readable } = require('stream');
    // @ts-ignore
    await pipeline(Readable.fromWeb(response.body), fileStream);

    // 2. Extract .vsix to extension folder
    const targetDir = path.join(this.extensionsDir, extensionId);
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.mkdirSync(targetDir, { recursive: true });

    try {
      // .vsix is a zip file. Windows 10+ has tar.exe built-in.
      // macOS/Linux have unzip.
      // We are on Windows, so we use tar.exe
      // Windows' own bsdtar reads zip files; a GNU tar earlier on PATH (Git for Windows) does not.
      const systemTar = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : '';
      const tar = process.platform === 'win32' && systemTar && fs.existsSync(systemTar) ? `"${systemTar}"` : 'tar';
      await execAsync(`${tar} -xf "${tempVsixPath}" -C "${targetDir}"`);
    } catch (error) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.unlinkSync(tempVsixPath);
      throw new Error(`Failed to extract extension: ${error}`);
    }

    // 3. Cleanup
    fs.unlinkSync(tempVsixPath);
  }

  public async uninstallExtension(extensionId: string): Promise<void> {
    const targetDir = path.join(this.extensionsDir, extensionId);
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  }

  /** The folder an extension was installed into (ids differ in case between search and manifest). */
  private installedDir(extensionId: string): string | null {
    if (!fs.existsSync(this.extensionsDir)) return null;
    const name = fs.readdirSync(this.extensionsDir).find((d) => d.toLowerCase() === extensionId.toLowerCase());
    return name ? path.join(this.extensionsDir, name) : null;
  }

  /** The agent CLI bundled inside an installed agent extension, or null if missing or for another platform. */
  private bundledAgentCli(def: AgentDefinition): string | null {
    const dir = this.installedDir(def.extensionId);
    if (!dir) return null;
    const cli = def.bundledCli(path.join(dir, 'extension'));
    return cli && fs.existsSync(cli) ? cli : null;
  }

  /**
   * The Claude Code CLI bundled with the installed Claude Code extension, or `claude` on PATH.
   * Returns null when neither exists (e.g. the extension was installed for another platform).
   */
  public findClaudeCli(): string | null {
    const bundled = this.bundledAgentCli(AGENT_DEFINITIONS[0]);
    if (bundled) return bundled;
    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    for (const dir of (process.env[pathKey] ?? '').split(path.delimiter)) {
      if (!dir) continue;
      for (const candidate of process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']) {
        const full = path.join(dir, candidate);
        if (fs.existsSync(full)) return full;
      }
    }
    return null;
  }

  /** Finds the CLI, reinstalling Claude Code for this platform if an unusable build is on disk. */
  public async ensureClaudeCli(): Promise<string | null> {
    return (await this.ensureAgentCli(CLAUDE_CODE_ID)) ?? this.findClaudeCli();
  }

  /** Installed coding-agent extensions (Claude Code, Codex, ...) that Synkro can open in a tab. */
  public listAgents(): AgentInfo[] {
    const agents: AgentInfo[] = [];
    for (const def of AGENT_DEFINITIONS) {
      const dir = this.installedDir(def.extensionId);
      if (!dir) continue;
      let iconUrl: string | undefined;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'extension', 'package.json'), 'utf8'));
        // A data URL: the renderer can't load file:// images while served from the dev server.
        const iconPath = pkg.icon ? path.join(dir, 'extension', pkg.icon) : '';
        if (iconPath && fs.existsSync(iconPath)) {
          const ext = path.extname(iconPath).slice(1).toLowerCase();
          const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          iconUrl = `data:${mime};base64,${fs.readFileSync(iconPath).toString('base64')}`;
        }
      } catch { /* no manifest: show the default icon */ }
      agents.push({ extensionId: def.extensionId, name: def.name, iconUrl, cliPath: this.bundledAgentCli(def), args: def.args ?? [] });
    }
    return agents;
  }

  /** The agent's CLI, reinstalling the extension for this platform if the build on disk can't run here. */
  public async ensureAgentCli(extensionId: string): Promise<string | null> {
    const def = AGENT_DEFINITIONS.find((d) => d.extensionId.toLowerCase() === extensionId.toLowerCase());
    if (!def) return null;
    const found = this.bundledAgentCli(def);
    if (found || !this.installedDir(def.extensionId)) return found;
    await this.installExtension(path.basename(this.installedDir(def.extensionId)!));
    return this.bundledAgentCli(def);
  }
}
