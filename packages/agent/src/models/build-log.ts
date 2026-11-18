/**
 * Turns the sandbox's stdout/stderr stream into build-log lines. npm and Gradle write warnings, notes and
 * progress to stderr, so stderr is not an error signal: only lines that read as a real error get "[ERROR] ".
 * The Gradle wrapper's download progress (a long line of dots and percentages) becomes one short line.
 */

/** Lines that are a real failure, whichever stream they came on. */
const ERROR_LINE = /^(npm (ERR!|error\b)|FAILURE:|BUILD FAILED\b|\* What went wrong:|Execution failed for task\b|e: |error:|ERROR:|Error:|\S+:\d+(:\d+)?: error:|\S+:\d+(:\d+)?: fatal error:)/;

/** The Gradle wrapper's progress: "..........10%..........20%...". */
const PROGRESS_LINE = /^[.\s]*(\d{1,3}%[.\s]*)*$/;

/** A partial line longer than this is emitted as it is, so one never grows without bound. */
const MAX_PARTIAL = 64 * 1024;

/** The build filled its disk limit (--storage-opt), on any stream. */
const OUT_OF_DISK = /No space left on device|ENOSPC/i;

/** A Java stack frame ("\tat org.gradle.Foo.bar(Foo.java:12)") or the "... 42 more" that ends a cause. */
const JAVA_FRAME = /^\s+(at [\w$.<>/\-]+\(.*\)|\.\.\. \d+ more)\s*$/;

/** One log line as it goes into the build log. Exported for tests. */
export function formatBuildLogLine(line: string): string {
  const text = line.replace(/\r$/, '');
  if (text.length >= 3 && text.includes('.') && PROGRESS_LINE.test(text)) {
    const percents = text.match(/\d{1,3}%/g);
    return `Download progress: ${percents ? percents[percents.length - 1] : 'done'}`;
  }
  if (ERROR_LINE.test(text.trimStart()) && !text.startsWith('[')) return `[ERROR] ${text}`;
  return text;
}

/**
 * Splits each stream into whole lines (a chunk can end mid-line) and passes them on formatted, joined with
 * "\n" and without a trailing newline (the build worker adds one per call).
 *
 * Out of disk: once a line says "No space left on device", `outOfDisk` is set and the Java stack frames that follow
 * are left out. That failure is our server's limit, not the user's code, so they get Gradle's own summary and a plain
 * message (DockerSandbox.runBuild) instead of a long stack trace. Other failures keep their stack traces.
 */
export class BuildLogLines {
  private partial: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  private droppedFrames = 0;

  /** Some line said the disk limit was reached. */
  outOfDisk = false;

  constructor(private onLines: (text: string) => void) {}

  push(stream: 'stdout' | 'stderr', chunk: string): void {
    const text = this.partial[stream] + chunk;
    const lines = text.split('\n');
    let rest = lines.pop() ?? '';
    if (rest.length > MAX_PARTIAL) {
      lines.push(rest);
      rest = '';
    }
    this.partial[stream] = rest;
    this.emit(lines);
  }

  /** Emits what is left of both streams (call when the process exits). */
  flush(): void {
    const lines = [this.partial.stdout, this.partial.stderr].filter((l) => l.length > 0);
    this.partial = { stdout: '', stderr: '' };
    this.emit(lines);
  }

  private emit(lines: string[]): void {
    const kept: string[] = [];
    for (const line of lines) {
      if (OUT_OF_DISK.test(line)) this.outOfDisk = true;
      if (this.outOfDisk && JAVA_FRAME.test(line)) {
        // One note per run of hidden frames, not one per frame.
        if (this.droppedFrames++ === 0) kept.push('[SYSTEM] (Java stack trace hidden: the build ran out of disk space)');
        continue;
      }
      this.droppedFrames = 0;
      kept.push(formatBuildLogLine(line));
    }
    if (kept.length > 0) this.onLines(kept.join('\n'));
  }
}
