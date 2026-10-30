// Block handling around the editor: a handle next to the block under the mouse and a right-click menu (turn into,
// move, duplicate, delete, plus what fits the block: image size, table rows, heading links), and a bar over tables.
import { useEffect, useRef, useState } from 'react';
import { GripVertical, Type, Heading1, Heading2, Heading3, List, ListOrdered, ListChecks, Quote, Code, Lightbulb, Copy, Trash2, ArrowUp, ArrowDown, Link2, ExternalLink, PenLine, Unlink, MessageSquarePlus,
  ChevronsDownUp, Rows3, Columns3, Table2 } from 'lucide-react';
import { toast } from '../store.js';
import { imageToInk, toggleFold } from './extensions.js';

const TURN = [
  ['Text', Type, (c) => c.setParagraph()], ['Heading 1', Heading1, (c) => c.setHeading({ level: 1 })], ['Heading 2', Heading2, (c) => c.setHeading({ level: 2 })],
  ['Heading 3', Heading3, (c) => c.setHeading({ level: 3 })], ['Bullet list', List, (c) => c.toggleBulletList()], ['Numbered list', ListOrdered, (c) => c.toggleOrderedList()],
  ['To-do list', ListChecks, (c) => c.toggleTaskList()], ['Quote', Quote, (c) => c.toggleBlockquote()], ['Code', Code, (c) => c.toggleCodeBlock()], ['Callout', Lightbulb, (c) => c.wrapIn('callout')],
];

export const tableActions = (e) => [
  ['Row above', Rows3, () => e.chain().focus().addRowBefore().run()], ['Row below', Rows3, () => e.chain().focus().addRowAfter().run()],
  ['Column left', Columns3, () => e.chain().focus().addColumnBefore().run()], ['Column right', Columns3, () => e.chain().focus().addColumnAfter().run()],
  ['Delete row', Rows3, () => e.chain().focus().deleteRow().run(), true], ['Delete column', Columns3, () => e.chain().focus().deleteColumn().run(), true],
  ['Header row', Table2, () => e.chain().focus().toggleHeaderRow().run()], ['Delete table', Trash2, () => e.chain().focus().deleteTable().run(), true],
];

/** The top-level block at a document position: { pos, node }. */
function topBlock(state, at) {
  const $p = state.doc.resolve(Math.min(at, state.doc.content.size));
  if ($p.depth >= 1) { const pos = $p.before(1); return { pos, node: state.doc.nodeAt(pos) }; }
  const node = state.doc.nodeAt(at);
  return node ? { pos: at, node } : null;
}

function buildMenu(editor, at, target, { noteId, onComment }) {
  const { state, view } = editor;
  const top = topBlock(state, at);
  if (!top) return [];
  const { pos, node } = top;
  const groups = [];
  const text = !['image', 'inkBlock', 'horizontalRule', 'table', 'audioBlock'].includes(node.type.name);
  if (text) {
    groups.push({ title: 'Turn into', items: TURN.map(([label, icon, run]) => ({ label, icon, run: () => { const c = editor.chain().focus(); if (at > 0) c.setTextSelection(Math.min(at, state.doc.content.size - 1)); run(c).run(); } })) });
  }
  const link = target?.closest?.('a[href]');
  if (link && !link.dataset.pageMention) {
    groups.push({ title: 'Link', items: [
      { label: 'Open link', icon: ExternalLink, run: () => window.open(link.href, '_blank', 'noopener') },
      { label: 'Remove link', icon: Unlink, run: () => editor.chain().setTextSelection(at).extendMarkRange('link').unsetLink().run() },
    ] });
  }
  if (node.type.name === 'image') {
    const set = (w) => editor.chain().command(({ tr }) => { tr.setNodeMarkup(pos, null, { ...node.attrs, width: w }); return true; }).run();
    groups.push({ title: 'Image', items: [
      { label: 'Draw on the image', icon: PenLine, run: () => { const img = view.nodeDOM(pos)?.querySelector?.('img') || view.nodeDOM(pos); imageToInk(view, pos, node, img); } },
      ...[25, 50, 75, 100].map((w) => ({ label: `${w}% width`, run: () => set(w) })),
    ] });
  }
  if (node.type.name === 'inkBlock' && node.attrs.bg) {
    const set = (w) => editor.chain().command(({ tr }) => { tr.setNodeMarkup(pos, null, { ...node.attrs, width: w }); return true; }).run();
    groups.push({ title: 'Picture', items: [25, 50, 75, 100].map((w) => ({ label: `${w}% width`, run: () => set(w) })) });
  }
  if (node.type.name === 'table') {
    groups.push({ title: 'Table', items: tableActions(editor).map(([label, icon, run, danger]) => ({ label, icon, run, danger })) });
  }
  if (node.type.name === 'heading') {
    const chapter = node.textContent;
    groups.push({ title: 'Chapter', items: [
      { label: 'Fold or unfold', icon: ChevronsDownUp, run: () => toggleFold(view, node) },
      { label: 'Copy link to chapter', icon: Link2, run: () => { navigator.clipboard?.writeText(`${location.origin}/#/n/${noteId}?h=${encodeURIComponent(chapter)}`); toast('Link copied'); } },
    ] });
  }
  const size = node.nodeSize;
  const move = (dir) => editor.chain().focus().command(({ tr, state: s }) => {
    const $p = s.doc.resolve(pos);
    const i = $p.index(0);
    if (dir < 0 && i === 0) return false;
    if (dir > 0 && i >= s.doc.childCount - 1) return false;
    const copy = s.doc.nodeAt(pos);
    if (dir < 0) { const before = pos - s.doc.child(i - 1).nodeSize; tr.delete(pos, pos + size).insert(before, copy); } else { const after = pos + size + s.doc.child(i + 1).nodeSize; tr.insert(after, copy).delete(pos, pos + size); }
    return true;
  }).run();
  groups.push({ title: 'Block', items: [
    ...(onComment ? [{ label: 'Comment', icon: MessageSquarePlus, run: () => onComment(node.textContent.slice(0, 200)) }] : []),
    { label: 'Duplicate', icon: Copy, run: () => editor.chain().focus().insertContentAt(pos + size, node.toJSON()).run() },
    { label: 'Move up', icon: ArrowUp, run: () => move(-1) }, { label: 'Move down', icon: ArrowDown, run: () => move(1) },
    { label: 'Delete', icon: Trash2, danger: true, run: () => editor.chain().focus().deleteRange({ from: pos, to: pos + size }).run() },
  ] });
  return groups;
}

