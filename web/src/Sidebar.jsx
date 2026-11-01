import { useEffect, useMemo, useState } from 'react';
import { FolderInput, X, CheckCheck, ArrowUpToLine, ChevronRight, ChevronDown, Plus, Search, Home, PenLine, Trash2, Star, MessageSquare, FilePlus2, MoreHorizontal, Copy, CalendarPlus, CalendarDays, CheckSquare, Mail, Sparkles, Compass } from 'lucide-react';
import { get, post } from './api.js';
import { store, useStore, openNote, navigate, toast, toastError, localGet, localSet, currentSpace, findNote } from './store.js';
import { onEvent, moveToSpace, movePages, trashPages } from './data.js';
import { Menu } from './ui/Menu.jsx';

const expandedSet = new Set(JSON.parse(localGet('expanded') || '[]'));
const saveExpanded = () => localSet('expanded', JSON.stringify([...expandedSet].slice(-500)));

export async function newPage({ kind = 'page', parentId = null, template } = {}) {
  const s = currentSpace();
  if (!s) return;
  if (!['owner', 'editor'].includes(s.role)) { toast('You can only view this space', { kind: 'error' }); return; }
  try {
    const n = await post('/api/notes', { spaceId: s.id, parentId, kind, template });
    if (parentId) { expandedSet.add(parentId); saveExpanded(); }
    openNote(n.id);
    setTimeout(() => document.querySelector('.title-input')?.focus(), 150);
  } catch (e) { toastError(e); }
}

export async function openToday() {
  // This device's day, not the server's (UTC) one.
  const d = new Date(), date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  try { openNote((await post('/api/journal', { date })).id); } catch (e) { toastError(e); }
}

// ---- several pages at once: Ctrl/⌘-click adds a page, Shift-click a range; while some are selected a click toggles.
const setSelected = (ids) => store.set({ selected: ids });
function clickSelect(e, id) {
  const sel = store.get().selected;
  if (!(e.ctrlKey || e.metaKey || e.shiftKey || sel.length)) return;
  e.preventDefault();
  if (e.shiftKey && sel.length) {
    const rows = [...document.querySelectorAll('.sidebar .tree-row[data-id]')].map((r) => r.dataset.id);
    const [a, b] = [rows.indexOf(sel.at(-1)), rows.indexOf(id)].sort((x, y) => x - y);
    if (a >= 0) { setSelected([...new Set([...sel, ...rows.slice(a, b + 1)])]); return; }
  }
  // Ctrl-click with nothing selected yet starts the selection with the open page.
  const route = store.get().route;
  const base = !sel.length && route.name === 'n' && route.id !== id && findNote(route.id) ? [route.id] : sel;
  setSelected(base.includes(id) ? base.filter((x) => x !== id) : [...base, id]);
}
if (typeof window !== 'undefined') window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && store.get().selected.length) setSelected([]); });

function ancestorsOf(id) {
  const out = [];
  for (let n = findNote(id); n?.parentId && out.length < 100; n = findNote(n.parentId)) out.push(n.parentId);
  return out;
}

function SelectionBar() {
  const selected = useStore((s) => s.selected);
  const spaces = useStore((s) => s.spaces);
  if (!selected.length) return null;
  const writable = spaces.filter((s) => ['owner', 'editor'].includes(s.role));
  const canEdit = selected.map(findNote).every((n) => n && writable.some((s) => s.id === n.spaceId));
  const run = (fn) => async () => { try { if (await fn() !== false) setSelected([]); } catch (e) { toastError(e); } };
  const showAll = () => setSelected([...document.querySelectorAll('.sidebar .tree-row[data-id]')].map((r) => r.dataset.id));
  const trash = async () => {
    const open = store.get().route.id;
    const ids = await trashPages(selected);
    if (ids.some((id) => id === open || ancestorsOf(open).includes(id))) navigate('#/');
  };
  return (
    <div className="select-bar" role="toolbar" aria-label="Selected pages">
      <span className="grow"><b>{selected.length}</b> selected</span>
      <button className="icon tiny" title="Select all shown pages" aria-label="Select all shown pages" onClick={showAll}><CheckCheck size={14} /></button>
      {canEdit && <Menu label="Move to…" className="icon tiny" trigger={<FolderInput size={14} />} items={[
        { label: 'Top level of space…', icon: ArrowUpToLine, submenu: writable.map((s) => ({ label: `${s.icon} ${s.name}`, onClick: run(() => movePages(selected, s, { parentId: null })) })) },
      ]} />}
      {canEdit && <button className="icon tiny" title="Move to trash" aria-label="Move to trash" onClick={run(trash)}><Trash2 size={14} /></button>}
      <button className="icon tiny" title="Clear selection (Esc)" aria-label="Clear selection" onClick={() => setSelected([])}><X size={14} /></button>
    </div>
  );
}

