import type { Request } from 'express';

// Request logging without credentials. Session tokens must never reach the logs (CLAUDE.md rule 2):
// download/stream links carry ?token=, and the desktop sends Authorization and session headers.

const SECRET_QUERY_PARAMS = /([?&](?:token|session|access_token|refresh_token)=)[^&#]*/gi;

/** The URL with the value of any token-like query parameter replaced by ***. */
export function redactUrl(url: string): string {
  return url.replace(SECRET_QUERY_PARAMS, '$1***');
}

/** One line per request: method and URL, with credentials masked. */
export function requestLogLine(req: Pick<Request, 'method' | 'url'>): string {
  return `[REQUEST ARRIVED] ${req.method} ${redactUrl(req.url)}`;
}

/** Which credentials a request carries, never their values. */
export function authLogLine(req: Pick<Request, 'headers'>): string {
  const present = (name: string) => (req.headers[name] ? 'present' : 'none');
  return `Authorization: ${present('authorization')}  Session: ${present('session')}`;
}
