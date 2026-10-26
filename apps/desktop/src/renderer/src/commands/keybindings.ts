import { COMMANDS, runCommand } from './commands';

/**
 * Global (workbench-level) keybinding dispatcher. Editor-only bindings are left
 * to Monaco, which handles them itself while it has focus.
 */

const CODE_KEYS: Record<string, string> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  PageUp: 'pageup', PageDown: 'pagedown', Home: 'home', End: 'end', Insert: 'insert',
  Delete: 'delete', Backspace: 'backspace', Enter: 'enter', Escape: 'escape', Tab: 'tab', Space: 'space',
};

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph']);

/** "Ctrl+Shift+`" → "ctrl+shift+`" with a canonical modifier order. */
function normalizeChord(chord: string): string {
  const parts = chord.split('+');
  // A trailing "+" key (e.g. "Ctrl++") splits into an empty last part.
  const key = (parts.pop() || '+').toLowerCase();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return [
    (mods.has('ctrl') || mods.has('cmd')) && 'ctrl',
    mods.has('shift') && 'shift',
    mods.has('alt') && 'alt',
    key,
  ].filter(Boolean).join('+');
}

function eventToChord(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  let key: string;
  if (e.code.startsWith('Key')) key = e.code.slice(3).toLowerCase();
  else if (e.code.startsWith('Digit')) key = e.code.slice(5);
  else if (e.code.startsWith('Numpad') || /^F\d+$/.test(e.code)) key = e.code.toLowerCase();
  else key = CODE_KEYS[e.code] ?? e.key.toLowerCase();
  return [
    (e.ctrlKey || e.metaKey) && 'ctrl',
    e.shiftKey && 'shift',
    e.altKey && 'alt',
    key,
  ].filter(Boolean).join('+');
}

const bindings = new Map<string, string>();
const chordPrefixes = new Set<string>();

for (const cmd of COMMANDS.values()) {
  if (cmd.editorKeybinding) continue;
  for (const kb of [cmd.keybinding, ...(cmd.altKeybindings ?? [])]) {
    // Alt+F4 is handled natively by the OS.
    if (!kb || kb === 'Alt+F4') continue;
    const chords = kb.split(' ').map(normalizeChord);
    bindings.set(chords.join(' '), cmd.id);
    if (chords.length > 1) chordPrefixes.add(chords[0]);
  }
}

let pendingChord: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;

function clearPending() {
  pendingChord = null;
  clearTimeout(pendingTimer);
}

/** Shell keys the terminal keeps even though they are also workbench bindings. */
const TERMINAL_KEEPS = new Set(['ctrl+w']);

/** True if the event (alone) is a workbench keybinding — lets the terminal skip it. */
export function isGlobalKeybinding(e: KeyboardEvent): boolean {
  const chord = eventToChord(e);
  return !!chord && !TERMINAL_KEEPS.has(chord) && (bindings.has(chord) || chordPrefixes.has(chord));
}

export function handleGlobalKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing) return;
  const chord = eventToChord(e);
  if (!chord) return;

  if (pendingChord) {
    const sequence = `${pendingChord} ${chord}`;
    clearPending();
    e.preventDefault();
    const id = bindings.get(sequence);
    if (id) runCommand(id);
    return;
  }

  if (chordPrefixes.has(chord)) {
    e.preventDefault();
    pendingChord = chord;
    pendingTimer = setTimeout(clearPending, 2000);
    return;
  }

  const id = bindings.get(chord);
  if (id) {
    e.preventDefault();
    runCommand(id);
  }
}
