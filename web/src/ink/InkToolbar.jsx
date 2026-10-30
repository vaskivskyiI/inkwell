import { useRef, useState } from 'react';
import { addCanvasImage } from './CanvasImages.jsx';
import { toggleCanvasFullscreen } from '../ui/fullscreen.js';
import { PenLine, Highlighter, Eraser, Lasso, Type, Undo2, Redo2, Trash2, ScanText, Shapes, ZoomIn, ZoomOut, Scissors, Maximize2, Minimize2, UnfoldVertical, ImagePlus, Camera, MousePointer2 } from 'lucide-react';
import { useStore, store, localSet } from '../store.js';

export const COLORS = ['#1f2937', '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c'];
const HL = ['#facc15', '#4ade80', '#60a5fa', '#f472b6'];
const WIDTHS = [2, 3, 5, 8];

export function setInkTool(patch) {
  const next = { ...store.get().inkTool, ...patch };
  store.set({ inkTool: next });
  localSet('inkTool', JSON.stringify(next));
}

export function InkToolbar({ canvas, text = false, space = true, onTranscribe, compact = false, onDeleteBlock, zoom = true, extra, imageTarget }) {
  const t = useStore((s) => s.inkTool);
  const pick = useRef(null), camera = useRef(null);
  const addFile = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) addCanvasImage(imageTarget.doc, imageTarget.canvasId, f, imageTarget.noteId, canvas.current?.viewCenter() || { x: 500, y: 200 }); };
  const tools = [['pen', PenLine, 'Pen (P)'], ['hl', Highlighter, 'Highlighter (H)'], ['eraser', Eraser, 'Eraser (E) — the pen\'s eraser button works too'], ['lasso', Lasso, 'Select & move (L)'], ...(space ? [['space', UnfoldVertical, 'Insert space (S): drag down from where you need room; drag up to close empty space']] : []), ...(text ? [['text', Type, 'Text box (T)']] : []), ...(imageTarget ? [['pick', MousePointer2, 'Select pictures: move, scale, rotate, crop (V)']] : [])];
  const palette = t.tool === 'hl' ? HL : COLORS;
  const drawing = t.tool === 'pen' || t.tool === 'hl';
  return (
    <div className={`ink-toolbar${compact ? ' compact' : ''}`} onPointerDown={(e) => { if (e.target.tagName !== 'SELECT') e.preventDefault(); }}>
      {tools.map(([id, Icon, title]) => (
        <button key={id} className={t.tool === id ? 'on' : ''} title={title} aria-label={title} onClick={() => setInkTool({ tool: id })}><Icon size={17} /></button>
      ))}
      {imageTarget && <>
        <button title="Insert a picture" aria-label="Insert a picture" onClick={() => pick.current?.click()}><ImagePlus size={17} /></button>
        <button className="touch-only" title="Take a photo" aria-label="Take a photo" onClick={() => camera.current?.click()}><Camera size={17} /></button>
        <input ref={pick} type="file" hidden accept="image/*" onChange={addFile} />
        <input ref={camera} type="file" hidden accept="image/*" capture="environment" onChange={addFile} />
      </>}
      <span className="sep" />
      {drawing && palette.map((c) => (
        <button key={c} className={`swatch${t.color === c ? ' on' : ''}`} style={{ '--c': c }} title={c} aria-label={`Colour ${c}`} onClick={() => setInkTool({ color: c })} />
      ))}
      {drawing && <span className="sep" />}
      {drawing && WIDTHS.map((w) => (
        <button key={w} className={t.width === w ? 'on' : ''} title={`Width ${w}`} aria-label={`Width ${w}`} onClick={() => setInkTool({ width: w })}>
          <span className="dot" style={{ width: w + 3, height: w + 3 }} />
        </button>
      ))}
      {t.tool === 'pen' && <button className={t.shapes ? 'on' : ''} title="Shapes: straighten lines and snap shapes when you lift the pen (handwriting is left alone). Holding the pen still at the end of a stroke always snaps." aria-label="Shape correction" onClick={() => setInkTool({ shapes: !t.shapes })}><Shapes size={17} /></button>}
      {t.tool === 'eraser' && (
        <>
          <button className={t.eraser !== 'point' ? 'on' : ''} title="Erase whole strokes" onClick={() => setInkTool({ eraser: 'stroke' })}><Eraser size={15} /> Stroke</button>
          <button className={t.eraser === 'point' ? 'on' : ''} title="Erase like a real eraser (cuts strokes)" onClick={() => setInkTool({ eraser: 'point' })}><Scissors size={15} /> Partial</button>
        </>
      )}
      <span className="sep" />
      <button title="Undo (Ctrl+Z)" aria-label="Undo" onClick={() => canvas.current?.undo()}><Undo2 size={17} /></button>
      <button title="Redo (Ctrl+Y)" aria-label="Redo" onClick={() => canvas.current?.redo()}><Redo2 size={17} /></button>
      {zoom && <>
        <button title="Zoom in (Ctrl+=, pinch, Ctrl+wheel)" aria-label="Zoom in" onClick={() => canvas.current?.zoomIn()}><ZoomIn size={17} /></button>
        <button title="Zoom out (Ctrl+-)" aria-label="Zoom out" onClick={() => canvas.current?.zoomOut()}><ZoomOut size={17} /></button>
      </>}
      {extra}
      {onTranscribe && <button title="Read the handwriting now" aria-label="Transcribe" onClick={onTranscribe}><ScanText size={17} /></button>}
      {onDeleteBlock && <button title="Remove this drawing" aria-label="Remove drawing" onClick={onDeleteBlock}><Trash2 size={17} /></button>}
    </div>
  );
}

// Keyboard shortcuts for tools while a canvas has focus.
export function toolKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const k = { p: 'pen', h: 'hl', e: 'eraser', l: 'lasso', t: 'text', s: 'space', v: 'pick' }[e.key.toLowerCase()];
  if (!k) return false;
  setInkTool({ tool: k });
  return true;
}

/** Full-screen toggle for the canvas around the button (the closest `selector`). */
export function FullscreenButton({ selector }) {
  const [fs, setFs] = useState(false);
  const Icon = fs ? Minimize2 : Maximize2;
  return (
    <button className={fs ? 'on' : ''} title={fs ? 'Exit full screen (Esc)' : 'Full screen'} aria-label={fs ? 'Exit full screen' : 'Full screen'}
      onClick={(e) => toggleCanvasFullscreen(e.currentTarget.closest(selector), setFs)}><Icon size={17} /></button>
  );
}
