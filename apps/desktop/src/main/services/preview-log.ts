import type { PreviewSession, PreviewRuntimeReport } from '@peep/shared';

/** The preview's recent output (Expo/Metro, Flutter), kept so the agent can read it. Capped, oldest dropped. */
export class PreviewLog {
  private text = '';

  constructor(private readonly maxChars = 200_000) {}

  clear(): void {
    this.text = '';
  }

  add(chunk: string): void {
    this.text += chunk.endsWith('\n') ? chunk : `${chunk}\n`;
    if (this.text.length > this.maxChars) this.text = this.text.slice(-this.maxChars);
  }

  get(): string {
    return this.text;
  }
}

/** Metro / Flutter output that marks a finished bundle or a failure. */
const BUNDLE_DONE = /\bBundled\b|bundling failed|\berror\b|ERR_[A-Z_]+|Application finished|Flutter run key commands/i;

/**
 * After a (re)start: waits while the server runs until its output shows a finished bundle or an error, so a
 * report reflects the new run, not a server that is still bundling. Gives up after `timeoutMs`.
 */
export async function waitForBundle(
  status: () => string | undefined, output: () => string, timeoutMs = 30_000, intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = status();
    if (s !== 'running' && s !== 'starting') return;
    if (s === 'running' && BUNDLE_DONE.test(output())) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Lines that report a failure in Metro, Expo, Node or Flutter output. */
const ERROR_LINE = /\b(error|failed|cannot find|unable to resolve|not defined by "exports"|exception)\b|ERR_[A-Z_]+/i;

// ANSI colour codes from the dev servers.
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * What the agent sees from the preview: its state, the error lines and the end of its output. The agent uses
 * this after a fix to check whether the error is really gone before it says so. Exported for tests.
 */
export function formatPreviewReport(
  session: PreviewSession | null, output: string, runtime: PreviewRuntimeReport | null = null, tailChars = 12_000,
): string {
  if (!session || session.status === 'stopped') {
    return 'Preview: not running. Call restart_preview to start it, then read its output.';
  }
  const clean = output.replace(ANSI, '');
  const errors = clean.split(/\r?\n/).filter((line) => ERROR_LINE.test(line)).slice(-15);
  const parts = [`Preview: ${session.status}${session.url ? ` at ${session.url}` : ''}`];
  if (session.error) parts.push(`Start error: ${session.error.replace(ANSI, '').slice(-4000)}`);
  parts.push(errors.length
    ? `Error lines in the output (${errors.length}, most recent last):\n${errors.join('\n')}`
    : 'No error lines in the output.');
  // The page itself: a bundle that builds can still crash in the browser or show nothing.
  if (session.status === 'running') {
    if (!runtime) {
      parts.push('Page: no report from the app page yet (not loaded yet, or the Preview pane is hidden).');
    } else {
      parts.push(runtime.rendered
        ? `Page: visible content yes (${runtime.textChars} characters of text).`
        : 'Page: visible content NO: the screen is empty (blank or black).');
      if (runtime.errors.length) {
        parts.push(`Runtime errors in the page (${runtime.errors.length}, most recent last):\n`
          + runtime.errors.map((e) => `[${e.kind}] ${e.message}`).join('\n'));
      } else {
        parts.push('No runtime errors in the page.');
      }
      if (runtime.overlay) parts.push(`Error overlay on screen:\n${runtime.overlay}`);
    }
  }
  const tail = clean.length > tailChars ? `…${clean.slice(-tailChars)}` : clean;
  parts.push(`Output (end):\n${tail.trim() || '(no output yet)'}`);
  return parts.join('\n\n');
}
