// OneNote files (.one sections, .onepkg packages, zipped notebook folders with .onetoc2): the converter in tools/onenote
// writes them out as JSON and files, and here they become pages. OneNote pages are free-form. Handwritten ones become
// journals, which keep positions; typed ones become ordinary pages read top to bottom, with their ink in a drawing block.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import * as Y from 'yjs';
import { q, now } from '../db/index.js';
import { fail } from '../util/http.js';
import { logger } from '../util/log.js';
import { createNote } from '../notes.js';
import { persist } from '../collab.js';
import { buildDoc, encode } from '../docmodel.js';
import { CANVAS_WIDTH } from '../ink/geometry.js';
import { assetFor } from './index.js';

const log = logger('onenote');
const ONE = /\.(one|onepkg|onetoc2)$/i;
export const isOneNote = (name) => ONE.test(name);
const RECYCLED = /OneNote_(RecycleBin|DeletedPages)/i;
const sid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const r1 = (v) => Math.round(v * 10) / 10;

// A page's coordinates, in px at 96 dpi: 1 logical unit is about 1 px at full width.
const PX_PER_HALF_INCH = 48, PX_PER_INK_UNIT = 0.0378;
const IMAGE_EXT = /^\.?(png|jpe?g|gif|webp|bmp|tiff?|emf|wmf)$/i;
// Typed text beyond this much makes a page a typed page, whatever else is on it.
const TYPED_LIMIT = 300;

function runConverter(root, input, out) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./onenote-worker.js', import.meta.url), { workerData: { root, input, out } });
    w.once('error', reject);
    w.once('exit', resolve);
  });
}

/** The files to convert: a package each; else a notebook's table of contents; else loose sections. */
function targets(names) {
  const live = names.filter((n) => !RECYCLED.test(n));
  const packages = live.filter((n) => /\.onepkg$/i.test(n));
  const tocs = live.filter((n) => /\.onetoc2$/i.test(n));
  const top = tocs.filter((t) => !tocs.some((o) => o !== t && path.posix.dirname(t).startsWith(`${path.posix.dirname(o)}/`)));
  const inToc = (n) => top.some((t) => path.posix.dirname(t) === '.' || n.startsWith(`${path.posix.dirname(t)}/`));
  return [...packages, ...top, ...live.filter((n) => /\.one$/i.test(n) && !inToc(n))];
}

