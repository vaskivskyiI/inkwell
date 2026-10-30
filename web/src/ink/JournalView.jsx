// A pen-first journal page: endless paper (ruled / grid / dotted / plain), ink anywhere, typed text boxes.
import { useRef, useState, useEffect } from 'react';
import * as Y from 'yjs';
import { GripHorizontal, Plus, X, FileText, Copy, ScanText } from 'lucide-react';
import { InkCanvas } from './InkCanvas.jsx';
import { InkToolbar, toolKey, setInkTool, FullscreenButton } from './InkToolbar.jsx';
import { sid } from './geometry.js';
import { useYObserve, applyText } from '../ui/ytext.js';
import { post } from '../api.js';
import { Markdown } from '../ui/Markdown.jsx';
import { addCanvasImage } from './CanvasImages.jsx';
import { toast, toastError, useStore, openNote } from '../store.js';

const PAPERS = [['ruled', 'Ruled'], ['grid', 'Grid'], ['dotted', 'Dotted'], ['plain', 'Plain']];

export function JournalView({ note, doc, readOnly }) {
  const meta = doc.getMap('meta');
  const boxes = doc.getMap('boxes');
  useYObserve(meta);
  useYObserve(boxes);
  const canvas = useRef(null);
  const paper = meta.get('paper') || 'ruled';
  const [height, setHeight] = useState(() => meta.get('height') || 1400);
  const [showText, setShowText] = useState(false);
  const rec = useStore((s) => s.inkText[note.id]?.page);

  useEffect(() => {
    const on = () => { const h = meta.get('height'); if (h && h > height) setHeight(h); };
    meta.observe(on);
    return () => meta.unobserve(on);
  }, [meta, height]);

  const grow = (h) => { setHeight(h); if (!readOnly) meta.set('height', h); };

  const addBox = (x, y) => {
    const id = sid();
    doc.transact(() => {
      const m = new Y.Map();
      m.set('x', Math.round(x)); m.set('y', Math.round(y)); m.set('w', 420); m.set('text', new Y.Text());
      boxes.set(id, m);
    });
    setTimeout(() => document.querySelector(`[data-box="${id}"] textarea`)?.focus(), 30);
    setInkTool({ tool: 'pen' });
  };

  const transcribe = () => post(`/api/notes/${note.id}/ink/page/recognize`).then(() => toast('Reading your handwriting…')).catch(toastError);

  return (
    <div className="journal" onPaste={(e) => { const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/')); if (f && !readOnly) { e.preventDefault(); addCanvasImage(doc, 'page', f, note.id, canvas.current?.viewCenter() || { x: 500, y: 200 }); } }} onKeyDown={(e) => { if (!readOnly && e.target.tagName !== 'TEXTAREA' && toolKey(e)) e.preventDefault(); }}>
      {readOnly && <button className="recognized-toggle" onClick={() => setShowText(!showText)}><FileText size={15} /> Recognized text</button>}
      {!readOnly && (
        <div className="journal-tools">
          <InkToolbar canvas={canvas} text onTranscribe={transcribe} imageTarget={{ doc, canvasId: 'page', noteId: note.id }} extra={<FullscreenButton selector=".journal" />} />
          <button className={`recognized-toggle${showText ? ' on' : ''}`} title="Show what AI read on this page" onClick={() => setShowText(!showText)}><FileText size={15} /> Recognized text</button>
          <select value={paper} onChange={(e) => meta.set('paper', e.target.value)} aria-label="Paper">
            {PAPERS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </div>
      )}
      <div className={`journal-body${showText ? ' split' : ''}`}>
      <div className="journal-paper">
        <InkCanvas ref={canvas} doc={doc} canvasId="page" height={height} minHeight={1400} autoGrow onHeightChange={grow} readOnly={readOnly} paper={paper} images
          onTap={readOnly ? undefined : addBox} onSpace={(y0, dy) => doc.transact(() => { for (const m of boxes.values()) if (m.get('y') >= y0) m.set('y', Math.max(0, m.get('y') + dy)); })}>
          {(scale) => [...boxes.entries()].map(([id, m]) => <TextBox key={id} id={id} map={m} scale={scale} readOnly={readOnly} onDelete={() => boxes.delete(id)} />)}
        </InkCanvas>
        {!readOnly && <button className="add-paper" onClick={() => grow(height + 1000)}><Plus size={15} /> More paper</button>}
      </div>
      {showText && <RecognizedText rec={rec} note={note} onRead={transcribe} readOnly={readOnly} />}
      </div>
    </div>
  );
}

// What AI read on the page, next to the handwriting.
function RecognizedText({ rec, note, onRead, readOnly }) {
  const typed = async () => {
    try { openNote((await post('/api/notes', { spaceId: note.spaceId, parentId: note.id, title: `${note.title || 'Handwritten'} (typed)`, markdown: rec.text })).id); } catch (e) { toastError(e); }
  };
  return (
    <aside className="recognized" aria-label="Recognized text">
      {rec?.text ? <>
        <Markdown text={rec.text} />
        {!!rec.data?.todos?.length && <p className="muted small">To-dos found: {rec.data.todos.join(' · ')}</p>}
        {rec.data?.confidence != null && rec.data.confidence < 0.6 && <p className="muted small">AI was not sure about parts of this.</p>}
        <div className="row wrap">
          <button onClick={() => { navigator.clipboard?.writeText(rec.text); toast('Copied'); }}><Copy size={14} /> Copy</button>
          {!readOnly && <button onClick={typed}>Make typed page</button>}
          {!readOnly && <button onClick={onRead}><ScanText size={14} /> Read again</button>}
        </div>
      </> : <>
        <p className="muted">{rec?.error ? `AI could not read this page: ${rec.error}` : 'Not read yet. AI reads the page a few seconds after you stop writing; it needs a vision model (Settings → AI).'}</p>
        {!readOnly && <button onClick={onRead}><ScanText size={14} /> Read now</button>}
      </>}
    </aside>
  );
}

function TextBox({ id, map, scale, readOnly, onDelete }) {
  useYObserve(map);
  const ytext = map.get('text');
  useYObserve(ytext);
  const drag = useRef(null);
  const value = ytext?.toString() || '';
  const x = map.get('x'), y = map.get('y'), w = map.get('w') || 420;
  const onDown = (e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { sx: e.clientX, sy: e.clientY, x, y }; };
  const onMove = (e) => {
    const d = drag.current;
    if (!d) return;
    map.doc.transact(() => { map.set('x', Math.round(d.x + (e.clientX - d.sx) / scale)); map.set('y', Math.round(d.y + (e.clientY - d.sy) / scale)); });
  };
  return (
    <div className="text-box" data-box={id} style={{ left: x * scale, top: y * scale, width: w * scale, fontSize: Math.max(12, 18 * scale) }}>
      {!readOnly && <div className="text-box-bar"><span onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} title="Move"><GripHorizontal size={14} /></span>
        <button onClick={onDelete} aria-label="Remove text box"><X size={13} /></button></div>}
      <textarea value={value} readOnly={readOnly} rows={Math.max(1, value.split('\n').length)} placeholder="Type…"
        onChange={(e) => applyText(ytext, e.target.value)} onBlur={() => { if (!ytext.toString().trim()) onDelete(); }} />
    </div>
  );
}

