// One right-click / long-press menu for the whole app: openContextMenu(e, items) shows it at the pointer.
// items: { label, icon, onClick, danger, disabled, keys, hidden } or { divider: true }.
import { useEffect, useRef } from 'react';
import { store, useStore, toastError } from '../store.js';

export function openContextMenu(e, items) {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  const list = items.filter((i) => i && !i.hidden).filter((i, k, a) => !i.divider || (k > 0 && k < a.length - 1 && !a[k - 1].divider));
  if (!list.length) return;
  store.set({ contextMenu: { x: e?.clientX ?? innerWidth / 2, y: e?.clientY ?? innerHeight / 2, items: list } });
}

export const closeContextMenu = () => { if (store.get().contextMenu) store.set({ contextMenu: null }); };

/** Touch and pen: hold still for a moment → the menu (where the browser does not fire `contextmenu` itself). */
export function longPress(open, ms = 550) {
  let t = 0, at = null;
  const stop = () => { clearTimeout(t); at = null; };
  return {
    onPointerDown: (e) => {
      if (e.pointerType === 'mouse') return;
      at = { x: e.clientX, y: e.clientY };
      const ev = { clientX: e.clientX, clientY: e.clientY, target: e.target, preventDefault() {}, stopPropagation() {} };
      t = setTimeout(() => { if (at) { justPressed = Date.now(); open(ev); } }, ms);
    },
    onPointerMove: (e) => { if (at && Math.hypot(e.clientX - at.x, e.clientY - at.y) > 8) stop(); },
    onPointerUp: stop, onPointerCancel: stop,
  };
}
// The browser's own `contextmenu` that follows a long press is then not a second menu.
let justPressed = 0;
export const pressedJustNow = () => Date.now() - justPressed < 1200;

export function ContextMenuHost() {
  const menu = useStore((s) => s.contextMenu);
  const ref = useRef(null);
  useEffect(() => {
    if (!menu) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) closeContextMenu(); };
    const key = (e) => { if (e.key === 'Escape') closeContextMenu(); };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', key);
    window.addEventListener('blur', closeContextMenu);
    window.addEventListener('resize', closeContextMenu);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('blur', closeContextMenu);
      window.removeEventListener('resize', closeContextMenu);
    };
  }, [menu]);
  // Keep it on screen.
  useEffect(() => {
    const el = ref.current;
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(menu.x, innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, menu.y + r.height > innerHeight - 4 ? menu.y - r.height : menu.y)}px`;
  }, [menu]);
  if (!menu) return null;
  const run = async (it) => { closeContextMenu(); try { await it.onClick?.(); } catch (e) { toastError(e); } };
  const move = (e) => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const bs = [...ref.current.querySelectorAll('button:not(:disabled)')];
    const i = bs.indexOf(document.activeElement);
    bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length]?.focus();
  };
  return (
    <div ref={ref} className="context-menu" role="menu" style={{ left: menu.x, top: menu.y }} onKeyDown={move} onContextMenu={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}>
      {menu.items.map((it, i) => {
        if (it.divider) return <hr key={`d${i}`} />;
        const Icon = it.icon;
        return (
          <button key={it.label} role="menuitem" className={it.danger ? 'danger' : ''} disabled={it.disabled} onClick={() => run(it)}>
            {Icon ? <Icon size={15} /> : <span style={{ width: 15 }} />}<span className="grow">{it.label}</span>{it.keys && <kbd>{it.keys}</kbd>}
          </button>
        );
      })}
    </div>
  );
}
