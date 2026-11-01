import { useEffect, useState } from 'react';
import { SidePane } from './SidePane.jsx';
import { Menu as MenuIcon } from 'lucide-react';
import { get } from './api.js';
import { store, useStore, localSet } from './store.js';
import { loadSpaces, loadTree, loadFavorites, connectEvents, switchSpace } from './data.js';
import { setUnauthorizedHandler } from './api.js';
import { Sidebar, newPage, openToday } from './Sidebar.jsx';
import { NoteView } from './NoteView.jsx';
import { HomePage, SearchPage, TrashPage, AskPage, NewFromItem, SmartPage, ReviewPage } from './Pages.jsx';
import { SettingsPage } from './Settings.jsx';
import { CalendarPage } from './Calendar.jsx';
import { QuickActions, CaptureSheet } from './QuickActions.jsx';
import { Palette } from './Palette.jsx';
import { Rail } from './Rail.jsx';
import { AuthPage } from './Auth.jsx';

async function boot() {
  const st = await get('/api/auth/state');
  store.set({ authState: st, user: st.user });
  if (!st.user) return;
  // Back from signing in with Halcyon: on to where the link pointed.
  try { const h = sessionStorage.getItem('afterLogin'); sessionStorage.removeItem('afterLogin'); if (h) location.hash = h; } catch { /* no storage: stays on the home page */ }
  const [spaces, settings, halcyon] = await Promise.all([loadSpaces(), get('/api/settings'), get('/api/integrations/halcyon').catch(() => ({ connected: false }))]);
  store.set({ settings, halcyon });
  const first = store.get().spaceId;
  await loadTree(first === 'all' ? spaces[0]?.id : first || spaces[0]?.id);
  loadFavorites().catch(() => {});
  connectEvents();
  // Other spaces' trees load in the background (page links and the palette search across them).
  for (const s of spaces) if (!store.get().trees[s.id]) loadTree(s.id).catch(() => {});
}

export function App() {
  const user = useStore((s) => s.user);
  const authState = useStore((s) => s.authState);
  const route = useStore((s) => s.route);
  const sidebar = useStore((s) => s.sidebar);
  const toasts = useStore((s) => s.toasts);
  const spaceId = useStore((s) => s.spaceId);
  const [err, setErr] = useState(null);

  useEffect(() => {
    setUnauthorizedHandler(() => store.set({ user: null }));
    boot().catch(setErr);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k' && !e.target.closest?.('.prose')) { e.preventDefault(); store.set({ palette: !store.get().palette }); }
      else if (mod && e.key.toLowerCase() === 'p' && !e.shiftKey) { e.preventDefault(); store.set({ palette: true }); }
      else if (mod && e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newPage(); }
      else if (mod && e.altKey && e.key.toLowerCase() === 'j') { e.preventDefault(); openToday(); }
      else if (mod && /^[1-9]$/.test(e.key) && !e.shiftKey) {
        const s = store.get().spaces[Number(e.key) - 1];
        if (s) { e.preventDefault(); switchSpace(s.id); }
      } else if (mod && e.key === '\\') { e.preventDefault(); const v = !store.get().sidebar; store.set({ sidebar: v }); localSet('sidebar', v ? '1' : '0'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The open page decides the active space (links from other spaces).
  useEffect(() => {
    if (route.name !== 'n') return;
    const n = Object.entries(store.get().trees).find(([, list]) => list.some((x) => x.id === route.id));
    if (n && spaceId !== 'all' && n[0] !== spaceId) switchSpace(n[0]);
  }, [route.name, route.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <div className="empty-state"><h2>Inkwell cannot reach its server</h2><p>{err.message}</p><button onClick={() => location.reload()}>Try again</button></div>;
  if (!authState) return <div className="note-loading"><span className="spinner" /></div>;
  if (!user) return <AuthPage onDone={() => boot().catch(setErr)} />;

  let main;
  if (route.name === 'n' && route.id) main = <NoteView key={route.id} id={route.id} />;
  else if (route.name === 'settings') main = <div className="scroll"><SettingsPage section={route.section} /></div>;
  else if (route.name === 'trash') main = <div className="scroll"><TrashPage /></div>;
  else if (route.name === 'search') main = <div className="scroll"><SearchPage q={route.query.q} /></div>;
  else if (route.name === 'ask') main = <div className="scroll"><AskPage /></div>;
  else if (route.name === 'review') main = <div className="scroll"><ReviewPage /></div>;
  else if (route.name === 'new') main = <NewFromItem query={route.query} />;
  else if (route.name === 'calendar') main = <div className="scroll"><CalendarPage day={route.id} /></div>;
  else if (route.name === 'smart') main = <div className="scroll"><SmartPage cat={route.id} sub={route.query.sub} /></div>;
  else main = <div className="scroll"><HomePage /></div>;

  return (
    <div className={`app${sidebar ? '' : ' no-sidebar'}`}>
      <Rail />
      {sidebar && <Sidebar />}
      {sidebar && <div className="scrim" onClick={() => store.set({ sidebar: false })} />}
      <main className="main">
        <button className="icon burger" onClick={() => { const v = !sidebar; store.set({ sidebar: v }); localSet('sidebar', v ? '1' : '0'); }} aria-label="Toggle sidebar" title="Toggle sidebar (Ctrl+\)"><MenuIcon size={18} /></button>
        {main}
      </main>
      <SidePane />
      <Palette />
      <QuickActions />
      <CaptureSheet />
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}{t.action && <button onClick={t.action.onClick}>{t.action.label}</button>}</div>)}
      </div>
    </div>
  );
}

