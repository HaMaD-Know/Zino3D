import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';

export type MenuEntry =
  | {
      kind?: 'item';
      label: string;
      icon?: LucideIcon;
      onSelect: () => void;
      disabled?: boolean;
      danger?: boolean;
      shortcut?: string;
    }
  | { kind: 'separator' }
  | { kind: 'label'; label: string };

interface MenuProps {
  anchor: HTMLElement | { x: number; y: number };
  entries: MenuEntry[];
  onClose: () => void;
}

/** Popup menu positioned next to an anchor element or point, kept on screen. */
export function Menu({ anchor, entries, onClose }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r =
      'getBoundingClientRect' in anchor
        ? anchor.getBoundingClientRect()
        : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = r.left;
    let top = r.bottom + 4;
    if (left + w > window.innerWidth - 8) left = Math.max(8, r.right - w);
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    setPos({ left, top });
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
        next?.focus();
        e.preventDefault();
      }
    };
    const t = setTimeout(() => window.addEventListener('pointerdown', onDown), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} className="z-menu" role="menu" style={pos}>
      {entries.map((entry, i) => {
        if (entry.kind === 'separator') return <div key={i} className="z-menu__sep" role="separator" />;
        if (entry.kind === 'label')
          return (
            <div key={i} className="z-menu__label">
              {entry.label}
            </div>
          );
        const Icon = entry.icon;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`z-menu__item ${entry.danger ? 'z-menu__item--danger' : ''}`}
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            {Icon ? <Icon size={15} aria-hidden /> : <span style={{ width: 15 }} />}
            {entry.label}
            {entry.shortcut && <kbd>{entry.shortcut}</kbd>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

/** Hook-style helper: renders a trigger and an attached menu. */
export function MenuButton({
  render,
  entries,
}: {
  render: (open: (el: HTMLElement) => void) => ReactNode;
  entries: MenuEntry[] | (() => MenuEntry[]);
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      {render((el) => setAnchor((a) => (a ? null : el)))}
      {anchor && (
        <Menu
          anchor={anchor}
          entries={typeof entries === 'function' ? entries() : entries}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}
