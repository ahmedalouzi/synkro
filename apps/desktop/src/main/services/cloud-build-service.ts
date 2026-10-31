import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { DatabaseService } from './db';
import { BrowserWindow } from 'electron';
import { IPC_EVENTS } from '@peep/shared';
import { resolveGatewayUrl } from '../build-config';


const execAsync = promisify(exec);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The project's permanent Cloud Build ID, kept in .synkro/project.json and created on its first build.
 * The server signs every build of a project with that project's own key, found by this ID, so it must not
 * change (renaming or moving the folder keeps it). Exported for tests.
 */
export async function ensureProjectId(workspacePath: string): Promise<string> {
  const file = path.join(workspacePath, '.synkro', 'project.json');
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    // Missing or unreadable: written below.
  }
  if (typeof data.projectId === 'string' && UUID_REGEX.test(data.projectId)) return data.projectId;

  const projectId = randomUUID();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ ...data, projectId }, null, 2) + '\n');
  return projectId;
}

export class CloudBuildService {
  constructor(private db: DatabaseService) {}

  private getGatewayUrl() {
    const settings = this.db.getSettingsRaw();
    return resolveGatewayUrl(settings.gatewayUrl);
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const settings = this.db.getSettingsRaw();
    if (!settings.sessionToken) {
      throw new Error('Not authenticated. Please sign in to use Cloud Build.');
    }
    return {
      'Authorization': `Bearer ${settings.sessionToken}`,
    };
  }

  async startBuild(workspacePath: string, framework: string, target: string) {
    const projectId = await ensureProjectId(workspacePath);
    const zipPath = path.join(require('os').tmpdir(), `peep-build-${Date.now()}.zip`);
    
    // Zip the project directory. Exclude node_modules, build, etc if possible, but for MVP just zip all.
    // On Windows 10+, tar -a -c -f creates a zip. On macOS/Linux, zip works.
    console.log(`[CLOUD_BUILD] Zipping ${workspacePath} to ${zipPath}`);
    try {
      if (process.platform === 'win32') {
        await execAsync(`tar.exe -a -c -f "${zipPath}" --exclude=node_modules --exclude=.git --exclude=android/build --exclude=android/.gradle --exclude=ios/Pods *`, { cwd: workspacePath, timeout: 120000 });
      } else {
        await execAsync(`zip -r "${zipPath}" . -x "node_modules/*" ".git/*" "build/*" "android/build/*" "android/.gradle/*" "ios/Pods/*"`, { cwd: workspacePath, timeout: 120000 });
      }
      const stat = await fs.stat(zipPath);
      console.log(`[CLOUD_BUILD] Zip complete, size: ${stat.size} bytes`);
    } catch (err: any) {
      console.error('[CLOUD_BUILD] Zip failed:', err);
      throw new Error(`Failed to zip project: ${err.message}`);
    }

    const fileBuffer = await fs.readFile(zipPath);
    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: 'application/zip' });
    formData.append('project', blob, 'project.zip');
    formData.append('projectId', projectId);
    formData.append('framework', framework);
    formData.append('target', target);

    const headers = await this.getAuthHeaders();
    
    const res = await fetch(`${this.getGatewayUrl()}/api/build/upload`, {
      method: 'POST',
      headers,
      body: formData as any,
    });

    // Cleanup zip
    fs.unlink(zipPath).catch(() => {});

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(`Cloud Build Start Failed: ${errData.error || res.statusText}`);
    }

    const data = await res.json();
    return this.getBuild(data.jobId);
  }

  async getBuild(id: string) {
    const headers = await this.getAuthHeaders();
    const res = await fetch(`${this.getGatewayUrl()}/api/build/${id}`, {
      method: 'GET',
      headers,
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(`Cloud Build Get Failed: ${errData.error || res.statusText}`);
    }
    const data = await res.json();
    if (data.artifactUrl && data.artifactUrl.startsWith('/')) {
      data.artifactUrl = `${this.getGatewayUrl()}${data.artifactUrl}`;
    }
    return data;
  }

  async getHistory() {
    const headers = await this.getAuthHeaders();
    const res = await fetch(`${this.getGatewayUrl()}/api/build/history`, {
      method: 'GET',
      headers,
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(`Cloud Build History Failed: ${errData.error || res.statusText}`);
    }
    const data = await res.json();
    return data.map((job: any) => {
      if (job.artifactUrl && job.artifactUrl.startsWith('/')) {
        job.artifactUrl = `${this.getGatewayUrl()}${job.artifactUrl}`;
      }
      return job;
    });
  }

  async getDownloadToken(id: string) {
    const headers = await this.getAuthHeaders();
    const res = await fetch(`${this.getGatewayUrl()}/api/build/${id}/download-token`, {
      method: 'GET',
      headers,
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(`Cloud Build Download Token Failed: ${errData.error || res.statusText}`);
    }
    const data = await res.json();
    if (data.downloadUrl && data.downloadUrl.startsWith('/')) {
      data.downloadUrl = `${this.getGatewayUrl()}${data.downloadUrl}`;
    }
    return data;
  }

  async cancelBuild(id: string) {
    const headers = await this.getAuthHeaders();
    const res = await fetch(`${this.getGatewayUrl()}/api/build/${id}/cancel`, {
      method: 'POST',
      headers,
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(`Cloud Build Cancel Failed: ${errData.error || res.statusText}`);
    }
    return this.getBuild(id);
  }

  async startLogStream(id: string, mainWindow: BrowserWindow) {
    try {
      const settings = this.db.getSettingsRaw();
      if (!settings.sessionToken) return;

      const url = `${this.getGatewayUrl()}/api/build/${id}/stream?token=${encodeURIComponent(settings.sessionToken)}`;
      const EventSourceModule = await import('eventsource') as any;
      const EventSource = EventSourceModule.EventSource || EventSourceModule.default || EventSourceModule;
      const es = new EventSource(url, {
        fetchParameters: {
          headers: {
            'Authorization': `Bearer ${settings.sessionToken}`,
          }
        },
        // Fallback for older eventsource package versions just in case
        headers: {
          'Authorization': `Bearer ${settings.sessionToken}`,
        }
      });

      es.onmessage = (event: any) => {
        try {
          const data = JSON.parse(event.data);
          if (data.chunk) {
            mainWindow.webContents.send(IPC_EVENTS.BUILD_LOG_CHUNK, { id, chunk: data.chunk });
          }
          if (data.chunk && data.chunk.includes('[Stream Terminated')) {
            es.close();
          }
        } catch (e) {
          console.error('Error parsing SSE data', e);
        }
      };

      es.onerror = (err: any) => {
        console.error('SSE Error', err);
        es.close();
      };
    } catch (err) {
      console.error('[CLOUD_BUILD] Failed to start log stream:', err);
    }
  }
}

