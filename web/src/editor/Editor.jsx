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
import { TableKit } from '@tiptap/extension-table';
import Typography from '@tiptap/extension-typography';
import { Bold, Italic, Underline, Strikethrough, Code, Link2, Highlighter, Sparkles, ChevronDown, Check, X, RotateCcw, ClipboardCopy, CornerDownLeft, Replace } from 'lucide-react';
import { InkBlock, AudioBlock, Callout, PageMention, KeyCapture, SizedImage, HeadingFold, imageToInk, unfoldAll } from './extensions.js';
import { BlockTools } from './BlockTools.jsx';
import { SLASH, AI_ACTIONS, matchSlash } from './commands.js';
import { get, post, stream, upload } from '../api.js';
import { store, useStore, navigate, openNote, toast, toastError } from '../store.js';
import { Markdown } from '../ui/Markdown.jsx';
import { sid } from '../ink/geometry.js';
import { allowKeyboard } from '../ink/keyboard.js';
import { useDrops } from '../capture.js';

const looksLikeMarkdown = (t) => /(^|\n)(#{1,6} |[-*+] |\d+\. |```|> |\|.*\|)/.test(t);

export function PageEditor({ note, doc, provider, user, readOnly }) {
  const capture = useRef(null);
  const touched = useRef(false); // the cursor is somewhere the person put it (else photos go to the end)
  const fileInput = useRef(null);
  const photoInput = useRef(null);
  const pdfInput = useRef(null);
  const recorder = useRef(null);
  const [recording, setRecording] = useState(null); // seconds so far
  const [pdfProgress, setPdfProgress] = useState(null);
  const [trigger, setTrigger] = useState(null); // { type: 'slash'|'mention', from, query, coords }
  const [ai, setAi] = useState(null);
  const wrap = useRef(null);
  const chapter = useStore((s) => (s.route.name === 'n' ? s.route.query.h : null));
  const [headings, setHeadings] = useState([]);

  // A photo (camera on phones) becomes a drawing block with the picture underneath, in the picture's proportions.
  async function insertPhoto(file) {
    try {
      const size = await new Promise((res) => {
        const url = URL.createObjectURL(file);
        const img = new window.Image();
        img.onload = () => { res({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
        img.onerror = () => { res({ w: 4, h: 3 }); URL.revokeObjectURL(url); };
        img.src = url;
      });
      const a = await upload(file, { noteId: note.id });
      const height = Math.min(4000, Math.max(80, Math.round((1000 * size.h) / size.w)));
      editorRef.current.chain().focus().insertContent([{ type: 'inkBlock', attrs: { id: sid(), height, bg: a.url } }, { type: 'paragraph' }]).run();
    } catch (err) { toastError(err); }
  }

  async function startRecording() {
    try {
      const stream2 = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream2);
      const chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        stream2.getTracks().forEach((t) => t.stop());
        clearInterval(recorder.current?.timer);
        recorder.current = null;
        setRecording(null);
        try {
          const type = rec.mimeType.split(';')[0] || 'audio/webm';
          const name = `Recording ${new Date().toLocaleString('sv-SE').slice(0, 16)}.${type.includes('mp4') ? 'm4a' : 'webm'}`;
          const a = await upload(new File(chunks, name, { type }), { noteId: note.id });
          editorRef.current.chain().focus().insertContent([{ type: 'audioBlock', attrs: { src: a.url, name } }, { type: 'paragraph' }]).run();
        } catch (err) { toastError(err); }
      };
      rec.start(1000);
      const started = Date.now();
      recorder.current = { rec, timer: setInterval(() => setRecording(Math.round((Date.now() - started) / 1000)), 1000) };
      setRecording(0);
    } catch (err) { toastError(new Error(`Cannot record: ${err.message}`)); }
  }

  async function insertPdf(file) {
    try {
      const { pdfToBlocks } = await import('./pdf.js');
      const { blocks, pages, total } = await pdfToBlocks(file, { noteId: note.id }, (i, n) => setPdfProgress(`PDF page ${i} of ${n}…`));
      editorRef.current.chain().focus().insertContent([...blocks, { type: 'paragraph' }]).run();
      if (total > pages) toast(`Only the first ${pages} of ${total} pages were added`, { kind: 'error' });
    } catch (err) { toastError(err); } finally { setPdfProgress(null); }
  }

  // A child page or journal of this page, linked from where the cursor is.
  async function subpage(kind) {
    try {
      const n = await post('/api/notes', { spaceId: note.spaceId, parentId: note.id, kind, title: kind === 'journal' ? 'Sketches' : '' });
      editorRef.current.chain().focus().insertContent([{ type: 'pageMention', attrs: { id: n.id, title: n.title || 'Untitled' } }, { type: 'text', text: ' ' }]).run();
      toast(kind === 'journal' ? 'Sub-journal created — click the link to draw' : 'Sub-page created', { action: { label: 'Open', onClick: () => openNote(n.id) } });
    } catch (err) { toastError(err); }
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false, heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true, defaultProtocol: 'https' } }),
      Collaboration.configure({ document: doc }),
      CollaborationCaret.configure({ provider, user: { name: user.name, color: user.color } }),
      Placeholder.configure({ placeholder: ({ node }) => (node.type.name === 'heading' ? 'Heading' : 'Write, or type “/” for blocks and AI, “[[” to link a page…') }),
      TaskList, TaskItem.configure({ nested: true }), Highlight.configure({ multicolor: true }), TextStyle, Color,
      SizedImage.configure({ inline: false, allowBase64: false }), HeadingFold.configure({ noteId: note.id }), TableKit.configure({ table: { resizable: true } }), Typography,
      InkBlock.configure({ doc, noteId: note.id }), AudioBlock.configure({ noteId: note.id }), Callout, PageMention, KeyCapture.configure({ onKey: (e) => capture.current?.(e) }),
    ],
    editable: !readOnly,
    onFocus: () => { touched.current = true; },
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
      // A pen near a picture makes it drawable right away.
      handleDOMEvents: {
        // Touching text (not a canvas in the page) brings the on-screen keyboard back.
        pointerdown: (view, e) => { if (!e.target.closest?.('.ink-block, .audio-block')) allowKeyboard(view.dom); return false; },
        pointerover: (view, e) => {
          if (e.pointerType !== 'pen' || e.target.tagName !== 'IMG' || !view.editable) return false;
          const pos = view.posAtDOM(e.target, 0);
          const at = view.state.doc.nodeAt(pos)?.type.name === 'image' ? pos : pos - 1;
          const node = view.state.doc.nodeAt(at);
          if (node?.type.name === 'image') imageToInk(view, at, node, e.target);
          return false;
        },
      },
      // Uploaded files open on a plain click (other links keep Ctrl+click while editing).
      handleClick: (view, pos, event) => {
        if (event.button !== 0) return false; // right click belongs to the block menu
        const a = event.target.closest?.('a[href^="/api/assets/"]');
        if (a) { event.preventDefault(); window.open(a.href, '_blank', 'noopener'); return true; }
        return false;
      },
      handleClickOn: (view, pos, node, nodePos, event) => {
        if (event.button !== 0) return false;
        if (node.type.name === 'pageMention' && node.attrs.id) { event.preventDefault(); navigate(`#/n/${node.attrs.id}${node.attrs.anchor ? `?h=${encodeURIComponent(node.attrs.anchor)}` : ''}`); return true; }
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

  // A photo from another device: after the block the cursor is in, without taking the focus.
  useDrops(note.id, (url, _size, name) => {
    const e = editorRef.current;
    if (!e || e.isDestroyed) return;
    const { $to } = e.state.selection;
    const pos = touched.current ? ($to.depth >= 1 ? $to.after(1) : $to.pos) : e.state.doc.content.size;
    e.chain().insertContentAt(pos, [{ type: 'image', attrs: { src: url, alt: name || '' } }, { type: 'paragraph' }]).run();
  }, !readOnly);

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
    m = /\[\[([^\]\n]{0,80})$/.exec(before);
    if (m) { setTrigger({ type: 'mention', from: selection.from - m[1].length - 2, query: m[1], coords: coords(), index: 0 }); return; }
    setTrigger(null);
  }

  // ---- AI
  const LABELS = { write: 'Write with AI', continue: 'Continue writing', outline: 'Outline' };
  const runAi = async (action, opts = {}) => {
    const e = editorRef.current;
    const { from, to, empty } = e.state.selection;
    // The selection is remembered when AI first asks a question, so typing the answer elsewhere does not lose it.
    const range = opts.range !== undefined ? opts.range : opts.wholePage || empty ? null : { from, to };
    const label = LABELS[action] || AI_ACTIONS.find((a) => a[0] === action)?.[1]?.replace('…', '') || action;
    const needsInput = opts.ask || action === 'translate' || action === 'custom' || action === 'write';
    if (needsInput && opts.input === undefined) {
      setAi({ action, label, asking: opts.ask || (action === 'translate' ? 'Translate into which language?' : 'What should AI do with it?'),
        placeholder: action === 'translate' ? 'e.g. English, Slovenian, German' : action === 'write' ? 'e.g. an intro paragraph about the project goals' : 'Your instruction',
        opts: { ...opts, range, insertAt: range ? range.to : to } });
      return;
    }
    let target = '', instruction = '';
    if (needsInput) { if (action === 'translate') target = opts.input; else instruction = opts.input; }
    const text = opts.titleOnly ? doc.getText('title').toString() : range ? e.state.doc.textBetween(range.from, range.to, '\n\n', '￼') : '';
    const at = opts.insertAt ?? (range ? range.to : e.state.selection.to);
    const state = { action, label, opts, range, insertAt: at, result: '', busy: true, error: null, target, instruction, text };
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
    const [pagePart, chapterPart] = splitRef(trigger.query);
    // "[[Page#" or "[[#": the chapters of that page (or of this one).
    if (chapterPart !== null) {
      const page = findPage(pagePart, note);
      const c = chapterPart.toLowerCase();
      return headings.filter((h) => h.text.toLowerCase().includes(c)).slice(0, 10).map((h) => ({ id: page.id, title: page.title, anchor: h.text, label: `${'  '.repeat(h.level - 1)}${h.text}`, icon: '§' }));
    }
    const q = pagePart.toLowerCase();
    const all = Object.values(store.get().trees).flat().filter((n) => n.id !== note.id && (n.title || 'Untitled').toLowerCase().includes(q));
    const list = all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8).map((n) => ({ id: n.id, title: n.title || 'Untitled', label: n.title || 'Untitled', icon: n.icon }));
    if (trigger.query.trim()) list.push({ create: true, label: `Create “${trigger.query.trim()}”` });
    return list;
  }, [trigger?.type, trigger?.query, note.id, headings]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (trigger?.type !== 'mention') return;
    const [pagePart, chapterPart] = splitRef(trigger.query);
    if (chapterPart === null) return;
    const page = findPage(pagePart, note);
    if (page.id) get(`/api/notes/${page.id}/headings`).then(setHeadings).catch(() => setHeadings([]));
  }, [trigger?.type, trigger?.query?.split('#')[0], trigger?.query?.includes('#')]); // eslint-disable-line react-hooks/exhaustive-deps

  // A link to a chapter: show it.
  useEffect(() => {
    if (!chapter || !editor) return undefined;
    const t = setTimeout(() => {
      unfoldAll(editor.view);
      const h = [...editor.view.dom.querySelectorAll('h1,h2,h3')].find((x) => x.textContent.replace('▾', '').trim() === chapter);
      h?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 350);
    return () => clearTimeout(t);
  }, [chapter, editor]);
  const items = trigger?.type === 'slash' ? slashItems : mentionItems;

  const choose = async (item) => {
    const e = editorRef.current;
    const t = trigger;
    setTrigger(null);
    e.chain().focus().deleteRange({ from: t.from, to: e.state.selection.from }).run();
    if (t.type === 'slash') item.run(e, { pickFile: () => fileInput.current?.click(), pickPhoto: () => photoInput.current?.click(), pickPdf: () => pdfInput.current?.click(), record: startRecording, ai: runAi, subpage });
    else {
      let target = item;
      if (item.create) {
        const n = await post('/api/notes', { spaceId: note.spaceId, parentId: note.id, title: t.query.trim() });
        target = { id: n.id, label: n.title };
      }
      e.chain().focus().insertContent([{ type: 'pageMention', attrs: { id: target.id, title: target.title || target.label, anchor: target.anchor || null } }, { type: 'text', text: ' ' }]).run();
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
    if (event.key === 'Tab' && trigger.type === 'mention' && items[trigger.index]?.id && !items[trigger.index].anchor) {
      // Tab on a page: go on to its chapters.
      const e = editorRef.current;
      e.chain().focus().deleteRange({ from: trigger.from, to: e.state.selection.from }).insertContent(`[[${items[trigger.index].title}#`).run();
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') { choose(items[trigger.index] || items[0]); return true; }
    if (event.key === 'Escape') { setTrigger(null); return true; }
    return false;
  };

  if (!editor) return null;
  return (
    <div className="editor-wrap" ref={wrap}>
      <EditorContent editor={editor} />
      <BlockTools editor={editor} wrap={wrap} noteId={note.id} readOnly={readOnly} onComment={(quote) => window.dispatchEvent(new CustomEvent('inkwell:comment', { detail: { quote } }))} />
      <input ref={fileInput} type="file" hidden multiple onChange={(e) => { [...e.target.files].forEach((f) => insertFile(f)); e.target.value = ''; }} />
      <input ref={pdfInput} type="file" hidden accept="application/pdf" onChange={(e) => { const f = e.target.files[0]; if (f) insertPdf(f); e.target.value = ''; }} />
      {recording !== null && <div className="record-bar"><span className="rec-dot" /> Recording {Math.floor(recording / 60)}:{String(recording % 60).padStart(2, '0')}<button className="primary" onClick={() => recorder.current?.rec.stop()}>Stop</button></div>}
      {pdfProgress && <div className="record-bar"><span className="spinner" /> {pdfProgress}</div>}
      {/* On phones `capture` opens the camera directly; on desktops it is a normal image picker. */}
      <input ref={photoInput} type="file" hidden accept="image/*" capture="environment" onChange={(e) => { const f = e.target.files[0]; if (f) insertPhoto(f); e.target.value = ''; }} />
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
                <span style={{ whiteSpace: 'pre' }}>{it.label}</span>
              </button>
            );
          })}
          {trigger.type === 'mention' && !splitRef(trigger.query)[1] && <div className="menu-hint">Tab: link to a chapter · “[[#” chapters of this page</div>}
        </div>
      )}
      {ai && <AiCard ai={ai} onClose={() => { ai.ctl?.abort(); setAi(null); editorRef.current?.commands.focus(); }} onApply={applyAi}
        onRetry={() => runAi(ai.action, { ...ai.opts, range: ai.range, insertAt: ai.insertAt, input: ai.opts?.input })}
        onAnswer={(input) => runAi(ai.action, { ...ai.opts, input })} />}
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

function AiCard({ ai, onClose, onApply, onRetry, onAnswer }) {
  const [input, setInput] = useState('');
  if (ai.asking) {
    return (
      <div className="ai-card" role="dialog" aria-label={ai.label}>
        <div className="ai-card-head"><Sparkles size={15} /> <b>{ai.label}</b><button className="icon" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <form className="ai-ask" onSubmit={(e) => { e.preventDefault(); if (input.trim()) onAnswer(input.trim()); }}>
          <input autoFocus value={input} onChange={(e) => setInput(e.target.value)} placeholder={ai.placeholder} aria-label={ai.asking}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }} />
          <button className="primary" disabled={!input.trim()}><Sparkles size={14} /> Go</button>
        </form>
      </div>
    );
  }
  return (
    <div className="ai-card" role="dialog" aria-label="AI result">
      <div className="ai-card-head"><Sparkles size={15} /> <b>{ai.label}</b>{ai.target ? ` → ${ai.target}` : ''}{ai.instruction ? <span className="muted small"> · {ai.instruction.slice(0, 60)}</span> : ''}{ai.busy && <span className="spinner" />}
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

// "[[Page#Chapter" → ['Page', 'Chapter']; no "#" → ['Page', null].
function splitRef(q) { const i = q.indexOf('#'); return i < 0 ? [q, null] : [q.slice(0, i), q.slice(i + 1)]; }
function findPage(name, note) {
  if (!name.trim()) return { id: note.id, title: note.title || 'This page' };
  const n = Object.values(store.get().trees).flat().find((x) => (x.title || '').toLowerCase() === name.trim().toLowerCase());
  return n ? { id: n.id, title: n.title } : { id: null, title: name };
}