export async function importOneNote(ctx, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-onenote-'));
  try {
    const names = [];
    for (const f of files) {
      const name = f.name.split('/').filter((p) => p && p !== '.' && p !== '..').join('/');
      if (!ONE.test(name)) continue;
      fs.mkdirSync(path.join(root, path.posix.dirname(name)), { recursive: true });
      if (f.extract) await f.extract(path.join(root, name));
      else fs.writeFileSync(path.join(root, name), f.data);
      names.push(name);
    }
    const inputs = targets(names);
    let done = 0, failure = '';
    for (const [i, input] of inputs.entries()) {
      const out = `out-${i}`;
      await runConverter(root, input, out).catch((e) => { failure = e.message; });
      const dir = path.join(root, out);
      const error = path.join(dir, 'error.txt');
      if (fs.existsSync(error)) { failure = fs.readFileSync(error, 'utf8'); ctx.warnings.push(`${path.basename(input)}: ${failure}`); continue; }
      if (!fs.existsSync(path.join(dir, 'doc.json'))) { ctx.warnings.push(`${path.basename(input)} could not be read`); continue; }
      const doc = JSON.parse(fs.readFileSync(path.join(dir, 'doc.json'), 'utf8'));
      ctx.files = dir;
      ctx.assetCache = new Map();
      for (const e of doc.entries) await entry(ctx, e, ctx.rootId);
      done++;
    }
    if (!done) fail(400, `This OneNote file could not be read${failure ? `: ${failure}` : ''}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function entry(ctx, e, parentId) {
  if (RECYCLED.test(e.name || '')) return;
  const n = await createNote(ctx.userId, { spaceId: ctx.spaceId, parentId, title: e.name, icon: e.type === 'group' ? '📁' : '📒' });
  ctx.stats.pages++;
  if (e.type === 'group') { for (const c of e.entries) await entry(ctx, c, n.id); return; }
  // Sub-pages: a page belongs under the nearest one before it with a lower level.
  const stack = [];
  for (const p of e.pages) {
    while (stack.length && stack.at(-1).level >= p.level) stack.pop();
    try {
      const id = await page(ctx, p, stack.at(-1)?.id || n.id);
      stack.push({ level: p.level, id });
    } catch (err) {
      log.warn(`page ${p.title}: ${err.message}`);
      ctx.warnings.push(`The page “${p.title || 'Untitled'}” could not be imported`);
    }
  }
}

// ---------------------------------------------------------------- ink

const hex = (c) => `#${[c & 255, (c >> 8) & 255, (c >> 16) & 255].map((v) => v.toString(16).padStart(2, '0')).join('')}`; // stored as BGR

/** All strokes of an ink object in page px, as { c, w, hl, pts: [[x, y], …] }. */
function strokesOf(ink, ox = 0, oy = 0) {
  const x0 = ox + (ink.x || 0) * PX_PER_HALF_INCH, y0 = oy + (ink.y || 0) * PX_PER_HALF_INCH;
  const own = ink.strokes.filter((s) => s.p.length >= 2).map((s) => {
    const pts = [];
    for (let i = 0; i < s.p.length; i += 2) pts.push([s.p[i] * PX_PER_INK_UNIT + x0, s.p[i + 1] * PX_PER_INK_UNIT + y0]);
    return { c: s.color == null ? '#111827' : hex(s.color), w: Math.max(s.w * PX_PER_INK_UNIT, 1), hl: s.alpha != null && s.alpha < 200, pts };
  });
  return [...own, ...ink.groups.flatMap((g) => strokesOf(g, x0, y0))];
}

const toStroke = (s, map, k) => ({ id: sid(), t: s.hl ? 'hl' : 'pen', c: s.c, w: Math.max(1, r1(s.w * k)), p: s.pts.flatMap(([x, y]) => { const [a, b] = map(x, y); return [r1(a), r1(b), 0.5]; }) });

/** An ink block of its own: moved to the top left corner and shrunk to the canvas width when wider. */
function inkBlock(strokes, inks) {
  if (!strokes.length) return [];
  const all = strokes.flatMap((s) => s.pts);
  const minX = Math.min(...all.map((p) => p[0])), minY = Math.min(...all.map((p) => p[1]));
  const maxX = Math.max(...all.map((p) => p[0])), maxY = Math.max(...all.map((p) => p[1]));
  const k = Math.min(1, (CANVAS_WIDTH - 40) / Math.max(1, maxX - minX));
  const id = sid();
  inks.push({ id, strokes: strokes.map((s) => toStroke(s, (x, y) => [(x - minX) * k + 20, (y - minY) * k + 20], k)) });
  return [{ type: 'inkBlock', attrs: { id, height: Math.ceil(((maxY - minY) * k + 60) / 10) * 10 } }];
}

// ---------------------------------------------------------------- typed content

const para = (content) => ({ type: 'paragraph', content: content?.length ? content : undefined });

function inline(t) {
  const out = [];
  for (const r of t.runs) {
    const marks = [];
    if (r.bold) marks.push({ type: 'bold' });
    if (r.italic) marks.push({ type: 'italic' });
    if (r.underline) marks.push({ type: 'underline' });
    if (r.strike) marks.push({ type: 'strike' });
    if (/consolas|courier/i.test(r.font || '')) marks.push({ type: 'code' });
    if (r.highlight) marks.push({ type: 'highlight' });
    if (/^(https?:|mailto:)/i.test(r.href || '')) marks.push({ type: 'link', attrs: { href: r.href } });
    r.text.split(/[\v\n\r]/).forEach((part, i) => {
      if (i) out.push({ type: 'hardBreak' });
      if (part) out.push(marks.length ? { type: 'text', text: part, marks } : { type: 'text', text: part });
    });
  }
  return out;
}

const isCheckbox = (t) => t.task || /check|box/i.test(t.shape || '') || /to.?do/i.test(t.label || '');
const taskOf = (el) => el.contents.flatMap((c) => c.tags || []).find(isCheckbox);
const kindOf = (el) => (taskOf(el) ? 'taskList' : !el.list ? null : el.list.format.startsWith('�') ? 'orderedList' : 'bulletList');

function textBlock(t) {
  const label = t.tags.filter((g) => !isCheckbox(g) && g.label).map((g) => `${g.label}: `).join('');
  const inl = [...(label ? [{ type: 'text', text: label, marks: [{ type: 'bold' }] }] : []), ...inline(t)];
  if (!inl.length) return [];
  const head = /^h([1-6])$/.exec(t.style || '');
  if (head) return [{ type: 'heading', attrs: { level: Math.min(3, Number(head[1])) }, content: inl }];
  if (/^(quote|cite)$/.test(t.style || '')) return [{ type: 'blockquote', content: [para(inl)] }];
  if (t.style === 'code') return [{ type: 'codeBlock', content: [{ type: 'text', text: t.runs.map((r) => r.text).join('') }] }];
  return [para(inl)];
}

async function picture(c, pc, im) {
  if (im.file == null) { pc.ctx.warnings.push('A picture had no data in the file'); return null; }
  const ext = IMAGE_EXT.test(im.ext || '') ? String(im.ext).replace(/^\./, '').toLowerCase() : 'png';
  const a = await assetFor(pc.ctx, pc.noteId, pc.ctx.assetCache, `${im.file}.${ext}`, fs.readFileSync(path.join(pc.ctx.files, 'files', String(im.file))));
  return `/api/assets/${a.id}`;
}

async function contentBlocks(c, pc) {
  switch (c.type) {
    case 'text': return textBlock(c);
    case 'table': {
      const rows = [];
      for (const row of c.rows) {
        const cells = [];
        for (const cell of row) {
          const inner = await itemBlocks(cell, pc);
          cells.push({ type: 'tableCell', content: inner.length ? inner : [para()] });
        }
        rows.push({ type: 'tableRow', content: cells });
      }
      return rows.length ? [{ type: 'table', content: rows }] : [];
    }
    case 'image': {
      const src = await picture(c, pc, c);
      return src ? [{ type: 'image', attrs: { src, alt: String(c.alt || c.ocr || '').slice(0, 300) } }] : [];
    }
    case 'file': {
      if (c.file == null) { pc.ctx.warnings.push(`The attached file ${c.name} had no data`); return []; }
      const a = await assetFor(pc.ctx, pc.noteId, pc.ctx.assetCache, c.name || `file-${c.file}`, fs.readFileSync(path.join(pc.ctx.files, 'files', String(c.file))));
      return [para([{ type: 'text', text: `📎 ${c.name || a.name}`, marks: [{ type: 'link', attrs: { href: `/api/assets/${a.id}` } }] }])];
    }
    case 'ink': return inkBlock(strokesOf(c), pc.inks);
    default: return [];
  }
}

/** Outline items → blocks, grouping neighbouring list items of one kind; nested items go inside theirs. */
async function itemBlocks(items, pc) {
  const out = [];
  let list = null;
  for (const it of items) {
    if (it.type === 'group') { list = null; out.push(...(await itemBlocks(it.items, pc))); continue; }
    const kind = kindOf(it);
    const own = [];
    for (const c of it.contents) own.push(...(await contentBlocks(c, pc)));
    const kids = await itemBlocks(it.children, pc);
    if (!kind) { list = null; out.push(...own, ...kids); continue; }
    if (!list || list.type !== kind) { list = { type: kind, content: [] }; out.push(list); }
    const inner = [...(own[0]?.type === 'paragraph' ? [] : [para()]), ...own, ...kids];
    list.content.push(kind === 'taskList' ? { type: 'taskItem', attrs: { checked: !!taskOf(it).done }, content: inner } : { type: 'listItem', content: inner });
  }
  return out;
}

// ---------------------------------------------------------------- pages

const walk = (items, fn) => { for (const it of items) { if (it.type === 'group') walk(it.items, fn); else { it.contents.forEach(fn); walk(it.children, fn); } } };
const outlineText = (o) => { let n = 0; walk(o.items, (c) => { if (c.type === 'text') n += c.runs.reduce((a, r) => a + r.text.length, 0); if (c.type === 'table') n += TYPED_LIMIT; }); return n; };

/** An outline as the plain lines of a text box. */
function outlineLines(items, depth = 0) {
  return items.flatMap((it) => {
    if (it.type === 'group') return outlineLines(it.items, depth);
    const kind = kindOf(it);
    const mark = kind === 'taskList' ? (taskOf(it).done ? '☑ ' : '☐ ') : kind ? '• ' : '';
    const text = it.contents.filter((c) => c.type === 'text').map((c) => c.runs.map((r) => r.text.replace(/[\v\r]/g, '\n')).join('')).join('');
    return [...(text ? [`${'  '.repeat(depth)}${mark}${text}`] : []), ...outlineLines(it.children, depth + 1)];
  });
}

async function journal(ctx, p, noteId, contents) {
  const pc = { ctx, noteId };
  const strokes = [], pictures = [], boxes = [];
  const place = (c, x, y) => {
    if (c.type === 'ink') strokes.push(...strokesOf(c, x, y));
    if (c.type === 'image') pictures.push({ im: c, x: x + (c.x || 0) * PX_PER_HALF_INCH, y: y + (c.y || 0) * PX_PER_HALF_INCH });
  };
  for (const c of contents) {
    if (c.type !== 'outline') { place(c, 0, 0); continue; }
    const x = (c.x || 0) * PX_PER_HALF_INCH, y = (c.y || 0) * PX_PER_HALF_INCH;
    const text = outlineLines(c.items).join('\n');
    if (text) boxes.push({ x, y, w: (c.w || 8) * PX_PER_HALF_INCH, text });
    walk(c.items, (inner) => place(inner, x, y));
  }
  const sizes = pictures.map(({ im }) => ({ w: (im.w || 8) * PX_PER_HALF_INCH, h: (im.h || 6) * PX_PER_HALF_INCH }));
  const right = Math.max(0, ...strokes.flatMap((s) => s.pts.map((pt) => pt[0])), ...boxes.map((b) => b.x + b.w), ...pictures.map((o, i) => o.x + sizes[i].w));
  const k = Math.min(1, (CANVAS_WIDTH - 20) / Math.max(1, right)); // a wide page shrinks; it never grows

  const doc = buildDoc({ title: p.title || '', paper: 'plain' });
  let bottom = 0;
  if (strokes.length) {
    const arr = new Y.Array();
    arr.push(strokes.map((s) => toStroke(s, (x, y) => [x * k, y * k], k)));
    doc.getMap('ink').set('page', arr);
    bottom = Math.max(...strokes.flatMap((s) => s.pts.map((pt) => pt[1] * k)));
  }
  for (const [i, o] of pictures.entries()) {
    const src = await picture(o.im, pc, o.im);
    if (!src) continue;
    const m = new Y.Map();
    const { w, h } = sizes[i];
    for (const [key, v] of Object.entries({ canvas: 'page', src, x: Math.round(o.x * k), y: Math.round(o.y * k), w: Math.round(w * k), ratio: h / w, rot: 0, crop: [0, 0, 0, 0] })) m.set(key, v);
    doc.getMap('images').set(sid(), m);
    bottom = Math.max(bottom, (o.y + h) * k);
  }
  for (const b of boxes) {
    const m = new Y.Map();
    const text = new Y.Text();
    doc.transact(() => {
      m.set('x', Math.round(b.x * k)); m.set('y', Math.round(b.y * k)); m.set('w', Math.round(b.w * k)); m.set('text', text);
      doc.getMap('boxes').set(sid(), m);
      text.insert(0, b.text);
    });
    bottom = Math.max(bottom, (b.y + 24 * b.text.split('\n').length) * k);
  }
  doc.getMap('meta').set('height', Math.max(1400, Math.ceil((bottom + 200) / 10) * 10));
  return doc;
}

async function typed(ctx, p, noteId, contents) {
  const pc = { ctx, noteId, inks: [] };
  const blocks = [], loose = [];
  for (const c of contents) {
    if (c.type === 'ink') loose.push(...strokesOf(c));
    else if (c.type === 'outline') blocks.push(...(await itemBlocks(c.items, pc)));
    else blocks.push(...(await contentBlocks(c, pc)));
  }
  if (loose.length) {
    ctx.warnings.push('Handwriting on mostly typed pages was placed below the text');
    blocks.push(...inkBlock(loose, pc.inks));
  }
  const doc = buildDoc({ title: p.title || '', blocks });
  for (const i of pc.inks) { const arr = new Y.Array(); arr.push(i.strokes); doc.getMap('ink').set(i.id, arr); }
  return doc;
}

async function page(ctx, p, parentId) {
  // Top to bottom, then left to right, as the page reads.
  const contents = p.contents.filter((c) => c.type !== 'unknown').sort((a, b) => ((a.y || 0) - (b.y || 0)) || ((a.x || 0) - (b.x || 0)));
  const hasInk = contents.some((c) => c.type === 'ink');
  const chars = contents.filter((c) => c.type === 'outline').reduce((a, o) => a + outlineText(o), 0);
  const handwritten = hasInk && chars < TYPED_LIMIT;
  const n = await createNote(ctx.userId, { spaceId: ctx.spaceId, parentId, title: p.title || '', kind: handwritten ? 'journal' : 'page', paper: 'plain' });
  ctx.stats.pages++;
  const doc = await (handwritten ? journal : typed)(ctx, p, n.id, contents);
  // OneNote's own reading of the handwriting serves until AI has read the page.
  if (handwritten && p.recognized?.trim()) await q('INSERT INTO ink_recognitions (note_id, canvas_id, text, updated_at) VALUES ($1, $2, $3, $4)', n.id, 'page', p.recognized.trim(), now());
  await q('UPDATE notes SET ydoc = $2 WHERE id = $1', n.id, encode(doc));
  await persist(n.id, doc, ctx.userId);
  if (p.created > 0) await q('UPDATE notes SET created_at = $2 WHERE id = $1', n.id, p.created);
  return n.id;
}
