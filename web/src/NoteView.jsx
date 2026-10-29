import { useEffect, useState, useRef } from 'react';
import { Star, MoreHorizontal, Sparkles, Link2, MessageSquare, History, Copy, Download, Globe, Trash2, FolderInput, ChevronRight, WifiOff, Eye } from 'lucide-react';
import { get, post, put, patch, del } from './api.js';
import { store, useStore, findNote, openNote, navigate, toast, toastError, localSet } from './store.js';
import { openDoc, onEvent, loadFavorites, forgetDoc } from './data.js';
import { PageEditor } from './editor/Editor.jsx';
import { JournalView } from './ink/JournalView.jsx';
import { useYText } from './ui/ytext.js';
import { Menu } from './ui/Menu.jsx';
import { EmojiPicker } from './ui/EmojiPicker.jsx';
import { RightPanel } from './RightPanel.jsx';

export function NoteView({ id }) {
  const user = useStore((s) => s.user);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [handle, setHandle] = useState(null);
  const [ready, setReady] = useState(false);

  const loadDetail = () => get(`/api/notes/${id}`).then((d) => {
    setDetail(d);
    store.set((s) => ({ inkText: { ...s.inkText, [id]: d.ink } }));
    return d;
  });

  useEffect(() => {
    setDetail(null); setError(null); setReady(false);
    loadDetail().catch((e) => setError(e));
    const h = openDoc(id, user);
    setHandle(h);
    // Show the page as soon as either the offline copy or the server copy is there.
    let done = false;
    const show = () => { if (!done) { done = true; setReady(true); } };
    h.idb.whenSynced.then(() => { if (h.doc.getXmlFragment('default').length || h.doc.getMap('ink').size || h.doc.getText('title').length) show(); });
    if (h.provider.synced) show();
    h.provider.on('synced', show);
    const t = setTimeout(show, 2500);
    const off = onEvent((m) => {
      if (m.type === 'ai:insight' && m.noteId === id) setDetail((d) => d && { ...d, insight: { ...m.insight, updatedAt: Date.now() } });
      if (m.type === 'ai:ink' && m.noteId === id) {
        store.set((s) => ({ inkText: { ...s.inkText, [id]: { ...(s.inkText[id] || {}), [m.canvasId]: { text: m.text, data: m.data } } } }));
      }
      if (m.type === 'note:links' && m.noteId === id) loadDetail().catch(() => {});
      if (m.type === 'note:removed' && m.ids.includes(id)) { toast('This page was moved to the trash'); navigate('#/'); }
    });
    return () => { clearTimeout(t); h.provider.off('synced', show); off(); h.release(); };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="empty-state"><h2>{error.status === 404 ? 'Page not found' : 'Could not open the page'}</h2><p>{error.message}</p><button onClick={() => navigate('#/')}>Go home</button></div>;
  if (!detail || !handle) return <div className="note-loading"><span className="spinner" /></div>;
  const readOnly = !['owner', 'editor'].includes(detail.role) || !!detail.deletedAt;
  return (
    <div className={`note-view kind-${detail.kind}`}>
      <NoteHeader detail={detail} setDetail={setDetail} handle={handle} readOnly={readOnly} />
      <div className="note-scroll" id="note-scroll">
        <div className={detail.kind === 'journal' ? 'journal-col' : 'page-col'}>
          <TitleRow detail={detail} setDetail={setDetail} doc={handle.doc} readOnly={readOnly} />
          {detail.deletedAt && <div className="banner">This page is in the trash. <button onClick={() => post(`/api/notes/${id}/restore`).then(loadDetail).catch(toastError)}>Restore</button></div>}
          {!ready ? <div className="note-loading"><span className="spinner" /></div>
            : detail.kind === 'journal' ? <JournalView note={detail} doc={handle.doc} readOnly={readOnly} />
              : <PageEditor key={id} note={detail} doc={handle.doc} provider={handle.provider} user={user} readOnly={readOnly} />}
        </div>
      </div>
      <PanelHost detail={detail} reload={loadDetail} doc={handle.doc} />
    </div>
  );
}

function Breadcrumbs({ detail }) {
  const spaces = useStore((s) => s.spaces);
  useStore((s) => s.trees);
  const chain = [];
  for (let p = findNote(detail.parentId); p && chain.length < 6; p = findNote(p.parentId)) chain.unshift(p);
  const space = spaces.find((s) => s.id === detail.spaceId);
  return (
    <nav className="crumbs">
      {space && <span className="crumb space" onClick={() => store.set({ spaceId: space.id })}>{space.icon} {space.name}</span>}
      {chain.map((n) => <span key={n.id} className="crumb-wrap"><ChevronRight size={13} /><a className="crumb" href={`#/n/${n.id}`}>{n.icon} {n.title || 'Untitled'}</a></span>)}
    </nav>
  );
}

function Presence({ provider }) {
  const [people, setPeople] = useState([]);
  useEffect(() => {
    const aw = provider.awareness;
    if (!aw) return undefined;
    const on = () => {
      const seen = new Map();
      aw.getStates().forEach((st, cid) => { if (cid !== aw.clientID && st.user?.name) seen.set(st.user.id || st.user.name, st.user); });
      setPeople([...seen.values()]);
    };
    on();
    aw.on('change', on);
    return () => aw.off('change', on);
  }, [provider]);
  if (!people.length) return null;
  return <div className="presence" title={`Also here: ${people.map((p) => p.name).join(', ')}`}>{people.slice(0, 5).map((p) => <span key={p.id || p.name} className="avatar" style={{ background: p.color }}>{p.name[0]?.toUpperCase()}</span>)}</div>;
}

function NoteHeader({ detail, setDetail, handle, readOnly }) {
  const panel = useStore((s) => s.panel);
  const online = useStore((s) => s.online);
  const spaces = useStore((s) => s.spaces);
  const setPanel = (p) => { const next = panel === p ? '' : p; store.set({ panel: next }); localSet('panel', next); };
  const toggleFav = async () => {
    try {
      if (detail.favorite) await del(`/api/favorites/${detail.id}`); else await put(`/api/favorites/${detail.id}`);
      setDetail((d) => ({ ...d, favorite: !d.favorite }));
      loadFavorites();
    } catch (e) { toastError(e); }
  };
  const items = [
    { label: detail.favorite ? 'Remove from favourites' : 'Add to favourites', icon: Star, onClick: toggleFav },
    { label: 'Duplicate', icon: Copy, onClick: async () => openNote((await post(`/api/notes/${detail.id}/duplicate`)).id), hidden: readOnly },
    { label: 'Move to space…', icon: FolderInput, hidden: readOnly, submenu: spaces.filter((s) => s.id !== detail.spaceId && ['owner', 'editor'].includes(s.role)).map((s) => ({ label: `${s.icon} ${s.name}`, onClick: async () => { await patch(`/api/notes/${detail.id}`, { spaceId: s.id }); store.set({ spaceId: s.id }); setDetail((d) => ({ ...d, spaceId: s.id })); toast(`Moved to ${s.name}`); } })) },
    { label: 'Export as Markdown', icon: Download, onClick: () => { location.href = `/api/notes/${detail.id}/export`; } },
    { label: 'Export as HTML', icon: Download, onClick: () => { location.href = `/api/notes/${detail.id}/export?format=html`; } },
    { label: detail.publicSlug ? 'Public link…' : 'Share public link…', icon: Globe, hidden: readOnly, onClick: async () => {
      const { slug } = await post(`/api/notes/${detail.id}/publish`);
      setDetail((d) => ({ ...d, publicSlug: slug }));
      const url = `${location.origin}/api/public/${slug}`;
      navigator.clipboard?.writeText(url);
      if (!window.confirm(`Anyone with this link can read the page:\n\n${url}\n\n(copied). Keep it shared? Cancel turns the link off.`)) {
        await post(`/api/notes/${detail.id}/publish`, { enabled: false });
        setDetail((d) => ({ ...d, publicSlug: null }));
        toast('Public link turned off');
      }
    } },
    { label: 'Version history', icon: History, onClick: () => setPanel('history') },
    { label: 'Move to trash', icon: Trash2, danger: true, hidden: readOnly, onClick: async () => { await del(`/api/notes/${detail.id}`); forgetDoc(detail.id); toast('Moved to the trash', { action: { label: 'Undo', onClick: () => post(`/api/notes/${detail.id}/restore`).then(() => openNote(detail.id)) } }); navigate('#/'); } },
  ].filter((i) => !i.hidden);
  return (
    <header className="note-header">
      <Breadcrumbs detail={detail} />
      <div className="note-actions">
        {!online && <span className="offline" title="Offline — changes are kept on this device and sync when you're back"><WifiOff size={15} /> Offline</span>}
        {readOnly && !detail.deletedAt && <span className="readonly" title="You can view this page"><Eye size={15} /> View only</span>}
        <Presence provider={handle.provider} />
        <button className={`icon${detail.favorite ? ' fav' : ''}`} onClick={toggleFav} title="Favourite" aria-label="Favourite"><Star size={18} /></button>
        <button className={`icon${panel === 'ai' ? ' on' : ''}`} onClick={() => setPanel('ai')} title="AI insights" aria-label="AI insights"><Sparkles size={18} /></button>
        <button className={`icon${panel === 'links' ? ' on' : ''}`} onClick={() => setPanel('links')} title="Links (mail, events, tasks, pages)" aria-label="Links"><Link2 size={18} /></button>
        <button className={`icon${panel === 'ask' ? ' on' : ''}`} onClick={() => setPanel('ask')} title="Ask AI about your notes" aria-label="Ask AI"><MessageSquare size={18} /></button>
        <Menu items={items} trigger={<MoreHorizontal size={18} />} label="Page menu" />
      </div>
    </header>
  );
}

function TitleRow({ detail, setDetail, doc, readOnly }) {
  const [title, setTitle] = useYText(doc.getText('title'));
  const [picker, setPicker] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (ref.current) { ref.current.style.height = 'auto'; ref.current.style.height = `${ref.current.scrollHeight}px`; } }, [title]);
  const setIcon = async (icon) => { setPicker(false); setDetail((d) => ({ ...d, icon })); await patch(`/api/notes/${detail.id}`, { icon }).catch(toastError); };
  const suggestion = detail.insight?.title && !title.trim() ? detail.insight.title : null;
  return (
    <div className="title-row">
      <div className="icon-pick">
        <button className={`page-icon${detail.icon ? '' : ' empty'}`} onClick={() => !readOnly && setPicker((p) => !p)} aria-label="Page icon">{detail.icon || '＋'}</button>
        {picker && <EmojiPicker onPick={setIcon} onClose={() => setPicker(false)} />}
      </div>
      <textarea ref={ref} className="title-input" rows={1} value={title} readOnly={readOnly} placeholder={suggestion || 'Untitled'}
        onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); document.querySelector('.prose')?.focus(); } if (e.key === 'Tab' && suggestion) { e.preventDefault(); setTitle(suggestion); } }} />
      {suggestion && !readOnly && <button className="chip" onClick={() => setTitle(suggestion)} title="AI suggestion — Tab"><Sparkles size={12} /> Use “{suggestion}”</button>}
    </div>
  );
}

function PanelHost({ detail, reload, doc }) {
  const panel = useStore((s) => s.panel);
  if (!panel) return null;
  return <RightPanel panel={panel} detail={detail} reload={reload} doc={doc} />;
}
