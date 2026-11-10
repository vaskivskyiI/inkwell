// A drawing in a typed page, with what a handwritten page has: paper (ruled, grid, dotted), text boxes (Text tool),
// pictures, insert space, the structure marks in the margin (headings, to-dos to tick, dividers…), lasso, copy and
// paste, full screen, handwriting read by AI.
import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { NodeViewWrapper } from '@tiptap/react';
import { GripVertical, Sparkles, Copy, ListTree } from 'lucide-react';
import { InkCanvas } from '../ink/InkCanvas.jsx';
import { InkToolbar, toolKey, FullscreenButton, setInkTool } from '../ink/InkToolbar.jsx';
import { TextBox, Marks, PAPERS, boxesOf } from '../ink/JournalView.jsx';
import { structure, sectionIds } from '../ink/structure.js';
import { addCanvasImage } from '../ink/CanvasImages.jsx';
import { sid } from '../ink/geometry.js';
import { useYObserve } from '../ui/ytext.js';
import { useStore, toast, toastError } from '../store.js';
import { post } from '../api.js';
import { Markdown } from '../ui/Markdown.jsx';

export function InkBlockView({ node, updateAttributes, editor, extension, deleteNode, selected, getPos }) {
  const { doc, noteId } = extension.options;
  const canvas = useRef(null);
  const [active, setActive] = useState(false);
  const rec = useStore((s) => s.inkText[noteId]?.[node.attrs.id]);
  const editable = editor.isEditable;
  const [drag, setDrag] = useState(null);
  const [open, setOpen] = useState(false);
  const id = node.attrs.id;
  const boxes = doc.getMap('boxes');
  useYObserve(boxes);
  const showMarks = useStore((s) => s.inkTool.marks !== false);
  const [items, setItems] = useState([]);
  const strokesNow = useRef([]);
  const reading = useRef(0);
  const onStrokes = (strokes) => { strokesNow.current = strokes; clearTimeout(reading.current); reading.current = setTimeout(() => setItems(structure(strokes)), 300); };
  useEffect(() => () => clearTimeout(reading.current), []);
  const addBox = (x, y) => {
    const box = sid();
    doc.transact(() => {
      const m = new Y.Map();
      m.set('canvas', id); m.set('x', Math.round(x)); m.set('y', Math.round(y)); m.set('w', 420); m.set('text', new Y.Text());
      boxes.set(box, m);
    });
    setTimeout(() => document.querySelector(`[data-box="${box}"] textarea`)?.focus(), 30);
    setInkTool({ tool: 'pen' });
  };
  const mine = boxesOf(boxes, id);
  const paper = node.attrs.paper || 'plain';

  const transcribe = () => post(`/api/notes/${noteId}/ink/${node.attrs.id}/recognize`).then(() => toast('Reading your handwriting…')).catch(toastError);
  const insertText = async () => {
    if (!rec?.text) return;
    const { blocks } = await post('/api/markdown/blocks', { markdown: rec.text });
    const pos = getPos() + node.nodeSize;
    editor.chain().insertContentAt(pos, blocks).focus().run();
  };

  // Height: drag the bottom edge.
  const onResizeDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ y: e.clientY, h: node.attrs.height, scale: e.currentTarget.parentElement.clientWidth / 1000 });
  };
  const onResizeMove = (e) => { if (drag) updateAttributes({ height: Math.max(120, Math.round((drag.h + (e.clientY - drag.y) / drag.scale) / 10) * 10) }); };

  return (
    <NodeViewWrapper className={`ink-block${selected || active ? ' active' : ''}`} style={node.attrs.bg && node.attrs.width < 100 ? { width: `${node.attrs.width}%` } : undefined} onFocus={() => setActive(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setActive(false); }}
      onKeyDown={(e) => { if (e.target.tagName !== 'TEXTAREA' && toolKey(e)) e.preventDefault(); }}
      onPaste={(e) => { const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/')); if (f && editable && !node.attrs.bg) { e.preventDefault(); addCanvasImage(doc, id, f, noteId, canvas.current?.viewCenter() || { x: 500, y: 100 }); } }}>
      {editable && <div className="ink-block-bar" contentEditable={false}>
        <span className="drag" data-drag-handle draggable="true" title="Drag to move"><GripVertical size={15} /></span>
        <InkToolbar canvas={canvas} compact text space={!node.attrs.bg} imageTarget={node.attrs.bg ? undefined : { doc, canvasId: id, noteId }} onTranscribe={transcribe} onDeleteBlock={deleteNode} extra={<>
          <button className={showMarks ? 'on' : ''} title="Mark headings, to-dos, lists, boxes and dividers in the margin" aria-label="Page structure" onClick={() => setInkTool({ marks: !showMarks })}><ListTree size={17} /></button>
          {!node.attrs.bg && <select value={paper} onChange={(e) => updateAttributes({ paper: e.target.value })} aria-label="Paper">{PAPERS.map(([p, label]) => <option key={p} value={p}>{label}</option>)}</select>}
          <FullscreenButton selector=".ink-block" />
        </>} />
      </div>}
      <InkCanvas ref={canvas} doc={doc} canvasId={id} height={node.attrs.height} minHeight={node.attrs.bg ? 40 : 120} readOnly={!editable}
        onHeightChange={node.attrs.bg ? undefined : (h) => updateAttributes({ height: h })} paper={node.attrs.bg ? 'plain' : paper} background={node.attrs.bg} spaceable={!node.attrs.bg} images={!node.attrs.bg}
        onStrokesChange={onStrokes} onTap={editable ? addBox : undefined} contentBottom={() => Math.max(0, ...mine.map(([, m]) => (m.get('y') || 0) + 120))}
        onSpace={(y0, dy) => doc.transact(() => { for (const [, m] of mine) if (m.get('y') >= y0) m.set('y', Math.max(0, m.get('y') + dy)); })}>
        {(scale) => <>
          {mine.map(([bid, m]) => <TextBox key={bid} id={bid} map={m} scale={scale} readOnly={!editable} onDelete={() => boxes.delete(bid)} />)}
          {showMarks && <Marks items={items} scale={scale} doc={doc} readOnly={!editable}
            onSelect={(it) => canvas.current?.select(it.kind === 'heading' ? sectionIds(strokesNow.current, items, it) : it.ids)}
            onSpace={(e, y) => canvas.current?.startSpace(e, y)} />}
        </>}
      </InkCanvas>
      {editable && node.attrs.bg && <div className="ink-corner" title="Drag to resize the picture" onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); setDrag({ x: e.clientX, w: node.attrs.width || 100, page: e.currentTarget.closest('.ProseMirror').clientWidth }); }}
        onPointerMove={(e) => { if (drag) updateAttributes({ width: Math.min(100, Math.max(15, Math.round(drag.w + ((e.clientX - drag.x) / drag.page) * 100))) }); }} onPointerUp={() => setDrag(null)} />}
      {editable && !node.attrs.bg && <div className="ink-resize" onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={() => setDrag(null)} title="Drag to resize" />}
      {rec?.text && (
        <div className="ink-transcript" contentEditable={false}>
          <Sparkles size={13} />
          {open ? <div className="t full"><Markdown text={rec.text} /></div> : <span className="t">{rec.text.replace(/^\s*- \[[ xX]\]\s*/gm, '☐ ').replace(/^#+\s*/gm, '').replace(/[*_]{1,2}/g, '')}</span>}
          <button onClick={() => setOpen(!open)} title="Show all that AI read">{open ? 'Less' : 'Full text'}</button>
          {editable && <button onClick={insertText} title="Insert the transcription as text below"><Copy size={13} /> As text</button>}
        </div>
      )}
    </NodeViewWrapper>
  );
}
