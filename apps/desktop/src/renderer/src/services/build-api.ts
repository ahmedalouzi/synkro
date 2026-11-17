import { CloudBuildJob, CloudBuildFramework, CloudBuildTarget } from '@peep/shared';

export interface IBuildApi {
  startBuild(workspacePath: string, framework: CloudBuildFramework, target: CloudBuildTarget): Promise<CloudBuildJob>;
  getBuild(id: string): Promise<CloudBuildJob>;
  cancelBuild(id: string): Promise<CloudBuildJob>;
  streamLogs(id: string, onChunk: (chunk: string) => void): () => void;
  getDownloadToken?(id: string): Promise<{ token: string; downloadUrl: string; expiresAt: number }>;
  createShortLink?(id: string): Promise<{ url: string; expiresAt: number }>;
}

export class MockBuildApi implements IBuildApi {
  /** Set to true before calling startBuild to simulate a build failure */
  public simulateFailure = false;

  /**
   * Dev only (VITE_MOCK_BUILD_QUEUE=true): a build that looks like a real one to the build experience
   * (BuildExperience.tsx): queued for a few seconds with an ETA, then the same "[STEP]" lines the server writes, about
   * 35 seconds in all, and the log in errorLog as the server returns it. With simulateFailure (VITE_MOCK_BUILD_FAIL=true)
   * it fails while compiling. Off by default: the build starts after 2 seconds, as the tests expect.
   */
  constructor(private readonly simulateStages = false) {}

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

    if (this.simulateStages) {
      this.currentJob.queueEtaSeconds = 11 * 60;
      this.statusTimeout = setTimeout(() => this.runStagedDemo(id, willFail), 6000);
      return { ...this.currentJob };
    }

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

  async createShortLink(id: string): Promise<{ url: string; expiresAt: number }> {
    return {
      url: `http://localhost:8080/d/mockShortCode12345678_${id.slice(-4)}`,
      expiresAt: Date.now() + 15 * 60 * 1000,
    };
  }

  getCurrentJob(): CloudBuildJob | null {
    return this.currentJob ? { ...this.currentJob } : null;
  }

  /** The staged demo (see the constructor): log lines on a timeline, appended to errorLog like the real server. */
  private runStagedDemo(id: string, willFail: boolean) {
    const job = this.currentJob;
    if (!job || job.id !== id || job.status !== 'queued') return;
    delete job.queueEtaSeconds;
    job.status = 'running';
    job.startedAt = new Date();
    job.errorLog = '';
    const emit = (line: string) => {
      if (!this.currentJob || this.currentJob.id !== id || this.currentJob.status !== 'running') return false;
      this.currentJob.errorLog = `${this.currentJob.errorLog ?? ''}${line}
`;
      this.logListeners.forEach((l) => l(`${line}
`));
      return true;
    };
    const timeline: Array<[number, string]> = willFail
      ? [[1, '[SYSTEM] Starting react-native build process...'], [5, 'added 1148 packages in 41s'], [6, '[STEP] npm install 0m41s'],
         [10, '[STEP] expo prebuild 0m38s'], [14, '> Task :app:compileReleaseKotlin FAILED'], [15, '[ERROR] FAILURE: Build failed with an exception.'],
         [16, "e: file:///build/android/app/src/main/java/com/demo/MainActivity.kt:3:8 Unresolved reference: Foo"], [17, '[STEP] total 2m31s']]
      : [[1, '[SYSTEM] Using the shared Gradle dependency cache (read-only).'], [2, '[SYSTEM] Starting react-native build process...'],
         [7, 'added 1148 packages in 41s'], [8, '[STEP] npm install 0m41s'], [14, '[STEP] expo prebuild 0m38s'],
         [20, '> Task :app:compileReleaseKotlin'], [26, '> Task :app:packageRelease'], [28, '[STEP] gradle 5m12s'],
         [29, '[SYSTEM] Disk used: 3.1 GB of 12 GB'], [30, '[STEP] total 6m44s']];
    for (const [sec, line] of timeline) {
      setTimeout(() => emit(line), sec * 1000);
    }
    const endSec = timeline[timeline.length - 1][0] + 3;
    this.statusTimeout = setTimeout(() => {
      const j = this.currentJob;
      if (!j || j.id !== id || j.status !== 'running') return;
      j.status = willFail ? 'failed' : 'success';
      j.completedAt = new Date();
      if (!willFail) j.artifactUrl = 'https://example.com/mock-artifact.apk';
    }, endSec * 1000);
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

  async createShortLink(id: string): Promise<{ url: string; expiresAt: number }> {
    return (window as any).peep.createCloudBuildShortLink(id);
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
  const env = (import.meta as any).env ?? {};
  // A release build always talks to the real Cloud Build server: without VITE_USE_REAL_BUILD_API (set nowhere)
  // the packaged app fell back to the mock, which fakes builds. The mock is a dev-only option.
  const useReal = env.PROD === true || shouldUseRealBuildApi(env.VITE_USE_REAL_BUILD_API);
  if (env.DEV) console.log('[BUILD API] using', useReal ? 'the real Cloud Build API' : 'the mock (set VITE_USE_REAL_BUILD_API=true for the real one)');
  if (useReal) return new RealBuildApi();
  const mock = new MockBuildApi(env.VITE_MOCK_BUILD_QUEUE === 'true');
  mock.simulateFailure = env.VITE_MOCK_BUILD_FAIL === 'true';
  return mock;
})();
