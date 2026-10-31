import { BrowserWindow } from 'electron';
import { IPC_EVENTS } from '@peep/shared';
import type { PreviewSession, PreviewRuntimeReport } from '@peep/shared';
import type { FrameworkProvider } from './providers/base-provider';
import { createServer } from 'node:net';
import { PreviewLog } from './preview-log';

function getFreePort(): Promise<number> {
  const startPort = 10000 + Math.floor(Math.random() * 10000);
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(startPort, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      resolve(getFreePort());
    });
  });
}

export class PreviewManager {
  private session: PreviewSession | null = null;
  private activeProvider: FrameworkProvider | null = null;
  /** The current preview's output, for the agent (get_preview_logs / restart_preview). */
  private readonly log = new PreviewLog();
  /** The preview page's runtime state, relayed from the iframe; null until the page reports after a (re)start. */
  private runtime: PreviewRuntimeReport | null = null;

  getLog(): string {
    return this.log.get();
  }

  getRuntime(): PreviewRuntimeReport | null {
    return this.runtime;
  }

  setRuntime(report: PreviewRuntimeReport): void {
    this.runtime = report;
  }

  setMainWindow(_window: BrowserWindow | null): void {
    // no-op
  }

  getSession(): PreviewSession | null {
    return this.session;
  }

  setSession(session: PreviewSession): void {
    this.emit(session);
  }

  private emit(session: PreviewSession): void {
    this.session = session;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_EVENTS.PREVIEW_STATUS, session);
      }
    }
  }

  async start(projectRoot: string, provider: FrameworkProvider): Promise<PreviewSession> {
    console.log('[DEBUG_RUNTIME] previewManager.start received projectRoot:', projectRoot);
    this.stop();

    this.activeProvider = provider;
    this.log.clear();
    this.runtime = null;
    this.emit({ url: '', processId: 0, status: 'starting' });

    try {
      const port = await getFreePort();
      const { url, processId } = await provider.startPreview(projectRoot, port, (line) => {
        this.log.add(line);
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send(IPC_EVENTS.PREVIEW_LOG, line);
          }
        }
      });

      const session: PreviewSession = { url, processId, status: 'running' };
      this.emit(session);
      return session;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.add(`[preview error] ${message}`);
      const session: PreviewSession = {
        url: '',
        processId: 0,
        status: 'error',
        error: message,
      };
      this.emit(session);
      throw error;
    }
  }

  stop(): void {
    if (this.session?.processId && this.activeProvider) {
      this.activeProvider.stopPreview(this.session.processId);
    }
    this.emit({ url: '', processId: 0, status: 'stopped' });
    this.activeProvider = null;
  }

  reload(): void {
    if (this.session?.processId && this.activeProvider) {
      this.activeProvider.reloadPreview(this.session.processId);
    }
  }
}
