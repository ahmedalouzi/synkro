import { CloudBuildJob, CloudBuildFramework, CloudBuildTarget } from '@peep/shared';

export interface IBuildApi {
  startBuild(workspacePath: string, framework: CloudBuildFramework, target: CloudBuildTarget): Promise<CloudBuildJob>;
  getBuild(id: string): Promise<CloudBuildJob>;
  cancelBuild(id: string): Promise<CloudBuildJob>;
  streamLogs(id: string, onChunk: (chunk: string) => void): () => void;
  getDownloadToken?(id: string): Promise<{ token: string; downloadUrl: string; expiresAt: number }>;
}

export class MockBuildApi implements IBuildApi {
  /** Set to true before calling startBuild to simulate a build failure */
  public simulateFailure = false;

  private currentJob: CloudBuildJob | null = null;
  private logInterval: ReturnType<typeof setInterval> | null = null;
  private statusTimeout: ReturnType<typeof setTimeout> | null = null;
  private logListeners: ((chunk: string) => void)[] = [];
  private startBuildCalls: Array<{ workspacePath: string; framework: CloudBuildFramework; target: CloudBuildTarget }> = [];

  /** Returns all calls made to startBuild — useful for test assertions */
  get startBuildCallCount(): number { return this.startBuildCalls.length; }
  get lastStartBuildArgs() { return this.startBuildCalls[this.startBuildCalls.length - 1] ?? null; }

  async startBuild(workspacePath: string, framework: CloudBuildFramework, target: CloudBuildTarget): Promise<CloudBuildJob> {
    this.startBuildCalls.push({ workspacePath, framework, target });

    const id = `build-${Date.now()}`;
    this.currentJob = {
      id,
      userId: 'mock-user',
      projectId: 'mock-project',
      framework,
      target,
      status: 'queued',
      createdAt: new Date(),
    };

    const willFail = this.simulateFailure;

    // Simulate transition to running after 2 seconds
    this.statusTimeout = setTimeout(() => {
      if (this.currentJob && this.currentJob.status === 'queued') {
        this.currentJob.status = 'running';
        this.currentJob.startedAt = new Date();
        if (willFail) {
          this.startFailureSimulation();
        } else {
          this.startLogSimulation();
        }
      }
    }, 2000);

    return { ...this.currentJob };
  }

  async getBuild(id: string): Promise<CloudBuildJob> {
    if (this.currentJob && this.currentJob.id === id) {
      return { ...this.currentJob };
    }
    throw new Error('Build not found');
  }

  async cancelBuild(id: string): Promise<CloudBuildJob> {
    if (this.currentJob && this.currentJob.id === id) {
      this.currentJob.status = 'cancelled';
      this.currentJob.completedAt = new Date();
      this.cleanup();
      return { ...this.currentJob };
    }
    throw new Error('Build not found');
  }

  streamLogs(_id: string, onChunk: (chunk: string) => void): () => void {
    this.logListeners.push(onChunk);
    return () => {
      this.logListeners = this.logListeners.filter(l => l !== onChunk);
    };
  }

  /** Emit a log chunk to all current stream listeners — for test use */
  emitLogChunk(chunk: string): void {
    this.logListeners.forEach(l => l(chunk));
  }

  /** Reset all state — call between tests */
  reset(): void {
    this.cleanup();
    this.currentJob = null;
    this.logListeners = [];
    this.startBuildCalls = [];
    this.simulateFailure = false;
  }

  async getDownloadToken(id: string): Promise<{ token: string; downloadUrl: string; expiresAt: number }> {
    const downloadUrl = (this.currentJob && this.currentJob.id === id && this.currentJob.artifactUrl)
      ? this.currentJob.artifactUrl
      : 'https://example.com/mock-artifact.apk';
    return {
      token: 'mock-signed-token',
      downloadUrl,
      expiresAt: Date.now() + 15 * 60 * 1000,
    };
  }

  getCurrentJob(): CloudBuildJob | null {
    return this.currentJob ? { ...this.currentJob } : null;
  }

  private startLogSimulation() {
    let step = 0;
    const logs = [
      'Starting build environment...\r\n',
      'Downloading dependencies...\r\n',
      'Resolving packages...\r\n',
      'Building native modules...\r\n',
      'Compiling assets...\r\n',
      'Linking executable...\r\n',
      'Signing artifact...\r\n',
      'Build complete.\r\n'
    ];

    this.logInterval = setInterval(() => {
      if (step < logs.length) {
        const chunk = logs[step++];
        this.logListeners.forEach(l => l(chunk));
      } else {
        // Transition to success
        if (this.currentJob) {
          this.currentJob.status = 'success';
          this.currentJob.completedAt = new Date();
          this.currentJob.artifactUrl = 'https://example.com/mock-artifact.apk';
        }
        this.cleanup();
      }
    }, 1500);
  }

  private startFailureSimulation() {
    // Emit one error log line then transition to failed
    this.logInterval = setTimeout(() => {
      this.logListeners.forEach(l => l('ERROR: Gradle build failed — check above for details\r\n'));
      if (this.currentJob) {
        this.currentJob.status = 'failed';
        this.currentJob.completedAt = new Date();
        this.currentJob.errorLog = 'Gradle build failed with exit code 1\n> Task :app:compileDebugJavaWithJavac FAILED\nError: package does not exist';
      }
      this.cleanup();
    }, 1500) as any;
  }

  private cleanup() {
    if (this.logInterval) {
      clearInterval(this.logInterval as any);
      clearTimeout(this.logInterval as any);
      this.logInterval = null;
    }
    if (this.statusTimeout) {
      clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }
  }
}

class RealBuildApi implements IBuildApi {
  async startBuild(workspacePath: string, framework: CloudBuildFramework, target: CloudBuildTarget): Promise<CloudBuildJob> {
    return (window as any).peep.startCloudBuild(workspacePath, framework, target);
  }

  async getBuild(id: string): Promise<CloudBuildJob> {
    return (window as any).peep.getCloudBuild(id);
  }

  async cancelBuild(id: string): Promise<CloudBuildJob> {
    return (window as any).peep.cancelCloudBuild(id);
  }

  streamLogs(id: string, onChunk: (chunk: string) => void): () => void {
    // Requires main process to emit peep:build-log-chunk events
    const handler = (payload: { id: string, chunk: string }) => {
      if (payload.id === id) {
        onChunk(payload.chunk);
      }
    };
    return (window as any).peep.onBuildLogChunk(handler);
  }
}

export function shouldUseRealBuildApi(envValue: string | undefined | boolean): boolean {
  return envValue === 'true' || envValue === true;
}

export const buildApi: IBuildApi = (() => {
  const envVal = (import.meta as any).env?.VITE_USE_REAL_BUILD_API;
  const useReal = shouldUseRealBuildApi(envVal);
  console.log('[BUILD API] VITE_USE_REAL_BUILD_API raw env value:', envVal);
  console.log('[BUILD API] Resolved shouldUseRealBuildApi:', useReal);
  return useReal ? new RealBuildApi() : new MockBuildApi();
})();
