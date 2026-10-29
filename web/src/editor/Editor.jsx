import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { Placeholder } from '@tiptap/extensions';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import Highlight from '@tiptap/extension-highlight';
import { TextStyle, Color } from '@tiptap/extension-text-style';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import Typography from '@tiptap/extension-typography';
import { Bold, Italic, Underline, Strikethrough, Code, Link2, Highlighter, Sparkles, ChevronDown, Check, X, RotateCcw, ClipboardCopy, CornerDownLeft, Replace } from 'lucide-react';
import { InkBlock, Callout, PageMention, KeyCapture } from './extensions.js';
import { SLASH, AI_ACTIONS, matchSlash } from './commands.js';
import { post, stream, upload } from '../api.js';
import { store, openNote, toast, toastError } from '../store.js';
import { Markdown } from '../ui/Markdown.jsx';

const looksLikeMarkdown = (t) => /(^|\n)(#{1,6} |[-*+] |\d+\. |```|> |\|.*\|)/.test(t);

export function PageEditor({ note, doc, provider, user, readOnly }) {
  const capture = useRef(null);
  const fileInput = useRef(null);
  const [trigger, setTrigger] = useState(null); // { type: 'slash'|'mention', from, query, coords }
  const [ai, setAi] = useState(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false, heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true, defaultProtocol: 'https' } }),
      Collaboration.configure({ document: doc }),
      CollaborationCaret.configure({ provider, user: { name: user.name, color: user.color } }),
      Placeholder.configure({ placeholder: ({ node }) => (node.type.name === 'heading' ? 'Heading' : 'Write, or type “/” for blocks and AI, “[[” to link a page…') }),
      TaskList, TaskItem.configure({ nested: true }), Highlight.configure({ multicolor: true }), TextStyle, Color,
      Image.configure({ inline: false, allowBase64: false }), TableKit.configure({ table: { resizable: true } }), Typography,
      InkBlock.configure({ doc, noteId: note.id }), Callout, PageMention, KeyCapture.configure({ onKey: (e) => capture.current?.(e) }),
    ],
    editable: !readOnly,
    editorProps: {
      attributes: { class: 'prose', spellcheck: 'true' },
      handlePaste: (view, event) => {
        const files = [...(event.clipboardData?.files || [])];
        if (files.length) { event.preventDefault(); files.forEach((f) => insertFile(f)); return true; }
        const text = event.clipboardData?.getData('text/plain') || '';
        if (!event.clipboardData?.getData('text/html') && text.length > 3 && looksLikeMarkdown(text)) {
          event.preventDefault();
          post('/api/markdown/blocks', { markdown: text }).then(({ blocks }) => editorRef.current?.chain().focus().insertContent(blocks).run()).catch(toastError);
          return true;
        }
        return false;
      },
      handleDrop: (view, event, slice, moved) => {
        const files = [...(event.dataTransfer?.files || [])];
        if (moved || !files.length) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        files.forEach((f) => insertFile(f, pos));
        return true;
      },
      handleClickOn: (view, pos, node, nodePos, event) => {
        if (node.type.name === 'pageMention' && node.attrs.id) { event.preventDefault(); openNote(node.attrs.id); return true; }
        const a = event.target.closest?.('a[href]');
        if (a && (event.ctrlKey || event.metaKey || readOnly)) { window.open(a.href, '_blank', 'noopener'); return true; }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => detectTrigger(e),
    onSelectionUpdate: ({ editor: e }) => detectTrigger(e),
  }, [doc, provider, readOnly]);
  const editorRef = useRef(null);
  editorRef.current = editor;

  // Set the awareness name/colour once more (the caret extension sends it on connect).
  useEffect(() => { editor?.commands.updateUser?.({ name: user.name, color: user.color }); }, [editor, user.name, user.color]);

  async function insertFile(file, pos) {
    try {
      const a = await upload(file, { noteId: note.id });
      const e = editorRef.current;
      const chain = e.chain().focus();
      const content = a.mime.startsWith('image/') ? { type: 'image', attrs: { src: a.url, alt: a.name } }
        : { type: 'paragraph', content: [{ type: 'text', text: `📎 ${a.name}`, marks: [{ type: 'link', attrs: { href: a.url } }] }] };
      (pos != null ? chain.insertContentAt(pos, content) : chain.insertContent(content)).run();
    } catch (err) { toastError(err); }
  }

  function detectTrigger(e) {
    const { selection } = e.state;
    if (!selection.empty || !e.isEditable) { setTrigger(null); return; }
    const $from = selection.$from;
    if ($from.parent.type.name === 'codeBlock') { setTrigger(null); return; }
    const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 60), $from.parentOffset, undefined, '￼');
    let m = /(?:^|\s)\/([\w-]{0,20})$/.exec(before);
    const coords = () => { const c = e.view.coordsAtPos(selection.from); return { left: c.left, top: c.bottom }; };
    if (m) { setTrigger({ type: 'slash', from: selection.from - m[1].length - 1, query: m[1], coords: coords(), index: 0 }); return; }
    m = /\[\[([^\]\n]{0,40})$/.exec(before);
    if (m) { setTrigger({ type: 'mention', from: selection.from - m[1].length - 2, query: m[1], coords: coords(), index: 0 }); return; }
    setTrigger(null);
  }

  // ---- AI
  const runAi = async (action, opts = {}) => {
    const e = editorRef.current;
    const { from, to, empty } = e.state.selection;
    const range = opts.wholePage || empty ? null : { from, to };
    let target = '', instruction = '';
    if (opts.ask || action === 'translate' || action === 'custom') {
      const answer = window.prompt(opts.ask || (action === 'translate' ? 'Translate into which language?' : 'What should AI do with it?'), action === 'translate' ? 'English' : '');
      if (!answer) return;
      if (action === 'translate') target = answer; else instruction = answer;
    }
    const text = opts.titleOnly ? doc.getText('title').toString() : range ? e.state.doc.textBetween(from, to, '\n\n', '￼') : '';
    const at = range ? range.to : e.state.selection.to;
    const state = { action, label: AI_ACTIONS.find((a) => a[0] === action)?.[1] || action, range, insertAt: at, result: '', busy: true, error: null, target, instruction, text };
    setAi(state);
    const ctl = new AbortController();
    state.ctl = ctl;
    try {
      const out = await stream('/api/ai/inline', { action, text, noteId: note.id, target, instruction }, { signal: ctl.signal, onToken: (t) => setAi((s) => s && { ...s, result: s.result + t }) });
      setAi((s) => s && { ...s, result: out?.text ?? s.result, busy: false });
    } catch (err) {
      if (err.name !== 'AbortError') setAi((s) => s && { ...s, busy: false, error: err.message });
    }
  };

  const applyAi = async (mode) => {
    const e = editorRef.current;
    const { blocks } = await post('/api/markdown/blocks', { markdown: ai.result });
    const content = blocks.length === 1 && blocks[0].type === 'paragraph' && mode === 'replace' && ai.range ? blocks[0].content : blocks;
    if (mode === 'replace' && ai.range) e.chain().focus().deleteRange(ai.range).insertContentAt(ai.range.from, content).run();
    else {
      const $pos = e.state.doc.resolve(Math.min(ai.insertAt, e.state.doc.content.size));
      const after = $pos.depth ? $pos.after(1) : e.state.doc.content.size;
      e.chain().focus().insertContentAt(after, blocks).run();
    }
    setAi(null);
  };

  // ---- menus take the keyboard while open
  const slashItems = useMemo(() => (trigger?.type === 'slash' ? matchSlash(SLASH, trigger.query) : []), [trigger?.type, trigger?.query]);
  const mentionItems = useMemo(() => {
    if (trigger?.type !== 'mention') return [];
    const q = trigger.query.toLowerCase();
    const all = Object.values(store.get().trees).flat().filter((n) => n.id !== note.id && (n.title || 'Untitled').toLowerCase().includes(q));
    const list = all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8).map((n) => ({ id: n.id, label: n.title || 'Untitled', icon: n.icon }));
    if (trigger.query.trim()) list.push({ create: true, label: `Create “${trigger.query.trim()}”` });
    return list;
  }, [trigger?.type, trigger?.query, note.id]);
  const items = trigger?.type === 'slash' ? slashItems : mentionItems;

  const choose = async (item) => {
    const e = editorRef.current;
    const t = trigger;
    setTrigger(null);
    e.chain().focus().deleteRange({ from: t.from, to: e.state.selection.from }).run();
    if (t.type === 'slash') item.run(e, { pickFile: () => fileInput.current?.click(), ai: runAi });
    else {
      let target = item;
      if (item.create) {
        const n = await post('/api/notes', { spaceId: note.spaceId, parentId: note.id, title: t.query.trim() });
        target = { id: n.id, label: n.title };
      }
      e.chain().focus().insertContent([{ type: 'pageMention', attrs: { id: target.id, title: target.label } }, { type: 'text', text: ' ' }]).run();
    }
  };

  capture.current = (event) => {
    if (ai && event.key === 'Escape') { ai.ctl?.abort(); setAi(null); return true; }
    if (!trigger || !items.length) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const d = event.key === 'ArrowDown' ? 1 : -1;
      setTrigger((t) => ({ ...t, index: (t.index + d + items.length) % items.length }));
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') { choose(items[trigger.index] || items[0]); return true; }
    if (event.key === 'Escape') { setTrigger(null); return true; }
    return false;
  };

  if (!editor) return null;
  return (
    <div className="editor-wrap">
      <EditorContent editor={editor} />
      <input ref={fileInput} type="file" hidden multiple onChange={(e) => { [...e.target.files].forEach((f) => insertFile(f)); e.target.value = ''; }} />
      {!readOnly && <BubbleMenu editor={editor} options={{ placement: 'top' }} shouldShow={({ editor: e, state }) => !state.selection.empty && e.isEditable && !e.isActive('inkBlock') && !e.isActive('image')}>
        <FormatBar editor={editor} onAi={runAi} />
      </BubbleMenu>}
      {trigger && items.length > 0 && (
        <div className="popup-menu" style={{ left: Math.min(trigger.coords.left, window.innerWidth - 300), top: trigger.coords.top + 6 }} onMouseDown={(e) => e.preventDefault()}>
          {items.map((it, i) => {
            const Icon = it.icon;
            return (
              <button key={it.id || it.label} className={i === trigger.index ? 'on' : ''} onMouseEnter={() => setTrigger((t) => ({ ...t, index: i }))} onClick={() => choose(it)}>
                {typeof Icon === 'string' || !Icon ? <span className="emoji">{Icon || (it.create ? '＋' : '📄')}</span> : <Icon size={16} />}
                <span>{it.label}</span>
              </button>
            );
          })}
        </div>
      )}
      {ai && <AiCard ai={ai} onClose={() => { ai.ctl?.abort(); setAi(null); }} onApply={applyAi} onRetry={() => runAi(ai.action, { wholePage: !ai.range })} />}
    </div>
  );
}

