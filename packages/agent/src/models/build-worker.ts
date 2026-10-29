import { db } from './db';
import { DockerSandbox, BuildFramework, BUILD_TIMEOUT_MS as SANDBOX_TIMEOUT_MS } from './docker-sandbox';
import { uploadArtifact, ensureBucket, isMinioConfigured } from './artifact-store';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import AdmZip from 'adm-zip';

// ---------------------------------------------------------------------------
// RLS helper
// ---------------------------------------------------------------------------
// SECURITY CRITICAL: The base pool authenticates as the postgres superuser.
// worker_user has BYPASSRLS — it can see all build_jobs rows for worker ops
// (claim, update, reconcile). All build_jobs queries MUST use this wrapper.
// Any future code that touches build_jobs without this wrapper silently
// regresses to superuser and loses role accountability.
async function withWorkerRole<T>(fn: (c: { query: Function }) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    // RLS protection depends ENTIRELY on this line being present.
    await c.query('SET LOCAL ROLE worker_user');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    (c as any).release();
  }
}

/**
 * Unconditionally cleans up temporary build files (`extractPath`, `localApkPath`, and `sourceZipPath`).
 * Exported so unit tests can verify temp cleanup behavior directly.
 */
export async function cleanupBuildTempFiles(paths: {
  extractPath?: string | null;
  localApkPath?: string | null;
  sourceZipPath?: string | null;
}): Promise<void> {
  if (paths.extractPath) {
    await fs.rm(paths.extractPath, { recursive: true, force: true }).catch((e) => {
      console.error(`[BUILD_WORKER] Cleanup failed for extractPath ${paths.extractPath}`, e);
    });
  }
  if (paths.localApkPath) {
    await fs.unlink(paths.localApkPath).catch(() => {});
  }
  if (paths.sourceZipPath && paths.sourceZipPath.endsWith('.zip')) {
    await fs.unlink(paths.sourceZipPath).catch(() => {});
  }
}

/**
 * Extracts a ZIP archive into `extractPath` after verifying every entry stays inside `path.resolve(extractPath)` (Zip-Slip protection).
 */
export async function extractZipSafely(sourceZipPath: string, extractPath: string): Promise<void> {
  await fs.mkdir(extractPath, { recursive: true });
  const resolvedRoot = path.resolve(extractPath);
  const zip = new AdmZip(sourceZipPath);
  for (const entry of zip.getEntries()) {
    const rawName = (entry.entryName || '').replace(/\\/g, '/');
    if (
      rawName.startsWith('/') ||
      rawName.includes('\0') ||
      /^[A-Za-z]:/.test(rawName) ||
      rawName.split('/').includes('..')
    ) {
      throw new Error(`Unsafe ZIP entry rejected (Zip-Slip): "${entry.entryName}"`);
    }
    const targetPath = path.resolve(resolvedRoot, rawName);
    if (targetPath !== resolvedRoot && !targetPath.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`Unsafe ZIP entry escapes target directory: "${entry.entryName}"`);
    }
  }
  zip.extractAllTo(extractPath, true);
}

// ---------------------------------------------------------------------------
// Reconciler: Recovers orphaned running jobs that the worker failed to complete
// ---------------------------------------------------------------------------
/** The longest sandbox timeout (45 minutes for React Native, see docker-sandbox.ts). */
export const BUILD_TIMEOUT_MS = Math.max(...Object.values(SANDBOX_TIMEOUT_MS));
export const GRACE_PERIOD_MS = 5 * 60 * 1000;
/** A running job older than this is treated as abandoned: always past the sandbox's own timeout. */
const ORPHAN_AFTER_SECONDS = (BUILD_TIMEOUT_MS + GRACE_PERIOD_MS) / 1000;

let isWorkerActive = false;
let pollTimeout: NodeJS.Timeout | null = null;
let reconcilerInterval: NodeJS.Timeout | null = null;
let reaperInterval: NodeJS.Timeout | null = null;
let retentionInterval: NodeJS.Timeout | null = null;

