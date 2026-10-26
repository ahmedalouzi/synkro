import type { InlineEditRequest, InlineEditResult } from '@peep/shared';
import type { DatabaseService } from './db';
import { createAIGateway } from './gateway-factory';
import { loadProjectRules } from './project-rules';

/**
 * Ctrl+K inline edit (Cursor's "Edit" prompt): rewrites the selected lines — or
 * generates code at the cursor — following a natural-language instruction.
 */

const MAX_BEFORE_CHARS = 8000;
const MAX_AFTER_CHARS = 4000;

const SYSTEM_PROMPT = `You are an expert programmer editing code inside an IDE.
You receive a file where the region to rewrite is wrapped in <SELECTION> ... </SELECTION>
(it may be empty: then write new code to insert at that spot), and an instruction.
Reply with ONLY the new code that replaces the whole <SELECTION> region:
- No explanations and no markdown fences.
- Keep the surrounding indentation and the file's style; do not repeat code outside the selection.
- Return complete lines. If the instruction cannot apply, return the original selection unchanged.`;

export function stripFences(text: string): string {
  const fenced = /^\s*```[\w-]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(text);
  return (fenced ? fenced[1] : text).replace(/<\/?SELECTION>/g, '');
}

export class InlineEditService {
  private inFlight: AbortController | null = null;

  constructor(private getDb: () => DatabaseService | null) {}

  async edit(req: InlineEditRequest): Promise<InlineEditResult> {
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;

    const db = this.getDb();
    if (!db) return { error: 'Database not ready' };
    const settings = db.getSettingsRaw();
    const resolved = createAIGateway(db, settings);
    if ('error' in resolved) return { error: resolved.error };

    const before = req.before.slice(-MAX_BEFORE_CHARS);
    const after = req.after.slice(0, MAX_AFTER_CHARS);
    try {
      const response = await resolved.gateway.generate(
        {
          tier: settings.capabilityTier || 'fast',
          manualModel: settings.apiModel,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT + (req.projectPath ? await loadProjectRules(req.projectPath, req.filePath) : '') },
            {
              role: 'user',
              content:
                `File: ${req.filePath}\nLanguage: ${req.language}\n\n` +
                `${before}<SELECTION>${req.selection}</SELECTION>${after}\n\n` +
                `Instruction: ${req.instruction}`,
            },
          ],
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return { error: 'cancelled' };
      return { text: stripFences(response.content ?? '') };
    } catch (err) {
      if (controller.signal.aborted) return { error: 'cancelled' };
      return { error: (err as Error).message || 'Request failed' };
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  cancel(): void {
    this.inFlight?.abort();
    this.inFlight = null;
  }
}
