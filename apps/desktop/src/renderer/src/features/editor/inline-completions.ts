import type * as Monaco from 'monaco-editor';
import { useWorkspaceStore } from '../../stores/workspace-store';

/**
 * Tab autocomplete — AI ghost text in the editor (Cursor Tab / Copilot style).
 * Tab accepts, Ctrl+→ accepts word by word, Esc dismisses (Monaco's inline-suggest keybindings).
 */

const ENABLED_KEY = 'peep.editor.aiCompletions';
const DEBOUNCE_MS = 350;
const PREFIX_CHARS = 3000;
const SUFFIX_CHARS = 1000;

let enabled = (() => {
  try {
    return localStorage.getItem(ENABLED_KEY) !== 'off';
  } catch {
    return true;
  }
})();
const listeners = new Set<() => void>();

export function isAICompletionsEnabled(): boolean {
  return enabled;
}

export function toggleAICompletions(): void {
  enabled = !enabled;
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? 'on' : 'off');
  } catch {
    // Not persisted; still applies to this session.
  }
  if (!enabled) void window.peep.cancelInlineCompletion();
  listeners.forEach((l) => l());
}

/** useSyncExternalStore-compatible subscription for the status bar toggle. */
export function subscribeAICompletions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Only complete at the end of a line or before closing punctuation, not in the middle of a word. */
function cursorAllowsCompletion(lineAfterCursor: string): boolean {
  return /^[\s)\]}'"`;,>]*$/.test(lineAfterCursor);
}

let registered = false;

export function registerInlineCompletions(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerInlineCompletionsProvider('*', {
    async provideInlineCompletions(model, position, context, token) {
      const none = { items: [] };
      if (!enabled) return none;

      const filePath = useWorkspaceStore.getState().activeFilePath;
      if (!filePath || /^[a-z-]+:\/\//.test(filePath)) return none;

      const lineAfter = model.getLineContent(position.lineNumber).slice(position.column - 1);
      if (!cursorAllowsCompletion(lineAfter)) return none;

      // Wait for a pause in typing; Monaco cancels the token on the next keystroke.
      if (context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Automatic) {
        await sleep(DEBOUNCE_MS);
      }
      if (token.isCancellationRequested) return none;

      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const prefix = text.slice(Math.max(0, offset - PREFIX_CHARS), offset);
      const suffix = text.slice(offset, offset + SUFFIX_CHARS);
      if (prefix.trim().length < 3) return none;

      const insertText = await window.peep.inlineComplete({
        filePath,
        language: model.getLanguageId(),
        prefix,
        suffix,
      });
      if (token.isCancellationRequested || !insertText) return none;

      return {
        items: [{
          insertText,
          range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
        }],
      };
    },
    freeInlineCompletions() {
      // Nothing to release; completions are plain strings.
    },
  });
}
