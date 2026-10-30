// The narrow bar on the left, the same as Halcyon's: apps, command palette, space, theme, settings.
import { NotebookPen, Mail, CalendarDays, CheckSquare, MessageSquare, Command, Layers, Settings, Sun, Moon, SunMoon, Plus, Users, Check } from 'lucide-react';
import { post } from './api.js';
import { store, useStore, navigate, localGet } from './store.js';
import { switchSpace, loadSpaces } from './data.js';
import { Menu } from './ui/Menu.jsx';
import { setTheme } from './theme.js';
import { useState } from 'react';

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

export function Rail() {
  const halcyon = useStore((s) => s.halcyon);
  const route = useStore((s) => s.route);
  const [theme, setPref] = useState(localGet('theme') || 'system');
  const next = { light: 'dark', dark: 'system', system: 'light' }[theme];
  const ThemeIcon = theme === 'system' ? SunMoon : theme === 'dark' ? Moon : Sun;
  const base = halcyon?.connected ? halcyon.baseUrl : null;
  return (
    <nav className="rail" aria-label="Apps">
      <img className="logo" src={LOGO} alt="Inkwell" />
      <a className={route.name !== 'settings' && route.name !== 'ask' ? 'active' : ''} href="#/" title="Notes" aria-label="Notes"><NotebookPen size={21} /></a>
      {base && <a href={`${base}/#/mail/unified`} title="Mail (Halcyon)" aria-label="Mail"><Mail size={21} /></a>}
      {base && <a href={`${base}/#/calendar`} title="Calendar (Halcyon)" aria-label="Calendar"><CalendarDays size={21} /></a>}
      {base && <a href={`${base}/#/tasks`} title="Tasks (Halcyon)" aria-label="Tasks"><CheckSquare size={21} /></a>}
      <a className={route.name === 'ask' ? 'active' : ''} href="#/ask" title="Ask Inkwell" aria-label="Ask Inkwell"><MessageSquare size={20} /></a>
      <button title="Go to, do, find — Ctrl+K" aria-label="Go to or do (Ctrl+K)" onClick={() => store.set({ palette: true })}><Command size={19} /></button>
      <div className="spacer" />
      <SpaceButton />
      <button className="desk-only" title={`Theme: ${theme} — click for ${next}`} aria-label="Change theme" onClick={() => { setPref(next); setTheme(next); }}><ThemeIcon size={19} /></button>
      <a className={route.name === 'settings' ? 'active' : ''} href="#/settings" title="Settings" aria-label="Settings"><Settings size={21} /></a>
    </nav>
  );
}