function FormatBar({ editor, onAi }) {
  const [menu, setMenu] = useState(false);
  const b = (name, Icon, cmd, title, attrs) => (
    <button className={editor.isActive(name, attrs) ? 'on' : ''} title={title} aria-label={title} onMouseDown={(e) => e.preventDefault()} onClick={cmd}><Icon size={16} /></button>
  );
  const link = () => {
    const prev = editor.getAttributes('link').href || '';
    const href = window.prompt('Link address', prev || 'https://');
    if (href === null) return;
    if (!href) editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  };
  return (
    <div className="format-bar">
      <button className="ai-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setMenu((m) => !m)}><Sparkles size={15} /> AI <ChevronDown size={13} /></button>
      {b('bold', Bold, () => editor.chain().focus().toggleBold().run(), 'Bold (Ctrl+B)')}
      {b('italic', Italic, () => editor.chain().focus().toggleItalic().run(), 'Italic (Ctrl+I)')}
      {b('underline', Underline, () => editor.chain().focus().toggleUnderline().run(), 'Underline (Ctrl+U)')}
      {b('strike', Strikethrough, () => editor.chain().focus().toggleStrike().run(), 'Strikethrough')}
      {b('code', Code, () => editor.chain().focus().toggleCode().run(), 'Code')}
      {b('highlight', Highlighter, () => editor.chain().focus().toggleHighlight({ color: '#fef08a' }).run(), 'Highlight')}
      {b('link', Link2, link, 'Link (Ctrl+K in text)')}
      {menu && (
        <div className="popup-menu ai-menu" onMouseDown={(e) => e.preventDefault()}>
          {AI_ACTIONS.map(([id, label]) => <button key={id} onClick={() => { setMenu(false); onAi(id); }}><Sparkles size={14} /><span>{label}</span></button>)}
        </div>
      )}
    </div>
  );
}

