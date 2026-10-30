// A recording in a page: player, the transcript when AI has it, and minutes written from it.
import { useEffect, useState } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import { FileText, Sparkles } from 'lucide-react';
import { get, post, stream } from '../api.js';
import { onEvent } from '../data.js';
import { toast, toastError } from '../store.js';

export function AudioBlockView({ node, editor, extension }) {
  const { noteId } = extension.options;
  const id = (/\/api\/assets\/([0-9a-f-]{36})/.exec(node.attrs.src || '') || [])[1];
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!id) return undefined;
    const load = () => get(`/api/assets/${id}/text`).then((r) => setText(r.text === '-' ? '' : r.text)).catch(() => {});
    load();
    return onEvent((m) => { if (m.type === 'ai:audio' && m.assetId === id) load(); });
  }, [id]);
  const minutes = async () => {
    setBusy(true);
    try {
      const out = await stream('/api/ai/inline', { action: 'minutes', text, noteId });
      await post(`/api/notes/${noteId}/append`, { markdown: `## Minutes\n\n${out.text}` });
      toast('Minutes added at the end of the page');
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <NodeViewWrapper className="audio-block" contentEditable={false}>
      <audio controls preload="metadata" src={node.attrs.src} />
      {text ? (
        <details><summary><FileText size={13} /> Transcript</summary><p>{text}</p></details>
      ) : <p className="muted small">The transcript appears here when AI has listened to it (Settings → AI → Speech to text).</p>}
      {text && editor.isEditable && <button onClick={minutes} disabled={busy}><Sparkles size={14} /> {busy ? 'Writing…' : 'Write minutes'}</button>}
    </NodeViewWrapper>
  );
}
