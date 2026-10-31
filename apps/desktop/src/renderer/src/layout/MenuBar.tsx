import { useI18n } from '../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MENUS, resolveMenu, type ResolvedMenuItem } from '../commands/menus';
import { useWorkspaceStore } from '../stores/workspace-store';
import './MenuBar.css';

const isActionable = (item: ResolvedMenuItem) => item.kind !== 'separator' && item.enabled;

function nextActionable(items: ResolvedMenuItem[], from: number, delta: number): number {
  for (let step = 1; step <= items.length; step++) {
    const i = (from + delta * step + items.length * step) % items.length;
    if (isActionable(items[i])) return i;
  }
  return -1;
}

function Mnemonic({ label, mnemonic, show }: { label: string; mnemonic: string; show: boolean }) {
  const i = label.toLowerCase().indexOf(mnemonic);
  if (!show || i < 0) return <>{label}</>;
  return <>{label.slice(0, i)}<u>{label[i]}</u>{label.slice(i + 1)}</>;
}

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M14.43 3.85 6.1 12.2 1.57 7.67l.86-.86 3.67 3.67 7.47-7.48z" />
  </svg>
);

interface MenuListProps {
  items: ResolvedMenuItem[];
  focused: number;
  openSubmenu: number | null;
  subFocused: number;
  onHover: (index: number) => void;
  onSubHover: (index: number) => void;
  onActivate: (item: ResolvedMenuItem) => void;
  className?: string;
}

