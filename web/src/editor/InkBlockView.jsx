import { useRef, useState } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import { GripVertical, Sparkles, Copy } from 'lucide-react';
import { InkCanvas } from '../ink/InkCanvas.jsx';
import { InkToolbar, toolKey, FullscreenButton } from '../ink/InkToolbar.jsx';
import { useStore, toast, toastError } from '../store.js';
import { post } from '../api.js';

export function InkBlockView({ node, updateAttributes, editor, extension, deleteNode, selected, getPos }) {
  const { doc, noteId } = extension.options;
  const canvas = useRef(null);
  const [active, setActive] = useState(false);
  const rec = useStore((s) => s.inkText[noteId]?.[node.attrs.id]);
  const editable = editor.isEditable;
  const [drag, setDrag] = useState(null);

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
      onKeyDown={(e) => { if (toolKey(e)) e.preventDefault(); }}>
      {editable && <div className="ink-block-bar" contentEditable={false}>
        <span className="drag" data-drag-handle draggable="true" title="Drag to move"><GripVertical size={15} /></span>
        <InkToolbar canvas={canvas} compact onTranscribe={transcribe} onDeleteBlock={deleteNode} extra={<FullscreenButton selector=".ink-block" />} />
      </div>}
      <InkCanvas ref={canvas} doc={doc} canvasId={node.attrs.id} height={node.attrs.height} minHeight={node.attrs.bg ? 40 : 120} readOnly={!editable}
        onHeightChange={node.attrs.bg ? undefined : (h) => updateAttributes({ height: h })} paper="plain" background={node.attrs.bg} />
      {editable && node.attrs.bg && <div className="ink-corner" title="Drag to resize the picture" onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); setDrag({ x: e.clientX, w: node.attrs.width || 100, page: e.currentTarget.closest('.ProseMirror').clientWidth }); }}
        onPointerMove={(e) => { if (drag) updateAttributes({ width: Math.min(100, Math.max(15, Math.round(drag.w + ((e.clientX - drag.x) / drag.page) * 100))) }); }} onPointerUp={() => setDrag(null)} />}
      {editable && !node.attrs.bg && <div className="ink-resize" onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={() => setDrag(null)} title="Drag to resize" />}
      {rec?.text && (
        <div className="ink-transcript" contentEditable={false}>
          <Sparkles size={13} /> <span className="t">{rec.text.replace(/^\s*- \[[ xX]\]\s*/gm, '☐ ').replace(/^#+\s*/gm, '').replace(/[*_]{1,2}/g, '')}</span>
          {editable && <button onClick={insertText} title="Insert the transcription as text below"><Copy size={13} /> As text</button>}
        </div>
      )}
    </NodeViewWrapper>
  );
}
