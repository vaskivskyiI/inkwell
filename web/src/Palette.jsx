import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, FilePlus2, PenLine, Settings, MessageSquare, Moon, Home, Trash2, CornerDownLeft } from 'lucide-react';
import { get } from './api.js';
import { store, useStore, openNote, navigate } from './store.js';
import { newPage, openToday } from './Sidebar.jsx';
import { setTheme } from './theme.js';

const COMMANDS = [
  { label: 'New page', icon: FilePlus2, run: () => newPage() },
  { label: 'New journal page (handwriting)', icon: PenLine, run: () => newPage({ kind: 'journal' }) },
  { label: "Open today's journal", icon: PenLine, run: openToday },
  { label: 'Ask Inkwell', icon: MessageSquare, run: () => navigate('#/ask') },
  { label: 'Home', icon: Home, run: () => navigate('#/') },
  { label: 'Trash', icon: Trash2, run: () => navigate('#/trash') },
  { label: 'Settings', icon: Settings, run: () => navigate('#/settings') },
  { label: 'Toggle dark mode', icon: Moon, run: () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') },
];

export function Palette() {
  const open = useStore((s) => s.palette);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [i, setI] = useState(0);
  const input = useRef(null);
  useEffect(() => { if (open) { setQ(''); setHits([]); setI(0); setTimeout(() => input.current?.focus(), 10); } }, [open]);
  useEffect(() => {
    if (!open || q.trim().length < 2) { setHits([]); return undefined; }
    const ctl = new AbortController();
    const t = setTimeout(() => get(`/api/search?q=${encodeURIComponent(q)}&limit=12`, { signal: ctl.signal }).then(setHits).catch(() => {}), 140);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, open]);
  const items = useMemo(() => {
    const s = q.toLowerCase().trim();
    // Instant title matches from loaded trees, then server results (text, handwriting, meaning).
    const titles = s ? Object.values(store.get().trees).flat().filter((n) => (n.title || '').toLowerCase().includes(s)).slice(0, 6)
      .map((n) => ({ key: n.id, label: n.title || 'Untitled', icon: n.icon || (n.kind === 'journal' ? '✍️' : '📄'), run: () => openNote(n.id) })) : [];
    const seen = new Set(titles.map((t) => t.key));
    const found = hits.filter((h) => !seen.has(h.id)).map((h) => ({ key: h.id, label: h.title || 'Untitled', icon: h.icon || (h.kind === 'journal' ? '✍️' : '📄'), snippet: h.snippet, via: h.via, run: () => openNote(h.id) }));
    const cmds = COMMANDS.filter((c) => !s || c.label.toLowerCase().includes(s)).map((c) => ({ ...c, key: c.label, cmd: true }));
    const out = [...titles, ...found, ...cmds];
    if (s) out.push({ key: 'all', label: `Search everything for “${q}”`, icon: Search, cmd: true, run: () => navigate(`#/search?q=${encodeURIComponent(q)}`) });
    return out;
  }, [q, hits]);
  if (!open) return null;
  const close = () => store.set({ palette: false });
  const choose = (it) => { close(); it?.run(); };
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Search and commands">
        <div className="palette-input"><Search size={18} />
          <input ref={input} value={q} placeholder="Search pages, handwriting, commands…" onChange={(e) => { setQ(e.target.value); setI(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(items.length - 1, x + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); choose(items[i]); }
              else if (e.key === 'Escape') close();
            }} />
        </div>
        <div className="palette-list">
          {items.map((it, k) => {
            const Icon = it.icon;
            return (
              <button key={it.key} className={k === i ? 'on' : ''} onMouseEnter={() => setI(k)} onClick={() => choose(it)}>
                {typeof Icon === 'string' ? <span className="emoji">{Icon}</span> : <Icon size={16} />}
                <span className="grow"><span>{it.label}</span>{it.snippet && <span className="snippet">{highlight(it.snippet)}</span>}</span>
                {it.via?.includes('meaning') && !it.via.includes('text') && <span className="badge">related</span>}
                {k === i && <CornerDownLeft size={14} className="muted" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export const highlight = (s) => String(s).split(/(«[^»]*»)/).map((p, j) => (p.startsWith('«') ? <mark key={j}>{p.slice(1, -1)}</mark> : p));
