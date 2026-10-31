import { type ReactNode, createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastApi {
  show: (kind: ToastKind, text: string) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (kind: ToastKind, text: string) => {
      const id = nextId.current++;
      setItems((list) => {
        // Collapse identical consecutive messages.
        if (list.length && list[list.length - 1].text === text) return list;
        return [...list.slice(-3), { id, kind, text }];
      });
      const ms = kind === 'error' ? 9000 : kind === 'warning' ? 7000 : 3200;
      setTimeout(() => dismiss(id), ms);
    },
    [dismiss],
  );
  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="z-toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`z-toast z-toast--${t.kind}`}>
            <p>{t.text}</p>
            <button
              type="button"
              className="z-icon-btn z-icon-btn--sm"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
