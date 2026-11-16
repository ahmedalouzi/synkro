import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Checks that Docker really enforces the per-build disk quota (`--storage-opt size=`, docker-sandbox.ts).
 *
 * Docker 29+ with the containerd image store ("containerd snapshotter", storage driver "overlayfs") accepts
 * `--storage-opt size=` and silently ignores it: container layers then live under /var/lib/containerd on the root
 * disk, not on the XFS volume mounted at /var/lib/docker. The quota only works with the classic overlay2 graph
 * driver on XFS mounted with pquota (scripts/setup-production-server.sh, DEC-06). So this checks both the driver and
 * the real behaviour: a container limited to 1G that writes 2G must fail with "No space left on device".
 *
 * Used by the build worker before it runs Cloud Builds, and by tests/sandbox-requirements.ts. The script runs the
 * same check in shell (section 13).
 */

/** Limit and write size of the probe container, in MB. */
const PROBE_LIMIT = '1G';
const PROBE_WRITE_MB = 2048;

export interface DiskQuotaStatus {
  ok: boolean;
  /** Why the quota is not enforced (empty when ok). Plain facts from `docker info` and the probe, nothing secret. */
  problem: string;
}

/** Storage driver and backing filesystem from `docker info`, e.g. { driver: 'overlay2', backingFs: 'xfs' }. */
export async function dockerStorageInfo(): Promise<{ driver: string; backingFs: string }> {
  const { stdout } = await execFileAsync('docker', ['info', '--format', '{{.Driver}}|{{json .DriverStatus}}'], { timeout: 20_000 });
  const [driver, statusJson] = stdout.trim().split('|');
  let backingFs = '';
  try {
    const status = JSON.parse(statusJson || 'null') as [string, string][] | null;
    backingFs = status?.find(([key]) => key === 'Backing Filesystem')?.[1] ?? '';
  } catch {
    /* no DriverStatus */
  }
  return { driver: driver.trim(), backingFs: backingFs.trim() };
}

/**
 * Runs the full check with `image` (a sandbox image already on the host) as the probe container.
 * Takes a few seconds: the probe writes until the 1G quota stops it.
 */
export async function checkDiskQuota(image: string): Promise<DiskQuotaStatus> {
  let info: { driver: string; backingFs: string };
  try {
    info = await dockerStorageInfo();
  } catch (err: any) {
    return { ok: false, problem: `docker info failed (${err.message})` };
  }
  if (info.driver !== 'overlay2' || info.backingFs !== 'xfs') {
    const hint = info.driver === 'overlayfs' ? ' (the containerd snapshotter, which ignores --storage-opt)' : '';
    return {
      ok: false,
      problem: `Docker storage driver is "${info.driver}"${hint} on "${info.backingFs || 'unknown'}"; the disk quota needs overlay2 on xfs with pquota`,
    };
  }

  const name = `synkro-quota-probe-${process.pid}-${Date.now()}`;
  try {
    const { stdout, stderr } = await execFileAsync(
      'docker',
      [
        'run', '--rm', '--name', name, '--network', 'none', '--cap-drop=ALL', '--user=1000:1000',
        '--storage-opt', `size=${PROBE_LIMIT}`, image,
        'sh', '-c', `dd if=/dev/zero of=/tmp/quota-probe bs=1M count=${PROBE_WRITE_MB} 2>&1`,
      ],
      { timeout: 180_000 },
    );
    return {
      ok: false,
      problem: `a container limited to ${PROBE_LIMIT} wrote ${PROBE_WRITE_MB} MB without error, so --storage-opt is not enforced (${(stdout + stderr).trim().split('\n').pop()})`,
    };
  } catch (err: any) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    if (/No space left on device|Disk quota exceeded/i.test(output)) return { ok: true, problem: '' };
    return { ok: false, problem: `the disk quota probe failed for another reason: ${output.trim().split('\n').pop() || err.message}` };
  } finally {
    await execFileAsync('docker', ['rm', '-f', name]).catch(() => {});
  }
}

const RECHECK_FAILED_MS = 10 * 60 * 1000;
let cached: { image: string; at: number; result: Promise<DiskQuotaStatus> } | null = null;

/**
 * checkDiskQuota() with a cache: a pass is kept for the life of the process (the storage driver only changes with a
 * Docker restart, and the setup script checks again then); a failure is checked again after 10 minutes, so fixing
 * the server does not need a worker restart.
 */
export function cachedDiskQuota(image: string): Promise<DiskQuotaStatus> {
  const now = Date.now();
  if (cached && cached.image === image) {
    const stale = now - cached.at > RECHECK_FAILED_MS;
    if (!stale) return cached.result;
    const prev = cached.result;
    return prev.then((r) => (r.ok ? r : refresh(image, now)));
  }
  return refresh(image, now);
}

function refresh(image: string, now: number): Promise<DiskQuotaStatus> {
  cached = { image, at: now, result: checkDiskQuota(image) };
  return cached.result;
}

/** The quota is required where Cloud Builds really run: the Linux production server. */
export function diskQuotaRequired(): boolean {
  return process.platform === 'linux' && process.env.NODE_ENV === 'production';
}
