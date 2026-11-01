// Calendar of notes: a month, each day marked with how many pages were created or worked on, and the pages of the
// chosen day. The server sends half-hour edit slots; days are this device's local days.
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, PenLine, FilePlus2, Pencil } from 'lucide-react';
import { get, post } from './api.js';
import { store, useStore, openNote, toastError, filterSpace, localGet, localSet } from './store.js';
import { onEvent } from './data.js';

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const parseDay = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The weeks shown for a month: Monday first, whole weeks. */
function gridOf(year, month) {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - ((first.getDay() + 6) % 7));
  const days = [];
  for (let d = new Date(start); days.length < 42; d.setDate(d.getDate() + 1)) days.push(new Date(d));
  // Drop a last week that lies wholly in the next month.
  return days.slice(0, days[35].getMonth() !== month ? 35 : 42);
}

export function CalendarPage({ day: routeDay }) {
  const spaceId = useStore((s) => s.spaceId);
  const spaces = useStore((s) => s.spaces);
  const today = dayKey(Date.now());
  const day = /^\d{4}-\d{2}-\d{2}$/.test(routeDay || '') ? routeDay : today;
  const [month, setMonth] = useState(() => { const d = parseDay(day); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [mine, setMine] = useState(() => localGet('calendarMine') === '1');
  const [notes, setNotes] = useState(null);
  const [tick, setTick] = useState(0);
  const grid = useMemo(() => gridOf(month.y, month.m), [month]);

  useEffect(() => { const d = parseDay(day); setMonth((m) => (m.y === d.getFullYear() && m.m === d.getMonth() ? m : { y: d.getFullYear(), m: d.getMonth() })); }, [day]);
  useEffect(() => {
    const from = grid[0].getTime(), to = new Date(grid.at(-1).getFullYear(), grid.at(-1).getMonth(), grid.at(-1).getDate() + 1).getTime();
    const sp = filterSpace();
    let stale = false;
    get(`/api/calendar?from=${from}&to=${to}${sp ? `&space=${sp}` : ''}${mine ? '&mine=1' : ''}`).then((r) => { if (!stale) setNotes(r); }).catch(toastError);
    return () => { stale = true; };
  }, [grid, spaceId, mine, tick]);
  useEffect(() => {
    let t;
    const off = onEvent((m) => { if (['note:created', 'note:updated', 'note:removed', 'tree:changed'].includes(m.type)) { clearTimeout(t); t = setTimeout(() => setTick((x) => x + 1), 1500); } });
    return () => { off(); clearTimeout(t); };
  }, []);

  // day → { created: [note], edited: [{ note, first, last }] }
  const byDay = useMemo(() => {
    const out = new Map();
    const at = (k) => { if (!out.has(k)) out.set(k, { created: [], edited: new Map() }); return out.get(k); };
    for (const n of notes || []) {
      at(dayKey(n.createdAt)).created.push(n);
      for (const s of n.edits) {
        // A slot is the half hour a save fell in; the page's last save narrows down the latest one.
        const first = Math.max(s, n.createdAt), last = Math.max(first, Math.min(s + 1799999, n.updatedAt));
        const e = at(dayKey(s)).edited;
        const cur = e.get(n.id);
        e.set(n.id, cur ? { ...cur, first: Math.min(cur.first, first), last: Math.max(cur.last, last) } : { note: n, first, last });
      }
    }
    for (const v of out.values()) {
      const created = new Set(v.created.map((n) => n.id));
      v.edited = [...v.edited.values()].filter((e) => !created.has(e.note.id) || e.last - e.note.createdAt > 5 * 60000).sort((a, b) => b.last - a.last);
      v.created.sort((a, b) => b.createdAt - a.createdAt);
    }
    return out;
  }, [notes]);

  const go = (k) => { location.hash = `#/calendar/${k}`; };
  const shift = (n) => setMonth(({ y, m }) => { const d = new Date(y, m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const sel = byDay.get(day) || { created: [], edited: [] };
  const spaceOf = (id) => (spaceId === 'all' ? spaces.find((s) => s.id === id) : null);
  const journal = async () => { try { openNote((await post('/api/journal', { date: day })).id); } catch (e) { toastError(e); } };
  const onKey = (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!step) return;
    e.preventDefault();
    const d = parseDay(day); d.setDate(d.getDate() + step); go(dayKey(d));
    setTimeout(() => document.querySelector('.cal-day.sel')?.focus(), 0);
  };
  const label = new Date(month.y, month.m, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
  const weekdays = grid.slice(0, 7).map((d) => d.toLocaleDateString([], { weekday: 'short' }));
  return (
    <div className="page-col calendar-page">
      <div className="cal-head">
        <h1 className="grow">{label}</h1>
        <label className="check small"><input type="checkbox" checked={mine} onChange={(e) => { setMine(e.target.checked); localSet('calendarMine', e.target.checked ? '1' : '0'); }} /> Only my work</label>
        <button className="icon" onClick={() => shift(-1)} aria-label="Previous month" title="Previous month"><ChevronLeft size={18} /></button>
        <button onClick={() => { setMonth({ y: new Date().getFullYear(), m: new Date().getMonth() }); go(today); }}>Today</button>
        <button className="icon" onClick={() => shift(1)} aria-label="Next month" title="Next month"><ChevronRight size={18} /></button>
      </div>
      <div className="cal-grid" role="grid" aria-label={label} onKeyDown={onKey}>
        {weekdays.map((w) => <div key={w} className="cal-wd" role="columnheader">{w}</div>)}
        {grid.map((d) => {
          const k = dayKey(d), v = byDay.get(k);
          const c = v?.created.length || 0, e = v?.edited.length || 0;
          return (
            <button key={k} role="gridcell" aria-selected={k === day} tabIndex={k === day ? 0 : -1}
              className={`cal-day${d.getMonth() !== month.m ? ' out' : ''}${k === today ? ' today' : ''}${k === day ? ' sel' : ''}${c + e ? ' has' : ''}`}
              onClick={() => go(k)} title={c + e ? `${c} created, ${e} edited` : ''}>
              <span className="n">{d.getDate()}</span>
              {c + e > 0 && <span className="cal-marks">{c > 0 && <span className="c">+{c}</span>}{e > 0 && <span className="e">{e}</span>}</span>}
              {c + e > 0 && <span className="cal-heat" style={{ opacity: Math.min(1, 0.15 + (c + e) / 12) }} />}
            </button>
          );
        })}
      </div>
      <p className="muted small cal-legend"><span className="c">+n</span> created · <span className="e">n</span> worked on · arrow keys move between days</p>

      <div className="cal-day-head">
        <h2 className="grow">{parseDay(day).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h2>
        <button onClick={journal}><PenLine size={14} /> Journal of this day</button>
      </div>
      {notes === null ? <span className="spinner" /> : !sel.created.length && !sel.edited.length ? <p className="muted">No pages were created or edited on this day.</p> : (
        <>
          {sel.created.length > 0 && <h3 className="cal-sec"><FilePlus2 size={14} /> Created ({sel.created.length})</h3>}
          {sel.created.map((n) => <Row key={n.id} n={n} space={spaceOf(n.spaceId)} when={time(n.createdAt)} />)}
          {sel.edited.length > 0 && <h3 className="cal-sec"><Pencil size={14} /> Worked on ({sel.edited.length})</h3>}
          {sel.edited.map(({ note: n, first, last }) => <Row key={n.id} n={n} space={spaceOf(n.spaceId)} when={time(first) === time(last) ? time(last) : `${time(first)}–${time(last)}`} />)}
        </>
      )}
    </div>
  );
}

function Row({ n, space, when }) {
  const parent = n.parentId && store.get().trees[n.spaceId]?.find((x) => x.id === n.parentId);
  return (
    <a className="cal-row" href={`#/n/${n.id}`}>
      <span className="ticon">{n.icon || (n.kind === 'journal' ? '✍️' : '📄')}</span>
      <span className="grow ttl">{n.title || 'Untitled'}{parent && <span className="muted small"> · in {parent.title || 'Untitled'}</span>}{space && <span className="muted small"> · {space.icon} {space.name}</span>}</span>
      <span className="muted small">{when}</span>
    </a>
  );
}
