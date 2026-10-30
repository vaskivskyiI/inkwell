// What a page is about, right under its title: the Halcyon e-mails, events and tasks it is linked to, each opening in
// Halcyon; an e-mail also shows its text and conversation here (read from Halcyon when asked, kept nowhere).
import { useEffect, useState } from 'react';
import { Mail, Calendar, CheckSquare, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { get } from './api.js';
import { onEvent } from './data.js';
import { toastError } from './store.js';

const ICONS = { email: Mail, event: Calendar, task: CheckSquare };
const box = { border: '1px solid var(--border)', borderRadius: 8, padding: '4px 10px', marginTop: 6 };

function MailText({ noteId, link }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { get(`/api/notes/${noteId}/links/${link.id}/mail`).then(setData).catch((e) => setError(e.message)); }, [noteId, link.id]);
  if (error) return <p className="muted small">{error}. It can still be opened in Halcyon.</p>;
  if (!data) return <span className="spinner" />;
  return (
    <div style={{ maxHeight: 420, overflow: 'auto', paddingBottom: 6 }}>
      {data.summary && <p className="muted small" style={{ whiteSpace: 'pre-wrap' }}>{data.summary}</p>}
      {data.messages.map((m) => (
        <div key={m.id} style={{ borderTop: '1px solid var(--border)', padding: '6px 0' }}>
          <div className="small"><b>{m.from}</b> <span className="muted">· {m.date ? new Date(m.date).toLocaleString() : ''}</span></div>
          {m.attachments.length > 0 && <div className="muted small">Attachments: {m.attachments.join(', ')}</div>}
          <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 4 }}>{m.text || <span className="muted">(no text)</span>}</div>
        </div>))}
    </div>
  );
}

function Linked({ noteId, link }) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[link.kind];
  const isMail = link.kind === 'email';
  return (
    <div style={box}>
      <div className="row" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <Icon size={15} className="muted" style={{ flex: 'none' }} />
        {isMail
          ? <button className="icon" style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: 1, fontSize: 'inherit', color: 'inherit', textAlign: 'left' }} title={open ? 'Hide the e-mail' : 'Show the e-mail and its conversation'} onClick={() => setOpen(!open)}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{link.title || 'E-mail'}</span></button>
          : <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{link.title || link.ref}</span>}
        {link.openUrl && <a className="small" style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 3 }} href={link.openUrl} target="_blank" rel="noreferrer" title="Open in Halcyon">Halcyon <ExternalLink size={12} /></a>}
      </div>
      {open && <MailText noteId={noteId} link={link} />}
    </div>
  );
}

export function LinkedItems({ noteId }) {
  const [links, setLinks] = useState([]);
  useEffect(() => {
    const load = () => get(`/api/notes/${noteId}/links`).then((l) => setLinks(l.filter((x) => ICONS[x.kind]))).catch(toastError);
    load();
    return onEvent((m) => { if (m.type === 'note:links' && m.noteId === noteId) load(); });
  }, [noteId]);
  return links.map((l) => <Linked key={l.id} noteId={noteId} link={l} />);
}
