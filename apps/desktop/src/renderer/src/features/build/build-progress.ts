import type { CloudBuildFramework, CloudBuildJob } from '@peep/shared';

/**
 * The friendly side of a Cloud Build (BuildExperience.tsx): which stage the build is in, read from the "[STEP] ..."
 * lines the sandbox writes to the build log (docker-sandbox.ts), and a progress estimate that always moves forward.
 * Pure functions, no React: tested in packages/agent/tests/build-experience.test.ts.
 */

export type BuildStage = 'preparing' | 'installing' | 'compiling' | 'signing' | 'finishing';
export const BUILD_STAGES: BuildStage[] = ['preparing', 'installing', 'compiling', 'signing', 'finishing'];

/** Names of the steps the build log reports as done ("[STEP] npm install 1m42s" -> "npm install"). */
export function completedSteps(log: string | undefined): string[] {
  if (!log) return [];
  const steps: string[] = [];
  for (const m of log.matchAll(/^\[STEP\] (.+?) \d+m\d{2}s\s*$/gm)) steps.push(m[1]);
  return steps;
}

/** Gradle has started packaging and signing the APK (it runs inside the gradle step). */
const PACKAGING = /:app:(package|validateSigning)Release\b|Running Gradle task 'assembleRelease'\.\.\. *Done|Built build\/app\/outputs/;

/**
 * Stage of a queued or running build:
 * - queued: preparing (no queue position is shown to the user);
 * - running: installing packages until the project is ready for Android (expo prebuild / flutter create done),
 *   then compiling, then signing once Gradle packages the APK or the gradle step is done, and almost ready once
 *   the sandbox has finished (the worker then checks the signature and stores the APK).
 */
export function buildStage(job: Pick<CloudBuildJob, 'status'>, log: string | undefined): BuildStage {
  if (job.status === 'queued') return 'preparing';
  const done = completedSteps(log);
  if (done.includes('total')) return 'finishing';
  if (done.some((s) => s === 'gradle' || s.startsWith('gradle '))) return 'signing';
  if (log && PACKAGING.test(log)) return 'signing';
  if (done.includes('expo prebuild') || done.includes('flutter create')) return 'compiling';
  return 'installing';
}

/** Share of the ring each stage fills: [start, end). */
const STAGE_RANGE: Record<BuildStage, [number, number]> = {
  preparing: [0, 0.06],
  installing: [0.06, 0.3],
  compiling: [0.3, 0.86],
  signing: [0.86, 0.94],
  finishing: [0.94, 0.99],
};

/** Typical seconds per stage once the build runs (with the Gradle cache, DEC-08). */
const TYPICAL_SECONDS: Record<CloudBuildFramework, Record<Exclude<BuildStage, 'preparing'>, number>> = {
  'react-native': { installing: 150, compiling: 420, signing: 40, finishing: 25 },
  'flutter': { installing: 60, compiling: 360, signing: 30, finishing: 20 },
};

export interface ProgressInput {
  stage: BuildStage;
  /** Seconds since this stage started (as the app saw it). */
  stageElapsedSeconds: number;
  framework: CloudBuildFramework;
  /** While queued: the server's estimate until the build is done (GET /api/build/:id), if any. */
  queueEtaSeconds?: number | null;
  /** The value shown before: the estimate never goes backwards. */
  previous: number;
}

/** Expected seconds of a stage. Queued: the wait, i.e. the server's ETA minus this build's own typical time. */
function expectedSeconds(stage: BuildStage, framework: CloudBuildFramework, queueEtaSeconds?: number | null): number {
  if (stage !== 'preparing') return TYPICAL_SECONDS[framework][stage];
  const typical = TYPICAL_SECONDS[framework];
  const ownTotal = typical.installing + typical.compiling + typical.signing + typical.finishing;
  return queueEtaSeconds ? Math.max(queueEtaSeconds - ownTotal, 20) : 30;
}

/**
 * Progress from 0 to 0.99 (1 only when the build has succeeded). Inside a stage it eases towards the stage's end
 * (1 - e^(-1.5 t/T): ~78% of the stage at its typical time) and keeps creeping after that, so it never stands still
 * and never reaches the next stage's share before that stage starts. Never lower than `previous`.
 */
export function estimateProgress(input: ProgressInput): number {
  const [start, end] = STAGE_RANGE[input.stage];
  const expected = expectedSeconds(input.stage, input.framework, input.queueEtaSeconds);
  const t = Math.max(0, input.stageElapsedSeconds);
  const within = 1 - Math.exp((-1.5 * t) / expected);
  const value = start + (end - start) * within;
  return Math.min(0.99, Math.max(input.previous, value));
}

/** Which short explanation a failed build gets (BuildExperience). */
export type FailureKind = 'disk' | 'dependencies' | 'timeout' | 'generic';

export function failureKind(log: string | undefined): FailureKind {
  if (!log) return 'generic';
  if (/ran out of disk space on our server/.test(log)) return 'disk';
  if (/ERESOLVE|conflicting peer dependencies|npm (ERR!|error) code E/.test(log)) return 'dependencies';
  if (/Build timed out after/.test(log)) return 'timeout';
  return 'generic';
}

/** Something the build changed on its own that the user should know about (shown under the progress or failure text). */
export type BuildNotice = 'androidRegenerated';

export function buildNotices(log: string | undefined): BuildNotice[] {
  if (!log) return [];
  // docker-sandbox.ts FLUTTER_ANDROID_FN: an outdated (v1 embedding) or incomplete android/ was generated again.
  return /^\[SYSTEM\] android\/ was (outdated|incomplete) .*regenerated it$/m.test(log) ? ['androidRegenerated'] : [];
}
