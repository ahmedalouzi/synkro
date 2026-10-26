import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import '../../layout/MenuBar.css';

export type ContextMenuItem =
  | '-'
  | { label: string; keybinding?: string; enabled?: boolean; run: () => void };

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/** Right-click menu styled like the menu bar dropdowns (VS Code context menu). */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="mb-dropdown"
      role="menu"
      style={{ position: 'fixed', left: pos.left, top: pos.top, minWidth: 200 }}
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item === '-' ? (
          <div key={`sep-${i}`} className="mb-separator" role="separator" />
        ) : (
          <div
            key={item.label}
            role="menuitem"
            aria-disabled={item.enabled === false}
            className={`mb-item ctx-item ${item.enabled === false ? 'disabled' : ''}`}
            onClick={() => {
              if (item.enabled === false) return;
              onClose();
              item.run();
            }}
          >
            <span className="mb-check" />
            <span className="mb-label">{item.label}</span>
            {item.keybinding && <span className="mb-keybinding">{item.keybinding}</span>}
          </div>
        ),
      )}
    </div>
  );
}
