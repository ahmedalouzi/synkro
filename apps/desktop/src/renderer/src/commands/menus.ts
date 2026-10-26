import { useWorkspaceStore } from '../stores/workspace-store';
import { getCommand, isCommandEnabled, openRecent, runCommand } from './commands';

/**
 * Menu bar layout, following VS Code's MenubarFileMenu / MenubarEditMenu / … contributions.
 * A string is a command id, '-' is a separator.
 */
type MenuEntry =
  | string
  | { submenu: string; items: MenuEntry[] | (() => MenuEntry[]) }
  | { label: string; run: () => void; enabled?: boolean };

export interface TopMenu {
  id: string;
  label: string;
  /** Alt+<mnemonic> opens the menu. */
  mnemonic: string;
  items: MenuEntry[];
}

export type ResolvedMenuItem =
  | { kind: 'separator' }
  | { kind: 'item'; label: string; keybinding?: string; enabled: boolean; checked?: boolean; run: () => void }
  | { kind: 'submenu'; label: string; enabled: boolean; items: ResolvedMenuItem[] };

function recentItems(): MenuEntry[] {
  const { recentProjects, project } = useWorkspaceStore.getState();
  const entries: MenuEntry[] = recentProjects
    .filter((p) => p.path !== project?.path)
    .slice(0, 10)
    .map((p) => ({ label: `${p.name}  —  ${p.path}`, run: () => void openRecent(p.path) }));
  if (entries.length === 0) entries.push({ label: 'No Recent Folders', run: () => undefined, enabled: false });
  return entries;
}

