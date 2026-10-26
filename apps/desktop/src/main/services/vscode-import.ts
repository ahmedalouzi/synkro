import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { VsCodeSettingsImport } from '@peep/shared';

/** VS Code's user settings.json for this platform. */
function vsCodeSettingsPath(): string {
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'settings.json');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  return join(homedir(), '.config', 'Code', 'User', 'settings.json');
}

/** settings.json is JSONC: drop comments (outside strings) and trailing commas. */
export function parseJsonc(text: string): Record<string, unknown> {
  const withoutComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? '');
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, '$1');
  const parsed = JSON.parse(withoutTrailingCommas || '{}');
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/** Reads the VS Code settings Synkro supports (Auto Save, Word Wrap, Minimap). */
export async function readVsCodeSettings(): Promise<VsCodeSettingsImport> {
  const path = vsCodeSettingsPath();
  if (!existsSync(path)) return { found: false, path, settings: {} };

  const raw = parseJsonc(await readFile(path, 'utf8'));
  const settings: VsCodeSettingsImport['settings'] = {};

  const autoSave = raw['files.autoSave'];
  if (typeof autoSave === 'string') settings.autoSave = autoSave !== 'off';

  const wordWrap = raw['editor.wordWrap'];
  if (typeof wordWrap === 'string') settings.wordWrap = wordWrap !== 'off';

  const minimap = raw['editor.minimap.enabled'];
  if (typeof minimap === 'boolean') settings.minimap = minimap;

  return { found: true, path, settings };
}
