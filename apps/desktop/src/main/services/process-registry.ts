import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** A process Atomvs started (preview, dev server, flutter run), as written to the registry file. */
export interface RecordedProcess {
  pid: number;
  /** When Atomvs started it (ms since 1970): with the PID, tells it apart from a later process that reuses the PID. */
  startedAt: number;
  command: string;
}

/**
 * The processes Atomvs started and that are still running, in a small JSON file in the app's data folder. If Atomvs
 * quits without stopping them (a crash, a forced quit), the next start stops exactly these, by PID, instead of every
 * dart.exe on the PC (the old startup kill by image name also stopped the user's own Flutter tools outside Atomvs).
 */
export class ProcessRegistry {
  constructor(private readonly file: string) {}

  read(): RecordedProcess[] {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(data)
        ? data.filter((p) => Number.isInteger(p?.pid) && p.pid > 0 && Number.isFinite(p?.startedAt) && typeof p?.command === 'string')
        : [];
    } catch {
      return [];
    }
  }

  add(entry: RecordedProcess): void {
    this.write([...this.read().filter((p) => p.pid !== entry.pid), entry]);
  }

  /** Removes these entries (same PID and start time); entries added since stay. */
  remove(entries: Pick<RecordedProcess, 'pid' | 'startedAt'>[]): void {
    const gone = (p: RecordedProcess) => entries.some((e) => e.pid === p.pid && e.startedAt === p.startedAt);
    this.write(this.read().filter((p) => !gone(p)));
  }

  private write(entries: RecordedProcess[]): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(entries));
    } catch (err) {
      console.error('[ProcessRegistry] Could not save the list of started processes:', err);
    }
  }
}

/** How far apart the recorded start and the running process's start may be (spawn vs. the OS's own clock). */
const START_TOLERANCE_MS = 10_000;

/**
 * Of the recorded processes, the PIDs still running as the same process: the PID exists and started within
 * START_TOLERANCE_MS of when Atomvs started it. A PID that Windows has since given to another program does not
 * match. `running` maps a PID to its start time (ms since 1970). Exported for tests.
 */
export function leftoverPids(recorded: RecordedProcess[], running: ReadonlyMap<number, number>): number[] {
  return recorded
    .filter((p) => running.has(p.pid) && Math.abs(running.get(p.pid)! - p.startedAt) <= START_TOLERANCE_MS)
    .map((p) => p.pid);
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, (_err, stdout) => resolve(String(stdout ?? '')));
  });
}

/** Start times of these PIDs (Windows, through PowerShell). Missing PIDs are left out. */
async function windowsStartTimes(pids: number[]): Promise<Map<number, number>> {
  const script = `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $([DateTimeOffset]::new($_.StartTime).ToUnixTimeMilliseconds())" }`;
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const times = new Map<number, number>();
  for (const m of out.matchAll(/^(\d+) (\d+)\s*$/gm)) times.set(Number(m[1]), Number(m[2]));
  return times;
}

/**
 * At startup (Windows): stops the processes a previous run of Atomvs left behind, each with its child processes
 * (taskkill /PID n /T /F), and nothing else. Returns the PIDs it stopped.
 */
export async function stopLeftoverProcesses(registry: ProcessRegistry): Promise<number[]> {
  const recorded = registry.read();
  if (recorded.length === 0) return [];
  const pids = leftoverPids(recorded, await windowsStartTimes(recorded.map((p) => p.pid)));
  for (const pid of pids) await run('taskkill', ['/PID', String(pid), '/T', '/F']);
  registry.remove(recorded);
  return pids;
}
