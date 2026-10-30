// Around the page content: tags (manual + AI suggestions), the pen layer over typed pages, and the connections
// footer (links, backlinks, related pages, unlinked mentions).
import { useEffect, useRef, useState, useMemo } from 'react';
import * as Y from 'yjs';
import { Plus, X, Sparkles, ArrowUpRight, ArrowDownLeft, Link2, Network, Quote, Pin } from 'lucide-react';
import { get, post } from './api.js';
import { store, useStore, navigate, toast, toastError } from './store.js';
import { onEvent } from './data.js';
import { useYObserve } from './ui/ytext.js';
import { InkCanvas } from './ink/InkCanvas.jsx';
import { InkToolbar, setInkTool } from './ink/InkToolbar.jsx';
import { pickAnchor, anchorShift } from './ink/anchor.js';

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

// Ink written over text can stick to it: each stroke remembers the block (paragraph, heading, list…) it was
// written on — by the start of that block's text and its position in the page — plus the block's top at the time.
// When text above is added or removed the block moves, and the stroke is drawn shifted by the same amount, on every
// device. (Text, not CRDT element identity: the editor sync may replace block elements when it splits them.)
const sigOf = (el) => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 80);

export function PenLayer({ doc, on, readOnly, children }) {
  const host = useRef(null);
  const canvas = useRef(null);
  const tool = useStore((s) => s.inkTool);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [layoutKey, setLayoutKey] = useState(0);
  const tops = useRef(null); // block tops (logical units) for the current layout
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => { setSize({ w: e.contentRect.width, h: e.contentRect.height }); tops.current = null; setLayoutKey((k) => k + 1); });
    ro.observe(host.current);
    // Content edits move blocks: re-measure after the editor has re-rendered.
    let raf = 0;
    const onUpdate = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { tops.current = null; setLayoutKey((k) => k + 1); }); };
    doc.on('update', onUpdate);
    return () => { ro.disconnect(); doc.off('update', onUpdate); cancelAnimationFrame(raf); };
  }, [doc]);
  const logicalH = size.w ? Math.ceil((size.h * 1000) / size.w) + 40 : 400;

  // Top-level blocks of the editor with their top (logical units) and text signature, for the current layout.
  const blocks = () => {
    if (tops.current) return tops.current;
    const pm = host.current?.querySelector('.ProseMirror');
    const base = host.current?.getBoundingClientRect();
    if (!pm || !base?.width) return [];
    const k = 1000 / base.width;
    tops.current = [...pm.children].filter((el) => !el.classList.contains('ProseMirror-gapcursor'))
      .map((el) => ({ top: (el.getBoundingClientRect().top - base.top) * k, sig: sigOf(el) }));
    return tops.current;
  };
  const anchorFor = (stroke) => {
    if (tool.anchor === false) return null;
    let minY = Infinity;
    for (let i = 1; i < stroke.p.length; i += 3) minY = Math.min(minY, stroke.p[i]);
    return pickAnchor(blocks(), minY);
  };
  const cache = useRef({ key: -1, map: new Map() });
  const offsetOf = (stroke) => {
    const a = stroke.a;
    if (!a?.sig) return 0;
    if (cache.current.key !== layoutKey) cache.current = { key: layoutKey, map: new Map() };
    const key = `${a.i}|${a.y0}|${a.sig}`;
    if (!cache.current.map.has(key)) cache.current.map.set(key, anchorShift(blocks(), a));
    return cache.current.map.get(key);
  };

  return (
    <>
      {on && !readOnly && (
        <div className="pen-bar">
          <InkToolbar canvas={canvas} zoom={false} space={false} extra={<>
            <button className={tool.anchor !== false ? 'on' : ''} title="Stick new ink to the text under it, so it moves along when text is added or removed above" onClick={() => setInkTool({ anchor: tool.anchor === false })}><Pin size={15} /> Stick to text</button>
            <button onClick={() => store.set({ penLayer: false })}>Done</button>
          </>} />
        </div>
      )}
      <div className="page-body" style={{ position: 'relative' }}>
        <div ref={host}>{children}</div>
        <div className={`pen-layer${on && !readOnly ? ' on' : ''}`}>
          <InkCanvas ref={canvas} doc={doc} canvasId="overlay" height={logicalH} minHeight={logicalH} readOnly={!on || readOnly} zoomable={false} spaceable={false}
            anchorFor={anchorFor} offsetOf={offsetOf} redrawKey={layoutKey} />
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
