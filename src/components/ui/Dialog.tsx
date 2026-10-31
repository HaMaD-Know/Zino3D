import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { IconButton } from './Button';

export interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Prevent closing via backdrop/Escape (e.g. while an operation runs). */
  locked?: boolean;
}

/** Accessible modal dialog: focus moves inside, Escape closes, focus returns on close. */
export function Dialog({ title, onClose, children, footer, wide, locked }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusable = el?.querySelector<HTMLElement>('input, select, textarea, button:not([data-close])');
    (focusable ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !locked) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [onClose, locked]);

  return createPortal(
    <div
      className="z-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !locked) onClose();
      }}
    >
      <div
        ref={ref}
        className={`z-dialog ${wide ? 'z-dialog--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="z-dialog__head">
          <h2>{title}</h2>
          <IconButton icon={X} label="Close" onClick={onClose} disabled={locked} data-close />
        </div>
        <div className="z-dialog__body">{children}</div>
        {footer && <div className="z-dialog__foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