function AiCard({ ai, onClose, onApply, onRetry }) {
  return (
    <div className="ai-card" role="dialog" aria-label="AI result">
      <div className="ai-card-head"><Sparkles size={15} /> <b>{ai.label}</b>{ai.target ? ` → ${ai.target}` : ''}{ai.busy && <span className="spinner" />}
        <button className="icon" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
      <div className="ai-card-body">{ai.error ? <p className="error">{ai.error}</p> : <Markdown text={ai.result || '…'} />}</div>
      {!ai.busy && !ai.error && (
        <div className="ai-card-actions">
          {ai.range && <button className="primary" onClick={() => onApply('replace')}><Replace size={15} /> Replace</button>}
          <button className={ai.range ? '' : 'primary'} onClick={() => onApply('insert')}><CornerDownLeft size={15} /> Insert below</button>
          <button onClick={() => { navigator.clipboard?.writeText(ai.result); toast('Copied'); }}><ClipboardCopy size={15} /> Copy</button>
          <button onClick={onRetry}><RotateCcw size={15} /> Retry</button>
          <button onClick={onClose}><X size={15} /> Discard</button>
        </div>
      )}
      {ai.busy && <div className="ai-card-actions"><button onClick={onClose}><Check size={15} /> Stop</button></div>}
    </div>
  );
}
