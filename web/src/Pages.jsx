// Home, search results, trash and the full-page assistant.
import { useEffect, useState } from 'react';
import { FilePlus2, PenLine, CalendarDays, RotateCcw, Trash2, Search as SearchIcon } from 'lucide-react';
import { get, post, del } from './api.js';
import { useStore, openNote, toast, toastError, currentSpace } from './store.js';
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
  const [events, setEvents] = useState(null);
  useEffect(() => { get('/api/recent?limit=12').then(setRecent).catch(toastError); }, [spaceId]);
  useEffect(() => { if (halcyon?.connected) get('/api/halcyon/events').then(setEvents).catch(() => setEvents([])); }, [halcyon?.connected]);
  const meeting = async (ev) => {
    const s = currentSpace();
    try { const n = await post('/api/notes/meeting', { spaceId: s.id, event: ev }); if (n.existing) toast('Opened the existing meeting note'); openNote(n.id); } catch (e) { toastError(e); }
  };
  return (
    <div className="page-col home">
      <h1>{greeting()}, {user?.name?.split(' ')[0]}</h1>
      <div className="quick">
        <button onClick={() => newPage()}><FilePlus2 size={18} /> New page</button>
        <button onClick={() => newPage({ kind: 'journal' })}><PenLine size={18} /> New journal</button>
        <button onClick={openToday}><PenLine size={18} /> Today's journal</button>
        <button onClick={() => newPage({ template: 'meeting' })}><CalendarDays size={18} /> Meeting notes</button>
      </div>
      {halcyon?.connected && (
        <section className={route.query.meetings ? 'highlight' : ''}>
          <h3><CalendarDays size={16} /> Today's meetings</h3>
          {events === null ? <span className="spinner" /> : !events.length ? <p className="muted">Nothing in your Halcyon calendar today.</p> : (
            <div className="events">
              {events.map((ev) => (
                <div key={ev.ref} className="event">
                  <span className="time">{ev.meta.allDay ? 'All day' : new Date(ev.meta.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="grow"><b>{ev.title}</b>{ev.meta.location && <span className="muted"> · {ev.meta.location}</span>}</span>
                  <button onClick={() => meeting(ev)}>Take notes</button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
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
