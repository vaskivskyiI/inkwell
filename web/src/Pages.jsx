// Home, search results, trash and the full-page assistant.
import { useEffect, useRef, useState } from 'react';
import { FilePlus2, PenLine, CalendarDays, RotateCcw, Trash2, Search as SearchIcon, CheckSquare, Mail, ExternalLink, NotebookText, MoveHorizontal, Camera, FileDown } from 'lucide-react';
import { get, post, del, upload, stream } from './api.js';
import { Markdown } from './ui/Markdown.jsx';
import { useStore, openNote, toast, toastError, currentSpace, filterSpace, localGet, localSet } from './store.js';
import { newPage, openToday } from './Sidebar.jsx';
import { AskTab } from './RightPanel.jsx';
import { highlight } from './Palette.jsx';

const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
const when = (t) => { const d = new Date(t); const today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(); };

export function HomePage() {
  const user = useStore((s) => s.user);
  const spaceId = useStore((s) => s.spaceId);
  const halcyon = useStore((s) => s.halcyon);
  const route = useStore((s) => s.route);
  const [recent, setRecent] = useState(null);
  useEffect(() => { const sp = filterSpace(); get(`/api/recent?limit=12${sp ? `&space=${sp}` : ''}`).then(setRecent).catch(toastError); }, [spaceId]);
  const [wide, setWide] = useState(localGet('homeWide') === '1');
  return (
    <div className={`page-col home${wide ? ' wide' : ''}`}>
      <div className="home-head">
        <h1>{greeting()}, {user?.name?.split(' ')[0]}</h1>
        <button className="icon desk-only" title={wide ? 'Fixed width' : 'Use the whole width'} aria-label={wide ? 'Fixed width' : 'Use the whole width'} onClick={() => { setWide(!wide); localSet('homeWide', wide ? '0' : '1'); }}><MoveHorizontal size={18} /></button>
      </div>
      <QuickNote />
      <div className="quick">
        <button onClick={() => newPage()}><FilePlus2 size={18} /> New page</button>
        <button onClick={() => newPage({ kind: 'journal' })}><PenLine size={18} /> New journal</button>
        <button onClick={openToday}><PenLine size={18} /> Today's journal</button>
        <button onClick={() => newPage({ template: 'meeting' })}><CalendarDays size={18} /> Meeting notes</button>
      </div>
      {halcyon?.connected && <Today key={spaceId} highlight={!!route.query.meetings} />}
      <section>
        <h3>Recently edited</h3>
        {recent === null ? <span className="spinner" /> : !recent.length ? <p className="muted">Nothing yet — start with a page or a journal.</p> : (
          <div className="cards">
            {recent.map((n) => (
              <a key={n.id} className="card" href={`#/n/${n.id}`}>
                <div className="card-title"><span>{n.icon || (n.kind === 'journal' ? '✍️' : '📄')}</span> {n.title || 'Untitled'}</div>
                <div className="card-snippet">{n.snippet || (n.kind === 'journal' ? 'Handwritten page' : '')}</div>
                <div className="muted small">{when(n.updatedAt)}</div>
              </a>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// Opens (or creates) the note for a Halcyon item. Item → note via a link like
// #/new?kind=event&ref=42&title=…&start=…&location=…&attendees=… (Halcyon's "New note in Inkwell", or Today below).
export async function noteForItem(kind, ref, title, meta = {}) {
  const n = await post('/api/notes/from-item', { kind, ref: String(ref), title, meta, spaceId: currentSpace()?.id });
  if (n.existing) toast('Opened the existing note');
  return n;
}

const localDay = (d) => d.toLocaleDateString('sv-SE');

// Capture without deciding where: one line becomes a page, a photo a page to draw on (the camera on phones).
function QuickNote() {
  const [text, setText] = useState('');
  const photo = useRef(null);
  const pdf = useRef(null);
  const [progress, setProgress] = useState('');
  const addPdf = async (file) => {
    try {
      const n = await post('/api/notes', { spaceId: currentSpace().id, title: file.name.replace(/\.pdf$/i, ''), icon: '📕' });
      const { pdfToBlocks } = await import('./editor/pdf.js');
      const { blocks } = await pdfToBlocks(file, { noteId: n.id }, (i, t) => setProgress(`${i}/${t}`));
      await post(`/api/notes/${n.id}/blocks`, { blocks });
      openNote(n.id);
    } catch (e) { toastError(e); } finally { setProgress(''); }
  };
  const add = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    try { openNote((await post('/api/notes', { spaceId: currentSpace().id, title: t.split(/[.!?\n]/)[0].slice(0, 80), markdown: t })).id); } catch (e) { toastError(e); }
  };
  const addPhoto = async (file) => {
    try {
      const url = URL.createObjectURL(file);
      const size = await new Promise((res) => { const i = new window.Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => res({ w: 4, h: 3 }); i.src = url; });
      URL.revokeObjectURL(url);
      const spaceId = currentSpace().id;
      const a = await upload(file, { spaceId });
      openNote((await post('/api/notes', { spaceId, title: `Photo ${localDay(new Date())}`, photo: { assetId: a.id, height: (1000 * size.h) / size.w } })).id);
    } catch (e) { toastError(e); }
  };
  return (
    <div className="quick-note">
      <input type="text" value={text} placeholder="Quick note — press Enter" aria-label="Quick note" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
      <button title="Take or choose a photo and draw on it" onClick={() => photo.current?.click()}><Camera size={16} /> Photo</button>
      <button title="Open a PDF to read and write on" onClick={() => pdf.current?.click()}><FileDown size={16} /> {progress || 'PDF'}</button>
      <input ref={pdf} type="file" hidden accept="application/pdf" onChange={(e) => { const f = e.target.files[0]; if (f) addPdf(f); e.target.value = ''; }} />
      <input ref={photo} type="file" hidden accept="image/*" capture="environment" onChange={(e) => { const f = e.target.files[0]; if (f) addPhoto(f); e.target.value = ''; }} />
    </div>
  );
}

// A smart category: all notes of meetings, tasks, e-mails… and of one recurring meeting.
export function SmartPage({ cat, sub }) {
  const spaceId = useStore((s) => s.spaceId);
  const [groups, setGroups] = useState(null);
  useEffect(() => { const sp = filterSpace(); get(`/api/smart${sp ? `?space=${sp}` : ''}`).then(setGroups).catch(toastError); }, [spaceId]);
  if (!groups) return <div className="note-loading"><span className="spinner" /></div>;
  const g = groups.find((x) => x.id === cat);
  if (!g) return <div className="page-col"><h1>Nothing here yet</h1><p className="muted">Notes appear here when they are linked to meetings, tasks or e-mails.</p></div>;
  const s = sub && g.subs.find((x) => x.id === sub);
  const notes = s ? s.notes : [...g.subs.flatMap((x) => x.notes), ...g.notes].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div className="page-col home wide">
      <h1>{s ? s.label : g.label}</h1>
      {!s && g.subs.length > 0 && <div className="chips" style={{ marginBottom: 18 }}>{g.subs.map((x) => <a key={x.id} className="chip" href={`#/smart/${g.id}?sub=${encodeURIComponent(x.id)}`}>{x.label} · {x.count}</a>)}</div>}
      <div className="cards">
        {notes.map((n) => <a key={n.id} className="card" href={`#/n/${n.id}`}><div className="card-title"><span>{n.icon || '📄'}</span> {n.title || 'Untitled'}</div><div className="card-snippet" /><div className="muted small">{when(n.createdAt)}</div></a>)}
      </div>
    </div>
  );
}

// The week in the notes: what was done and decided, what is open, what to follow up.
export function ReviewPage() {
  const spaceId = useStore((s) => s.spaceId);
  const [days, setDays] = useState(7);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setText('');
    try {
      const out = await stream('/api/ai/review', { days, spaceId: filterSpace() || undefined }, { onToken: (t) => setText((s) => s + t) });
      setText(out.text);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const save = async () => {
    try { openNote((await post('/api/notes', { spaceId: currentSpace().id, title: `Review ${localDay(new Date())}`, icon: '🧭', markdown: text })).id); } catch (e) { toastError(e); }
  };
  return (
    <div className="page-col">
      <h1>Review</h1>
      <p className="muted">{spaceId === 'all' ? 'All spaces' : currentSpace()?.name}: AI goes through the pages changed lately.</p>
      <div className="row">
        <select value={days} aria-label="Period" onChange={(e) => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={14}>Last 14 days</option><option value={31}>Last month</option></select>
        <button className="primary" disabled={busy} onClick={run}>{busy ? 'Reading…' : 'Write review'}</button>
        {text && !busy && <button onClick={save}>Save as page</button>}
      </div>
      {text && <div style={{ marginTop: 18 }}><Markdown text={text} /></div>}
    </div>
  );
}

export function NewFromItem({ query }) {
  const [error, setError] = useState(null);
  useEffect(() => {
    const { kind, ref, title, space, ...rest } = query;
    const meta = Object.fromEntries(Object.entries(rest).filter(([, v]) => v));
    post('/api/notes/from-item', { kind, ref, title, meta, spaceId: space || currentSpace()?.id })
      .then((n) => location.replace(`#/n/${n.id}`)) // replace: Back returns to where the user came from, not here
      .catch(setError);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <div className="empty-state"><h2>Could not create the note</h2><p>{error.message}</p><a href="#/">Go home</a></div>;
  return <div className="note-loading"><span className="spinner" /> Opening the note…</div>;
}

const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dueOf = (iso) => {
  if (!iso) return { label: '', late: false };
  const d = new Date(iso), today = new Date(new Date().toDateString());
  const days = Math.round((new Date(d.toDateString()) - today) / 864e5);
  return { label: days < 0 ? `${-days} d late` : days === 0 ? 'today' : days === 1 ? 'tomorrow' : d.toLocaleDateString([], { day: 'numeric', month: 'short' }), late: days < 0 };
};

/** Today with Halcyon: meetings, open tasks and e-mails waiting for the user — each one a click from its note. */
function Today({ highlight }) {
  const halcyon = useStore((s) => s.halcyon);
  const [data, setData] = useState({ events: null, tasks: null, mail: null });
  const [notes, setNotes] = useState({}); // "kind:ref" → note id
  useEffect(() => {
    const load = async (key, url, kind) => {
      const items = await get(url).catch(() => []);
      setData((d) => ({ ...d, [key]: items }));
      if (items.length) {
        const found = await get(`/api/links/lookup?kind=${kind}&ref=${items.map((i) => encodeURIComponent(i.ref)).join(',')}`).catch(() => []);
        // Repeating meetings have one note per day: only today's counts as this event's note.
        const today = localDay(new Date());
        setNotes((n) => ({ ...n, ...Object.fromEntries(found.filter((f) => kind !== 'event' || f.date === today).map((f) => [`${kind}:${f.ref}`, f.id])) }));
      }
    };
    const sp = filterSpace() ? `?space=${filterSpace()}` : '';
    load('events', `/api/halcyon/events${sp}`, 'event');
    load('tasks', `/api/halcyon/tasks${sp}`, 'task');
    load('mail', `/api/halcyon/open-items${sp}`, 'email');
  }, []);
  const open = async (it) => {
    const id = notes[`${it.kind}:${it.ref}`];
    if (id) { openNote(id); return; }
    const meta = it.kind === 'event' ? { ...it.meta, day: it.meta.allDay ? it.meta.start.slice(0, 10) : localDay(new Date(it.meta.start)) } : it.meta;
    try { openNote((await noteForItem(it.kind, it.ref, it.title, meta)).id); } catch (e) { toastError(e); }
  };
  const ext = (it) => `${halcyon.baseUrl}/#/${it.kind === 'email' ? `mail/unified/${it.ref}` : it.kind === 'event' ? 'calendar' : 'tasks'}`;
  const row = (it, when, late, sub) => (
    <div key={`${it.kind}:${it.ref}`} className="today-item">
      <span className={`when${late ? ' late' : ''}`}>{when}</span>
      <span className="grow"><b>{it.title}</b>{sub && <span className="sub">{sub}</span>}</span>
      <a className="ext" href={ext(it)} title="Open in Halcyon"><ExternalLink size={14} /></a>
      <button onClick={() => open(it)}>{notes[`${it.kind}:${it.ref}`] ? <><NotebookText size={14} /> Open note</> : <><FilePlus2 size={14} /> Note</>}</button>
    </div>
  );
  const list = (items, empty, render) => (items === null ? <span className="spinner" /> : !items.length ? <p className="muted">{empty}</p> : <div className="today-list">{items.map(render)}</div>);
  return (
    <>
      <section className={highlight ? 'highlight' : ''}>
        <h3><CalendarDays size={16} /> Today's meetings</h3>
        {list(data.events, 'Nothing in your calendar today.', (ev) => row(ev, ev.meta.allDay ? 'All day' : timeOf(ev.meta.start), false, [ev.meta.location, (ev.meta.attendees || []).slice(0, 4).join(', ')].filter(Boolean).join(' · ')))}
      </section>
      <div className="today-grid">
        <section>
          <h3><CheckSquare size={16} /> Tasks</h3>
          {list(data.tasks, 'No open tasks.', (t) => { const d = dueOf(t.meta.due); return row(t, d.label, d.late, ''); })}
        </section>
        <section>
          <h3><Mail size={16} /> Waiting for you</h3>
          {list(data.mail, 'No e-mails waiting for a reply or an action.', (m) => row(m, m.date ? new Date(m.date).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '', false,
            [m.meta.from?.replace(/<.*>/, '').trim(), m.meta.action || (m.meta.needsReply ? 'needs a reply' : '')].filter(Boolean).join(' · ')))}
        </section>
      </div>
    </>
  );
}

export function SearchPage({ q }) {
  const [hits, setHits] = useState(null);
  const [query, setQuery] = useState(q || '');
  useEffect(() => { setQuery(q || ''); }, [q]);
  useEffect(() => {
    if (!query.trim()) { setHits([]); return undefined; }
    const t = setTimeout(() => get(`/api/search?q=${encodeURIComponent(query)}&limit=50`).then(setHits).catch(toastError), 200);
    return () => clearTimeout(t);
  }, [query]);
  return (
    <div className="page-col">
      <h1>Search</h1>
      <div className="search-box"><SearchIcon size={18} /><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Words, #tags, tag:x, kind:journal, in:work…" /></div>
      {hits === null ? <span className="spinner" /> : hits.map((h) => (
        <a key={h.id} className="result" href={`#/n/${h.id}`}>
          <div><span>{h.icon || (h.kind === 'journal' ? '✍️' : '📄')}</span> <b>{h.title || 'Untitled'}</b> {h.via.includes('meaning') && !h.via.includes('text') && <span className="badge">related in meaning</span>}</div>
          {h.snippet && <div className="snippet">{highlight(h.snippet)}</div>}
        </a>
      ))}
      {hits?.length === 0 && query && <p className="muted">No pages found.</p>}
    </div>
  );
}

export function TrashPage() {
  const [items, setItems] = useState(null);
  const load = () => get('/api/trash').then(setItems).catch(toastError);
  useEffect(() => { load(); }, []);
  return (
    <div className="page-col">
      <h1>Trash</h1>
      <p className="muted">Pages stay here for 30 days.</p>
      {items === null ? <span className="spinner" /> : !items.length ? <p className="muted">The trash is empty.</p> : items.map((n) => (
        <div key={n.id} className="trash-row">
          <span>{n.icon || '📄'}</span><span className="grow">{n.title || 'Untitled'}<span className="muted small"> · deleted {new Date(n.deletedAt).toLocaleString()}</span></span>
          <button onClick={() => post(`/api/notes/${n.id}/restore`).then(() => { toast('Restored'); load(); }).catch(toastError)}><RotateCcw size={14} /> Restore</button>
          <button className="danger" onClick={() => { if (window.confirm('Delete this page and its sub-pages forever?')) del(`/api/notes/${n.id}?permanent=1`).then(load).catch(toastError); }}><Trash2 size={14} /> Delete forever</button>
        </div>
      ))}
    </div>
  );
}

export function AskPage() {
  return <div className="page-col ask-page"><h1>Ask Inkwell</h1><AskTab standalone /></div>;
}
