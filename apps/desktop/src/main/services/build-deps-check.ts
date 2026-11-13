import { spawn } from 'node:child_process';
import type { BuildDepsCheck } from '@peep/shared';
import { EXPO_DEPS_CHECK, NPM_PEERS_CHECK, isExpoProject, usesNpm } from './expo-deps';
import { cleanUserProjectEnv, windowsSpawnArgs } from './process-manager';

/**
 * The dependency check before a Cloud Build upload. The server installs with `npm ci`, which fails on a peer
 * dependency conflict (ERESOLVE) that the local preview never hits; finding it here takes seconds instead of a
 * failed build two minutes later. Only Expo projects that install with npm (what Cloud Build does).
 */

const CHECK_TIMEOUT_MS = 60_000;
const FIX_TIMEOUT_MS = 5 * 60_000;

function run(command: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  const [bin, ...args] = command.split(' ');
  const target = process.platform === 'win32' ? windowsSpawnArgs(bin, args) : { file: bin, args, verbatim: false };
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      // CI=1: report only, never prompt.
      child = spawn(target.file, target.args, {
        cwd, env: { ...cleanUserProjectEnv(), CI: '1' }, windowsHide: true, windowsVerbatimArguments: target.verbatim,
      });
    } catch (err: any) {
      resolve({ code: -1, output: String(err?.message ?? err) });
      return;
    }
    const timer = setTimeout(() => { child.kill(); output += `\n${command} timed out`; }, timeoutMs);
    child.stdout?.on('data', (d) => { output += d.toString(); });
    child.stderr?.on('data', (d) => { output += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, output: output + String(err.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, output }); });
  });
}

/** `npm ls --depth=0` lines for packages whose version does not satisfy what depends on them. Exported for tests. */
export function npmLsProblems(output: string): string[] {
  return output.split(/\r?\n/)
    .filter((line) => / invalid: |UNMET (PEER )?DEPENDENCY|\bmissing: /.test(line) && !/^npm (ERR!|error)/.test(line))
    .map((line) => line.replace(/^[\s│├└─+`|\\-]+/, '').trim())
    .filter(Boolean);
}

/** `npx expo install --check` lines for packages that do not match the Expo SDK. Exported for tests. */
export function expoCheckProblems(output: string): string[] {
  return output.split(/\r?\n/)
    .map((line) => /^\s*(\S+@\S+)\s+-\s+expected version:\s*(\S+)/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => `${m[1]} (the Expo SDK expects ${m[2]})`);
}

export async function checkBuildDeps(projectPath: string): Promise<BuildDepsCheck> {
  if (!(await isExpoProject(projectPath)) || !(await usesNpm(projectPath))) return { ok: true, problems: [] };
  const [peers, sdk] = await Promise.all([
    run(NPM_PEERS_CHECK, projectPath, CHECK_TIMEOUT_MS),
    run(EXPO_DEPS_CHECK, projectPath, CHECK_TIMEOUT_MS),
  ]);
  // A check that could not run (no npm, no node_modules yet, offline) does not block the build: the server
  // install reports the same problem, as before.
  const problems = [...(peers.code > 0 ? npmLsProblems(peers.output) : []), ...(sdk.code > 0 ? expoCheckProblems(sdk.output) : [])];
  return { ok: problems.length === 0, problems };
}

/** `npx expo install --fix`: every package the SDK knows to its expected version. Then checks again. */
export async function fixBuildDeps(projectPath: string): Promise<BuildDepsCheck> {
  const fix = await run('npx expo install --fix', projectPath, FIX_TIMEOUT_MS);
  const after = await checkBuildDeps(projectPath);
  if (fix.code !== 0 && after.ok) return after;
  return fix.code === 0 ? after : { ...after, fixError: fix.output.trim().split(/\r?\n/).slice(-6).join('\n') };
}
