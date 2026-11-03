import { useEffect, useRef, useState } from 'react';
import { addCanvasImage } from './CanvasImages.jsx';
import { toggleCanvasFullscreen } from '../ui/fullscreen.js';
import { PenLine, Highlighter, Eraser, Lasso, Type, Undo2, Redo2, Trash2, ScanText, Shapes, ZoomIn, ZoomOut, Scissors, Maximize2, Minimize2, UnfoldVertical, ImagePlus, Camera, MousePointer2, Plus, SlidersHorizontal } from 'lucide-react';
import { useStore } from '../store.js';
import { COLORS, HL, SIZES, RANGE, PALETTE, setInkTool, toolSize, toolColor, setToolSize, setToolColor } from './tools.js';

export { COLORS, setInkTool };

export function InkToolbar({ canvas, text = false, space = true, onTranscribe, compact = false, onDeleteBlock, zoom = true, extra, imageTarget }) {
  const t = useStore((s) => s.inkTool);
  const pick = useRef(null), camera = useRef(null);
  const addFile = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) addCanvasImage(imageTarget.doc, imageTarget.canvasId, f, imageTarget.noteId, canvas.current?.viewCenter() || { x: 500, y: 200 }); };
  const tools = [['pen', PenLine, 'Pen (P)'], ['hl', Highlighter, 'Highlighter (H)'], ['eraser', Eraser, 'Eraser (E) — the pen\'s eraser button works too'], ['lasso', Lasso, 'Select & move (L)'], ...(space ? [['space', UnfoldVertical, 'Insert space (S): drag down from where you need room; drag up to close empty space']] : []), ...(text ? [['text', Type, 'Text box (T)']] : []), ...(imageTarget ? [['pick', MousePointer2, 'Select pictures: move, scale, rotate, crop (V)']] : [])];
  const drawing = t.tool === 'pen' || t.tool === 'hl';
  const kind = t.tool === 'hl' ? 'hl' : 'pen';
  const base = kind === 'hl' ? HL : COLORS;
  const palette = [...base, ...(t.recent || []).filter((c) => !base.includes(c)).slice(0, 4)];
  const color = toolColor(t), size = toolSize(t);
  return (
    <div className={`ink-toolbar${compact ? ' compact' : ''}`} onPointerDown={(e) => { if (!['SELECT', 'INPUT'].includes(e.target.tagName)) e.preventDefault(); }}>
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
        <button key={c} className={`swatch${color === c ? ' on' : ''}`} style={{ '--c': c }} title={c} aria-label={`Colour ${c}`} onClick={() => setToolColor(c)} />
      ))}
      {drawing && <ColorPicker color={color} on={!palette.includes(color)} />}
      {drawing && <span className="sep" />}
      {drawing && SIZES[kind].map((w) => (
        <button key={w} className={size === w ? 'on' : ''} title={`Size ${w}`} aria-label={`Size ${w}`} onClick={() => setToolSize(w)}>
          <span className="dot" style={dotStyle(w, kind)} />
        </button>
      ))}
      {drawing && <SizePicker kind={kind} size={size} on={!SIZES[kind].includes(size)} />}
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

const dotStyle = (w, kind) => { const d = Math.max(3, Math.min(18, (kind === 'hl' ? w / 2 : w * 1.7) + 2)); return { width: d, height: d }; };

// A small panel under its button; closes on a tap anywhere else.
function Pop({ button, title, children, on }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  return (
    <span className="ink-pop-wrap" ref={ref}>
      <button className={on || open ? 'on' : ''} title={title} aria-label={title} onClick={() => setOpen(!open)}>{button}</button>
      {open && <div className="ink-pop" onClick={(e) => { if (e.target.dataset.close) setOpen(false); }}>{children}</div>}
    </span>
  );
}

function ColorPicker({ color, on }) {
  return (
    <Pop title="More colours" on={on} button={on ? <span className="swatch-dot" style={{ '--c': color }} /> : <Plus size={15} />}>
      <div className="palette-grid">
        {PALETTE.map((c) => <button key={c} data-close="1" className={`swatch${c === color ? ' on' : ''}`} style={{ '--c': c }} title={c} aria-label={`Colour ${c}`} onClick={() => setToolColor(c, { custom: true })} />)}
      </div>
      <label className="row small">Any colour <input type="color" value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#000000'} onChange={(e) => setToolColor(e.target.value, { custom: true })} /></label>
    </Pop>
  );
}

function SizePicker({ kind, size, on }) {
  const [min, max, step] = RANGE[kind];
  return (
    <Pop title="Any size" on={on} button={<SlidersHorizontal size={15} />}>
      <div className="size-pick">
        <span className="size-preview"><span className="dot" style={{ width: Math.min(60, size * (kind === 'hl' ? 0.6 : 1.4) + 1), height: Math.min(60, size * (kind === 'hl' ? 0.6 : 1.4) + 1) }} /></span>
        <input type="range" min={min} max={max} step={step} value={size} onChange={(e) => setToolSize(Number(e.target.value))} aria-label="Size" />
        <span className="small">{size}</span>
      </div>
    </Pop>
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
