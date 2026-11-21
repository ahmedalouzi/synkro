/**
 * PII & secret scrubber for Sentry events and breadcrumbs across main & renderer processes.
 *
 * Unlike the server-side scrubber in `@peep/agent/src/utils/sentry-scrubber.ts` (which replaces
 * full paths with `[REDACTED]/<filename>`), this scrubber preserves diagnostic path structure
 * (such as `OneDrive\Desktop\flutter\.pub-preload-cache`) while replacing OS user folder names
 * (`C:\Users\<name>\...`, `/Users/<name>/...`, `/home/<name>/...`) with `<user>`, and stripping
 * all tokens, API keys, JWTs, cookies, and secret fields.
 */

export interface SentryScrubOptions {
  /** Current OS username (e.g. `os.userInfo().username`), if known. */
  username?: string | null;
}

const SENSITIVE_KEY_PATTERN =
  /^(authorization|cookie|set-cookie|x-api-key|api[_-]?key|secret|secret[_-]?key|password|passwd|token|access[_-]?token|refresh[_-]?token|session[_-]?token|id[_-]?token|private[_-]?key|client[_-]?secret|sessiontoken|refreshtoken|aiproviderapikey)$/i;

const BEARER_PATTERN = /\b(Bearer\s+)([^\s'"`,;&}]+)/gi;
const KV_SECRET_PATTERN =
  /((?:session_?token|refresh_?token|access_?token|auth_?token|id_?token|api_?key|secret_?key|password|passwd|authorization)\s*[:=]\s*['"]?)([^\s'"`,;&}]+)/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const API_KEY_PATTERN =
  /\b(?:AIza[0-9A-Za-z\-_]{35}|sk-ant-[A-Za-z0-9\-_]{20,}|sk-(?:proj-|live-|test-)?[A-Za-z0-9\-_]{20,})\b/g;
const PROVIDER_TOKEN_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;

// Windows: C:\Users\<name>\... or C:/Users/<name>/...
const WIN_USER_BACKSLASH_PATTERN = /([A-Za-z]:\\Users\\)([^\\/\r\n"'`<>|]+)/gi;
const WIN_USER_SLASH_PATTERN = /([A-Za-z]:\/Users\/)([^\\/\r\n"'`<>|]+)/gi;
// macOS: /Users/<name>/...
const MAC_USER_PATTERN = /(\/Users\/)([^\\/\r\n"'`<>|]+)/g;
// Linux: /home/<name>/...
const LINUX_USER_PATTERN = /(\/home\/)([^\\/\r\n"'`<>|]+)/g;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scrubs tokens, API keys, JWTs, and OS usernames in file paths from an arbitrary string
 * while preserving the meaningful remainder of paths (e.g. `OneDrive\Desktop\flutter`).
 */
export function scrubPiiString(input: string, options?: SentryScrubOptions): string {
  if (!input) return input;

  let out = input;

  // 1. Strip credentials, JWTs, API keys, and tokens
  out = out.replace(BEARER_PATTERN, '$1[REDACTED]');
  out = out.replace(JWT_PATTERN, '[REDACTED_JWT]');
  out = out.replace(API_KEY_PATTERN, '[REDACTED_API_KEY]');
  out = out.replace(PROVIDER_TOKEN_PATTERN, '[REDACTED_TOKEN]');
  out = out.replace(KV_SECRET_PATTERN, '$1[REDACTED]');

  // 2. Replace OS user folder segments while preserving the rest of the path
  out = out.replace(WIN_USER_BACKSLASH_PATTERN, '$1<user>');
  out = out.replace(WIN_USER_SLASH_PATTERN, '$1<user>');
  out = out.replace(MAC_USER_PATTERN, '$1<user>');
  out = out.replace(LINUX_USER_PATTERN, '$1<user>');

  // 3. If the current OS username was provided, also scrub any custom path segment containing it
  const rawUser = options?.username?.trim();
  if (rawUser && rawUser.length >= 2 && rawUser !== '<user>') {
    const escaped = escapeRegex(rawUser);
    const segmentPattern = new RegExp(`([\\\\/])${escaped}(?=[\\\\/]|$)`, 'gi');
    out = out.replace(segmentPattern, '$1<user>');
  }

  return out;
}

/**
 * Recursively scrubs strings, arrays, and plain objects, redacting sensitive keys.
 */
export function scrubValue<T>(value: T, options?: SentryScrubOptions, seen = new WeakSet<object>()): T {
  if (typeof value === 'string') {
    return scrubPiiString(value, options) as unknown as T;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, options, seen)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = scrubValue(val, options, seen);
    }
  }
  return out as T;
}

/**
 * Scrubs a Sentry breadcrumb (message, category, and data payload).
 */
export function scrubSentryBreadcrumb<T extends Record<string, any>>(
  breadcrumb: T,
  options?: SentryScrubOptions,
): T {
  if (!breadcrumb || typeof breadcrumb !== 'object') return breadcrumb;
  const copy: Record<string, any> = { ...breadcrumb };
  if (typeof copy.message === 'string') {
    copy.message = scrubPiiString(copy.message, options);
  }
  if (typeof copy.category === 'string') {
    copy.category = scrubPiiString(copy.category, options);
  }
  if (copy.data && typeof copy.data === 'object') {
    copy.data = scrubValue(copy.data, options);
  }
  return copy as T;
}

function scrubStacktrace(stacktrace: Record<string, any> | undefined, options?: SentryScrubOptions): void {
  if (!stacktrace || !Array.isArray(stacktrace.frames)) return;
  stacktrace.frames = stacktrace.frames.map((frame: any) => {
    if (!frame || typeof frame !== 'object') return frame;
    const next = { ...frame };
    if (typeof next.filename === 'string') next.filename = scrubPiiString(next.filename, options);
    if (typeof next.abs_path === 'string') next.abs_path = scrubPiiString(next.abs_path, options);
    if (typeof next.function === 'string') next.function = scrubPiiString(next.function, options);
    if (typeof next.context_line === 'string') next.context_line = scrubPiiString(next.context_line, options);
    if (Array.isArray(next.pre_context)) {
      next.pre_context = next.pre_context.map((l: unknown) => (typeof l === 'string' ? scrubPiiString(l, options) : l));
    }
    if (Array.isArray(next.post_context)) {
      next.post_context = next.post_context.map((l: unknown) => (typeof l === 'string' ? scrubPiiString(l, options) : l));
    }
    if (next.vars && typeof next.vars === 'object') {
      next.vars = scrubValue(next.vars, options);
    }
    return next;
  });
}

/**
 * Scrubs a full Sentry event across message, exception stack frames, breadcrumbs,
 * request headers/data, user PII, extra, contexts, and tags.
 */
export function scrubSentryEvent<T extends Record<string, any>>(
  event: T,
  options?: SentryScrubOptions,
): T {
  if (!event || typeof event !== 'object') return event;
  const copy: Record<string, any> = { ...event };

  if (typeof copy.message === 'string') {
    copy.message = scrubPiiString(copy.message, options);
  }
  if (typeof copy.culprit === 'string') {
    copy.culprit = scrubPiiString(copy.culprit, options);
  }
  if (typeof copy.transaction === 'string') {
    copy.transaction = scrubPiiString(copy.transaction, options);
  }
  if (copy.logentry && typeof copy.logentry === 'object') {
    copy.logentry = scrubValue(copy.logentry, options);
  }

  // Strip request body/cookies and scrub headers/URL/query_string
  if (copy.request && typeof copy.request === 'object') {
    const req: Record<string, any> = { ...copy.request };
    delete req.data;
    delete req.cookies;
    if (typeof req.url === 'string') req.url = scrubPiiString(req.url, options);
    if (typeof req.query_string === 'string') {
      req.query_string = scrubPiiString(req.query_string, options);
    } else if (req.query_string && typeof req.query_string === 'object') {
      req.query_string = scrubValue(req.query_string, options);
    }
    if (req.headers && typeof req.headers === 'object') {
      req.headers = scrubValue(req.headers, options);
    }
    copy.request = req;
  }

  // Strip PII from user context
  if (copy.user && typeof copy.user === 'object') {
    const user: Record<string, any> = { ...copy.user };
    delete user.email;
    delete user.username;
    delete user.ip_address;
    copy.user = scrubValue(user, options);
  }

  // Scrub exceptions & stacktrace frames
  if (copy.exception && Array.isArray(copy.exception.values)) {
    copy.exception = {
      ...copy.exception,
      values: copy.exception.values.map((val: any) => {
        if (!val || typeof val !== 'object') return val;
        const nextVal = { ...val };
        if (typeof nextVal.value === 'string') nextVal.value = scrubPiiString(nextVal.value, options);
        if (typeof nextVal.type === 'string') nextVal.type = scrubPiiString(nextVal.type, options);
        if (nextVal.stacktrace && typeof nextVal.stacktrace === 'object') {
          nextVal.stacktrace = { ...nextVal.stacktrace };
          scrubStacktrace(nextVal.stacktrace, options);
        }
        return nextVal;
      }),
    };
  }

  // Scrub thread stacktraces
  if (copy.threads && Array.isArray(copy.threads.values)) {
    copy.threads = {
      ...copy.threads,
      values: copy.threads.values.map((thread: any) => {
        if (!thread || typeof thread !== 'object') return thread;
        const nextThread = { ...thread };
        if (nextThread.stacktrace && typeof nextThread.stacktrace === 'object') {
          nextThread.stacktrace = { ...nextThread.stacktrace };
          scrubStacktrace(nextThread.stacktrace, options);
        }
        return nextThread;
      }),
    };
  }

  // Scrub breadcrumbs
  if (Array.isArray(copy.breadcrumbs)) {
    copy.breadcrumbs = copy.breadcrumbs.map((bc: any) => scrubSentryBreadcrumb(bc, options));
  } else if (copy.breadcrumbs && Array.isArray(copy.breadcrumbs.values)) {
    copy.breadcrumbs = {
      ...copy.breadcrumbs,
      values: copy.breadcrumbs.values.map((bc: any) => scrubSentryBreadcrumb(bc, options)),
    };
  }

  // Scrub extra, contexts, tags
  if (copy.extra && typeof copy.extra === 'object') {
    copy.extra = scrubValue(copy.extra, options);
  }
  if (copy.contexts && typeof copy.contexts === 'object') {
    copy.contexts = scrubValue(copy.contexts, options);
  }
  if (copy.tags && typeof copy.tags === 'object') {
    copy.tags = scrubValue(copy.tags, options);
  }

  return copy as T;
}
