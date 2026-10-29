import { Node, Extension, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { Plugin } from '@tiptap/pm/state';
import { InkBlockView } from './InkBlockView.jsx';

// Handwriting inside a page. Strokes live in the page doc's `ink` map under the block's id.
export const InkBlock = Node.create({
  name: 'inkBlock',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addOptions: () => ({ doc: null, noteId: null }),
  addAttributes: () => ({ id: { default: null }, height: { default: 240 } }),
  parseHTML: () => [{ tag: 'div[data-ink-block]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-ink-block': '' })],
  addNodeView() {
    // The canvas handles its own pointer and key events; only drags from the handle reach ProseMirror.
    return ReactNodeViewRenderer(InkBlockView, { stopEvent: ({ event }) => !(event.type.startsWith('drag') || event.type === 'drop') || !event.target?.closest?.('[data-drag-handle]') });
  },
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
  addAttributes: () => ({ id: { default: null }, title: { default: '' } }),
  parseHTML: () => [{ tag: 'a[data-page-mention]', getAttrs: (el) => ({ id: el.getAttribute('data-id'), title: el.textContent }) }],
  renderHTML: ({ node }) => ['a', { 'data-page-mention': '', 'data-id': node.attrs.id, href: `#/n/${node.attrs.id}`, class: 'mention' }, node.attrs.title || 'Untitled'],
  renderText: ({ node }) => `[[${node.attrs.title}]]`,
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
