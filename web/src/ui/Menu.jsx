import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { toastError } from '../store.js';

/** Dropdown menu. items: { label, icon, onClick, danger, submenu: items[] } */
export function Menu({ items, trigger, label, align = 'right', className = 'icon' }) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) { setOpen(false); setSub(null); } };
    const esc = (e) => { if (e.key === 'Escape') { setOpen(false); setSub(null); } };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const run = async (it) => {
    if (it.submenu) { setSub(sub === it.label ? null : it.label); return; }
    setOpen(false); setSub(null);
    try { await it.onClick?.(); } catch (e) { toastError(e); }
  };
  return (
    <div className="menu" ref={ref}>
      <button className={className} aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen((o) => !o)}>{trigger}</button>
      {open && (
        <div className={`menu-pop ${align}`} role="menu">
          {items.map((it) => {
            const Icon = it.icon;
            return (
              <div key={it.label}>
                <button role="menuitem" className={it.danger ? 'danger' : ''} onClick={() => run(it)} disabled={it.submenu && !it.submenu.length}>
                  {Icon ? <Icon size={15} /> : <span style={{ width: 15 }} />}<span>{it.label}</span>{it.submenu && <ChevronRight size={14} className="end" />}
                </button>
                {sub === it.label && <div className="submenu">{it.submenu.map((s) => <button key={s.label} role="menuitem" onClick={() => run(s)}>{s.label}</button>)}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
