/**
 * Error reports (Sentry), shared by the desktop app (main + renderer) and the server.
 *
 * Nothing here imports a Sentry SDK. Each process installs its reporter once (desktop main: @sentry/electron,
 * server: @sentry/node); without a reporter, or with reports turned off in Settings, a report is dropped.
 * Every report carries the same tags (category, framework, stage, app version, OS) so failures group by kind, and
 * every string in an event goes through the same scrubber before it leaves the machine.
 */

export type FailureCategory = 'preview' | 'cloud-build' | 'agent-tool' | 'usage-accounting';

export interface FailureReport {
  category: FailureCategory;
  /** What failed, in one short fixed line (it groups the reports: no ids, paths or user text). */
  title: string;
  /** 'flutter', 'react-native', … or undefined when it does not apply. */
  framework?: string;
  /** Where it failed: a build stage, a tool name. */
  stage?: string;
  /** The error itself; its message is scrubbed. */
  error?: unknown;
  /** Small extra facts (exit code, duration, a scrubbed log line). */
  extra?: Record<string, string | number | boolean>;
}

export type FailureReporter = (report: FailureReport) => void;

let reporter: FailureReporter | null = null;

/** Installs (or removes, with null) this process's reporter. */
export function setFailureReporter(next: FailureReporter | null): void {
  reporter = next;
}

/** Sends a report through the installed reporter. Never throws, never blocks. */
export function reportFailure(report: FailureReport): void {
  try {
    reporter?.(report);
  } catch {
    // Error reporting must never break the thing that failed.
  }
}

export interface ReportEnvironment {
  /** The app or server version, e.g. '0.1.3'. */
  appVersion: string;
  /** e.g. 'win32 10.0.26200 x64'. */
  os: string;
}

/** The tags every report carries. */
export function failureTags(report: FailureReport, env: ReportEnvironment): Record<string, string> {
  return {
    category: report.category,
    framework: report.framework || 'none',
    stage: report.stage || 'none',
    app_version: env.appVersion,
    os: env.os,
  };
}

/** Groups reports by what failed (not by the error text, which carries ids and paths). */
export function failureFingerprint(report: FailureReport): string[] {
  return [report.category, report.framework || 'none', report.stage || 'none', report.title];
}

// ── Scrubbing ────────────────────────────────────────────────────────────────

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Credentials inside URLs: https://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/g, '$1 [REDACTED]'],
  // key=value / "key": "value" for anything that names a secret.
  [/\b([\w-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|session|signature|dsn)[\w-]*)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, '$1$2[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED_API_KEY]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED_API_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED_API_KEY]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED_TOKEN]'],
  [/\b(?:sk|rk|pk|whsec)_(?:live|test)_[A-Za-z0-9]{10,}/g, '[REDACTED_API_KEY]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED_TOKEN]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_KEY_ID]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
];

/**
 * Removes secrets, e-mail addresses and local paths (which carry user and project names) from a string.
 * A path keeps only its last part: `C:\Users\Sam Lee\apps\shop\lib\main.dart` → `[REDACTED]/main.dart`.
 */
export function scrubString<T extends string | null | undefined>(input: T): T {
  if (!input) return input;
  let out: string = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  // A user folder may contain spaces ("C:\Users\Sam Lee\…"): the name goes first, then the path itself.
  out = out
    .replace(/\b([A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+)[^\\/\r\n]+/gi, '$1~')
    .replace(/(^|[\s"'(=:])\/(home|Users)\/[^/\r\n]+/g, '$1/$2/~')
    .replace(/(?:\b[A-Za-z]:[\\/]|\\\\|~[\\/]|(?<![\w:/])\/)[^\s"'`<>|]*[\\/]([^\s"'`<>|\\/]+)/g, '[REDACTED]/$1');
  return out as T;
}

const DROPPED_HEADERS = /^(authorization|cookie|set-cookie|session|x-api-key|x-auth-token|proxy-authorization)$/i;

function scrubDeep(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubDeep(v, depth + 1);
  return out;
}

/**
 * Scrubs a whole Sentry event in place and returns it: every string (message, exception values, breadcrumbs, extra,
 * contexts, tags), request bodies, cookies and auth headers removed, and nothing that names the user or the machine.
 * Stack frame file names keep only their last part.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scrubEvent<E extends Record<string, any>>(event: E): E {
  const e = event as Record<string, any>;
  if (typeof e.message === 'string') e.message = scrubString(e.message);
  if (e.message && typeof e.message === 'object' && typeof e.message.formatted === 'string') {
    e.message.formatted = scrubString(e.message.formatted);
  }
  for (const val of e.exception?.values ?? []) {
    if (typeof val.value === 'string') val.value = scrubString(val.value);
    for (const frame of val.stacktrace?.frames ?? []) {
      for (const key of ['filename', 'abs_path'] as const) {
        if (typeof frame[key] === 'string') frame[key] = scrubString(frame[key]);
      }
      delete frame.vars;
    }
  }
  for (const crumb of e.breadcrumbs ?? []) {
    if (typeof crumb.message === 'string') crumb.message = scrubString(crumb.message);
    if (crumb.data) crumb.data = scrubDeep(crumb.data, 0);
  }
  for (const key of ['extra', 'contexts', 'tags'] as const) {
    if (e[key]) e[key] = scrubDeep(e[key], 0);
  }
  if (e.request) {
    delete e.request.data;
    delete e.request.cookies;
    if (typeof e.request.query_string === 'string') e.request.query_string = '[REDACTED]';
    if (typeof e.request.url === 'string') e.request.url = scrubString(e.request.url.split('?')[0]);
    if (e.request.headers) {
      for (const h of Object.keys(e.request.headers)) {
        if (DROPPED_HEADERS.test(h)) delete e.request.headers[h];
      }
    }
  }
  // No account id, IP or e-mail, and not the machine's name.
  delete e.user;
  delete e.server_name;
  return event;
}
