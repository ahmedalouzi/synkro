import { COMMANDS } from '../../commands/commands';
import './KeyboardHelp.css';

interface KeyboardHelpProps {
  open: boolean;
  onClose: () => void;
}

const SHORTCUTS = [
  ...[...COMMANDS.values()]
    .filter((c) => c.keybinding)
    .map((c) => ({ id: c.id, group: c.category ?? 'General', key: c.keybinding!, desc: c.title })),
  { id: 'chat.send',   group: 'AI Agent', key: 'Ctrl+Enter', desc: 'Send message' },
  { id: 'chat.cancel', group: 'AI Agent', key: 'Escape',     desc: 'Cancel agent' },
];

const groups = [...new Set(SHORTCUTS.map((s) => s.group))];

export function KeyboardHelp({ open, onClose }: KeyboardHelpProps) {
  if (!open) return null;
  return (
    <div className="kbd-overlay" onClick={onClose}>
      <div className="kbd-modal" onClick={(e) => e.stopPropagation()}>
        <div className="kbd-modal__header">
          <span className="kbd-modal__title">⌨ Keyboard Shortcuts</span>
          <button type="button" className="btn btn-ghost" onClick={onClose}>×</button>
        </div>

        <div className="kbd-modal__body">
          {groups.map((group) => (
            <div key={group} className="kbd-group">
              <div className="kbd-group__title">{group}</div>
              <div className="kbd-group__items">
                {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                  <div key={s.id} className="kbd-row">
                    <span className="kbd-desc">{s.desc}</span>
                    <kbd className="kbd-key">{s.key}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="kbd-modal__footer">
          <span>Press <kbd className="kbd-key-inline">Ctrl+K Ctrl+S</kbd> to open this panel · <kbd className="kbd-key-inline">Ctrl+Shift+P</kbd> for all commands</span>
        </div>
      </div>
    </div>
  );
}
