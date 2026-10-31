// The narrow bar on the left, the same as Halcyon's: apps, command palette, space, theme, settings.
import { NotebookPen, Mail, CalendarDays, CheckSquare, Sparkles, Command, Layers, Settings, Sun, Moon, SunMoon, Plus, Users, Check, Bell as Bell2, Home, Columns2, LogOut } from 'lucide-react';
import { embedUrl, openBeside } from './SidePane.jsx';
import { get, post } from './api.js';
import { store, useStore, navigate, localGet } from './store.js';
import { switchSpace, loadSpaces, onEvent } from './data.js';
import { Menu } from './ui/Menu.jsx';
import { setTheme } from './theme.js';
import { useEffect, useState } from 'react';

export const LOGO = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%232563eb'/%3E%3Cpath d='M18 46c8-2 14-10 18-20l6-12 4 2-6 12c-4 10-10 18-20 22z' fill='white'/%3E%3Ccircle cx='18' cy='47' r='3' fill='white'/%3E%3C/svg%3E";

function SpaceButton() {
  const spaces = useStore((s) => s.spaces);
  const spaceId = useStore((s) => s.spaceId);
  const current = spaces.find((s) => s.id === spaceId);
  const items = [
    { label: 'All spaces', icon: spaceId === 'all' ? Check : undefined, onClick: () => switchSpace('all') },
    ...spaces.map((s) => ({ label: `${s.icon || '•'} ${s.name}${s.members > 1 ? ' 👥' : ''}`, icon: s.id === spaceId ? Check : undefined, onClick: () => switchSpace(s.id) })),
    { label: 'New space…', icon: Plus, onClick: async () => { const name = window.prompt('Name of the new space'); if (name) { const s = await post('/api/spaces', { name }); await loadSpaces(); switchSpace(s.id); } } },
    { label: 'Members & sharing…', icon: Users, onClick: () => navigate(`#/settings/spaces${current ? `?space=${current.id}` : ''}`) },
  ];
  return (
    <Menu className={`space-btn${current ? ' active' : ''}`} align="up" label={current ? `Space: ${current.name}` : 'All spaces'} items={items}
      trigger={current ? <span className="space-initial">{current.name.slice(0, 2)}</span> : <Layers size={19} />} />
  );
}

function Bell() {
  const [items, setItems] = useState([]);
  const load = () => get('/api/notifications').then(setItems).catch(() => {});
  useEffect(() => { load(); return onEvent((m) => { if (m.type === 'notification:new') load(); }); }, []);
  const unread = items.filter((n) => !n.read).length;
  const read = () => post('/api/notifications/read').then(load);
  return (
    <span className="bell">
      <Menu className="" align="up" label={unread ? `${unread} new notifications` : 'Notifications'} trigger={<Bell2 size={19} />} items={[
        ...items.slice(0, 12).map((n) => ({ label: `${n.read ? '' : '● '}${n.text.slice(0, 90)}`, onClick: () => { read(); navigate(`#/n/${n.noteId}`); store.set({ panel: 'comments' }); } })),
        ...(items.length ? [{ label: 'Mark all as read', onClick: read }] : [{ label: 'Nothing new', onClick: () => {} }]),
      ]} />
      {unread > 0 && <span className="badge">{unread > 9 ? '9+' : unread}</span>}
    </span>
  );
}

/** Signing out of the suite: this app, then Halcyon, which comes back here to the sign-in page. */
export async function signOut() {
  const { authState } = store.get();
  await post('/api/auth/logout');
  location.href = authState?.halcyonLogin && authState.halcyonUrl
    ? `${authState.halcyonUrl}/api/sso/logout?return=${encodeURIComponent(`${location.origin}/?signedout=1`)}` : '/?signedout=1';
}

function Profile() {
  const user = useStore((s) => s.user);
  return <Menu className="profile-btn" align="up" label={user?.email || 'Profile'} trigger={<span className="avatar" style={{ background: user?.color }}>{user?.name?.[0]?.toUpperCase()}</span>} items={[
    { label: [user?.name, user?.email].filter(Boolean).join(' · '), onClick: () => navigate('#/settings/profile') },
    { label: 'Sign out', icon: LogOut, onClick: signOut },
  ]} />;
}

// The same order in every app of the suite (Halcyon: Shell in web/src/App.jsx), so nothing jumps when switching.
export function Rail() {
  const halcyon = useStore((s) => s.halcyon);
  const authState = useStore((s) => s.authState);
  const route = useStore((s) => s.route);
  const [theme, setPref] = useState(localGet('theme') || 'system');
  const next = { light: 'dark', dark: 'system', system: 'light' }[theme];
  const ThemeIcon = theme === 'system' ? SunMoon : theme === 'dark' ? Moon : Sun;
  const base = halcyon?.connected ? halcyon.baseUrl : authState?.halcyonUrl || null;
  const others = base ? [['Mail', Mail, '/mail/unified'], ['Calendar', CalendarDays, '/calendar'], ['Contacts', Users, '/contacts'], ['Tasks', CheckSquare, '/tasks']] : [];
  return (
    <nav className="rail" aria-label="Apps">
      <img className="logo" src={LOGO} alt="Inkwell" />
      {base && <a href={`${base}/#/home`} title="Home" aria-label="Home"><Home size={21} /></a>}
      {others.map(([label, Icon, path]) => <a key={label} href={`${base}/#${path}`} title={`${label} (Halcyon)`} aria-label={label}><Icon size={21} /></a>)}
      <a className={route.name !== 'settings' && route.name !== 'ask' ? 'active' : ''} href="#/" title="Notes" aria-label="Notes"><NotebookPen size={20} /></a>
      <a className={route.name === 'ask' ? 'active' : ''} href="#/ask" title="Ask Inkwell" aria-label="Ask Inkwell"><Sparkles size={21} /></a>
      <button title="Go to, do, find — Ctrl+K" aria-label="Go to or do (Ctrl+K)" onClick={() => store.set({ palette: true })}><Command size={19} /></button>
      <span className="desk-only"><Menu className="" label="Open another app beside this one" trigger={<Columns2 size={19} />} items={[
        ...others.map(([label, Icon, path]) => ({ label, icon: Icon, onClick: () => openBeside(label, embedUrl(base, `#${path}`)) })),
        { label: 'Notes', icon: NotebookPen, onClick: () => openBeside('Notes', embedUrl(location.origin)) },
      ]} /></span>
      <div className="spacer" />
      <Bell />
      <SpaceButton />
      <button className="desk-only" title={`Theme: ${theme} — click for ${next}`} aria-label="Change theme" onClick={() => { setPref(next); setTheme(next); }}><ThemeIcon size={19} /></button>
      <a className={route.name === 'settings' ? 'active' : ''} href="#/settings" title="Settings" aria-label="Settings"><Settings size={21} /></a>
      <Profile />
    </nav>
  );
}
