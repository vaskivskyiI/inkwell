// Around the page content: tags (manual + AI suggestions), the pen layer over typed pages, and the connections
// footer (links, backlinks, related pages, unlinked mentions).
import { useEffect, useRef, useState, useMemo } from 'react';
import * as Y from 'yjs';
import { Plus, X, Sparkles, ArrowUpRight, ArrowDownLeft, Link2, Network, Quote } from 'lucide-react';
import { get, post } from './api.js';
import { store, useStore, navigate, toast, toastError } from './store.js';
import { onEvent } from './data.js';
import { useYObserve } from './ui/ytext.js';
import { InkCanvas } from './ink/InkCanvas.jsx';
import { InkToolbar } from './ink/InkToolbar.jsx';

// ---------------------------------------------------------------- tags

export function TagBar({ detail, doc, readOnly }) {
  const meta = doc.getMap('meta');
  useYObserve(meta);
  const arr = meta.get('tags');
  useYObserve(arr instanceof Y.Array ? arr : null);
  const manual = arr instanceof Y.Array ? arr.toArray() : [];
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const [known, setKnown] = useState([]);
  useEffect(() => { if (adding) get(`/api/tags?space=${detail.spaceId}`).then((t) => setKnown(t.map((x) => x.tag))).catch(() => {}); }, [adding, detail.spaceId]);
  const hashtags = (detail.tags || []).filter((t) => !manual.includes(t));
  const suggested = (detail.insight?.tags || []).filter((t) => !manual.includes(t) && !hashtags.includes(t));

  const add = (raw) => {
    const t = String(raw).toLowerCase().replace(/^#/, '').trim().replace(/\s+/g, '-').slice(0, 40);
    if (!t || manual.includes(t)) return;
    doc.transact(() => {
      let a = meta.get('tags');
      if (!(a instanceof Y.Array)) { a = new Y.Array(); meta.set('tags', a); }
      a.push([t]);
    });
  };
  const remove = (t) => {
    const a = meta.get('tags');
    const i = a?.toArray().indexOf(t);
    if (i >= 0) a.delete(i, 1);
  };
  const search = (t) => navigate(`#/search?q=${encodeURIComponent(`tag:${t}`)}`);
  if (readOnly && !manual.length && !hashtags.length) return null;
  return (
    <div className="tag-bar">
      {manual.map((t) => (
        <span key={t} className="chip manual"><button className="link" onClick={() => search(t)}>#{t}</button>
          {!readOnly && <button className="link x" onClick={() => remove(t)} aria-label={`Remove tag ${t}`}><X size={11} /></button>}</span>
      ))}
      {hashtags.map((t) => <button key={t} className="chip" title="From a #tag in the text" onClick={() => search(t)}>#{t}</button>)}
      {!readOnly && suggested.map((t) => <button key={t} className="chip suggested" title="Suggested by AI — click to add" onClick={() => add(t)}><Sparkles size={11} /> {t}</button>)}
      {!readOnly && (adding ? (
        <>
          <input autoFocus list="known-tags" value={value} placeholder="tag name" onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(value); setValue(''); } if (e.key === 'Escape') setAdding(false); }}
            onBlur={() => { if (value) add(value); setValue(''); setAdding(false); }} />
          <datalist id="known-tags">{known.filter((t) => !manual.includes(t)).map((t) => <option key={t} value={t} />)}</datalist>
        </>
      ) : <button className="chip" onClick={() => setAdding(true)}><Plus size={11} /> Tag</button>)}
    </div>
  );
}

// ---------------------------------------------------------------- handwriting over a typed page