export function BlockTools({ editor, wrap, noteId, readOnly, onComment }) {
  const [menu, setMenu] = useState(null); // { x, y, groups }
  const [handle, setHandle] = useState(null); // { top, el }
  const [table, setTable] = useState(null); // { top, left }
  const popup = useRef(null);

  const open = (x, y, at, target) => {
    const groups = buildMenu(editor, at, target, { noteId, onComment });
    if (groups.length) setMenu({ x: Math.min(x, window.innerWidth - 240), y: Math.min(y, window.innerHeight - 320), groups });
  };

  useEffect(() => {
    if (!editor || readOnly) return undefined;
    const dom = editor.view.dom;
    const onContext = (e) => {
      if (e.target.closest('.ink-canvas')) return;
      const p = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (!p) return;
      e.preventDefault();
      open(e.clientX, e.clientY, p.inside >= 0 ? p.inside + 1 : p.pos, e.target);
    };
    const onMove = (e) => {
      let el = e.target;
      while (el && el.parentElement !== dom) el = el.parentElement;
      if (!el) return;
      const host = wrap.current?.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      setHandle((h) => (h?.el === el ? h : { el, top: r.top - host.top + 2 }));
    };
    const onSel = () => {
      if (!editor.isActive('table')) { setTable(null); return; }
      const d = editor.view.domAtPos(editor.state.selection.from).node;
      const t = (d.nodeType === 1 ? d : d.parentElement)?.closest('table');
      const host = wrap.current?.getBoundingClientRect();
      if (t && host) { const r = t.getBoundingClientRect(); setTable({ top: r.top - host.top - 34, left: r.left - host.left }); }
    };
    dom.addEventListener('contextmenu', onContext);
    dom.addEventListener('mousemove', onMove);
    editor.on('selectionUpdate', onSel);
    editor.on('update', onSel);
    return () => { dom.removeEventListener('contextmenu', onContext); dom.removeEventListener('mousemove', onMove); editor.off('selectionUpdate', onSel); editor.off('update', onSel); };
  }, [editor, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!menu) return undefined;
    const close = (e) => { if (!popup.current?.contains(e.target)) setMenu(null); };
    const esc = (e) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc); };
  }, [menu]);

  if (readOnly) return null;
  return (
    <>
      {handle && (
        <button className="block-handle" style={{ top: handle.top }} title="Block menu" aria-label="Block menu" onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { const at = editor.view.posAtDOM(handle.el, 0); open(e.clientX + 8, e.clientY, at, handle.el); }}><GripVertical size={15} /></button>
      )}
      {table && (
        <div className="table-bar" style={{ top: Math.max(0, table.top), left: table.left }} onMouseDown={(e) => e.preventDefault()}>
          {tableActions(editor).map(([label, Icon, run, danger]) => <button key={label} className={danger ? 'danger' : ''} title={label} onClick={run}><Icon size={14} /> {label}</button>)}
        </div>
      )}
      {menu && (
        <div ref={popup} className="popup-menu block-menu" style={{ left: menu.x, top: menu.y }} role="menu" onMouseDown={(e) => e.preventDefault()}>
          {menu.groups.map((g) => (
            <div key={g.title}>
              <div className="menu-title">{g.title}</div>
              {g.items.map((it) => { const Icon = it.icon; return <button key={it.label} role="menuitem" className={it.danger ? 'danger' : ''} onClick={() => { setMenu(null); it.run(); }}>{Icon ? <Icon size={15} /> : <span style={{ width: 15 }} />}<span>{it.label}</span></button>; })}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
