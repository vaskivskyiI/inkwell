// What another app shared with Inkwell (the phone's share sheet) or a photo taken from the app's shortcut: into the
// page being worked on elsewhere, or a new page.
import { useEffect, useState } from 'react';
import { Camera, FilePlus2, FileText, Image, Link2, Send } from 'lucide-react';
import { post, upload } from './api.js';
import { useStore, openNote, toast, toastError, currentSpace } from './store.js';
import { loadTree } from './data.js';
import { captureTarget, pickPhoto, sendPhoto } from './capture.js';
import { takeShared, clearShared } from './pwa.js';

const isImage = (f) => /^image\//.test(f.type);
const titleOf = (s) => s.title || s.text?.split('\n')[0].slice(0, 80) || (s.url && new URL(s.url).hostname) || s.files[0]?.name?.replace(/\.[^.]+$/, '') || 'Shared';

/** Images go where the page's device puts them (its cursor, or the paper); text, links and other files go below. */
async function addTo(note, shared, { fresh = false } = {}) {
  const lines = [];
  if (shared.text && shared.text !== shared.title) lines.push(shared.text);
  if (shared.url && !shared.text?.includes(shared.url)) lines.push(`[${shared.title || shared.url}](${shared.url})`);
  for (const f of shared.files.filter((x) => !isImage(x))) {
    const a = await upload(f, { noteId: note.id });
    lines.push(`[${a.name.replace(/[[\]]/g, '')}](${a.url})`);
  }
  if (lines.length) await post(`/api/notes/${note.id}/append`, { markdown: lines.join('\n\n') });
  for (const f of shared.files.filter(isImage)) await sendPhoto(f, note, { wait: !fresh });
}

export function SharePage({ photo }) {
  const spaces = useStore((s) => s.spaces).filter((s) => ['owner', 'editor'].includes(s.role));
  const [shared, setShared] = useState(undefined);
  const [target, setTarget] = useState(undefined);
  const [spaceId, setSpaceId] = useState(currentSpace()?.id);
  const [busy, setBusy] = useState(false);
  const space = spaces.find((s) => s.id === spaceId) || spaces[0];
  useEffect(() => {
    takeShared().then((s) => setShared(s || (photo ? { title: '', text: '', url: '', files: [] } : null))).catch(() => setShared(null));
    captureTarget().then(setTarget);
  }, [photo]);
  const takePhoto = async () => { const f = await pickPhoto(); if (f) setShared((s) => ({ ...s, files: [...s.files, f] })); };
  const run = async (fn) => {
    setBusy(true);
    try { await fn(); await clearShared(); } catch (e) { toastError(e); }
    setBusy(false);
  };
  const toPage = (note) => run(async () => { await addTo(note, shared); toast(`Added to “${note.title || 'Untitled'}”`); openNote(note.id); });
  const toNew = () => run(async () => {
    const n = await post('/api/notes', { spaceId: space.id, title: titleOf(shared), icon: shared.files.some(isImage) && !shared.text ? '📷' : undefined });
    await addTo(n, shared, { fresh: true });
    await loadTree(space.id);
    openNote(n.id);
  });

  if (shared === undefined) return <div className="page-col"><span className="spinner" /></div>;
  if (!shared) return <div className="page-col"><h1>Share to Inkwell</h1><p className="muted">Nothing was shared, or it was already added. Share photos, files, text or links to Inkwell from other apps.</p><a href="#/">Go home</a></div>;
  const empty = !shared.files.length && !shared.text && !shared.url;
  return (
    <div className="page-col share-page">
      <h1>{photo && empty ? 'Photo to a page' : 'Share to Inkwell'}</h1>
      <div className="share-items">
        {shared.files.map((f, i) => (
          <div key={i} className="share-item">
            {isImage(f) ? <img alt={f.name} src={URL.createObjectURL(f)} /> : <span className="share-icon"><FileText size={22} /></span>}
            <span className="grow">{f.name}<span className="muted small"> · {Math.max(1, Math.round(f.size / 1024))} kB</span></span>
          </div>
        ))}
        {shared.text && <div className="share-item"><span className="share-icon"><FileText size={22} /></span><span className="grow share-text">{shared.text}</span></div>}
        {shared.url && <div className="share-item"><span className="share-icon"><Link2 size={22} /></span><span className="grow share-text">{shared.url}</span></div>}
      </div>
      <button onClick={takePhoto} disabled={busy}><Camera size={15} /> {shared.files.length ? 'Take another photo' : 'Take a photo'}</button>
      {!empty && (
        <div className="share-targets">
          {target && <button className="primary" disabled={busy} onClick={() => toPage(target)}><Send size={15} /> Add to <b>{target.icon} {target.title || 'Untitled'}</b><span className="sub">the page you are working on</span></button>}
          <div className="share-new">
            <button className={target ? '' : 'primary'} disabled={busy || !space} onClick={toNew}>{shared.files.some(isImage) ? <Image size={15} /> : <FilePlus2 size={15} />} New page in</button>
            <select value={space?.id || ''} onChange={(e) => setSpaceId(e.target.value)}>{spaces.map((s) => <option key={s.id} value={s.id}>{s.icon} {s.name}</option>)}</select>
          </div>
          {busy && <span className="spinner" />}
        </div>
      )}
    </div>
  );
}
