// Around the page content: tags (manual + AI suggestions), the pen layer over typed pages, and the connections
// footer (links, backlinks, related pages, unlinked mentions).
import { useEffect, useRef, useState, useMemo } from 'react';
import * as Y from 'yjs';
import { Plus, X, Pencil, Sparkles, ArrowUpRight, ArrowDownLeft, Link2, Network, Quote, Pin } from 'lucide-react';
import { get, post } from './api.js';
import { store, useStore, navigate, toast, toastError } from './store.js';
import { onEvent } from './data.js';
import { useYObserve } from './ui/ytext.js';
import { InkCanvas } from './ink/InkCanvas.jsx';
import { InkToolbar, setInkTool } from './ink/InkToolbar.jsx';
import { pickAnchor, anchorShift } from './ink/anchor.js';
import { matchTag, cleanTag } from './tags.js';

// ---------------------------------------------------------------- tags

export function TagBar({ detail, doc, readOnly }) {
  const meta = doc.getMap('meta');
  useYObserve(meta);
  const arr = meta.get('tags');
  useYObserve(arr instanceof Y.Array ? arr : null);
  const hiddenArr = meta.get('tagsHidden');
  useYObserve(hiddenArr instanceof Y.Array ? hiddenArr : null);
  const manual = arr instanceof Y.Array ? arr.toArray() : [];
  const hidden = hiddenArr instanceof Y.Array ? hiddenArr.toArray() : [];
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [value, setValue] = useState('');
  const [known, setKnown] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const loadKnown = () => get(`/api/tags?space=${detail.spaceId}`).then((k) => { setKnown(k); setLoaded(true); }).catch(() => {});
  useEffect(() => { if (!readOnly) loadKnown(); }, [detail.spaceId, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  const knownTags = known.map((x) => x.tag);
  const hashtags = (detail.tags || []).filter((t) => !manual.includes(t));
  const has = (t) => manual.includes(t) || hashtags.includes(t);
  // AI's ideas, spelled like the tags already in use ("IJS plus" is the existing "ijsplus"); dismissed ones stay away.
  const suggested = [...new Set((detail.insight?.tags || []).map((t) => matchTag(t, knownTags)))].filter((t) => t && !has(t) && !hidden.includes(t));

  const tagsArr = () => {
    let a = meta.get('tags');
    if (!(a instanceof Y.Array)) { a = new Y.Array(); meta.set('tags', a); }
    return a;
  };
  const add = (raw) => {
    const t = matchTag(raw, knownTags);
    if (!t || manual.includes(t)) return;
    doc.transact(() => tagsArr().push([t]));
  };
  // Dismissed AI suggestions, and tags removed or renamed here, are not suggested again.
  const dismiss = (t) => doc.transact(() => {
    let a = meta.get('tagsHidden');
    if (!(a instanceof Y.Array)) { a = new Y.Array(); meta.set('tagsHidden', a); }
    if (!a.toArray().includes(t)) a.push([t]);
  });
  const remove = (t) => doc.transact(() => {
    const a = meta.get('tags');
    const i = a?.toArray().indexOf(t);
    if (i >= 0) a.delete(i, 1);
    dismiss(t);
  });
  const rename = async (from, raw) => {
    setEditing(null);
    const to = cleanTag(raw);
    if (!to || to === from) return;
    const others = (known.find((x) => x.tag === from)?.count || 1) - 1;
    if (others > 0 && window.confirm(`Rename #${from} to #${to} on all ${others + 1} pages that have it?`)) {
      try { const { count } = await post('/api/tags/rename', { from, to, spaceId: detail.spaceId }); toast(`Renamed on ${count} page${count === 1 ? '' : 's'}`); loadKnown(); } catch (e) { toastError(e); }
      return;
    }
    doc.transact(() => {
      const a = tagsArr();
      const i = a.toArray().indexOf(from);
      if (i >= 0) a.delete(i, 1);
      if (!a.toArray().includes(to)) a.insert(Math.max(0, i), [to]);
      dismiss(from);
    });
  };
  // "Tags the AI finds: add them": the server adds new ones itself; this catches pages analysed before that.
  const autoTags = useStore((s) => (s.settings?.aiTags || 'apply') === 'apply');
  const pending = autoTags && !readOnly && loaded ? suggested.join() : '';
  useEffect(() => { if (pending) doc.transact(() => { const a = tagsArr(); a.push(pending.split(',').filter((t) => !a.toArray().includes(t))); }); }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps
  const search = (t) => navigate(`#/search?q=${encodeURIComponent(`tag:${t}`)}`);
  if (readOnly &&!manual.length && !hashtags.length) return null;
  const input = (initial, done) => (
    <input autoFocus list="known-tags" defaultValue={initial} placeholder="tag name" size={Math.max(8, initial.length + 2)}
      onKeyDown={(e) => {
        const el = e.currentTarget;
        // Renaming finishes on blur only (so it happens once); adding keeps the field open for the next tag.
        if (e.key === 'Enter' && initial) { e.preventDefault(); el.blur(); }
        else if ((e.key === 'Enter' || e.key === ',') && !initial) { e.preventDefault(); done(el.value, true); el.value = ''; }
        if (e.key === 'Escape') { el.value = initial; el.blur(); }
      }}
      onBlur={(e) => done(e.currentTarget.value, false)} />
  );
  return (
    <div className="tag-bar">
      {manual.map((t) => (editing === t
        ? <span key={t} className="chip manual editing">#{input(t, (v) => rename(t, v))}</span>
        : <span key={t} className="chip manual"><button className="link" onClick={() => search(t)} title="Pages with this tag">#{t}</button>
          {!readOnly && <button className="link x" onClick={() => setEditing(t)} title="Rename" aria-label={`Rename tag ${t}`}><Pencil size={10} /></button>}
          {!readOnly && <button className="link x" onClick={() => remove(t)} title="Remove" aria-label={`Remove tag ${t}`}><X size={11} /></button>}</span>
      ))}
      {hashtags.map((t) => <button key={t} className="chip" title="From a #tag in the text (edit the text to change it)" onClick={() => search(t)}>#{t}</button>)}
      {!readOnly && suggested.map((t) => (
        <span key={t} className="chip suggested"><button className="link" title="Suggested by AI — add it" onClick={() => add(t)}><Sparkles size={11} /> {t}</button>
          <button className="link x" title="Not this one" aria-label={`Dismiss suggested tag ${t}`} onClick={() => dismiss(t)}><X size={11} /></button></span>
      ))}
      {!readOnly && (adding
        ? <span className="chip editing">{input('', (v, keep) => { if (v) add(v); if (!keep) setAdding(false); })}</span>
        : <button className="chip" onClick={() => setAdding(true)}><Plus size={11} /> Tag</button>)}
      {!readOnly && (adding || editing) && <datalist id="known-tags">{knownTags.filter((t) => !manual.includes(t)).map((t) => <option key={t} value={t} />)}</datalist>}
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
