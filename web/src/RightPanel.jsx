import { useEffect, useState, useRef } from 'react';
import { X, RefreshCw, Sparkles, ListTodo, Send, Mail, CalendarDays, CheckSquare, User, FileText, Globe, Trash2, ExternalLink, PenLine, ArrowRight, RotateCcw } from 'lucide-react';
import { get, post, patch, del, stream } from './api.js';
import { onEvent } from './data.js';
import { store, useStore, openNote, navigate, toast, toastError, localSet } from './store.js';
import { Markdown } from './ui/Markdown.jsx';

const TITLES = { ai: 'AI insights', links: 'Links', ask: 'Ask Inkwell', history: 'Version history', comments: 'Comments' };

export function RightPanel({ panel, detail, reload }) {
  const close = () => { store.set({ panel: '' }); localSet('panel', ''); };
  return (
    <aside className="right-panel" aria-label={TITLES[panel]}>
      <div className="panel-head"><b>{TITLES[panel]}</b><button className="icon" onClick={close} aria-label="Close panel"><X size={17} /></button></div>
      <div className="panel-body">
        {panel === 'ai' && <AiTab detail={detail} reload={reload} />}
        {panel === 'links' && <LinksTab detail={detail} reload={reload} />}
        {panel === 'ask' && <AskTab detail={detail} />}
        {panel === 'history' && <HistoryTab detail={detail} />}
        {panel === 'comments' && <CommentsTab detail={detail} />}
      </div>
    </aside>
  );
}