export function PenLayer({ doc, on, readOnly, children }) {
  const host = useRef(null);
  const canvas = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(host.current);
    return () => ro.disconnect();
  }, []);
  const logicalH = size.w ? Math.ceil((size.h * 1000) / size.w) + 40 : 400;
  return (
    <>
      {on && !readOnly && (
        <div className="pen-bar">
          <InkToolbar canvas={canvas} zoom={false} extra={<button onClick={() => store.set({ penLayer: false })}>Done</button>} />
        </div>
      )}
      <div className="page-body" style={{ position: 'relative' }}>
        <div ref={host}>{children}</div>
        <div className={`pen-layer${on && !readOnly ? ' on' : ''}`}>
          <InkCanvas ref={canvas} doc={doc} canvasId="overlay" height={logicalH} minHeight={logicalH} readOnly={!on || readOnly} zoomable={false} />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- connections

function Card({ n, dir, action }) {
  const Icon = dir === 'out' ? ArrowUpRight : dir === 'in' ? ArrowDownLeft : null;
  return (
    <span className="conn">
      {Icon && <Icon size={13} className="muted" />}
      <a href={`#/n/${n.id}`}>{n.icon || (n.kind === 'journal' ? '✍️' : '📄')} {n.title || 'Untitled'}</a>
      {n.via === 'meaning' && <span className="muted">similar</span>}
      {action}
    </span>
  );
}

export function Connections({ detail, readOnly }) {
  const [c, setC] = useState(null);
  const [linking, setLinking] = useState(false);
  const [q, setQ] = useState('');
  const trees = useStore((s) => s.trees);
  const load = () => get(`/api/notes/${detail.id}/connections`).then(setC).catch(() => {});
  useEffect(() => {
    load();
    return onEvent((m) => { if ((m.type === 'note:links' && m.noteId === detail.id) || (m.type === 'ai:insight' && m.noteId === detail.id)) load(); });
  }, [detail.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const link = async (n) => {
    try { await post(`/api/notes/${detail.id}/links`, { kind: 'note', ref: n.id, title: n.title, both: true }); toast(`Linked with “${n.title || 'Untitled'}”`); setLinking(false); setQ(''); load(); } catch (e) { toastError(e); }
  };
  const candidates = useMemo(() => {
    if (!linking) return [];
    const s = q.toLowerCase();
    return Object.values(trees).flat().filter((n) => n.id !== detail.id && (n.title || '').toLowerCase().includes(s)).slice(0, 8);
  }, [linking, q, trees, detail.id]);
  if (!c) return null;
  const linked = new Map();
  for (const n of c.outgoing) linked.set(n.id, { ...n, dir: 'out' });
  for (const n of c.backlinks) linked.set(n.id, { ...n, dir: linked.has(n.id) ? 'both' : 'in' });
  const empty = !linked.size && !c.related.length && !c.unlinked.length;
  return (
    <section className="connections" aria-label="Connections">
      <h4><Network size={13} /> Connections
        {!readOnly && <button className="link" style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 }} onClick={() => setLinking((v) => !v)}><Link2 size={13} /> Link a page</button>}</h4>
      {linking && (
        <div className="row wrap" style={{ marginBottom: 8 }}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a page to link both ways…" />
          <div className="conn-grid">{candidates.map((n) => <span key={n.id} className="conn"><span>{n.icon || '📄'} {n.title || 'Untitled'}</span><button onClick={() => link(n)}>Link</button></span>)}</div>
        </div>
      )}
      {empty && !linking && <p className="muted small">No connections yet. Type <code>[[</code> in the text to link a page; related pages appear here once AI has read this one.</p>}
      {linked.size > 0 && <div className="conn-grid">{[...linked.values()].map((n) => <Card key={n.id} n={n} dir={n.dir === 'both' ? 'out' : n.dir} />)}</div>}
      {c.related.length > 0 && (
        <>
          <h4><Sparkles size={13} /> Related</h4>
          <div className="conn-grid">{c.related.map((n) => <Card key={n.id} n={n} action={!readOnly && <button onClick={() => link(n)} title="Link both pages to each other">Link</button>} />)}</div>
        </>
      )}
      {c.unlinked.length > 0 && (
        <>
          <h4><Quote size={13} /> Mention “{detail.title}” without a link</h4>
          <div className="conn-grid">{c.unlinked.map((n) => <Card key={n.id} n={n} action={!readOnly && <button onClick={() => link(n)}>Link</button>} />)}</div>
        </>
      )}
    </section>
  );
}