export async function reconcileOrphanedJobs(customPool?: any): Promise<number> {
  const runner = async (c: { query: Function }) => {
    const res = await c.query(`
      UPDATE build_jobs
      SET status = 'failed',
          completed_at = NOW(),
          error_log = COALESCE(error_log, '') || '[RECONCILER] Auto-recovered orphaned job from worker ' || COALESCE(worker_id, 'unknown') || '. Worker crashed or timed out.\n',
          updated_at = NOW()
      WHERE status = 'running' 
        AND (started_at < NOW() - make_interval(secs => $1) OR (started_at IS NULL AND updated_at < NOW() - make_interval(secs => $1)))
      RETURNING id
    `, [ORPHAN_AFTER_SECONDS]);
    if (res.rows.length > 0) {
      console.log(`[RECONCILER] Recovered ${res.rows.length} orphaned jobs: ${res.rows.map((r: any) => r.id).join(', ')}`);
    }
    return res.rows.length;
  };

  try {
    if (customPool) {
      return await runner(customPool);
    }
    return await withWorkerRole(runner);
  } catch (err) {
    console.error('[RECONCILER] Error:', err);
    return 0;
  }
}

/**
 * Purges build artifacts older than retention limits (24h Free / 7d Pro).
 * Removes files from local disk and MinIO (if enabled), then nulls artifact_url in build_jobs.
 */
export async function cleanupExpiredArtifacts(artifactDir?: string): Promise<number> {
  try {
    const expiredJobs = await withWorkerRole(async (c) => {
      const res = await c.query(`
        SELECT b.id, b.user_id, b.artifact_url, COALESCE(u.plan, 'free') AS plan
        FROM build_jobs b
        LEFT JOIN users u ON b.user_id = u.id
        WHERE b.status = 'success'
          AND b.artifact_url IS NOT NULL
          AND (
            (COALESCE(u.plan, 'free') = 'free' AND b.completed_at < NOW() - INTERVAL '24 hours')
            OR
            (COALESCE(u.plan, 'free') != 'free' AND b.completed_at < NOW() - INTERVAL '7 days')
          )
      `);
      return res.rows;
    });

    if (expiredJobs.length === 0) {
      return 0;
    }

    const destDir = artifactDir || process.env.ARTIFACT_DIR || '/var/lib/synkro/artifacts';
    let cleanedCount = 0;

    for (const job of expiredJobs) {
      if (isMinioConfigured()) {
        try {
          const { deleteArtifact } = await import('./artifact-store');
          await deleteArtifact(job.id);
        } catch (minioErr) {
          console.warn(`[BUILD_WORKER] MinIO cleanup error for job ${job.id}:`, minioErr);
        }
      }

      try {
        const localPath = path.join(destDir, job.user_id.toString(), `${job.id}.apk`);
        await fs.unlink(localPath).catch(() => {});
      } catch (fsErr) {
        // ignore if not present
      }

      await withWorkerRole(async (c) => {
        await c.query(`
          UPDATE build_jobs
          SET artifact_url = NULL, updated_at = NOW()
          WHERE id = $1
        `, [job.id]);
      });

      cleanedCount++;
    }

    console.log(`[BUILD_WORKER] Cleaned up ${cleanedCount} expired build artifact(s).`);
    return cleanedCount;
  } catch (err) {
    console.error('[BUILD_WORKER] Error cleaning up expired artifacts:', err);
    return 0;
  }
}

export function stopBuildWorker() {
  isWorkerActive = false;
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
  if (reconcilerInterval) {
    clearInterval(reconcilerInterval);
    reconcilerInterval = null;
  }
  if (reaperInterval) {
    clearInterval(reaperInterval);
    reaperInterval = null;
  }
  if (retentionInterval) {
    clearInterval(retentionInterval);
    retentionInterval = null;
  }
  console.log('[BUILD_WORKER] Stopped.');
}

