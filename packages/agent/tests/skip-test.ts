/**
 * Thrown by a suite that cannot run on this host; test-runner.ts reports it as skipped with the reason, never as
 * passed. See sandbox-requirements.ts (real-Docker suites) and terminal-streaming.test.ts (Windows only for now).
 */
export class SkipTest extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SkipTest';
  }
}
