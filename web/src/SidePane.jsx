// A second app next to the one in use, as in Halcyon (its components/SidePane.jsx). Kept on this device.
import { useEffect, useRef, useState } from 'react';
import { X, ExternalLink } from 'lucide-react';
import { store, useStore, localGet, localSet } from './store.js';

const KEY = 'beside';
const saved = () => { try { return JSON.parse(localGet(KEY) || 'null'); } catch { return null; } };

export const embedUrl = (origin, hash = '') => `${origin}/?embed=1${hash}`;
export function openBeside(title, url) {
  const v = { title, url, width: store.get().beside?.width || saved()?.width || 50 };
  localSet(KEY, JSON.stringify(v));
  store.set({ beside: v });
}

export function SidePane() {
  const pane = useStore((s) => s.beside);
  const [dragging, setDragging] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (!store.get().beside && saved()?.url) store.set({ beside: saved() }); }, []);
  if (!pane?.url) return null;
  const close = () => { localSet(KEY, JSON.stringify({ width: pane.width })); store.set({ beside: null }); };
  const drag = (e) => {
    e.preventDefault();
    setDragging(true);
    const app = ref.current.parentElement.getBoundingClientRect();
    const move = (m) => store.set({ beside: { ...store.get().beside, width: Math.min(75, Math.max(25, ((app.right - m.clientX) / app.width) * 100)) } });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setDragging(false); localSet(KEY, JSON.stringify(store.get().beside)); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  return (
    <aside className="side-pane" ref={ref} style={{ width: `${pane.width}%` }}>
      <div className="side-drag" onPointerDown={drag} title="Drag to resize" />
      <div className="side-head"><b className="grow">{pane.title}</b>
        <button className="icon small" title="Open in its own window" aria-label="Open in its own window" onClick={() => { window.open(pane.url.replace('?embed=1', ''), '_blank'); close(); }}><ExternalLink size={15} /></button>
        <button className="icon small" title="Close" aria-label="Close" onClick={close}><X size={16} /></button></div>
      <iframe title={pane.title} src={pane.url} style={{ pointerEvents: dragging ? 'none' : undefined }} />
    </aside>
  );
}