export function Sidebar() {
  const spaces = useStore((s) => s.spaces);
  const spaceId = useStore((s) => s.spaceId);
  const trees = useStore((s) => s.trees);
  const favorites = useStore((s) => s.favorites);
  const route = useStore((s) => s.route);
  const halcyon = useStore((s) => s.halcyon);
  const picking = useStore((s) => s.selected.length > 0);
  const space = spaces.find((s) => s.id === spaceId) || spaces[0];
  const all = spaceId === 'all';
  const canEdit = all ? spaces.some((x) => ['owner', 'editor'].includes(x.role)) : ['owner', 'editor'].includes(space?.role);
  const activeId = route.name === 'n' ? route.id : null;

  const close = () => { if (window.innerWidth < 800) store.set({ sidebar: false }); };

  return (
    <nav className="sidebar" onClick={(e) => { if (!e.defaultPrevented && e.target.closest('a,.tree-row,.nav-item')) close(); }}>
      <div className="sidebar-title">{all ? 'All spaces' : <>{space?.icon} {space?.name}</>}</div>

      <button className="nav-item search" onClick={() => store.set({ palette: true })}><Search size={16} /><span className="grow">Search</span><kbd>Ctrl K</kbd></button>
      <a className={`nav-item${route.name === 'home' ? ' on' : ''}`} href="#/"><Home size={16} /> Home</a>
      <button className="nav-item" onClick={openToday}><PenLine size={16} /> Today's journal</button>
      <a className={`nav-item${route.name === 'ask' ? ' on' : ''}`} href="#/ask"><MessageSquare size={16} /> Ask Inkwell</a>
      <a className={`nav-item${route.name === 'review' ? ' on' : ''}`} href="#/review"><Compass size={16} /> Review</a>
      <a className={`nav-item${route.name === 'calendar' ? ' on' : ''}`} href="#/calendar"><CalendarDays size={16} /> Calendar</a>
      {halcyon?.connected && <a className="nav-item" href="#/?meetings=1"><CalendarPlus size={16} /> Meeting notes</a>}

      {favorites.length > 0 && (
        <div className="section">
          <div className="section-head"><Star size={13} /> Favourites</div>
          {favorites.map((n) => <a key={n.id} href={`#/n/${n.id}`} className={`tree-row flat${activeId === n.id ? ' on' : ''}`}><span className="ticon">{n.icon || (n.kind === 'journal' ? '✍️' : '📄')}</span><span className="grow ttl">{n.title || 'Untitled'}</span></a>)}
        </div>
      )}

      <div className="section tree">
        <SmartSection />
        {picking ? <SelectionBar /> : <div className="section-head">
          <span className="grow">Pages</span>
          {canEdit && <Menu label="New…" className="icon small" trigger={<Plus size={15} />} items={[
            { label: 'New page', icon: FilePlus2, onClick: () => newPage() },
            { label: 'New journal (handwriting)', icon: PenLine, onClick: () => newPage({ kind: 'journal' }) },
            { label: 'From template', icon: Copy, submenu: [['meeting', 'Meeting notes'], ['daily', 'Daily plan'], ['project', 'Project brief'], ['oneOnOne', '1:1'], ['lecture', 'Lecture notes']].map(([t, label]) => ({ label, onClick: () => newPage({ template: t }) })) },
          ]} />}
        </div>}
        {(all ? spaces : space ? [space] : []).map((sp) => <SpaceTree key={sp.id} space={sp} header={all} activeId={activeId} notes={trees[sp.id]} />)}
      </div>

      <div className="sidebar-foot">
        <a className={`nav-item${route.name === 'trash' ? ' on' : ''}`} href="#/trash"><Trash2 size={16} /> Trash</a>
      </div>
    </nav>
  );
}

