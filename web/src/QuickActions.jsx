// Frequent actions within one tap on phones and tablets, and the camera offered when another device asks for a photo.
import { useEffect, useState } from 'react';
import { Camera, X, FilePlus2, PenLine, Search, Image, Zap } from 'lucide-react';
import { post } from './api.js';
import { store, useStore, openNote, toastError, currentSpace, findNote } from './store.js';
import { onEvent } from './data.js';
import { TAB, touchDevice, pickPhoto, sendPhoto, captureTarget } from './capture.js';
import { newPage, openToday } from './Sidebar.jsx';

export function useNarrow(px = 700) {
  const q = `(max-width: ${px}px)`;
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [q]);
  return narrow;
}

/** A new page holding just this photo, in the current space. */
async function photoAsPage(camera) {
  const file = await pickPhoto({ camera });
  if (!file) return;
  const s = currentSpace();
  try {
    const title = `Photo ${new Date().toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
    const n = await post('/api/notes', { spaceId: s.id, title, icon: '📷' });
    await sendPhoto(file, n, { wait: false });
    openNote(n.id);
  } catch (e) { toastError(e); }
}

/** Round button bottom right on touch screens and narrow windows. */
export function QuickActions() {
  const route = useStore((s) => s.route);
  const narrow = useNarrow(800);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(undefined);
  const show = (touchDevice() || narrow) && !['settings'].includes(route.name);
  useEffect(() => { if (open) { setTarget(undefined); captureTarget().then(setTarget); } }, [open]);
  useEffect(() => setOpen(false), [route]);
  if (!show) return null;
  const here = route.name === 'n' ? route.id : null;
  const go = (fn) => async () => { setOpen(false); try { await fn(); } catch (e) { toastError(e); } };
  const elsewhere = target && target.id !== here ? target : null;
  const items = [
    elsewhere && { icon: Camera, label: <>Photo to <b>{elsewhere.icon} {elsewhere.title || 'Untitled'}</b></>, hint: 'the page you are working on elsewhere', primary: true, run: () => pickPhoto().then((f) => sendPhoto(f, elsewhere)) },
    here && { icon: Camera, label: 'Photo into this page', primary: !elsewhere, run: () => pickPhoto().then((f) => sendPhoto(f, findNote(here) || { id: here })) },
    { icon: Image, label: 'Photo as a new page', run: () => photoAsPage(true) },
    { icon: FilePlus2, label: 'New page', run: () => newPage() },
    { icon: PenLine, label: "Today's journal", run: openToday },
    { icon: Search, label: 'Search', run: () => store.set({ palette: true }) },
  ].filter(Boolean);
  return (
    <>
      {open && <div className="qa-scrim" onClick={() => setOpen(false)} />}
      {open && (
        <div className="qa-menu" role="menu" aria-label="Quick actions">
          {target === undefined && <div className="muted small qa-wait"><span className="spinner" /> Looking for the page you work on…</div>}
          {items.map((it, i) => (
            <button key={i} role="menuitem" className={it.primary ? 'qa-item lead' : 'qa-item'} onClick={go(it.run)}>
              <it.icon size={18} /><span className="grow">{it.label}{it.hint && <span className="qa-hint">{it.hint}</span>}</span>
            </button>
          ))}
        </div>
      )}
      <button className="qa-fab" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Quick actions" title="Quick actions">{open ? <X size={22} /> : <Zap size={22} />}</button>
    </>
  );
}

/** When another device of this user asks for a photo, a phone or tablet offers its camera. */
export function CaptureSheet() {
  const [req, setReq] = useState(null);
  useEffect(() => onEvent((m) => {
    if (m.type === 'capture:request' && m.from !== TAB && touchDevice()) setReq({ ...m, at: Date.now() });
  }), []);
  useEffect(() => { if (!req) return undefined; const t = setTimeout(() => setReq(null), 3 * 60000); return () => clearTimeout(t); }, [req]);
  if (!req) return null;
  const note = { id: req.noteId, title: req.title };
  const take = (camera) => async () => { const f = await pickPhoto({ camera }); if (f) { setReq(null); await sendPhoto(f, note); } };
  return (
    <div className="capture-sheet" role="dialog" aria-label="Photo for another device">
      <div className="capture-title">📷 Photo for <b>{req.icon} {req.title || 'Untitled'}</b></div>
      <p className="muted small">Your other device asked for a picture; it appears where its cursor is.</p>
      <div className="capture-buttons">
        <button className="primary big" onClick={take(true)}><Camera size={20} /> Take photo</button>
        <button onClick={take(false)}><Image size={16} /> From gallery</button>
        <button onClick={() => setReq(null)}><X size={16} /> Not now</button>
      </div>
    </div>
  );
}
