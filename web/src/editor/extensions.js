import { Node, Extension, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import Image from '@tiptap/extension-image';
import { sid } from '../ink/geometry.js';
import { localGet, localSet } from '../store.js';
import { InkBlockView } from './InkBlockView.jsx';
import { AudioBlockView } from './AudioBlockView.jsx';

// Handwriting inside a page. Strokes live in the page doc's `ink` map under the block's id.
export const InkBlock = Node.create({
  name: 'inkBlock',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addOptions: () => ({ doc: null, noteId: null }),
  // bg: an uploaded photo/image to draw on (annotation); the block keeps the picture's aspect ratio.
  addAttributes: () => ({ id: { default: null }, height: { default: 240 }, bg: { default: null }, width: { default: 100 } }),
  parseHTML: () => [{ tag: 'div[data-ink-block]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-ink-block': '' })],
  addNodeView() {
    // The canvas handles its own pointer and key events; only drags from the handle reach ProseMirror.
    return ReactNodeViewRenderer(InkBlockView, { stopEvent: ({ event }) => !(event.type.startsWith('drag') || event.type === 'drop') || !event.target?.closest?.('[data-drag-handle]') });
  },
});

export const AudioBlock = Node.create({
  name: 'audioBlock',
  group: 'block',
  atom: true,
  draggable: true,
  addOptions: () => ({ noteId: null }),
  addAttributes: () => ({ src: { default: null }, name: { default: '' } }),
  parseHTML: () => [{ tag: 'div[data-audio-block]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-audio-block': '' })],
  addNodeView() { return ReactNodeViewRenderer(AudioBlockView, { stopEvent: () => true }); },
});

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes: () => ({ emoji: { default: '💡', parseHTML: (el) => el.getAttribute('data-emoji') || '💡' } }),
  parseHTML: () => [{ tag: 'div[data-callout]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '', 'data-emoji': node.attrs.emoji, class: 'callout' }), 0],
});

// [[Page]] links: an inline atom with the page id; the title is refreshed when shown.
export const PageMention = Node.create({
  name: 'pageMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  // anchor: a chapter (heading text) of that page.
  addAttributes: () => ({ id: { default: null }, title: { default: '' }, anchor: { default: null } }),
  parseHTML: () => [{ tag: 'a[data-page-mention]', getAttrs: (el) => ({ id: el.getAttribute('data-id'), title: el.getAttribute('data-title') || el.textContent, anchor: el.getAttribute('data-anchor') }) }],
  renderHTML: ({ node }) => ['a', { 'data-page-mention': '', 'data-id': node.attrs.id, 'data-title': node.attrs.title, ...(node.attrs.anchor ? { 'data-anchor': node.attrs.anchor } : {}),
    href: `#/n/${node.attrs.id}${node.attrs.anchor ? `?h=${encodeURIComponent(node.attrs.anchor)}` : ''}`, class: 'mention' }, `${node.attrs.title || 'Untitled'}${node.attrs.anchor ? ` › ${node.attrs.anchor}` : ''}`],
  renderText: ({ node }) => `[[${node.attrs.title}${node.attrs.anchor ? `#${node.attrs.anchor}` : ''}]]`,
});

/** Lets React menus (slash, [[, AI) take keys first while they are open. */
export const KeyCapture = Extension.create({
  name: 'keyCapture',
  priority: 1000, // before the editor's own Enter/arrow keymaps
  // A function, not a ref object: configure() deep-merges objects, which would copy the ref.
  addOptions: () => ({ onKey: () => false }),
  addProseMirrorPlugins() {
    const { onKey } = this.options;
    return [new Plugin({ props: { handleKeyDown: (view, event) => !!onKey(event) } })];
  },
});

// Images with a width in percent of the page.
export const SizedImage = Image.extend({
  addAttributes() {
    return { ...this.parent?.(), width: { default: null, parseHTML: (el) => el.getAttribute('data-width'), renderHTML: (a) => (a.width ? { 'data-width': a.width, style: `width:${a.width}%` } : {}) } };
  },
});

