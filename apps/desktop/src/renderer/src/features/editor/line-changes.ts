import { diffLines } from 'diff';

/** The same text with "\n" line ends: the editor's buffer and the agent's text may differ only in CRLF vs LF. */
export const lf = (text: string) => text.replace(/\r\n/g, '\n');

/** Line ranges [first, last] (1-based) removed from the old text and added in the new one. Exported for tests. */
export function lineChanges(oldText: string, newText: string): { removed: Array<[number, number]>; added: Array<[number, number]> } {
  const removed: Array<[number, number]> = [];
  const added: Array<[number, number]> = [];
  let oldLine = 1;
  let newLine = 1;
  for (const part of diffLines(lf(oldText), lf(newText))) {
    const n = part.count ?? part.value.split('\n').length - 1;
    if (part.added) { added.push([newLine, newLine + n - 1]); newLine += n; }
    else if (part.removed) { removed.push([oldLine, oldLine + n - 1]); oldLine += n; }
    else { oldLine += n; newLine += n; }
  }
  return { removed, added };
}
