// A pen-first journal page: endless paper (ruled / grid / dotted / plain), ink anywhere, typed text boxes.
import { useRef, useState, useEffect } from 'react';
import * as Y from 'yjs';
import { GripHorizontal, Plus, X } from 'lucide-react';
import { InkCanvas } from './InkCanvas.jsx';
import { InkToolbar, toolKey, setInkTool, FullscreenButton } from './InkToolbar.jsx';
import { sid } from './geometry.js';
import { useYObserve, applyText } from '../ui/ytext.js';
import { post } from '../api.js';
import { toast, toastError, useStore } from '../store.js';

const PAPERS = [['ruled', 'Ruled'], ['grid', 'Grid'], ['dotted', 'Dotted'], ['plain', 'Plain']];

export function JournalView({ note, doc, readOnly }) {
  const meta = doc.getMap('meta');
  const boxes = doc.getMap('boxes');
  useYObserve(meta);
  useYObserve(boxes);
  const canvas = useRef(null);
  const paper = meta.get('paper') || 'ruled';
  const [height, setHeight] = useState(() => meta.get('height') || 1400);
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
    <div className="journal" onKeyDown={(e) => { if (!readOnly && e.target.tagName !== 'TEXTAREA' && toolKey(e)) e.preventDefault(); }}>
      {!readOnly && (
        <div className="journal-tools">
          <InkToolbar canvas={canvas} text onTranscribe={transcribe} extra={<FullscreenButton selector=".journal" />} />
          <select value={paper} onChange={(e) => meta.set('paper', e.target.value)} aria-label="Paper">
            {PAPERS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </div>
      )}
      <div className="journal-paper">
        <InkCanvas ref={canvas} doc={doc} canvasId="page" height={height} minHeight={1400} autoGrow onHeightChange={grow} readOnly={readOnly} paper={paper}
          onTap={readOnly ? undefined : addBox}>
          {(scale) => [...boxes.entries()].map(([id, m]) => <TextBox key={id} id={id} map={m} scale={scale} readOnly={readOnly} onDelete={() => boxes.delete(id)} />)}
        </InkCanvas>
        {!readOnly && <button className="add-paper" onClick={() => grow(height + 1000)}><Plus size={15} /> More paper</button>}
      </div>
      {rec?.text && <details className="journal-transcript"><summary>What AI read on this page</summary><pre>{rec.text}</pre></details>}
    </div>
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

