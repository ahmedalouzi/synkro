import type { Terminal } from '@xterm/xterm';

/** Exposes the active terminal's output to other features (e.g. the chat's @Terminal mention). */
let activeTerminal: Terminal | null = null;

export function setActiveTerminal(term: Terminal | null): void {
  activeTerminal = term;
}

export function clearActiveTerminal(term: Terminal): void {
  if (activeTerminal === term) activeTerminal = null;
}

/** The last `maxLines` lines of the active terminal (scrollback included), or null if empty. */
export function getActiveTerminalOutput(maxLines = 200): string | null {
  const term = activeTerminal;
  if (!term) return null;
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = Math.max(0, buffer.length - maxLines); i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const text = lines.join('\n').trim();
  return text || null;
}
