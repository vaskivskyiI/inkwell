// A page edited as Markdown text. The server turns the page into Markdown (handwriting and recordings become
// `<!-- keep:N -->` lines) and back; Apply replaces the page body for everyone, as one edit (version history has the old one).
import { useEffect, useRef, useState } from 'react';
import { Check, X, Eye, EyeOff } from 'lucide-react';
import { get, put } from '../api.js';
import { toast, toastError, localGet, localSet } from '../store.js';
import { Markdown } from '../ui/Markdown.jsx';

export function MarkdownSource({ noteId, onClose }) {
  const [src, setSrc] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(() => localGet('mdPreview') !== '0');
  const ref = useRef(null);

  useEffect(() => {
    get(`/api/notes/${noteId}/markdown`).then((r) => { setSrc(r); setText(r.markdown); setTimeout(() => ref.current?.focus(), 0); }).catch((e) => { toastError(e); onClose(); });
  }, [noteId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.max(320, el.scrollHeight + 4)}px`; } }, [text, src]);

  const apply = async (force = false) => {
    if (text === src.markdown) { onClose(); return; }
    setBusy(true);
    try {
      await put(`/api/notes/${noteId}/markdown`, { markdown: text, keep: src.keep, base: src.base, force });
      toast('Page updated from Markdown');
      onClose();
    } catch (e) {
      if (e.status === 409 && window.confirm(`${e.message}. Replace the page with your Markdown anyway? (Their change stays in the version history.)`)) { setBusy(false); return apply(true); }
      toastError(e);
    }
    setBusy(false);
  };
  const cancel = () => { if (text === src?.markdown || window.confirm('Discard your Markdown changes?')) onClose(); };
  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'Enter')) { e.preventDefault(); apply(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Tab') {
      // Tab indents (nested lists) instead of leaving the box.
      e.preventDefault();
      const el = e.currentTarget, { selectionStart: a, selectionEnd: b } = el;
      const next = e.shiftKey ? text.slice(0, a).replace(/ {1,2}$/, '') + text.slice(b) : `${text.slice(0, a)}  ${text.slice(b)}`;
      const at = e.shiftKey ? a - (text.slice(0, a).length - text.slice(0, a).replace(/ {1,2}$/, '').length) : a + 2;
      setText(next);
      requestAnimationFrame(() => el.setSelectionRange(at, at));
    }
  };
  if (!src) return <div className="note-loading"><span className="spinner" /></div>;
  return (
    <div className="md-source">
      <div className="md-source-bar">
        <span className="grow muted small">Markdown — <code>**bold**</code> <code>_italic_</code> <code># heading</code> <code>- [ ] to-do</code> <code>&gt; [!💡] callout</code> <code>[[Page]]</code>. Colours and underline are not kept.</span>
        <button className="icon small" onClick={() => { setPreview(!preview); localSet('mdPreview', preview ? '0' : '1'); }} title={preview ? 'Hide preview' : 'Show preview'} aria-label="Preview">{preview ? <EyeOff size={15} /> : <Eye size={15} />}</button>
        <button onClick={cancel} disabled={busy}><X size={14} /> Cancel</button>
        <button className="primary" onClick={() => apply()} disabled={busy} title="Ctrl+S">{busy ? <span className="spinner" /> : <Check size={14} />} Apply</button>
      </div>
      <div className={`md-source-body${preview ? ' split' : ''}`}>
        <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} spellCheck aria-label="Page as Markdown" />
        {preview && <div className="md-preview prose"><Markdown text={text.replace(/^\s*<!--\s*keep:\d+\s*(.*?)\s*—.*-->\s*$/gm, '_[$1]_')} /></div>}
      </div>
    </div>
  );
}
