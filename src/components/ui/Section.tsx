import { type ReactNode, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export function Section({
  title,
  children,
  defaultOpen = true,
  actions,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="z-section">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <button type="button" className="z-section__head" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {title}
        </button>
        {actions && <div style={{ paddingRight: 6, display: 'flex', gap: 2 }}>{actions}</div>}
      </div>
      {open && <div className="z-section__body">{children}</div>}
    </section>
  );
}