// ---------------------------------------------------------------------------
// Reaper: Force kills orphaned containers older than 15 minutes
// ---------------------------------------------------------------------------
async function reapOrphanedContainers() {
  const { exec } = await import('node:child_process');
  exec('docker ps -aq --filter name=build_sandbox_', (err, stdout) => {
    if (err) return;
    const containers = stdout.split('\\n').filter(Boolean);
    if (containers.length > 0) {
      exec('docker rm -f $(docker ps -aq --filter name=build_sandbox_ --filter "status=exited")', () => {});
    }
  });
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------
export async function startBuildWorker() {
  console.log('[BUILD_WORKER] Starting worker, reconciler, and reaper...');
  isWorkerActive = true;

  if (reconcilerInterval) clearInterval(reconcilerInterval);
  if (reaperInterval) clearInterval(reaperInterval);
  if (retentionInterval) clearInterval(retentionInterval);
  if (pollTimeout) clearTimeout(pollTimeout);

  // Ensure MinIO bucket exists on startup if configured
  if (isMinioConfigured()) {
    try {
      await ensureBucket();
      console.log('[BUILD_WORKER] MinIO bucket verified.');
    } catch (err) {
      console.warn('[BUILD_WORKER] MinIO not available, will retry on artifact upload:', err);
    }
  } else {
    console.log('[BUILD_WORKER] MinIO not configured, using local disk storage.');
  }

  // Startup cleanup: reap any lingering containers from previous crashes
  const { exec } = await import('node:child_process');
  exec('docker rm -f $(docker ps -aq --filter name=build_sandbox_)', () => {
    console.log('[BUILD_WORKER] Startup cleanup complete.');
  });

  reconcilerInterval = setInterval(reconcileOrphanedJobs, 60000);
  reconcilerInterval.unref();

  reaperInterval = setInterval(reapOrphanedContainers, 60000);
  reaperInterval.unref();

  retentionInterval = setInterval(() => {
    cleanupExpiredArtifacts().catch((err) =>
      console.error('[BUILD_WORKER] Retention cleanup failed:', err)
    );
  }, 60 * 60 * 1000);
  retentionInterval.unref();

  // Startup artifact cleanup
  cleanupExpiredArtifacts().catch((err) =>
    console.error('[BUILD_WORKER] Startup retention cleanup failed:', err)
  );

  // Simple recursive polling loop
  const poll = async () => {
    if (!isWorkerActive) return;
    try {
      // Claim next queued job as worker_user (BYPASSRLS, no app.current_user_id needed)
      const result = await withWorkerRole(async (c) => c.query(`
        SELECT id, user_id, project_id, status, source_path, framework, keystore_secret_id
        FROM build_jobs 
        WHERE status = 'queued' 
        ORDER BY created_at ASC 
        LIMIT 1 
        FOR UPDATE SKIP LOCKED
      `));

      if (result.rows.length > 0) {
        const job = result.rows[0];
        const framework: BuildFramework = job.framework || 'flutter';
        console.log(`[BUILD_WORKER] Picked up ${framework} job ${job.id} for project ${job.project_id}`);
        
        // Mark as running — still inside worker_user role via wrapper
        await withWorkerRole(async (c) => c.query(
          `UPDATE build_jobs SET status = 'running', started_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [job.id]
        ));
        
        const extractPath = path.join('/tmp/builds', `${job.id}_extracted`);
        const localApkPath = path.join('/tmp/artifacts', `${job.id}.apk`);
        let cancelInterval: ReturnType<typeof setInterval> | undefined;
        let sandbox: DockerSandbox | undefined;

        try {
          // Extract the ZIP with Zip-Slip entry validation
          try {
            if (job.source_path && job.source_path.endsWith('.zip')) {
              await extractZipSafely(job.source_path, extractPath);
            } else {
              await fs.mkdir(extractPath, { recursive: true });
              console.log(`[BUILD_WORKER] Mocking extraction, no valid zip found for job ${job.id}`);
            }
          } catch (err: any) {
            console.error(`[BUILD_WORKER] Extraction failed for job ${job.id}:`, err);
            await withWorkerRole(async (c) => c.query(
              `UPDATE build_jobs SET status = 'failed', error_log = COALESCE(error_log, '') || $1, updated_at = NOW() WHERE id = $2`,
              [`Extraction Failed: ${err.message}\n`, job.id]
            ));
            return;
          }

          // Resolve keystore if present
          let keystorePath: string | undefined;
          let keystorePassword: string | undefined;
          let keyAlias: string | undefined;
          let keyPassword: string | undefined;

          if (job.keystore_secret_id) {
            const localKeystorePath = path.join('/tmp/keystores', `${job.keystore_secret_id}.jks`);
            try {
              await fs.access(localKeystorePath);
              keystorePath = localKeystorePath;
              keystorePassword = process.env.DEFAULT_KEYSTORE_PASSWORD || 'changeit';
              keyAlias = process.env.DEFAULT_KEY_ALIAS || 'release';
              keyPassword = process.env.DEFAULT_KEY_PASSWORD || keystorePassword;
            } catch {
              console.warn(`[BUILD_WORKER] Keystore ${job.keystore_secret_id} not found, building without signing`);
            }
          }

          // Execute the sandbox
          sandbox = new DockerSandbox({
            jobId: job.id,
            projectPath: extractPath,
            framework,
            keystorePath,
            keystorePassword,
            keyAlias,
            keyPassword,
          });

          console.log(`[BUILD_WORKER] Launching ${framework} Docker Sandbox for job ${job.id}...`);
          
          const buildStartTime = Date.now();
          let logsBuffer = '';
          let logsFlushed = 0;
          let jobCancelled = false;

          // Periodic cancel check and log flush while build is running
          cancelInterval = setInterval(async () => {
            try {
              const res = await withWorkerRole(async (c) => c.query(
                `SELECT status FROM build_jobs WHERE id = $1`, [job.id]
              ));
              if (res.rows[0]?.status === 'cancelled') {
                console.log(`[BUILD_WORKER] Job ${job.id} cancelled by user. Terminating sandbox...`);
                jobCancelled = true;
                sandbox?.forceKill();
              } else if (logsBuffer.length > logsFlushed) {
                const toFlush = logsBuffer.substring(logsFlushed);
                logsFlushed = logsBuffer.length;
                await withWorkerRole(async (c) => c.query(
                  `UPDATE build_jobs SET error_log = COALESCE(error_log, '') || $1 WHERE id = $2`,
                  [toFlush, job.id]
                ));
              }
            } catch (err) {
              console.error(`[BUILD_WORKER] Error in periodic check for job ${job.id}:`, err);
            }
          }, 5000);

          const success = await sandbox.runBuild((logChunk) => {
            process.stdout.write(`[SANDBOX ${job.id}] ${logChunk}`);
            logsBuffer += logChunk + '\n';
          });
          
          clearInterval(cancelInterval);
          
          const buildDuration = Date.now() - buildStartTime;

          // Flush any remaining logs that weren't caught by the interval
          const remainingLogs = logsBuffer.substring(logsFlushed);
          await withWorkerRole(async (c) => c.query(
            `UPDATE build_jobs SET error_log = COALESCE(error_log, '') || $1, build_duration_ms = $2 WHERE id = $3`,
            [remainingLogs, buildDuration, job.id]
          ));

          if (success && !jobCancelled) {
            console.log(`[BUILD_WORKER] Job ${job.id} completed successfully in ${buildDuration}ms.`);
            
            // Extract artifact from container and upload to MinIO
            await fs.mkdir(path.dirname(localApkPath), { recursive: true });
            
            const extracted = await sandbox.extractArtifact(localApkPath);
            if (extracted) {
              try {
                let url: string;
                let sizeBytes: number;
                
                if (isMinioConfigured()) {
                  const res = await uploadArtifact(job.id, localApkPath, 'app-release.apk');
                  url = res.url;
                  sizeBytes = res.sizeBytes;
                } else {
                  const destDir = process.env.ARTIFACT_DIR || '/var/lib/synkro/artifacts';
                  const userDir = path.join(destDir, job.user_id.toString());
                  const destPath = path.join(userDir, `${job.id}.apk`);
                  
                  await fs.mkdir(userDir, { recursive: true, mode: 0o700 });
                  await fs.copyFile(localApkPath, destPath);
                  const stat = await fs.stat(destPath);
                  sizeBytes = stat.size;
                  
                  // Store relative URL for local artifacts
                  url = `/api/build/${job.id}/download`;
                }

                await withWorkerRole(async (c) => c.query(
                  `UPDATE build_jobs SET status = 'success', completed_at = NOW(), artifact_url = $1, artifact_size_bytes = $2, updated_at = NOW() WHERE id = $3 AND status != 'cancelled'`,
                  [url, sizeBytes, job.id]
                ));
              } catch (uploadErr: any) {
                if (process.env.SYNKRO_ALLOW_MOCK_ARTIFACT === 'true') {
                  console.warn(`[BUILD_WORKER] [WARNING] SYNKRO_ALLOW_MOCK_ARTIFACT is enabled. MinIO upload failed for job ${job.id}, falling back to mock URL:`, uploadErr);
                  await withWorkerRole(async (c) => c.query(
                    `UPDATE build_jobs SET status = 'success', completed_at = NOW(), artifact_url = $1, artifact_size_bytes = 0, updated_at = NOW() WHERE id = $2 AND status != 'cancelled'`,
                    ['https://example.com/mock-artifact-local-fallback.apk', job.id]
                  ));
                } else {
                  console.error(`[BUILD_WORKER] MinIO upload failed for job ${job.id}:`, uploadErr);
                  await withWorkerRole(async (c) => c.query(
                    `UPDATE build_jobs SET status = 'failed', completed_at = NOW(), error_log = COALESCE(error_log, '') || $1, updated_at = NOW() WHERE id = $2 AND status != 'cancelled'`,
                    [`[STORAGE] Artifact upload failed: ${uploadErr.message}\n`, job.id]
                  ));
                }
              }
            } else {
              await withWorkerRole(async (c) => c.query(
                `UPDATE build_jobs SET status = 'failed', completed_at = NOW(), error_log = COALESCE(error_log, '') || '[SYSTEM] Artifact extraction failed.\n', updated_at = NOW() WHERE id = $1 AND status != 'cancelled'`,
                [job.id]
              ));
            }
          } else if (!jobCancelled) {
            console.log(`[BUILD_WORKER] Job ${job.id} failed after ${buildDuration}ms.`);
            await withWorkerRole(async (c) => c.query(
              `UPDATE build_jobs SET status = 'failed', completed_at = NOW(), updated_at = NOW() WHERE id = $1 AND status != 'cancelled'`,
              [job.id]
            ));
          } else {
            console.log(`[BUILD_WORKER] Job ${job.id} exited due to user cancellation after ${buildDuration}ms.`);
          }
        } finally {
          if (cancelInterval) clearInterval(cancelInterval);
          sandbox?.forceKill();
          await cleanupBuildTempFiles({
            extractPath,
            localApkPath,
            sourceZipPath: job.source_path,
          });
        }
        
        if (isWorkerActive) {
          pollTimeout = setTimeout(poll, 0);
          pollTimeout.unref();
        }
      } else {
        if (isWorkerActive) {
          pollTimeout = setTimeout(poll, 3000);
          pollTimeout.unref();
        }
      }
    } catch (err) {
      console.error('[BUILD_WORKER] Error during polling:', err);
      if (isWorkerActive) {
        pollTimeout = setTimeout(poll, 5000);
        pollTimeout.unref();
      }
    }
  };

  poll();
}
