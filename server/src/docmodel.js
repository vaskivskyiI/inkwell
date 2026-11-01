// The page document (one Y.Doc per page) and what the server derives from it without an editor schema:
//   title   Y.Text        — page title
//   default Y.XmlFragment — rich-text body as y-prosemirror writes it (elements named by node type, marks as text attributes)
//   ink     Y.Map         — canvasId → Y.Array of strokes { id, t: 'pen'|'hl', c, w, p: [x, y, pressure, …], by }
//   boxes   Y.Map         — journal text boxes: boxId → Y.Map { x, y, w, text: Y.Text }
//   meta    Y.Map         — paper style etc.
import * as Y from 'yjs';
import { sha256 } from './util/crypto.js';

export const docFrom = (bytes) => {
  const d = new Y.Doc();
  if (bytes?.length) Y.applyUpdate(d, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  return d;
};

// ---------- reading

const MARK_WRAP = { bold: '**', italic: '_', strike: '~~', code: '`' };

function inlineMd(el, ctx) {
  let out = '';
  for (const c of el.toArray()) {
    if (c instanceof Y.XmlText) {
      for (const op of c.toDelta()) {
        if (typeof op.insert !== 'string') continue;
        let s = op.insert;
        const a = op.attributes || {};
        const file = /\/api\/assets\/([0-9a-f-]{36})/.exec(a.link?.href || '');
        if (file) ctx.assets?.add(file[1]);
        if (ctx.plain) { out += s; continue; }
        for (const [m, w] of Object.entries(MARK_WRAP)) if (a[m] && s.trim()) s = s.replace(/^(\s*)(.*?)(\s*)$/s, `$1${w}$2${w}$3`);
        if (a.link?.href) s = `[${s}](${a.link.href})`;
        if (a.highlight && s.trim()) s = `==${s}==`;
        out += s;
      }
    } else if (c instanceof Y.XmlElement) {
      const n = c.nodeName;
      if (n === 'hardBreak') out += ctx.plain ? '\n' : '  \n';
      else if (n === 'pageMention') {
        const label = `${c.getAttribute('title') || ''}${c.getAttribute('anchor') ? `#${c.getAttribute('anchor')}` : ''}`;
        out += ctx.plain ? label : `[[${label}]]`;
        ctx.mentions?.add(c.getAttribute('id'));
      }
      else if (n === 'image') out += imageMd(c, ctx);
      else out += inlineMd(c, ctx);
    }
  }
  return out;
}

function imageMd(el, ctx) {
  const src = el.getAttribute('src') || '';
  const m = /\/api\/assets\/([0-9a-f-]{36})/.exec(src);
  if (m) ctx.assets?.add(m[1]);
  const described = m && ctx.assetText?.(m[1]);
  if (ctx.plain) return described ? `[image: ${described}]` : '';
  return `![${el.getAttribute('alt') || ''}](${src})${described ? `\n_(image: ${described})_` : ''}`;
}

const prefixLines = (s, first, rest = ' '.repeat(first.length)) => s.split('\n').map((l, i) => (i ? rest : first) + l).join('\n');

function blocksMd(parent, ctx) {
  return parent.toArray().map((c) => blockMd(c, ctx)).filter((s) => s !== null && s !== '').join('\n\n');
}

// Blocks Markdown has no words for, kept as they are when a page is edited as Markdown.
const KEEP_LABEL = { inkBlock: '✍️ handwriting', audioBlock: '🎙️ recording' };
const KNOWN = new Set(['paragraph', 'heading', 'blockquote', 'callout', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem', 'codeBlock', 'horizontalRule', 'image', 'table']);

function blockMd(el, ctx) {
  if (el instanceof Y.XmlText) return inlineMd({ toArray: () => [el] }, ctx);
  const n = el.nodeName;
  if (ctx.keep && (KEEP_LABEL[n] || !KNOWN.has(n))) {
    ctx.keep.push(yToJson(el));
    return `<!-- keep:${ctx.keep.length - 1} ${KEEP_LABEL[n] || n} — leave this line to keep it -->`;
  }
  switch (n) {
    case 'paragraph': return inlineMd(el, ctx);
    case 'heading': return ctx.plain ? inlineMd(el, ctx) : `${'#'.repeat(Number(el.getAttribute('level')) || 1)} ${inlineMd(el, ctx)}`;
    case 'blockquote': return prefixLines(blocksMd(el, ctx), ctx.plain ? '' : '> ', ctx.plain ? '' : '> ');
    case 'callout':
      if (ctx.keep) return prefixLines(`[!${el.getAttribute('emoji') || '💡'}]\n${blocksMd(el, ctx)}`, '> ', '> ');
      return prefixLines(blocksMd(el, ctx), ctx.plain ? '' : `> ${el.getAttribute('emoji') || '💡'} `, ctx.plain ? '' : '> ');
    case 'bulletList': case 'orderedList': case 'taskList':
      return el.toArray().map((item, i) => {
        const mark = n === 'orderedList' ? `${i + 1}. ` : n === 'taskList' ? `- [${item.getAttribute?.('checked') ? 'x' : ' '}] ` : '- ';
        const body = item.toArray ? item.toArray().map((b) => blockMd(b, ctx)).filter(Boolean).join('\n') : '';
        return prefixLines(body, ctx.plain && n !== 'taskList' ? '• ' : mark);
      }).join('\n');
    case 'listItem': case 'taskItem': return blocksMd(el, ctx);
    case 'codeBlock': {
      const code = el.toArray().map((t) => t.toString()).join('');
      return ctx.plain ? code : `\`\`\`${el.getAttribute('language') || ''}\n${code}\n\`\`\``;
    }
    case 'horizontalRule': return ctx.plain ? '' : '---';
    case 'image': return imageMd(el, ctx);
    case 'table': {
      const rows = el.toArray().map((r) => r.toArray().map((cell) => blocksMd(cell, { ...ctx, plain: ctx.plain }).replace(/\n+/g, ' ').replace(/\|/g, '\\|')));
      if (!rows.length) return '';
      if (ctx.plain) return rows.map((r) => r.join(' · ')).join('\n');
      const w = Math.max(...rows.map((r) => r.length));
      const line = (r) => `| ${Array.from({ length: w }, (_, i) => r[i] || '').join(' | ')} |`;
      return [line(rows[0]), `|${' --- |'.repeat(w)}`, ...rows.slice(1).map(line)].join('\n');
    }
    case 'audioBlock': {
      const m = /\/api\/assets\/([0-9a-f-]{36})/.exec(el.getAttribute('src') || '');
      if (m) ctx.assets?.add(m[1]);
      const t = m && ctx.assetText?.(m[1]);
      return ctx.plain ? t || '' : `🎙️ *(recording)*${t ? `\n${prefixLines(t, '> ', '> ')}` : ''}`;
    }
    case 'inkBlock': {
      const id = el.getAttribute('id');
      ctx.inkIds?.add(id);
      const t = ctx.ink?.(id);
      // An annotated photo: the picture under the ink.
      const bg = el.getAttribute('bg');
      const photo = bg ? imageMd({ getAttribute: (k) => (k === 'src' ? bg : k === 'alt' ? 'annotated photo' : null) }, ctx) : '';
      const ink = t ? (ctx.plain ? t : `✍️ *(handwritten)*\n${prefixLines(t, '> ', '> ')}`) : (ctx.plain || bg ? '' : '✍️ *(handwriting — not transcribed yet)*');
      return [photo, ink].filter(Boolean).join(ctx.plain ? '\n' : '\n\n');
    }
    default: return el.toArray ? blocksMd(el, ctx) : '';
  }
}

function yToJson(el) {
  const node = { type: el.nodeName, attrs: el.getAttributes() };
  const content = el.toArray().flatMap((c) => (c instanceof Y.XmlText
    ? c.toDelta().filter((op) => typeof op.insert === 'string').map((op) => ({ type: 'text', text: op.insert, ...(op.attributes && { marks: Object.entries(op.attributes).map(([type, attrs]) => ({ type, attrs })) }) }))
    : [yToJson(c)]));
  if (content.length) node.content = content;
  return node;
}

/**
 * The page body as Markdown to edit by hand. Callouts become `> [!💡]` alerts; blocks Markdown cannot hold (handwriting,
 * recordings…) become `<!-- keep:N -->` lines, their editor JSON in `keep`, so writing the Markdown back keeps them.
 */
export function editableMarkdown(ydoc) {
  const keep = [];
  const markdown = blocksMd(ydoc.getXmlFragment('default'), { keep });
  return { markdown, keep };
}

/** Replaces the page body with Markdown (from editableMarkdown, edited). */
export function replaceBody(ydoc, blocks, origin) {
  ydoc.transact(() => {
    const frag = ydoc.getXmlFragment('default');
    frag.delete(0, frag.length);
    frag.insert(0, orParagraph(blocks).map(toY));
  }, origin);
}

export function strokesOf(ydoc, canvasId) {
  const arr = ydoc.getMap('ink').get(canvasId);
  return arr instanceof Y.Array ? arr.toArray() : [];
}

export const strokesHash = (strokes) => sha256(strokes.map((s) => s.id).join(','));

export const WHOLE_PAGE_CANVASES = ['page', 'overlay'];

function walkTasks(el, fn) {
  for (const c of el.toArray?.() || []) {
    if (c instanceof Y.XmlElement) { if (c.nodeName === 'taskItem') fn(c); walkTasks(c, fn); }
  }
}
const itemText = (item) => { const p = item.get(0); return p?.toArray ? inlineMd(p, { plain: true }).trim() : ''; };

/** All to-dos of a page: { text, checked }. */
export function todosOf(ydoc) {
  const out = [];
  walkTasks(ydoc.getXmlFragment('default'), (i) => out.push({ text: itemText(i), checked: !!i.getAttribute('checked') }));
  return out;
}

/** Ticks or unticks the to-do with this text; true when something changed. */
export function setTodoChecked(ydoc, text, checked) {
  let changed = false;
  const want = String(text).trim().toLowerCase();
  walkTasks(ydoc.getXmlFragment('default'), (i) => {
    if (itemText(i).toLowerCase() === want && !!i.getAttribute('checked') !== checked) { i.setAttribute('checked', checked); changed = true; }
  });
  return changed;
}

/** Tags the user added by hand live in the doc (meta.tags, a Y.Array) so they sync like everything else. */
export function manualTags(ydoc) {
  const t = ydoc.getMap('meta').get('tags');
  return (t instanceof Y.Array ? t.toArray() : []).map((x) => String(x).toLowerCase().trim()).filter(Boolean);
}

/**
 * Everything the server needs from a page: title, Markdown (for AI/export), plain text (search), ink canvases,
 * referenced assets and mentioned pages. `recognitions` maps canvasId → transcription; `assetText` describes images.
 */
export function extract(ydoc, { recognitions = {}, assetText } = {}) {
  const title = ydoc.getText('title').toString().trim();
  const frag = ydoc.getXmlFragment('default');
  const ctxBase = { ink: (id) => recognitions[id], assetText, inkIds: new Set(), assets: new Set(), mentions: new Set() };
  const markdown = blocksMd(frag, ctxBase);
  const text = blocksMd(frag, { ...ctxBase, plain: true, inkIds: null, assets: null, mentions: null });
  // Pictures on canvases that still exist count as used files and are described in the page's text.
  const canvasImages = [...ydoc.getMap('images').values()].filter((m) => m instanceof Y.Map && (m.get('canvas') === 'page' || ctxBase.inkIds.has(m.get('canvas'))));
  const pictureMd = canvasImages.map((m) => imageMd({ getAttribute: (k) => (k === 'src' ? m.get('src') : '') }, ctxBase)).filter(Boolean);
  const pictureText = canvasImages.map((m) => imageMd({ getAttribute: (k) => (k === 'src' ? m.get('src') : '') }, { ...ctxBase, plain: true, assets: null })).filter(Boolean);
  const boxes = [...ydoc.getMap('boxes').values()].map((b) => (b instanceof Y.Map ? String(b.get('text') || '') : '')).filter(Boolean);
  const inkMap = ydoc.getMap('ink');
  const canvases = [...inkMap.keys()].map((id) => {
    const strokes = strokesOf(ydoc, id);
    return { id, strokes, hash: strokesHash(strokes) };
  }).filter((c) => c.strokes.length && (WHOLE_PAGE_CANVASES.includes(c.id) || ctxBase.inkIds.has(c.id)));
  // `page`: a journal's paper; `overlay`: handwriting on top of a typed page.
  const pageInk = WHOLE_PAGE_CANVASES.filter((id) => recognitions[id]).map((id) => `✍️ *(handwritten ${id === 'page' ? 'page' : 'notes on the page'})*\n${recognitions[id]}`);
  const fullMd = [markdown, ...pictureMd, boxes.join('\n\n'), ...pageInk].filter(Boolean).join('\n\n');
  const fullText = [text, ...pictureText, boxes.join('\n'), ...WHOLE_PAGE_CANVASES.map((id) => recognitions[id] || '')].filter(Boolean).join('\n');
  const tags = [...new Set([...manualTags(ydoc), ...[...fullText.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{2,40})/gu)].map((m) => m[1].toLowerCase())])];
  return {
    title, markdown: fullMd, text: fullText, tags, canvases,
    assets: [...ctxBase.assets], mentions: [...ctxBase.mentions].filter(Boolean),
    hash: sha256(`${title}\n${fullMd}\n${tags.join(',')}\n${canvases.map((c) => c.hash).join(',')}`),
  };
}

// ---------- writing

function textNode(runs) {
  const t = new Y.XmlText();
  let pos = 0;
  for (const r of runs) {
    const attrs = {};
    for (const m of r.marks || []) attrs[m.type] = m.attrs || {};
    t.insert(pos, r.text, attrs);
    pos += r.text.length;
  }
  return t;
}

function toY(node) {
  const el = new Y.XmlElement(node.type);
  for (const [k, v] of Object.entries(node.attrs || {})) if (v !== undefined) el.setAttribute(k, v);
  const kids = [];
  let runs = [];
  for (const c of node.content || []) {
    if (c.type === 'text') { if (c.text) runs.push(c); continue; }
    if (runs.length) { kids.push(textNode(runs)); runs = []; }
    kids.push(toY(c));
  }
  if (runs.length) kids.push(textNode(runs));
  if (kids.length) el.insert(0, kids);
  return el;
}

/** Appends ProseMirror-JSON blocks to the page body. */
export function appendBlocks(ydoc, blocks, origin) {
  ydoc.transact(() => {
    const frag = ydoc.getXmlFragment('default');
    frag.insert(frag.length, blocks.map(toY));
  }, origin);
}

export function setTitle(ydoc, title, origin) {
  const t = ydoc.getText('title');
  if (t.toString() === title) return;
  ydoc.transact(() => { t.delete(0, t.length); t.insert(0, title); }, origin);
}

export function buildDoc({ title = '', blocks = [], paper } = {}) {
  const d = new Y.Doc();
  if (title) d.getText('title').insert(0, title);
  if (blocks.length) appendBlocks(d, blocks);
  if (paper) d.getMap('meta').set('paper', paper);
  return d;
}

/** Pictures of a canvas as SVG, cropped and rotated as on screen, plus how far down they reach. */
export function canvasImagesSvg(ydoc, canvasId, asset = (u) => u) {
  let svg = '', bottom = 0;
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  for (const m of ydoc.getMap('images').values()) {
    if (!(m instanceof Y.Map) || m.get('canvas') !== canvasId || !/^\/api\/assets\//.test(m.get('src') || '')) continue;
    const [l, t, r, b] = m.get('crop') || [0, 0, 0, 0];
    const x = Number(m.get('x')) || 0, y = Number(m.get('y')) || 0, w = Number(m.get('w')) || 100, rot = Number(m.get('rot')) || 0;
    const fw = w / (1 - l - r), fh = fw * (Number(m.get('ratio')) || 1), h = fh * (1 - t - b);
    bottom = Math.max(bottom, y + h);
    svg += `<g transform="rotate(${rot} ${x + w / 2} ${y + h / 2})"><svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${l * fw} ${t * fh} ${w} ${h}"><image href="${esc(asset(m.get('src')))}" width="${fw}" height="${fh}" preserveAspectRatio="none"/></svg></g>`;
  }
  return { svg, bottom };
}

export const encode = (ydoc) => Y.encodeStateAsUpdate(ydoc);

// ---------- Markdown → ProseMirror JSON (import, templates, AI output)

function inlineFromMd(s) {
  const out = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|`([^`]+)`|~~([^~]+)~~|==([^=]+)==|\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0, m;
  const push = (text, marks) => { if (text) out.push(marks?.length ? { type: 'text', text, marks } : { type: 'text', text }); };
  while ((m = re.exec(s))) {
    push(s.slice(last, m.index));
    if (m[2] || m[3]) push(m[2] || m[3], [{ type: 'bold' }]);
    else if (m[4] || m[5]) push(m[4] || m[5], [{ type: 'italic' }]);
    else if (m[6]) push(m[6], [{ type: 'code' }]);
    else if (m[7]) push(m[7], [{ type: 'strike' }]);
    else if (m[8]) push(m[8], [{ type: 'highlight' }]);
    else if (m[9]) push(`[[${m[9]}]]`);
    else if (m[10]) push(m[10], [{ type: 'link', attrs: { href: m[11] } }]);
    last = re.lastIndex;
  }
  push(s.slice(last));
  return out;
}

const para = (text) => ({ type: 'paragraph', content: inlineFromMd(text) });

const orParagraph = (blocks) => (blocks.length ? blocks : [{ type: 'paragraph' }]);
const ALERT = { NOTE: 'ℹ️', TIP: '💡', IMPORTANT: '❗', WARNING: '⚠️', CAUTION: '🛑' };

/** `keep`: the blocks `<!-- keep:N -->` lines stand for (see editableMarkdown); other HTML comments are dropped. */
export function markdownToBlocks(md, keep) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const isList = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^\s*<!--\s*keep:(\d+)\b.*-->\s*$/.exec(line))) {
      const b = keep?.[Number(m[1])];
      if (b && typeof b === 'object' && typeof b.type === 'string') blocks.push(b);
      i++;
    } else if (/^\s*<!--.*-->\s*$/.test(line)) {
      i++;
    } else if ((m = /^```\s*([\w+-]*)/.exec(line))) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push({ type: 'codeBlock', attrs: { language: m[1] || null }, content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] });
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      blocks.push({ type: 'heading', attrs: { level: Math.min(m[1].length, 3) }, content: inlineFromMd(m[2]) });
      i++;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'horizontalRule' });
      i++;
    } else if ((m = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line))) {
      blocks.push({ type: 'image', attrs: { src: m[2], alt: m[1] } });
      i++;
    } else if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      // `> [!💡]` or GitHub's `> [!NOTE]`: a callout.
      const alert = /^\[!([^\]\s]{1,12})\]\s*(.*)$/u.exec(q[0]);
      if (alert) blocks.push({ type: 'callout', attrs: { emoji: ALERT[alert[1].toUpperCase()] || alert[1] }, content: orParagraph(markdownToBlocks([alert[2], ...q.slice(1)].join('\n'), keep)) });
      else blocks.push({ type: 'blockquote', content: markdownToBlocks(q.join('\n'), keep) });
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = rows.filter((r) => !/^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(r))
        .map((r) => r.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|')));
      blocks.push({ type: 'table', content: cells.map((r, ri) => ({ type: 'tableRow', content: r.map((c) => ({ type: ri ? 'tableCell' : 'tableHeader', content: [para(c)] })) })) });
    } else if (isList(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
    } else {
      const p = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>|\s*\|.*\|\s*$)/.test(lines[i]) && !isList(lines[i])) p.push(lines[i++].trim());
      if (!p.length) p.push(lines[i++].trim()); // always make progress
      blocks.push(para(p.join(' ')));
    }
  }
  return blocks;
}