function MenuList({ items, focused, openSubmenu, subFocused, onHover, onSubHover, onActivate, className = '' }: MenuListProps) {
  return (
    <div className={`mb-dropdown ${className}`} role="menu">
      {items.map((item, i) => {
        if (item.kind === 'separator') return <div key={`sep-${i}`} className="mb-separator" role="separator" />;
        const isSubmenu = item.kind === 'submenu';
        return (
          <div key={`${item.label}-${i}`} className="mb-entry">
            <div
              role="menuitem"
              aria-disabled={!item.enabled}
              aria-haspopup={isSubmenu || undefined}
              className={`mb-item ${focused === i ? 'focused' : ''} ${item.enabled ? '' : 'disabled'}`}
              onMouseEnter={() => onHover(i)}
              onClick={() => onActivate(item)}
            >
              <span className="mb-check">{item.kind === 'item' && item.checked && <CheckIcon />}</span>
              <span className="mb-label">{item.label}</span>
              {item.kind === 'item' && item.keybinding && <span className="mb-keybinding" dir="ltr">{item.keybinding}</span>}
              {isSubmenu && <span className="mb-chevron">›</span>}
            </div>
            {isSubmenu && openSubmenu === i && (
              <MenuList
                items={item.items}
                focused={subFocused}
                openSubmenu={null}
                subFocused={-1}
                onHover={onSubHover}
                onSubHover={() => undefined}
                onActivate={onActivate}
                className="mb-submenu"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function MenuBar() {
  const { t } = useI18n();
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [focused, setFocused] = useState(-1);
  const [openSubmenu, setOpenSubmenu] = useState<number | null>(null);
  const [subFocused, setSubFocused] = useState(-1);
  const [altHeld, setAltHeld] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  // Re-render while open so "Open Recent" reflects freshly loaded projects.
  useWorkspaceStore((s) => s.recentProjects);

  const items = openIndex !== null ? resolveMenu(MENUS[openIndex].items, t) : [];
  const submenuItems = openSubmenu !== null && items[openSubmenu]?.kind === 'submenu'
    ? (items[openSubmenu] as Extract<ResolvedMenuItem, { kind: 'submenu' }>).items
    : [];

  const close = useCallback(() => {
    setOpenIndex(null);
    setFocused(-1);
    setOpenSubmenu(null);
    setSubFocused(-1);
  }, []);

  const open = useCallback((index: number, focusFirst = false) => {
    setOpenIndex(index);
    setOpenSubmenu(null);
    setSubFocused(-1);
    setFocused(focusFirst ? nextActionable(resolveMenu(MENUS[index].items, t), -1, 1) : -1);
    if (MENUS[index].id === 'file') {
      void window.peep.getRecentProjects().then((recent) => useWorkspaceStore.getState().setRecentProjects(recent));
    }
  }, []);

  const activate = useCallback((item: ResolvedMenuItem) => {
    if (item.kind === 'separator' || !item.enabled) return;
    if (item.kind === 'submenu') {
      const index = items.indexOf(item);
      if (index >= 0) {
        setOpenSubmenu(index);
        setSubFocused(nextActionable(item.items, -1, 1));
      }
      return;
    }
    close();
    item.run();
  }, [items, close]);

  // Close on outside click / window blur.
  useEffect(() => {
    if (openIndex === null) return;
    const onMouseDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) close();
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('blur', close);
    };
  }, [openIndex, close]);

  // Keyboard navigation while a menu is open (capture phase, so the editor doesn't see the keys).
  useEffect(() => {
    if (openIndex === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const inSub = openSubmenu !== null;
      const list = inSub ? submenuItems : items;
      const index = inSub ? subFocused : focused;
      const setIndex = inSub ? setSubFocused : setFocused;
      switch (e.key) {
        case 'Escape':
          if (inSub) setOpenSubmenu(null);
          else close();
          break;
        case 'ArrowDown':
          setIndex(nextActionable(list, index, 1));
          break;
        case 'ArrowUp':
          setIndex(nextActionable(list, index < 0 ? 0 : index, -1));
          break;
        case 'ArrowRight': {
          const item = items[focused];
          if (!inSub && item?.kind === 'submenu' && item.enabled) activate(item);
          else open((openIndex + 1) % MENUS.length, true);
          break;
        }
        case 'ArrowLeft':
          if (inSub) setOpenSubmenu(null);
          else open((openIndex - 1 + MENUS.length) % MENUS.length, true);
          break;
        case 'Enter':
        case ' ':
          if (list[index]) activate(list[index]);
          break;
        case 'Tab':
          close();
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [openIndex, items, submenuItems, focused, subFocused, openSubmenu, activate, open, close]);

  // Alt+<mnemonic> opens a menu; holding Alt underlines the mnemonics.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(true);
      if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const letter = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : '';
      const index = MENUS.findIndex((m) => m.mnemonic === letter);
      if (index >= 0) {
        e.preventDefault();
        open(index, true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(false);
    };
    const onBlur = () => setAltHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]);

  return (
    <div
      className="mb-bar"
      ref={barRef}
      role="menubar"
      // Keep focus where it was (e.g. in the editor) so Edit/Selection commands act on it.
      onMouseDown={(e) => e.preventDefault()}
    >
      {MENUS.map((menu, i) => (
        <div key={menu.id} className="mb-top">
          <div
            className={`menu-item ${openIndex === i ? 'active' : ''}`}
            role="menuitem"
            aria-haspopup
            aria-expanded={openIndex === i}
            onClick={() => (openIndex === i ? close() : open(i))}
            onMouseEnter={() => { if (openIndex !== null && openIndex !== i) open(i); }}
          >
            <Mnemonic label={t('menu.' + menu.id) || menu.label} mnemonic={menu.mnemonic} show={altHeld || openIndex !== null} />
          </div>
          {openIndex === i && (
            <MenuList
              items={items}
              focused={focused}
              openSubmenu={openSubmenu}
              subFocused={subFocused}
              onHover={(index) => {
                setFocused(index);
                const item = items[index];
                if (item.kind === 'submenu' && item.enabled) {
                  setOpenSubmenu(index);
                  setSubFocused(-1);
                } else {
                  setOpenSubmenu(null);
                }
              }}
              onSubHover={setSubFocused}
              onActivate={activate}
            />
          )}
        </div>
      ))}
    </div>
  );
}
