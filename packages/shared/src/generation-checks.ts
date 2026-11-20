/**
 * Cheap checks on what the agent generates, shared by the engine (main process) and the window.
 *
 * - Dart strings with an escaped interpolation: `'\${total.toStringAsFixed(2)}'` shows that text literally instead of
 *   the price (`\$` is a literal dollar sign, so `{…}` is no longer interpolated). The analyzer accepts it.
 * - Flutter error reports from the preview (FlutterError: a RenderFlex overflow, an unbounded height): one line each,
 *   with the fix that usually applies.
 * - Once per failure: the same failure is sent to the agent once (a second click, a second report of the same
 *   overflow with a different pixel count, and a run already in progress never send it again).
 */

export interface EscapedInterpolation {
  line: number;
  text: string;
}

/** The correct way to show a price with a dollar sign in Dart. */
export const DART_PRICE_PATTERN = "'\\$${value.toStringAsFixed(2)}'";

/**
 * Lines of a Dart file with `\${` (an escaped, so dead, interpolation) outside comments. Exported for tests.
 * `'\$${price}'` (a literal $ followed by an interpolation) is correct and not reported.
 */
export function escapedDartInterpolations(source: string): EscapedInterpolation[] {
  const found: EscapedInterpolation[] = [];
  const lines = source.split(/\r?\n/);
  let inBlockComment = false;
  lines.forEach((raw, i) => {
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end < 0) return;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    // Block comments that start here (a /* inside a string is rare enough to ignore).
    line = line.replace(/\/\*[\s\S]*?\*\//g, '');
    const open = line.indexOf('/*');
    if (open >= 0) {
      line = line.slice(0, open);
      inBlockComment = true;
    }
    // A line comment: // outside a URL-like string (https://…).
    const comment = line.search(/(^|[^:'"])\/\//);
    if (comment >= 0) line = line.slice(0, comment + 1);
    if (/\\\$\{/.test(line)) found.push({ line: i + 1, text: raw.trim().slice(0, 160) });
  });
  return found;
}

/** The message for the agent about escaped interpolations in one file. */
export function escapedInterpolationMessage(relPath: string, found: EscapedInterpolation[]): string {
  const where = found.slice(0, 5).map((f) => `  ${relPath}:${f.line}: ${f.text}`).join('\n');
  return `${relPath} has \`\\\${…}\` inside a string (${found.length}x): Dart shows that text literally (the backslash escapes the $, `
    + `so the expression is not interpolated). Remove the backslash before \${; for a price with a dollar sign write ${DART_PRICE_PATTERN}.\n${where}`;
}

/** The usual fix for a Flutter error report, or ''. */
export function flutterErrorHint(summary: string): string {
  if (/RenderFlex overflowed/i.test(summary)) {
    return 'Fix: in that Row/Column, wrap long text and prices in Flexible or Expanded with maxLines and '
      + 'overflow: TextOverflow.ellipsis (or make the content scroll); bottom bars must fit a 360 px wide screen.';
  }
  if (/unbounded (height|width)|Vertical viewport was given unbounded height|Horizontal viewport was given unbounded width/i.test(summary)) {
    return 'Fix: a scrollable (ListView, GridView) inside a Column/Row has no bounded size: wrap it in Expanded, '
      + 'or give it a fixed height, or use shrinkWrap: true with NeverScrollableScrollPhysics inside an outer scroll view.';
  }
  if (/RenderBox was not laid out|hasSize/i.test(summary)) {
    return 'Fix: this follows another layout error (usually unbounded size or an overflow just before it); fix that one first.';
  }
  if (/setState\(\) or markNeedsBuild\(\) called during build/i.test(summary)) {
    return 'Fix: do not call setState during build; move it to a callback or WidgetsBinding.instance.addPostFrameCallback.';
  }
  return '';
}

/** A Flutter error from the preview, with its hint, for the agent. */
export function describeFlutterError(entry: string): string {
  const hint = flutterErrorHint(entry);
  return hint ? `${entry} ${hint}` : entry;
}

/**
 * What makes two reports "the same failure": numbers (pixels, line and column of a stack, ids) and whitespace do not
 * count, so "overflowed by 204 pixels" and "overflowed by 198 pixels" in the same widget are one failure.
 */
export function failureSignature(text: string): string {
  return text.replace(/\d+(\.\d+)?/g, 'N').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 500);
}

/** Remembers which failures were already sent to the agent. */
export class OncePerFailure {
  private readonly sent = new Set<string>();

  constructor(private readonly limit = Infinity) {}

  /** True the first time a failure is seen (and records it); false for a repeat or once the limit is reached. */
  claim(text: string): boolean {
    const key = failureSignature(text);
    if (!key || this.sent.has(key) || this.sent.size >= this.limit) return false;
    this.sent.add(key);
    return true;
  }

  /** The failures not sent yet (does not record them). */
  fresh(texts: string[]): string[] {
    const seen = new Set<string>();
    return texts.filter((t) => {
      const key = failureSignature(t);
      if (!key || this.sent.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Claims the failures not sent yet (up to the limit) and returns them. */
  claimAll(texts: string[]): string[] {
    return this.fresh(texts).filter((t) => this.claim(t));
  }

  get count(): number {
    return this.sent.size;
  }

  reset(): void {
    this.sent.clear();
  }
}

/**
 * "Auto-Fix Build" for a failed preview: one request per failure. A failure is one time the preview ends in an error
 * (Retry and a new failure allow it again); a second click, a double click, or a click while the agent is still
 * working never sends it again.
 */
export class FailureGate {
  private failure = 0;
  private sentFor = 0;

  /** The preview just failed (again). */
  noteFailure(): void {
    this.failure++;
  }

  /** True once per failure, and never while the agent is busy. */
  claim(agentBusy: boolean): boolean {
    if (agentBusy || this.failure === 0 || this.sentFor === this.failure) return false;
    this.sentFor = this.failure;
    return true;
  }

  /** The current failure was already sent to the agent. */
  get sent(): boolean {
    return this.failure > 0 && this.sentFor === this.failure;
  }
}

/** The message for Flutter errors the preview reported (sent once each, see OncePerFailure). */
export function runtimeFixMessage(errors: string[]): string {
  return 'The running preview reported Flutter errors on screen (the user sees broken layout). Fix each one in the code, '
    + 'then call restart_preview and confirm they are gone:\n'
    + errors.map((e) => `- ${describeFlutterError(e)}`).join('\n');
}
