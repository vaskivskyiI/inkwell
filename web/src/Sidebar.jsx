import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Plus, Search, Home, PenLine, Trash2, Star, MessageSquare, FilePlus2, MoreHorizontal, Copy, LogOut, CalendarPlus, CalendarDays, CheckSquare, Mail, Sparkles, Compass } from 'lucide-react';
import { get, post, patch, del } from './api.js';
import { store, useStore, openNote, navigate, toast, toastError, localGet, localSet, currentSpace } from './store.js';
import { forgetDoc, onEvent } from './data.js';
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
  try { openNote((await post('/api/journal', {})).id); } catch (e) { toastError(e); }
}

export function Sidebar() {
  const spaces = useStore((s) => s.spaces);
  const spaceId = useStore((s) => s.spaceId);
  const trees = useStore((s) => s.trees);
  const favorites = useStore((s) => s.favorites);
  const route = useStore((s) => s.route);
  const user = useStore((s) => s.user);
  const halcyon = useStore((s) => s.halcyon);
  const space = spaces.find((s) => s.id === spaceId) || spaces[0];
  const all = spaceId === 'all';
  const canEdit = all ? spaces.some((x) => ['owner', 'editor'].includes(x.role)) : ['owner', 'editor'].includes(space?.role);
  const activeId = route.name === 'n' ? route.id : null;

  const logout = async () => { await post('/api/auth/logout'); location.hash = '#/'; location.reload(); };
  const close = () => { if (window.innerWidth < 800) store.set({ sidebar: false }); };

  return (
    <nav className="sidebar" onClick={(e) => { if (e.target.closest('a,.tree-row,.nav-item')) close(); }}>
      <div className="sidebar-title">{all ? 'All spaces' : <>{space?.icon} {space?.name}</>}</div>

      <button className="nav-item search" onClick={() => store.set({ palette: true })}><Search size={16} /><span className="grow">Search</span><kbd>Ctrl K</kbd></button>
      <a className={`nav-item${route.name === 'home' ? ' on' : ''}`} href="#/"><Home size={16} /> Home</a>
      <button className="nav-item" onClick={openToday}><PenLine size={16} /> Today's journal</button>
      <a className={`nav-item${route.name === 'ask' ? ' on' : ''}`} href="#/ask"><MessageSquare size={16} /> Ask Inkwell</a>
      <a className={`nav-item${route.name === 'review' ? ' on' : ''}`} href="#/review"><Compass size={16} /> Review</a>
      {halcyon?.connected && <a className="nav-item" href="#/?meetings=1"><CalendarPlus size={16} /> Meeting notes</a>}

      {favorites.length > 0 && (
        <div className="section">
          <div className="section-head"><Star size={13} /> Favourites</div>
          {favorites.map((n) => <a key={n.id} href={`#/n/${n.id}`} className={`tree-row flat${activeId === n.id ? ' on' : ''}`}><span className="ticon">{n.icon || (n.kind === 'journal' ? '✍️' : '📄')}</span><span className="grow ttl">{n.title || 'Untitled'}</span></a>)}
        </div>
      )}

      <div className="section tree">
        <SmartSection />
        <div className="section-head">
          <span className="grow">Pages</span>
          {canEdit && <Menu label="New…" className="icon small" trigger={<Plus size={15} />} items={[
            { label: 'New page', icon: FilePlus2, onClick: () => newPage() },
            { label: 'New journal (handwriting)', icon: PenLine, onClick: () => newPage({ kind: 'journal' }) },
            { label: 'From template', icon: Copy, submenu: [['meeting', 'Meeting notes'], ['daily', 'Daily plan'], ['project', 'Project brief'], ['oneOnOne', '1:1'], ['lecture', 'Lecture notes']].map(([t, label]) => ({ label, onClick: () => newPage({ template: t }) })) },
          ]} />}
        </div>
        {(all ? spaces : space ? [space] : []).map((sp) => <SpaceTree key={sp.id} space={sp} header={all} activeId={activeId} notes={trees[sp.id]} />)}
      </div>

      <div className="sidebar-foot">
        <a className={`nav-item${route.name === 'trash' ? ' on' : ''}`} href="#/trash"><Trash2 size={16} /> Trash</a>
        <div className="me">
          <span className="avatar" style={{ background: user?.color }}>{user?.name?.[0]?.toUpperCase()}</span>
          <span className="grow ttl">{user?.name}</span>
          <button className="icon small" onClick={logout} title="Sign out" aria-label="Sign out"><LogOut size={15} /></button>
        </div>
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

let dragId = null;

function TreeNode({ note, childrenMap, depth, activeId, canEdit }) {
  const kids = childrenMap.get(note.id) || [];
  const [open, setOpen] = useState(expandedSet.has(note.id));
  const [drop, setDrop] = useState(null); // 'before' | 'inside' | 'after'
  const toggle = (e) => { e.preventDefault(); e.stopPropagation(); const o = !open; setOpen(o); if (o) expandedSet.add(note.id); else expandedSet.delete(note.id); saveExpanded(); };

  const onDragOver = (e) => {
    if (!canEdit || !dragId || dragId === note.id) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    setDrop(y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside');
  };
  const onDrop = async (e) => {
    e.preventDefault();
    const where = drop;
    setDrop(null);
    const id = dragId;
    dragId = null;
    if (!id || id === note.id) return;
    try {
      if (where === 'inside') { await patch(`/api/notes/${id}`, { parentId: note.id }); expandedSet.add(note.id); saveExpanded(); setOpen(true); }
      else {
        const siblings = childrenMap.get(note.parentId || 'root') || [];
        const i = siblings.findIndex((s) => s.id === note.id);
        const afterId = where === 'after' ? note.id : (siblings[i - 1]?.id === id ? siblings[i - 2]?.id : siblings[i - 1]?.id) ?? null;
        await patch(`/api/notes/${id}`, { parentId: note.parentId, afterId });
      }
    } catch (err) { toastError(err); }
  };

  const items = [
    { label: 'Add sub-page', icon: Plus, onClick: () => newPage({ parentId: note.id }) },
    { label: 'Add sub-journal (handwriting)', icon: PenLine, onClick: () => newPage({ parentId: note.id, kind: 'journal' }) },
    { label: 'Duplicate', icon: Copy, onClick: async () => openNote((await post(`/api/notes/${note.id}/duplicate`)).id) },
    { label: 'Move to trash', icon: Trash2, danger: true, onClick: async () => { await del(`/api/notes/${note.id}`); forgetDoc(note.id); toast('Moved to the trash', { action: { label: 'Undo', onClick: () => post(`/api/notes/${note.id}/restore`) } }); if (activeId === note.id) navigate('#/'); } },
  ];
  return (
    <div className="tree-node">
      <a href={`#/n/${note.id}`} className={`tree-row${activeId === note.id ? ' on' : ''}${drop ? ` drop-${drop}` : ''}`} style={{ paddingLeft: 6 + depth * 14 }}
        draggable={canEdit} onDragStart={(e) => { dragId = note.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', note.title || ''); }}
        onDragOver={onDragOver} onDragLeave={() => setDrop(null)} onDrop={onDrop} onDragEnd={() => { dragId = null; setDrop(null); }}>
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