/** Replaces an image by a drawing block with the picture underneath (same width, so ink scales with it). */
export function imageToInk(view, pos, node, img) {
  const w = img?.naturalWidth || 4, h = img?.naturalHeight || 3;
  const ink = view.state.schema.nodes.inkBlock.create({ id: sid(), height: Math.min(4000, Math.max(80, Math.round((1000 * h) / w))), bg: node.attrs.src, width: Number(node.attrs.width) || 100 });
  view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, ink));
}

// ---- folding chapters: everything under a heading until the next heading of the same or a higher level. Folded
// state is per device (local storage) and a view decoration only, so it never touches the shared document.
const foldKey = new PluginKey('headingFold');
const keyOf = (node) => `${node.attrs.level}:${node.textContent}`;

export function toggleFold(view, node) { view.dispatch(view.state.tr.setMeta(foldKey, keyOf(node))); }

function foldDecorations(doc, folded) {
  const decos = [];
  let hideBelow = 0; // level of the folded heading being hidden under; 0 = not hiding
  let hiddenCount = 0, foldedAt = null;
  const flush = () => {
    const n = hiddenCount;
    if (foldedAt !== null && n) decos.push(Decoration.widget(foldedAt, () => { const s = document.createElement('span'); s.className = 'fold-count'; s.contentEditable = 'false'; s.textContent = `${n} hidden`; return s; }, { side: 1, key: `count-${n}` }));
    foldedAt = null; hiddenCount = 0;
  };
  doc.forEach((node, pos) => {
    const heading = node.type.name === 'heading';
    if (hideBelow && heading && node.attrs.level <= hideBelow) { flush(); hideBelow = 0; }
    if (hideBelow) { decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'fold-hidden' })); hiddenCount++; return; }
    if (heading && node.textContent) {
      const isFolded = folded.has(keyOf(node));
      decos.push(Decoration.widget(pos + 1, (view) => {
        const b = document.createElement('button');
        b.className = `fold-toggle${isFolded ? ' folded' : ''}`;
        b.contentEditable = 'false';
        b.title = isFolded ? 'Unfold chapter' : 'Fold chapter';
        b.setAttribute('aria-label', b.title);
        b.textContent = '▾';
        b.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); toggleFold(view, node); };
        return b;
      }, { side: -1, key: `fold-${isFolded}-${pos}`, ignoreSelection: true }));
      if (isFolded) { hideBelow = node.attrs.level; foldedAt = pos + node.nodeSize - 1; }
    }
  });
  flush();
  return DecorationSet.create(doc, decos);
}

export const HeadingFold = Extension.create({
  name: 'headingFold',
  addOptions: () => ({ noteId: '' }),
  addProseMirrorPlugins() {
    const storeKey = `fold:${this.options.noteId}`;
    return [new Plugin({
      key: foldKey,
      state: {
        init: (_, s) => { const set = new Set(JSON.parse(localGet(storeKey) || '[]')); return { set, deco: foldDecorations(s.doc, set) }; },
        apply(tr, v, old, s) {
          const k = tr.getMeta(foldKey);
          if (k === undefined && !tr.docChanged) return v;
          const set = new Set(v.set);
          if (k !== undefined) { if (set.has(k)) set.delete(k); else set.add(k); localSet(storeKey, JSON.stringify([...set])); }
          return { set, deco: foldDecorations(s.doc, set) };
        },
      },
      props: { decorations: (s) => foldKey.getState(s).deco },
    })];
  },
});

/** Unfolds whatever hides a chapter (a link to it was followed). */
export function unfoldAll(view) {
  const st = foldKey.getState(view.state);
  for (const k of st?.set || []) view.dispatch(view.state.tr.setMeta(foldKey, k));
}