const ago = (t) => {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

function AiTab({ detail, reload }) {
  const [status, setStatus] = useState(null);
  const [related, setRelated] = useState([]);
  const [chosen, setChosen] = useState(new Set());
  const halcyon = useStore((s) => s.halcyon);
  const ink = useStore((s) => s.inkText[detail.id]) || {};
  const ins = detail.insight;
  useEffect(() => { get('/api/ai/status').then(setStatus).catch(() => {}); get(`/api/notes/${detail.id}/related`).then(setRelated).catch(() => {}); }, [detail.id, ins?.updatedAt]);
  const refresh = () => post(`/api/notes/${detail.id}/ai/refresh`).then(() => toast('AI is reading the page again…')).catch(toastError);
  const actions = ins?.actions || [];
  const picked = actions.filter((_, i) => chosen.has(i));
  const toPage = async () => {
    const md = (picked.length ? picked : actions).map((a) => `- [ ] ${a.text}${a.due ? ` (due ${a.due})` : ''}`).join('\n');
    await post(`/api/notes/${detail.id}/append`, { markdown: `## Action items\n${md}` });
    toast('Added to the page');
  };
  const toHalcyon = async () => {
    const r = await post(`/api/notes/${detail.id}/tasks`, { items: picked.length ? picked : actions });
    toast(`${r.created.length} task${r.created.length === 1 ? '' : 's'} added in Halcyon`);
    reload();
  };
  const canvases = Object.entries(ink).filter(([, r]) => r?.text);
  return (
    <div className="ai-tab">
      {status && !status.chat && <div className="banner">No AI provider yet. <a href="#/settings/ai">Add one in Settings → AI</a> — Ollama runs on your own server.</div>}
      <section>
        <div className="sec-head"><h4><Sparkles size={14} /> Summary</h4><button className="icon small" onClick={refresh} title="Analyse again" aria-label="Analyse again"><RefreshCw size={14} /></button></div>
        {ins?.error && <p className="error small">{ins.error}</p>}
        {ins?.summary ? <p>{ins.summary}</p> : <p className="muted">{status?.chat ? 'AI summarises the page a little after you stop writing.' : '—'}</p>}
        {ins?.updatedAt && <p className="muted small">Updated {ago(ins.updatedAt)}</p>}
        {!!(ins?.tags?.length || detail.tags?.length) && <div className="chips">{[...new Set([...(detail.tags || []), ...(ins?.tags || [])])].map((t) => <button key={t} className="chip" onClick={() => navigate(`#/search?q=${encodeURIComponent(`tag:${t}`)}`)}>#{t}</button>)}</div>}
      </section>
      {actions.length > 0 && (
        <section>
          <h4><ListTodo size={14} /> Action items</h4>
          <ul className="check-list">
            {actions.map((a, i) => (
              <li key={i}><label><input type="checkbox" checked={chosen.has(i)} onChange={() => setChosen((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })} />
                <span>{a.text}{a.due && <span className="muted"> · {a.due}</span>}</span></label></li>
            ))}
          </ul>
          <div className="row">
            <button onClick={() => toPage().catch(toastError)}>Add to page</button>
            {halcyon?.connected && <button className="primary" onClick={() => toHalcyon().catch(toastError)}><Send size={14} /> To Halcyon tasks</button>}
          </div>
        </section>
      )}
      {canvases.length > 0 && (
        <section>
          <h4><PenLine size={14} /> Handwriting</h4>
          {canvases.map(([cid, r]) => (
            <div key={cid} className="transcript">
              <Markdown text={r.text} />
              {!!r.data?.todos?.length && <p className="muted small">To-dos found: {r.data.todos.join(' · ')}</p>}
              <button onClick={() => post(`/api/notes/${detail.id}/append`, { markdown: r.text }).then(() => toast('Added as typed text')).catch(toastError)}>Add as typed text</button>
            </div>
          ))}
        </section>
      )}
      {related.length > 0 && (
        <section>
          <h4><FileText size={14} /> Related pages</h4>
          {related.map((n) => <button key={n.id} className="list-item" onClick={() => openNote(n.id)}><span>{n.icon || (n.kind === 'journal' ? '✍️' : '📄')}</span><span className="grow">{n.title || 'Untitled'}</span><ArrowRight size={14} /></button>)}
        </section>
      )}
    </div>
  );
}

const KIND = { email: [Mail, 'E-mail'], event: [CalendarDays, 'Event'], task: [CheckSquare, 'Task'], contact: [User, 'Person'], note: [FileText, 'Page'], url: [Globe, 'Web link'] };

function LinksTab({ detail, reload }) {
  const halcyon = useStore((s) => s.halcyon);
  const [links, setLinks] = useState([]);
  const [kind, setKind] = useState(halcyon?.connected ? 'event' : 'note');
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const load = () => get(`/api/notes/${detail.id}/links`).then(setLinks).catch(toastError);
  useEffect(() => { load(); }, [detail.id, detail.links?.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const canEdit = ['owner', 'editor'].includes(detail.role);

  useEffect(() => {
    let stop = false;
    const t = setTimeout(async () => {
      if (kind === 'url') { setResults([]); return; }
      if (kind === 'note') {
        const all = Object.values(store.get().trees).flat().filter((n) => n.id !== detail.id && (n.title || '').toLowerCase().includes(q.toLowerCase())).slice(0, 15);
        setResults(all.map((n) => ({ kind: 'note', ref: n.id, title: n.title || 'Untitled', subtitle: '' })));
        return;
      }
      if (!halcyon?.connected) { setResults([]); return; }
      setBusy(true);
      try { const r = await get(`/api/halcyon/search?kind=${kind}&q=${encodeURIComponent(q)}`); if (!stop) setResults(r); } catch (e) { if (!stop) { setResults([]); toastError(e); } } finally { if (!stop) setBusy(false); }
    }, 250);
    return () => { stop = true; clearTimeout(t); };
  }, [kind, q, halcyon?.connected, detail.id]);

  const add = async (item) => { await post(`/api/notes/${detail.id}/links`, item); load(); reload(); toast('Linked'); };
  const addUrl = async () => { const ref = q.trim(); if (!/^https?:\/\//.test(ref)) { toast('Enter a full address starting with https://', { kind: 'error' }); return; } await add({ kind: 'url', ref, title: ref }); setQ(''); };
  const remove = async (l) => { await del(`/api/notes/${detail.id}/links/${l.id}`); load(); };
  const open = (l) => { if (l.kind === 'note') openNote(l.ref); else if (l.openUrl) window.open(l.openUrl, '_blank', 'noopener'); };

  return (
    <div className="links-tab">
      {links.length === 0 && <p className="muted">Nothing linked yet. Link the meeting this page belongs to, the e-mails it is about, or tasks that come out of it.</p>}
      {links.map((l) => {
        const [Icon, label] = KIND[l.kind] || [Globe, l.kind];
        return (
          <div key={l.id} className="link-row">
            <Icon size={16} />
            <button className="grow link-title" onClick={() => open(l)} title={`Open ${label.toLowerCase()}`}>{l.title || l.ref}<span className="muted small">{label}{l.meta?.start ? ` · ${new Date(l.meta.start).toLocaleString()}` : ''}{l.meta?.from ? ` · ${l.meta.from}` : ''}</span></button>
            {l.openUrl && l.kind !== 'note' && <ExternalLink size={14} className="muted" />}
            {canEdit && <button className="icon small" onClick={() => remove(l).catch(toastError)} aria-label="Remove link"><Trash2 size={14} /></button>}
          </div>
        );
      })}
      {canEdit && (
        <section className="add-link">
          <h4>Add a link</h4>
          <div className="seg">
            {Object.entries(KIND).map(([k, [Icon, label]]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => { setKind(k); setResults([]); }} title={label}><Icon size={14} /> {label}</button>)}
          </div>
          {['email', 'event', 'task', 'contact'].includes(kind) && !halcyon?.connected
            ? <p className="muted small">Connect Halcyon in <a href="#/settings/integrations">Settings → Integrations</a> to link e-mails, events, tasks and people.</p>
            : (
              <>
                <div className="row">
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={kind === 'url' ? 'https://…' : kind === 'event' ? 'Search events (±2 months)…' : kind === 'email' ? 'Search mail (from:, subject:…)' : 'Search…'} onKeyDown={(e) => { if (e.key === 'Enter' && kind === 'url') addUrl().catch(toastError); }} />
                  {kind === 'url' && <button onClick={() => addUrl().catch(toastError)}>Add</button>}
                </div>
                {busy && <span className="spinner" />}
                <div className="results">
                  {results.map((r) => (
                    <button key={`${r.kind}:${r.ref}`} className="list-item" onClick={() => add(r).catch(toastError)}>
                      <span className="grow"><span>{r.title}</span>{r.subtitle && <span className="muted small"> {r.subtitle}</span>}</span><span className="muted small">Link</span>
                    </button>
                  ))}
                </div>
              </>
            )}
        </section>
      )}
      {detail.backlinks?.length > 0 && (
        <section>
          <h4>Linked from</h4>
          {detail.backlinks.map((b) => <button key={b.id} className="list-item" onClick={() => openNote(b.id)}><span>{b.icon || '📄'}</span><span className="grow">{b.title || 'Untitled'}</span></button>)}
        </section>
      )}
    </div>
  );
}

export function AskTab({ detail, standalone = false }) {
  const spaceId = useStore((s) => s.spaceId);
  const [scope, setScope] = useState(detail ? 'page' : 'space');
  const [msgs, setMsgs] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs]);
  const send = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setQ('');
    const history = msgs.map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: 'user', content: question }, { role: 'assistant', content: '', sources: [] }]);
    setBusy(true);
    try {
      const out = await stream('/api/ai/ask', { question, history, spaceId: scope === 'all' ? undefined : spaceId, noteId: scope === 'page' ? detail?.id : undefined }, {
        onToken: (t) => setMsgs((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: c[c.length - 1].content + t }; return c; }),
      });
      setMsgs((m) => { const c = [...m]; c[c.length - 1] = { role: 'assistant', content: out.text, sources: out.sources }; return c; });
    } catch (e) {
      setMsgs((m) => { const c = [...m]; c[c.length - 1] = { role: 'assistant', content: `⚠️ ${e.message}`, sources: [] }; return c; });
    } finally { setBusy(false); }
  };
  return (
    <div className={`ask-tab${standalone ? ' standalone' : ''}`}>
      <div className="seg">
        {detail && <button className={scope === 'page' ? 'on' : ''} onClick={() => setScope('page')}>This page</button>}
        {spaceId !== 'all' && <button className={scope === 'space' ? 'on' : ''} onClick={() => setScope('space')}>This space</button>}
        <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All spaces</button>
      </div>
      <div className="chat">
        {!msgs.length && <p className="muted">Ask about anything you wrote or handwrote — e.g. “What did we decide about the budget?” or “Summarise this week's meetings”.</p>}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === 'assistant' ? <Markdown text={m.content || '…'} cite={(n) => { const s = m.sources?.find((x) => x.n === n); return s ? <a className="cite" href={`#/n/${s.id}`} title={s.title}>{n}</a> : `[${n}]`; }} /> : <p>{m.content}</p>}
            {m.sources?.length > 0 && <div className="sources">{m.sources.map((s) => <a key={s.n} href={`#/n/${s.id}`}>[{s.n}] {s.title}</a>)}</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="ask-input">
        <textarea rows={2} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask your notes…" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="primary" onClick={send} disabled={busy || !q.trim()} aria-label="Send">{busy ? <span className="spinner" /> : <Send size={16} />}</button>
      </div>
    </div>
  );
}

function CommentsTab({ detail }) {
  const quote = useStore((s) => s.commentQuote);
  const user = useStore((s) => s.user);
  const [list, setList] = useState(null);
  const [members, setMembers] = useState([]);
  const [body, setBody] = useState('');
  const [reply, setReply] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const canPost = ['owner', 'editor', 'commenter'].includes(detail.role);
  const canManage = ['owner', 'editor'].includes(detail.role);
  const load = () => get(`/api/notes/${detail.id}/comments`).then(setList).catch(toastError);
  useEffect(() => {
    load();
    get(`/api/spaces/${detail.spaceId}/members`).then(setMembers).catch(() => {});
    return onEvent((m) => { if (m.type === 'note:comments' && m.noteId === detail.id) load(); });
  }, [detail.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async () => {
    await post(`/api/notes/${detail.id}/comments`, { body, quote: reply ? '' : quote || '', parentId: reply });
    setBody(''); setReply(null); store.set({ commentQuote: '' }); load();
  };
  if (!list) return <span className="spinner" />;
  const tops = list.filter((c) => !c.parentId && (showDone || !c.resolved));
  const done = list.filter((c) => !c.parentId && c.resolved).length;
  const others = members.filter((m) => m.id !== user.id);
  return (
    <div className="comments-tab">
      {!tops.length && <p className="muted">No comments yet. Right-click a block and choose Comment, or write here. Use @name to tell someone.</p>}
      {tops.map((c) => (
        <div key={c.id} className="comment">
          {c.quote && <blockquote>{c.quote}</blockquote>}
          {[c, ...list.filter((r) => r.parentId === c.id)].map((m) => (
            <div key={m.id} className="comment-msg">
              <div className="row"><span className="avatar" style={{ background: m.color || '#8a93a3' }}>{(m.author || '?')[0]}</span><b>{m.author || 'Former member'}</b><span className="muted small">{new Date(m.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span></div>
              <p>{m.body}</p>
            </div>
          ))}
          <div className="row">
            {canPost && <button className="link" onClick={() => setReply(c.id)}>Reply</button>}
            {(canManage || c.userId === user.id) && <button className="link" onClick={() => patch(`/api/comments/${c.id}`, { resolved: !c.resolved }).then(load).catch(toastError)}>{c.resolved ? 'Reopen' : 'Resolve'}</button>}
            {(canManage || c.userId === user.id) && <button className="link" onClick={() => del(`/api/comments/${c.id}`).then(load).catch(toastError)}>Delete</button>}
          </div>
        </div>
      ))}
      {done > 0 && <button className="link" onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide resolved' : `Show ${done} resolved`}</button>}
      {canPost && (
        <div className="comment-new">
          {quote && !reply && <blockquote>{quote}</blockquote>}
          {reply && <p className="muted small">Replying <button className="link" onClick={() => setReply(null)}>cancel</button></p>}
          <textarea rows={3} value={body} placeholder="Comment… @name notifies them" onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && body.trim()) send().catch(toastError); }} />
          {others.length > 0 && <div className="chips">{others.slice(0, 8).map((m) => <button key={m.id} className="chip" onClick={() => setBody((b) => `${b}${b && !b.endsWith(' ') ? ' ' : ''}@${m.name.toLowerCase().split(/\s+/)[0]} `)}>@{m.name}</button>)}</div>}
          <button className="primary" disabled={!body.trim()} onClick={() => send().catch(toastError)}>Send</button>
        </div>
      )}
    </div>
  );
}

function HistoryTab({ detail }) {
  const [versions, setVersions] = useState(null);
  const [preview, setPreview] = useState(null);
  useEffect(() => { get(`/api/notes/${detail.id}/versions`).then(setVersions).catch(toastError); }, [detail.id]);
  const show = async (v) => setPreview({ ...v, ...(await get(`/api/notes/${detail.id}/versions/${v.id}`)) });
  const restore = async (v) => {
    if (!window.confirm(`Restore the version from ${new Date(v.createdAt).toLocaleString()}? The current content stays in the history.`)) return;
    await post(`/api/notes/${detail.id}/versions/${v.id}/restore`);
    toast('Version restored');
    setPreview(null);
    get(`/api/notes/${detail.id}/versions`).then(setVersions);
  };
  if (!versions) return <span className="spinner" />;
  if (!versions.length) return <p className="muted">Snapshots are taken while you edit (at most every 10 minutes).</p>;
  return (
    <div className="history-tab">
      {preview && (
        <div className="preview">
          <div className="row"><b>{new Date(preview.createdAt).toLocaleString()}</b>
            {['owner', 'editor'].includes(detail.role) && <button className="primary" onClick={() => restore(preview).catch(toastError)}><RotateCcw size={14} /> Restore</button>}
            <button onClick={() => setPreview(null)}>Close</button></div>
          <iframe title="Version preview" sandbox="" srcDoc={preview.html} />
        </div>
      )}
      {versions.map((v) => (
        <button key={v.id} className={`list-item${preview?.id === v.id ? ' on' : ''}`} onClick={() => show(v).catch(toastError)}>
          <span className="grow">{new Date(v.createdAt).toLocaleString()}<span className="muted small"> {v.by || ''}</span></span>
        </button>
      ))}
    </div>
  );
}