function parseList(lines, start) {
  const indentOf = (l) => /^\s*/.exec(l)[0].replace(/\t/g, '  ').length;
  const ITEM = /^\s*([-*+]|\d+[.)])\s+(\[([ xX])\](?:\s+|$))?(.*)$/;
  const base = indentOf(lines[start]);
  const head = ITEM.exec(lines[start]);
  const task = !!head[2];
  const ordered = /^\d/.test(head[1]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { if (i + 1 < lines.length && indentOf(lines[i + 1]) >= base && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1])) { i++; continue; } break; }
    const ind = indentOf(l);
    if (ind < base) break;
    const m = ITEM.exec(l);
    if (ind === base && m) {
      // A different kind of list starts a new list block (the first line always belongs to this one).
      if (i > start && (/^\d/.test(m[1]) !== ordered || !!m[2] !== task)) break;
      items.push({ checked: m[3] ? m[3].toLowerCase() === 'x' : null, lines: [m[4]] });
      i++;
    } else if (ind > base && items.length) {
      items[items.length - 1].lines.push(l.slice(Math.min(ind, base + 2)));
      i++;
    } else break;
  }
  const type = task ? 'taskList' : ordered ? 'orderedList' : 'bulletList';
  return {
    next: i,
    block: {
      type,
      content: items.map((it) => ({
        type: task ? 'taskItem' : 'listItem',
        ...(task ? { attrs: { checked: !!it.checked } } : {}),
        content: [para(it.lines[0]), ...markdownToBlocks(it.lines.slice(1).join('\n'))],
      })),
    },
  };
}
