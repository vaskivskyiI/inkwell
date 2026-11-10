// A pen-first journal page: endless paper (ruled / grid / dotted / plain), ink anywhere, typed text boxes.
import { useRef, useState, useEffect } from 'react';
import * as Y from 'yjs';
import { GripHorizontal, Plus, X, FileText, Copy, ScanText, ListTree, Square, SquareCheck, Highlighter, Circle, Dot } from 'lucide-react';
import { InkCanvas, penOnlyActive } from './InkCanvas.jsx';
import { structure, sectionIds } from './structure.js';
import { InkToolbar, toolKey, setInkTool, FullscreenButton } from './InkToolbar.jsx';
import { sid } from './geometry.js';
import { useYObserve, applyText } from '../ui/ytext.js';
import { post } from '../api.js';
import { Markdown } from '../ui/Markdown.jsx';
import { addCanvasImage, placeCanvasImage } from './CanvasImages.jsx';
import { useDrops } from '../capture.js';
import { store, toast, toastError, useStore, openNote } from '../store.js';

export const PAPERS = [['ruled', 'Ruled'], ['grid', 'Grid'], ['dotted', 'Dotted'], ['plain', 'Plain']];
// Text boxes belong to a canvas: none named is the journal's page (drawing blocks in typed pages name theirs).
export const boxesOf = (boxes, canvasId) => [...boxes.entries()].filter(([, m]) => (m.get('canvas') || 'page') === canvasId);

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
  const showMarks = useStore((s) => s.inkTool.marks !== false);
  const [items, setItems] = useState([]);
  const strokesNow = useRef([]);
  const reading = useRef(0);
  const onStrokes = (strokes) => {
    strokesNow.current = strokes;
    clearTimeout(reading.current);
    reading.current = setTimeout(() => setItems(structure(strokes)), 300);
  };
  useEffect(() => () => clearTimeout(reading.current), []);

  useEffect(() => {
    const on = () => { const h = meta.get('height'); if (h && h !== height) setHeight(h); };
    meta.observe(on);
    return () => meta.unobserve(on);
  }, [meta, height]);

  // Opened with "Write by hand": the pen is in hand and keys go to the paper.
  const root = useRef(null);
  useEffect(() => {
    if (readOnly || store.get().penStart !== note.id) return;
    store.set({ penStart: null });
    setInkTool({ tool: 'pen' });
    root.current?.focus({ preventScroll: true });
  }, [note.id, readOnly]);

  const grow = (h) => { if (h === height) return; setHeight(h); if (!readOnly) meta.set('height', h); };
  // A palm brushing the button while writing must not add paper (the pen or a mouse does).
  const paperBy = useRef('');

  // A photo from another device: in the middle of what this screen shows.
  useDrops(note.id, (url, size) => placeCanvasImage(doc, 'page', url, size, canvas.current?.viewCenter() || { x: 500, y: 200 }), !readOnly);

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
    <div className="journal" ref={root} tabIndex={-1} onPaste={(e) => { const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/')); if (f && !readOnly) { e.preventDefault(); addCanvasImage(doc, 'page', f, note.id, canvas.current?.viewCenter() || { x: 500, y: 200 }); } }} onKeyDown={(e) => { if (!readOnly && e.target.tagName !== 'TEXTAREA' && toolKey(e)) e.preventDefault(); }}>
      {readOnly && <button className="recognized-toggle" onClick={() => setShowText(!showText)}><FileText size={15} /> Recognized text</button>}
      {!readOnly && (
        <div className="journal-tools">
          <InkToolbar canvas={canvas} text onTranscribe={transcribe} imageTarget={{ doc, canvasId: 'page', noteId: note.id }} extra={<>
            <button className={showMarks ? 'on' : ''} title="Mark headings, to-dos, lists, boxes and dividers in the margin" aria-label="Page structure" onClick={() => setInkTool({ marks: !showMarks })}><ListTree size={17} /></button>
            <FullscreenButton selector=".journal" />
          </>} />
          <button className={`recognized-toggle${showText ? ' on' : ''}`} title="Show what AI read on this page" onClick={() => setShowText(!showText)}><FileText size={15} /> Recognized text</button>
          <select value={paper} onChange={(e) => meta.set('paper', e.target.value)} aria-label="Paper">
            {PAPERS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </div>
      )}
      <div className={`journal-body${showText ? ' split' : ''}`}>
      <div className="journal-paper">
        <InkCanvas ref={canvas} doc={doc} canvasId="page" height={height} minHeight={1400} autoGrow onHeightChange={grow} readOnly={readOnly} paper={paper} images onStrokesChange={onStrokes}
          contentBottom={() => Math.max(0, ...boxesOf(boxes, 'page').map(([, m]) => (m.get('y') || 0) + 120))}
          onTap={readOnly ? undefined : addBox} onSpace={(y0, dy) => doc.transact(() => { for (const [, m] of boxesOf(boxes, 'page')) if (m.get('y') >= y0) m.set('y', Math.max(0, m.get('y') + dy)); })}>
          {(scale) => <>
            {boxesOf(boxes, 'page').map(([id, m]) => <TextBox key={id} id={id} map={m} scale={scale} readOnly={readOnly} onDelete={() => boxes.delete(id)} />)}
            {showMarks && <Marks items={items} scale={scale} doc={doc} readOnly={readOnly}
              onSelect={(it) => canvas.current?.select(it.kind === 'heading' ? sectionIds(strokesNow.current, items, it) : it.ids)}
              onSpace={(e, y) => canvas.current?.startSpace(e, y)} />}
          </>}
        </InkCanvas>
        {!readOnly && <button className="add-paper" onPointerDown={(e) => { paperBy.current = e.pointerType; }}
          onClick={() => { if (paperBy.current === 'touch' && penOnlyActive()) return; grow(height + 1000); }}><Plus size={15} /> More paper</button>}
      </div>
      {showText && <RecognizedText rec={rec} note={note} onRead={transcribe} readOnly={readOnly} />}
      </div>
    </div>
  );
}

const MARK = { heading: null, divider: GripHorizontal, bullet: Dot, box: Square, circled: Circle, highlight: Highlighter };
const TIP = {
  heading: 'Heading — tap to select its section', divider: 'Divider — drag to make or close space below', bullet: 'List item — tap to select',
  box: 'Boxed — tap to select', circled: 'Circled — tap to select', highlight: 'Highlighted — tap to select', todo: 'To-do — tap to tick it off',
};

// What the page's structure looks like, in the left margin: headings, to-dos (tick them here), dividers (drag them
// to make room), list items, boxed, circled and highlighted parts.
export function Marks({ items, scale, doc, readOnly, onSelect, onSpace }) {
  const ticks = doc.getMap('ticks');
  useYObserve(ticks);
  const used = [];
  return items.map((it) => {
    const y = ((it.y0 + it.y1) / 2) * scale - 11;
    // Marks on the same line sit side by side.
    const n = used.filter((u) => Math.abs(u - y) < 18).length;
    used.push(y);
    const left = Math.max(2, (it.kind === 'todo' ? it.mark.x0 : it.x0) * scale - 28 - n * 24);
    const style = { left, top: y };
    if (it.kind === 'todo') {
      const done = ticks.get(it.box) ?? it.done;
      const m = it.mark;
      return <span key={it.key}>
        <button className={`ink-mark todo${done ? ' done' : ''}`} style={style} title={TIP.todo} aria-label={done ? 'Done to-do' : 'Open to-do'} disabled={readOnly} onClick={() => ticks.set(it.box, !done)}>{done ? <SquareCheck size={14} /> : <Square size={14} />}</button>
        {done && !it.done && <svg className="ink-tick" style={{ left: m.x0 * scale, top: m.y0 * scale, width: (m.x1 - m.x0) * scale, height: (m.y1 - m.y0) * scale }} viewBox="0 0 10 10"><path d="M2 5.5 4.2 7.6 8.2 2.6" /></svg>}
      </span>;
    }
    const Icon = MARK[it.kind];
    if (it.kind === 'divider') return <span key={it.key} className="ink-mark divider" style={{ left: 2, top: y }} title={TIP.divider} onPointerDown={(e) => !readOnly && onSpace(e, it.y1 + 3)}><Icon size={14} /></span>;
    return <button key={it.key} className={`ink-mark ${it.kind}`} style={style} title={TIP[it.kind]} onClick={() => onSelect(it)}>{Icon ? <Icon size={14} /> : `H${it.level}`}</button>;
  });
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

export function TextBox({ id, map, scale, readOnly, onDelete }) {
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