export const MENUS: TopMenu[] = [
  {
    id: 'file', label: 'File', mnemonic: 'f',
    items: [
      'workbench.action.files.newUntitledFile',
      'peep.newProject',
      'workbench.action.newWindow',
      '-',
      'workbench.action.files.openFile',
      'workbench.action.files.openFolder',
      { submenu: 'Open Recent', items: recentItems },
      '-',
      'workbench.action.files.save',
      'workbench.action.files.saveAs',
      'workbench.action.files.saveAll',
      '-',
      'workbench.action.toggleAutoSave',
      '-',
      {
        submenu: 'Preferences',
        items: ['workbench.action.openSettings', 'workbench.view.extensions', '-', 'workbench.action.openGlobalKeybindings', '-', 'synkro.openProjectRules'],
      },
      '-',
      'workbench.action.files.revert',
      'workbench.action.closeActiveEditor',
      'workbench.action.closeAllEditors',
      'workbench.action.closeFolder',
      'workbench.action.closeWindow',
      '-',
      'workbench.action.quit',
    ],
  },
  {
    id: 'edit', label: 'Edit', mnemonic: 'e',
    items: [
      'undo',
      'redo',
      '-',
      'editor.action.clipboardCutAction',
      'editor.action.clipboardCopyAction',
      'editor.action.clipboardPasteAction',
      '-',
      'actions.find',
      'editor.action.startFindReplaceAction',
      '-',
      'workbench.action.findInFiles',
      'workbench.action.replaceInFiles',
      '-',
      'editor.action.commentLine',
      'editor.action.blockComment',
      '-',
      'synkro.inlineEdit',
    ],
  },
  {
    id: 'selection', label: 'Selection', mnemonic: 's',
    items: [
      'editor.action.selectAll',
      'editor.action.smartSelect.expand',
      'editor.action.smartSelect.shrink',
      '-',
      'editor.action.copyLinesUpAction',
      'editor.action.copyLinesDownAction',
      'editor.action.moveLinesUpAction',
      'editor.action.moveLinesDownAction',
      'editor.action.duplicateSelection',
      '-',
      'editor.action.insertCursorAbove',
      'editor.action.insertCursorBelow',
      'editor.action.insertCursorAtEndOfEachLineSelected',
      'editor.action.addSelectionToNextFindMatch',
      'editor.action.addSelectionToPreviousFindMatch',
      'editor.action.selectHighlights',
      '-',
      'editor.action.toggleColumnSelection',
    ],
  },
  {
    id: 'view', label: 'View', mnemonic: 'v',
    items: [
      'workbench.action.showCommands',
      '-',
      {
        submenu: 'Appearance',
        items: [
          'workbench.action.toggleFullScreen',
          '-',
          'workbench.action.toggleSidebarVisibility',
          'workbench.action.togglePanel',
          'peep.toggleChat',
          'peep.togglePreview',
          'workbench.action.toggleStatusbarVisibility',
          '-',
          'editor.action.toggleMinimap',
          '-',
          'workbench.action.zoomIn',
          'workbench.action.zoomOut',
          'workbench.action.zoomReset',
        ],
      },
      '-',
      'workbench.view.explorer',
      'workbench.view.search',
      'workbench.view.scm',
      'workbench.view.extensions',
      '-',
      'workbench.actions.view.problems',
      'workbench.action.output.toggleOutput',
      'workbench.action.terminal.toggleTerminal',
      '-',
      'editor.action.toggleWordWrap',
    ],
  },
  {
    id: 'go', label: 'Go', mnemonic: 'g',
    items: [
      'workbench.action.navigateBack',
      'workbench.action.navigateForward',
      '-',
      {
        submenu: 'Switch Editor',
        items: ['workbench.action.nextEditor', 'workbench.action.previousEditor'],
      },
      '-',
      'workbench.action.quickOpen',
      'editor.action.quickOutline',
      '-',
      'editor.action.revealDefinition',
      'editor.action.goToReferences',
      '-',
      'editor.action.gotoLine',
      'editor.action.jumpToBracket',
      '-',
      'editor.action.marker.nextInFiles',
      'editor.action.marker.prevInFiles',
    ],
  },
  {
    id: 'run', label: 'Run', mnemonic: 'r',
    items: [
      'peep.preview.start',
      'peep.preview.reload',
      'peep.preview.stop',
      '-',
      'peep.buildApk',
      'peep.publish',
    ],
  },
  {
    id: 'terminal', label: 'Terminal', mnemonic: 't',
    items: [
      'workbench.action.terminal.new',
      '-',
      'workbench.action.terminal.runActiveFile',
      'workbench.action.terminal.runSelectedText',
      'peep.buildApk',
      '-',
      'workbench.action.terminal.clear',
      'workbench.action.terminal.kill',
    ],
  },
  {
    id: 'help', label: 'Help', mnemonic: 'h',
    items: [
      'workbench.action.showCommands',
      'workbench.action.keybindingsReference',
      '-',
      'workbench.action.toggleDevTools',
      'workbench.action.reloadWindow',
      '-',
      'update.checkForUpdates',
      '-',
      'workbench.action.showAboutDialog',
    ],
  },
];

/** Resolves entries against the command registry, dropping leading/trailing/duplicate separators. */
export function resolveMenu(entries: MenuEntry[]): ResolvedMenuItem[] {
  const out: ResolvedMenuItem[] = [];
  for (const entry of entries) {
    if (entry === '-') {
      if (out.length > 0 && out[out.length - 1].kind !== 'separator') out.push({ kind: 'separator' });
    } else if (typeof entry === 'string') {
      const cmd = getCommand(entry);
      if (!cmd) continue;
      out.push({
        kind: 'item',
        label: cmd.title,
        keybinding: cmd.keybinding,
        enabled: isCommandEnabled(cmd),
        checked: cmd.checked?.(),
        run: () => runCommand(cmd.id),
      });
    } else if ('submenu' in entry) {
      const items = resolveMenu(typeof entry.items === 'function' ? entry.items() : entry.items);
      out.push({ kind: 'submenu', label: entry.submenu, enabled: items.some((i) => i.kind !== 'separator'), items });
    } else {
      out.push({ kind: 'item', label: entry.label, enabled: entry.enabled ?? true, run: entry.run });
    }
  }
  if (out[out.length - 1]?.kind === 'separator') out.pop();
  return out;
}
