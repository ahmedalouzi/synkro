import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BUILD_NETWORK, verifyBuildNetwork } from '../src/models/network-setup.js';
import { FRAMEWORK_IMAGES } from '../src/models/docker-sandbox.js';

const execFileAsync = promisify(execFile);

/**
 * Real-Docker sandbox tests (isolation, fork bomb, OOM, disk quota, network allowlist, a real Expo build) need the
 * Linux build server: Docker, our sandbox image, and the build-restricted network with the DNS allowlist
 * (scripts/setup-production-server.sh). Without them they are reported as skipped, like the Postgres tests without a
 * database. With SYNKRO_RUN_SANDBOX_TESTS=1 (on the server) a missing piece is a failure instead.
 */
export const RUN_SANDBOX_TESTS = process.env.SYNKRO_RUN_SANDBOX_TESTS === '1';

/** Thrown to report a suite as skipped; test-runner.ts counts it under "skipped" with the reason. */
export class SkipTest extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SkipTest';
  }
}

export interface SandboxNeeds {
  /** Root on the host (dmesg, tcpdump). */
  root?: boolean;
  /** Docker --storage-opt size= (XFS with pquota), for the disk quota test. */
  storageQuota?: boolean;
}

/** What is missing for the sandbox tests on this host; empty when they can run. */
export async function missingSandboxRequirements(needs: SandboxNeeds = {}): Promise<string[]> {
  if (process.platform !== 'linux') return ['a Linux host'];
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 15_000 });
  } catch {
    return ['Docker (the daemon is not reachable)'];
  }
  const missing: string[] = [];
  const image = FRAMEWORK_IMAGES['react-native'];
  let hasImage = true;
  try {
    await execFileAsync('docker', ['image', 'inspect', image], { timeout: 15_000 });
  } catch {
    hasImage = false;
    missing.push(`the ${image} image (built by scripts/setup-production-server.sh)`);
  }
  try {
    await verifyBuildNetwork();
  } catch (err: any) {
    missing.push(`the ${BUILD_NETWORK} network with the DNS allowlist (${err.message})`);
  }
  if (needs.root && process.getuid?.() !== 0) missing.push('root (run with sudo)');
  if (needs.storageQuota && hasImage) {
    const name = `synkro-quota-probe-${process.pid}`;
    try {
      await execFileAsync('docker', ['create', '--name', name, '--storage-opt', 'size=1G', image, 'true'], { timeout: 30_000 });
    } catch {
      missing.push('Docker --storage-opt size= support (XFS with pquota, see docs/LINUX_TEST_SESSION.md)');
    } finally {
      await execFileAsync('docker', ['rm', '-f', name]).catch(() => {});
    }
  }
  return missing;
}

/**
 * Call at the start of a real-Docker sandbox test. Returns when everything is in place. Otherwise throws SkipTest,
 * or, with SYNKRO_RUN_SANDBOX_TESTS=1, a plain Error so the run fails.
 */
export async function requireSandbox(needs: SandboxNeeds = {}): Promise<void> {
  const missing = await missingSandboxRequirements(needs);
  if (missing.length === 0) return;
  const what = missing.join('; ');
  if (RUN_SANDBOX_TESTS) {
    throw new Error(`SYNKRO_RUN_SANDBOX_TESTS=1 but the sandbox is not ready. Missing: ${what}`);
  }
  throw new SkipTest(`Docker sandbox not available, needs ${what}. Run on the Linux build server with SYNKRO_RUN_SANDBOX_TESTS=1`);
}
