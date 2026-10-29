import { PenLine, Highlighter, Eraser, Lasso, Type, Undo2, Redo2, Trash2, ScanText } from 'lucide-react';
import { useStore, store, localSet } from '../store.js';

export const COLORS = ['#1f2937', '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c'];
const HL = ['#facc15', '#4ade80', '#60a5fa', '#f472b6'];
const WIDTHS = [2, 3, 5, 8];

export function setInkTool(patch) {
  const next = { ...store.get().inkTool, ...patch };
  store.set({ inkTool: next });
  localSet('inkTool', JSON.stringify(next));
}

export function InkToolbar({ canvas, text = false, onTranscribe, compact = false, onDeleteBlock }) {
  const t = useStore((s) => s.inkTool);
  const tools = [['pen', PenLine, 'Pen (P)'], ['hl', Highlighter, 'Highlighter (H)'], ['eraser', Eraser, 'Eraser (E) — the pen\'s eraser button works too'], ['lasso', Lasso, 'Select & move (L)'], ...(text ? [['text', Type, 'Text box (T)']] : [])];
  const palette = t.tool === 'hl' ? HL : COLORS;
  return (
    <div className={`ink-toolbar${compact ? ' compact' : ''}`} onPointerDown={(e) => e.preventDefault()}>
      {tools.map(([id, Icon, title]) => (
        <button key={id} className={t.tool === id ? 'on' : ''} title={title} aria-label={title} onClick={() => setInkTool({ tool: id })}><Icon size={17} /></button>
      ))}
      <span className="sep" />
      {(t.tool === 'pen' || t.tool === 'hl') && palette.map((c) => (
        <button key={c} className={`swatch${t.color === c ? ' on' : ''}`} style={{ '--c': c }} title={c} aria-label={`Colour ${c}`} onClick={() => setInkTool({ color: c })} />
      ))}
      {(t.tool === 'pen' || t.tool === 'hl') && <span className="sep" />}
      {(t.tool === 'pen' || t.tool === 'hl') && WIDTHS.map((w) => (
        <button key={w} className={t.width === w ? 'on' : ''} title={`Width ${w}`} aria-label={`Width ${w}`} onClick={() => setInkTool({ width: w })}>
          <span className="dot" style={{ width: w + 3, height: w + 3 }} />
        </button>
      ))}
      <span className="sep" />
      <button title="Undo (Ctrl+Z)" aria-label="Undo" onClick={() => canvas.current?.undo()}><Undo2 size={17} /></button>
      <button title="Redo (Ctrl+Y)" aria-label="Redo" onClick={() => canvas.current?.redo()}><Redo2 size={17} /></button>
      {onTranscribe && <button title="Read the handwriting now" aria-label="Transcribe" onClick={onTranscribe}><ScanText size={17} /></button>}
      {onDeleteBlock && <button title="Remove this drawing" aria-label="Remove drawing" onClick={onDeleteBlock}><Trash2 size={17} /></button>}
    </div>
  );
}

// Keyboard shortcuts for tools while a canvas has focus.
export function toolKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const k = { p: 'pen', h: 'hl', e: 'eraser', l: 'lasso', t: 'text' }[e.key.toLowerCase()];
  if (!k) return false;
  setInkTool({ tool: k });
  return true;
}
