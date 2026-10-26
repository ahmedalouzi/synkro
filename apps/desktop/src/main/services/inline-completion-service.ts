import type { InlineCompletionRequest } from '@peep/shared';
import type { DatabaseService } from './db';
import { createAIGateway } from './gateway-factory';

/**
 * Tab autocomplete (Cursor Tab / Copilot-style ghost text).
 * Sends the code around the cursor to the fast tier and returns the text to insert.
 */

// ~1k input tokens per request: enough context for a good completion at a fraction of the cost.
const MAX_PREFIX_CHARS = 3000;
const MAX_SUFFIX_CHARS = 1000;
const MAX_COMPLETION_LINES = 16;
const CACHE_SIZE = 64;

/** Client-side cost savings. Plan quotas are enforced by the server (packages/agent usage-limits.ts). */
const MIN_REQUEST_INTERVAL_MS = 1000;
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 10 * 60_000;

const SYSTEM_PROMPT = `You are a code completion engine inside an IDE, like GitHub Copilot or Cursor Tab.
You receive a file with a <CURSOR> marker. Reply with ONLY the exact text to insert at <CURSOR>:
- No explanations, no markdown fences, no repetition of code before or after the cursor.
- Continue the current line and, when natural, complete the rest of the statement or block.
- Match the file's language, indentation and style. Prefer short, high-confidence completions.
- If nothing useful should be inserted, reply with an empty message.`;

/** Removes markdown fences and any echo of the code that already follows the cursor. */
export function cleanCompletion(raw: string, prefix: string, suffix: string): string {
  let text = raw.replace(/^\s*```[\w-]*\n?/, '').replace(/\n?```\s*$/, '');
  if (text.includes('<CURSOR>')) text = text.slice(text.indexOf('<CURSOR>') + '<CURSOR>'.length);

  // The model sometimes repeats the start of the current line.
  const currentLine = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (currentLine.trim() && text.startsWith(currentLine)) text = text.slice(currentLine.length);

  // Drop the overlap with the text after the cursor (e.g. a closing bracket that already exists).
  const suffixHead = suffix.slice(0, 200);
  for (let len = Math.min(text.length, suffixHead.length); len > 0; len--) {
    if (text.endsWith(suffixHead.slice(0, len)) && suffixHead.slice(0, len).trim()) {
      text = text.slice(0, -len);
      break;
    }
  }

  const lines = text.split('\n');
  if (lines.length > MAX_COMPLETION_LINES) text = lines.slice(0, MAX_COMPLETION_LINES).join('\n');
  return text.trim() ? text.replace(/\s+$/, '') : '';
}

/** Last suggestion shown, so typing that matches it can be served without a new request. */
interface LastSuggestion {
  filePath: string;
  prefix: string;
  suffix: string;
  text: string;
}

export class InlineCompletionService {
  private inFlight: AbortController | null = null;
  private cache = new Map<string, string>();
  private last: LastSuggestion | null = null;
  private lastRequestAt = 0;
  private backoffUntil = 0;
  private backoffMs = BACKOFF_START_MS;

  constructor(private getDb: () => DatabaseService | null) {}

  /** If the user has typed the start of the current suggestion, returns the rest of it. */
  private continueLastSuggestion(filePath: string, prefix: string, suffix: string): string | null {
    const last = this.last;
    if (!last || last.filePath !== filePath || suffix !== last.suffix) return null;
    const anchor = last.prefix.slice(-200);
    for (let typed = 1; typed < last.text.length; typed++) {
      if (prefix.endsWith(anchor + last.text.slice(0, typed))) return last.text.slice(typed);
    }
    return null;
  }

  async complete(req: InlineCompletionRequest): Promise<string> {
    const prefix = req.prefix.slice(-MAX_PREFIX_CHARS);
    const suffix = req.suffix.slice(0, MAX_SUFFIX_CHARS);
    const key = `${req.filePath}\u0000${prefix.slice(-500)}\u0000${suffix.slice(0, 200)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const continued = this.continueLastSuggestion(req.filePath, prefix, suffix);
    if (continued !== null) return continued;

    const now = Date.now();
    if (now < this.backoffUntil || now - this.lastRequestAt < MIN_REQUEST_INTERVAL_MS) return '';

    // Only the latest request matters — typing more cancels the previous one.
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;

    const db = this.getDb();
    if (!db) return '';
    const resolved = createAIGateway(db, db.getSettingsRaw());
    if ('error' in resolved) return '';
    this.lastRequestAt = now;

    try {
      const response = await resolved.gateway.generate(
        {
          tier: 'fast',
          purpose: 'completion',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `File: ${req.filePath}\nLanguage: ${req.language}\n\n${prefix}<CURSOR>${suffix}`,
            },
          ],
        },
        { signal: controller.signal },
      );
      // A newer request replaced this one while it was running.
      if (controller.signal.aborted) return '';
      const text = cleanCompletion(response.content ?? '', prefix, suffix);
      this.cache.set(key, text);
      if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
      this.last = text ? { filePath: req.filePath, prefix, suffix, text } : null;
      this.backoffMs = BACKOFF_START_MS;
      return text;
    } catch (err) {
      if (!controller.signal.aborted) {
        // Quota, auth or network errors would otherwise repeat on every pause in typing.
        this.backoffUntil = Date.now() + this.backoffMs;
        console.warn(`[InlineCompletion] request failed, pausing ${this.backoffMs / 1000}s:`, (err as Error).message);
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
      }
      return '';
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  cancel(): void {
    this.inFlight?.abort();
    this.inFlight = null;
  }
}