function SpaceTree({ space, header, activeId, notes }) {
  const canEdit = ['owner', 'editor'].includes(space.role);
  const [open, setOpen] = useState(true);
  const children = useMemo(() => {
    const m = new Map();
    for (const n of notes || []) { const k = n.parentId || 'root'; if (!m.has(k)) m.set(k, []); m.get(k).push(n); }
    for (const list of m.values()) list.sort((a, b) => a.position - b.position);
    return m;
  }, [notes]);
  return (
    <>
      {header && <button className="space-head" onClick={() => setOpen((o) => !o)}><span className="space-icon" style={{ background: space.color }}>{space.icon || space.name[0]}</span>{space.name}{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>}
      {open && !notes && <div className="muted small pad">Loading…</div>}
      {open && notes && !notes.length && <div className="muted small pad">No pages yet. {canEdit && !header && <button className="link" onClick={() => newPage()}>Create one</button>}</div>}
      {open && (children.get('root') || []).map((n) => <TreeNode key={n.id} note={n} childrenMap={children} depth={0} activeId={activeId} canEdit={canEdit} />)}
    </>
  );
}

// Smart categories: notes grouped by what they belong to; recurring meetings get their own sub-category.
const SMART_ICON = { meetings: CalendarDays, tasks: CheckSquare, emails: Mail, journals: PenLine };
function SmartSection() {
  const spaceId = useStore((s) => s.spaceId);
  const route = useStore((s) => s.route);
  const [groups, setGroups] = useState([]);
  const [open, setOpen] = useState(() => localGet('smartOpen') !== '0');
  useEffect(() => {
    let t;
    const load = () => get(`/api/smart${spaceId === 'all' ? '' : `?space=${spaceId}`}`).then(setGroups).catch(() => {});
    load();
    const off = onEvent((m) => { if (['note:created', 'note:links', 'note:removed', 'tree:changed'].includes(m.type)) { clearTimeout(t); t = setTimeout(load, 800); } });
    return () => { off(); clearTimeout(t); };
  }, [spaceId]);
  if (!groups.length) return null;
  return (
    <div className="smart">
      <button className="section-head" style={{ border: 0, background: 'none', width: '100%' }} onClick={() => { setOpen(!open); localSet('smartOpen', open ? '0' : '1'); }}><Sparkles size={13} /> <span className="grow" style={{ textAlign: 'left' }}>Smart</span>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
      {open && groups.map((g) => {
        const Icon = SMART_ICON[g.id] || Sparkles;
        return (
          <div key={g.id}>
            <a className={`tree-row flat${route.name === 'smart' && route.id === g.id && !route.query.sub ? ' on' : ''}`} href={`#/smart/${g.id}`}><span className="ticon"><Icon size={15} /></span><span className="grow ttl">{g.label}</span><span className="muted small">{g.count}</span></a>
            {g.subs.map((s) => <a key={s.id} className={`tree-row${route.query.sub === s.id ? ' on' : ''}`} style={{ paddingLeft: 32 }} href={`#/smart/${g.id}?sub=${encodeURIComponent(s.id)}`}><span className="grow ttl">{s.label}</span><span className="muted small">{s.count}</span></a>)}
          </div>
        );
      })}
    </div>
  );
}

let dragIds = null; // pages being dragged: the whole selection when the dragged page is part of it

function TreeNode({ note, childrenMap, depth, activeId, canEdit }) {
  const kids = childrenMap.get(note.id) || [];
  const selected = useStore((s) => s.selected.includes(note.id));
  const [open, setOpen] = useState(expandedSet.has(note.id));
  const [drop, setDrop] = useState(null); // 'before' | 'inside' | 'after'
  const toggle = (e) => { e.preventDefault(); e.stopPropagation(); const o = !open; setOpen(o); if (o) expandedSet.add(note.id); else expandedSet.delete(note.id); saveExpanded(); };

  const onDragOver = (e) => {
    if (!canEdit || !dragIds || dragIds.includes(note.id)) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    setDrop(y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside');
  };
  const onDrop = async (e) => {
    e.preventDefault();
    const where = drop;
    setDrop(null);
    const ids = dragIds;
    dragIds = null;
    if (!ids?.length || ids.includes(note.id)) return;
    if (ancestorsOf(note.id).some((a) => ids.includes(a))) { toast('A page cannot go inside its own sub-page', { kind: 'error' }); return; }
    try {
      // Dropped on a page of another space: the pages move there.
      const space = store.get().spaces.find((s) => s.id === note.spaceId);
      if (where === 'inside') { await movePages(ids, space, { parentId: note.id }); expandedSet.add(note.id); saveExpanded(); setOpen(true); }
      else {
        const siblings = (childrenMap.get(note.parentId || 'root') || []).filter((s) => s.id === note.id || !ids.includes(s.id));
        const i = siblings.findIndex((s) => s.id === note.id);
        const afterId = where === 'after' ? note.id : siblings[i - 1]?.id ?? null;
        await movePages(ids, space, { parentId: note.parentId, afterId });
      }
      if (ids.length > 1) setSelected([]);
    } catch (err) { toastError(err); }
  };

  const items = [
    { label: 'Add sub-page', icon: Plus, onClick: () => newPage({ parentId: note.id }) },
    { label: 'Add sub-journal (handwriting)', icon: PenLine, onClick: () => newPage({ parentId: note.id, kind: 'journal' }) },
    { label: 'Duplicate', icon: Copy, onClick: async () => openNote((await post(`/api/notes/${note.id}/duplicate`)).id) },
    { label: 'Move to space…', icon: FolderInput, hidden: !canEdit, submenu: store.get().spaces.filter((s) => s.id !== note.spaceId && ['owner', 'editor'].includes(s.role)).map((s) => ({ label: `${s.icon} ${s.name}`, onClick: () => moveToSpace(note.id, s).catch(toastError) })) },
    { label: 'Select', icon: CheckCheck, onClick: () => setSelected([...new Set([...store.get().selected, note.id])]) },
    { label: 'Move to trash', icon: Trash2, danger: true, onClick: async () => { await trashPages([note.id]); if (activeId === note.id || ancestorsOf(activeId).includes(note.id)) navigate('#/'); } },
  ];
  return (
    <div className="tree-node">
      <a href={`#/n/${note.id}`} data-id={note.id} aria-selected={selected || undefined} className={`tree-row${activeId === note.id ? ' on' : ''}${selected ? ' picked' : ''}${drop ? ` drop-${drop}` : ''}`} style={{ paddingLeft: 6 + depth * 14 }}
        onClick={(e) => clickSelect(e, note.id)}
        draggable={canEdit} onDragStart={(e) => {
          const sel = store.get().selected;
          dragIds = sel.includes(note.id) ? sel : [note.id];
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', dragIds.length > 1 ? `${dragIds.length} pages` : note.title || '');
        }}
        onDragOver={onDragOver} onDragLeave={() => setDrop(null)} onDrop={onDrop} onDragEnd={() => { dragIds = null; setDrop(null); }}>
        <span className={`twisty${kids.length ? '' : ' leaf'}`} onClick={toggle}>{kids.length ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}</span>
        <span className="ticon">{note.icon || (note.kind === 'journal' ? '✍️' : '📄')}</span>
        <span className="grow ttl">{note.title || 'Untitled'}</span>
        {canEdit && <span className="row-actions" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
          <Menu label="Page actions" className="icon tiny" trigger={<MoreHorizontal size={14} />} items={items} />
          <button className="icon tiny" title="Add sub-page" aria-label="Add sub-page" onClick={() => newPage({ parentId: note.id })}><Plus size={14} /></button>
        </span>}
      </a>
      {open && kids.map((k) => <TreeNode key={k.id} note={k} childrenMap={childrenMap} depth={depth + 1} activeId={activeId} canEdit={canEdit} />)}
    </div>
  );
}
