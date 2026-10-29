// Imports from other notes apps:
//  • AFFiNE "Snapshot" export (`<collection>.bs.zip`): one `<title>-<id>.snapshot.json` per doc (a BlockSuite block tree)
//    plus `assets/<blobId>.<ext>`. Keeps headings, nested lists, to-dos, code, tables, callouts, quotes, images,
//    attachments, links between docs (as page mentions and as sub-pages) and edgeless pen strokes (as an ink block).
//  • Markdown: single .md files or zips of them (AFFiNE Markdown export, Notion, Obsidian…); folders become parent
//    pages, relative images become assets, links to other .md files become page mentions.
// Pages are created first (so links can point at them), then filled; each fill goes through persist(), so search
// and background AI pick the imported pages up like typed ones.
import path from 'node:path';
import * as Y from 'yjs';
import { unzipSync, strFromU8 } from 'fflate';
import { q } from '../db/index.js';
import { fail } from '../util/http.js';
import { createNote } from '../notes.js';
import { storeAsset } from '../assets.js';
import { persist } from '../collab.js';
import { buildDoc, markdownToBlocks, encode } from '../docmodel.js';
import { CANVAS_WIDTH } from '../ink/geometry.js';
import { publish } from '../events.js';
import { logger } from '../util/log.js';

const log = logger('import');
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', txt: 'text/plain', zip: 'application/zip' };
const mimeOf = (name) => MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';
const sid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function readArchive(filename, data) {
  if (/\.zip$/i.test(filename) || (data[0] === 0x50 && data[1] === 0x4b)) {
    let entries;
    try { entries = unzipSync(new Uint8Array(data)); } catch (e) { fail(400, `Cannot read the zip file: ${e.message}`); }
    return Object.entries(entries)
      .filter(([name, d]) => d.length && !/(^|\/)(__MACOSX|\.DS_Store)/.test(name) && !name.endsWith('/'))
      .map(([name, d]) => ({ name: name.replace(/\\/g, '/'), data: d }));
  }
  return [{ name: filename, data: new Uint8Array(data) }];
}

/** Entry point: returns { pages, assets, rootId, format, notes: [...warnings] }. */
export async function importArchive(userId, { spaceId, parentId = null, filename = 'import', data }) {
  const files = readArchive(filename, data);
  const ctx = { userId, spaceId, stats: { pages: 0, assets: 0 }, warnings: [] };
  const snapshots = files.filter((f) => f.name.endsWith('.snapshot.json'));
  const markdown = files.filter((f) => /\.(md|markdown)$/i.test(f.name));
  if (!snapshots.length && !markdown.length) fail(400, 'Nothing to import — expected an AFFiNE snapshot export (.zip with *.snapshot.json) or Markdown files');
  const format = snapshots.length ? 'affine' : 'markdown';
  const label = format === 'affine' ? 'Imported from AFFiNE' : `Imported ${path.basename(filename).replace(/\.(zip|md|markdown)$/i, '')}`;
  const root = parentId || (await createNote(userId, { spaceId, title: `${label} ${new Date().toISOString().slice(0, 10)}`, icon: '📥' })).id;
  ctx.rootId = root;
  if (format === 'affine') await importAffine(ctx, snapshots, files);
  else await importMarkdown(ctx, markdown, files);
  publish(spaceId, 'tree:changed', {});
  log.info(`${format} import into ${spaceId}: ${ctx.stats.pages} pages, ${ctx.stats.assets} files`);
  return { format, rootId: root, pages: ctx.stats.pages, assets: ctx.stats.assets, warnings: [...new Set(ctx.warnings)].slice(0, 20) };
}

async function fillPage(ctx, noteId, { title, blocks, ink, createdAt }) {
  const doc = buildDoc({ title, blocks });
  if (ink?.strokes.length) {
    const arr = new Y.Array();
    arr.push(ink.strokes);
    doc.getMap('ink').set(ink.id, arr);
  }
  await q('UPDATE notes SET ydoc = $2 WHERE id = $1', noteId, encode(doc));
  await persist(noteId, doc, ctx.userId);
  if (createdAt) await q('UPDATE notes SET created_at = $2 WHERE id = $1', noteId, createdAt);
}

async function assetFor(ctx, noteId, cache, name, data) {
  const key = `${noteId}|${name}`;
  if (!cache.has(key)) {
    const a = await storeAsset({ spaceId: ctx.spaceId, noteId, userId: ctx.userId, name: path.basename(name), mime: mimeOf(name), data: Buffer.from(data) });
    ctx.stats.assets++;
    cache.set(key, a);
  }
  return cache.get(key);
}

// ---------------------------------------------------------------- AFFiNE (BlockSuite snapshots)

const deltaOf = (t) => (Array.isArray(t?.delta) ? t.delta : typeof t === 'string' ? [{ insert: t }] : Array.isArray(t) ? t : []);
const plainOf = (t) => deltaOf(t).map((d) => (typeof d.insert === 'string' ? d.insert : '')).join('');

function inlineNodes(t, ctx) {
  const out = [];
  for (const d of deltaOf(t)) {
    if (typeof d.insert !== 'string' || !d.insert) continue;
    const a = d.attributes || {};
    const ref = a.reference?.pageId;
    if (ref) {
      const target = ctx.pages.get(ref);
      if (target) { out.push({ type: 'pageMention', attrs: { id: target.noteId, title: target.title } }); continue; }
    }
    const marks = [];
    if (a.bold) marks.push({ type: 'bold' });
    if (a.italic) marks.push({ type: 'italic' });
    if (a.underline) marks.push({ type: 'underline' });
    if (a.strike) marks.push({ type: 'strike' });
    if (a.code) marks.push({ type: 'code' });
    if (a.background) marks.push({ type: 'highlight' });
    if (typeof a.link === 'string' && /^(https?:|mailto:)/i.test(a.link)) marks.push({ type: 'link', attrs: { href: a.link } });
    d.insert.split('\n').forEach((part, i) => {
      if (i) out.push({ type: 'hardBreak' });
      if (part) out.push(marks.length ? { type: 'text', text: part, marks } : { type: 'text', text: part });
    });
  }
  return out;
}

const para = (content) => ({ type: 'paragraph', content: content.length ? content : undefined });
const linkPara = (label, href) => para([{ type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] }]);

function listKind(b) {
  const t = b.props?.type;
  return t === 'numbered' ? 'orderedList' : t === 'todo' ? 'taskList' : 'bulletList';
}

/** Children → blocks, grouping consecutive list items of one kind into a list. */
async function childBlocks(children, ctx) {
  const out = [];
  let list = null;
  for (const c of children || []) {
    if (c.flavour === 'affine:list') {
      const kind = listKind(c);
      if (!list || list.type !== kind) { list = { type: kind, content: [] }; out.push(list); }
      const inner = [para(inlineNodes(c.props?.text, ctx)), ...(await childBlocks(c.children, ctx))];
      list.content.push(kind === 'taskList' ? { type: 'taskItem', attrs: { checked: !!c.props?.checked }, content: inner } : { type: 'listItem', content: inner });
      continue;
    }
    list = null;
    out.push(...(await blockOf(c, ctx)));
  }
  return out;
}

async function blockOf(b, ctx) {
  const p = b.props || {};
  switch (b.flavour) {
    case 'affine:page': case 'affine:note': case 'affine:frame':
      return childBlocks(b.children, ctx);
    case 'affine:surface':
      collectBrushes(p, ctx);
      return childBlocks(b.children, ctx);
    case 'affine:paragraph': {
      const inl = inlineNodes(p.text, ctx);
      const head = /^h([1-6])$/.exec(p.type || '');
      const self = head ? { type: 'heading', attrs: { level: Math.min(3, Number(head[1])) }, content: inl.length ? inl : undefined }
        : p.type === 'quote' ? { type: 'blockquote', content: [para(inl)] } : para(inl);
      // AFFiNE indents paragraphs by nesting them; Inkwell flattens them below.
      return [self, ...(await childBlocks(b.children, ctx))];
    }
    case 'affine:code':
      return [{ type: 'codeBlock', attrs: { language: p.language || null }, content: plainOf(p.text) ? [{ type: 'text', text: plainOf(p.text) }] : undefined }];
    case 'affine:latex':
      return [{ type: 'codeBlock', attrs: { language: 'latex' }, content: p.latex ? [{ type: 'text', text: String(p.latex) }] : undefined }];
    case 'affine:divider':
      return [{ type: 'horizontalRule' }];
    case 'affine:image': case 'affine:attachment': {
      const id = String(p.sourceId || '').replace(/^\//, '');
      const file = ctx.assets.get(id);
      if (!file) { ctx.warnings.push(`A ${b.flavour === 'affine:image' ? 'picture' : 'file'} was missing from the export`); return []; }
      const a = await assetFor(ctx, ctx.noteId, ctx.assetCache, b.flavour === 'affine:attachment' && p.name ? p.name : file.name, file.data);
      if (b.flavour === 'affine:image') {
        const out = [{ type: 'image', attrs: { src: `/api/assets/${a.id}`, alt: plainOf(p.caption) || '' } }];
        if (p.caption) out.push(para([{ type: 'text', text: plainOf(p.caption), marks: [{ type: 'italic' }] }]));
        return out;
      }
      return [linkPara(`📎 ${p.name || a.name}`, `/api/assets/${a.id}`)];
    }
    case 'affine:bookmark': case 'affine:embed-youtube': case 'affine:embed-figma': case 'affine:embed-github': case 'affine:embed-loom': case 'affine:embed-html': case 'affine:embed-iframe':
      return p.url ? [linkPara(p.title || p.url, p.url)] : [];
    case 'affine:embed-linked-doc': case 'affine:embed-synced-doc': {
      const target = ctx.pages.get(p.pageId);
      return target ? [para([{ type: 'pageMention', attrs: { id: target.noteId, title: target.title } }])] : [];
    }
    case 'affine:callout': {
      const inner = await childBlocks(b.children, ctx);
      if (p.text) inner.unshift(para(inlineNodes(p.text, ctx)));
      return [{ type: 'callout', attrs: { emoji: p.emoji || '💡' }, content: inner.length ? inner : [para([])] }];
    }
    case 'affine:table': return [tableOf(p, ctx)].filter(Boolean);
    case 'affine:database': {
      // Database views have no Inkwell equivalent yet: keep the title and the rows' text.
      const rows = (b.children || []).map((r) => plainOf(r.props?.text)).filter(Boolean);
      ctx.warnings.push('Database blocks were imported as plain lists (columns and views are not kept)');
      return [
        ...(plainOf(p.title) ? [{ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: plainOf(p.title) }] }] : []),
        ...(rows.length ? [{ type: 'bulletList', content: rows.map((r) => ({ type: 'listItem', content: [para([{ type: 'text', text: r }])] })) }] : []),
      ];
    }
    default: {
      const out = p.text ? [para(inlineNodes(p.text, ctx))] : [];
      if (!p.text && !b.children?.length && !/surface-ref|edgeless-text/.test(b.flavour)) ctx.warnings.push(`Skipped unsupported block type ${b.flavour}`);
      return [...out, ...(await childBlocks(b.children, ctx))];
    }
  }
}

// AFFiNE's own table block: rows/columns ordered by `order`, cells keyed "<rowId>:<columnId>".
function tableOf(p, ctx) {
  const byOrder = (o) => Object.values(o || {}).sort((a, b) => String(a.order).localeCompare(String(b.order)));
  const rows = byOrder(p.rows), cols = byOrder(p.columns);
  if (!rows.length || !cols.length) return null;
  return {
    type: 'table',
    content: rows.map((r, ri) => ({
      type: 'tableRow',
      content: cols.map((c) => ({ type: ri ? 'tableCell' : 'tableHeader', content: [para(inlineNodes(p.cells?.[`${r.rowId}:${c.columnId}`]?.text, ctx))] })),
    })),
  };
}

// Edgeless pen ("brush") strokes become one ink block, scaled to fit Inkwell's canvas width.
function collectBrushes(p, ctx) {
  const els = p.elements?.value || p.elements || {};
  for (const el of Object.values(els)) {
    if (el?.type !== 'brush' || !Array.isArray(el.points) || el.points.length < 2) continue;
    let xywh = el.xywh;
    if (typeof xywh === 'string') { try { xywh = JSON.parse(xywh); } catch { xywh = null; } }
    const [x = 0, y = 0] = Array.isArray(xywh) ? xywh : [];
    // Brush points are relative to the element's bounding box.
    ctx.brushes.push({ points: el.points.map(([px, py, pr]) => [px + x, py + y, typeof pr === 'number' ? pr : 0.5]), color: colorOf(el.color), width: Number(el.lineWidth) || 4 });
  }
  if (Object.values(els).some((e) => e && e.type && e.type !== 'brush' && e.type !== 'connector')) ctx.warnings.push('Shapes and text on edgeless canvases were not imported (pen strokes were)');
}

const colorOf = (c) => {
  const v = typeof c === 'string' ? c : c?.light || c?.normal || c?.dark;
  return /^#[0-9a-f]{3,8}$/i.test(v || '') ? v : '#1f2937';
};

function brushesToInk(brushes) {
  if (!brushes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of brushes) for (const [x, y] of b.points) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const s = Math.min(1, (CANVAS_WIDTH - 40) / Math.max(1, maxX - minX));
  const r = (v) => Math.round(v * 10) / 10;
  const strokes = brushes.map((b) => ({
    id: sid(), t: 'pen', c: b.color, w: Math.max(1, r(b.width * s)),
    p: b.points.flatMap(([x, y, pr]) => [r((x - minX) * s + 20), r((y - minY) * s + 20), Math.round(pr * 100) / 100]),
  }));
  return { id: sid(), strokes, height: Math.ceil(((maxY - minY) * s + 60) / 10) * 10 };
}

async function importAffine(ctx, snapshotFiles, files) {
  ctx.assets = new Map(files.filter((f) => /(^|\/)assets\//.test(f.name)).map((f) => [path.basename(f.name).replace(/\.[^.]+$/, ''), f]));
  ctx.assetCache = new Map();
  const snaps = [];
  for (const f of snapshotFiles) {
    try {
      const s = JSON.parse(strFromU8(f.data));
      if (s?.blocks && s?.meta?.id) snaps.push(s);
    } catch { ctx.warnings.push(`Could not read ${f.name}`); }
  }
  const byId = new Map(snaps.map((s) => [s.meta.id, s]));
  // Docs embedded as linked cards inside another doc become its sub-pages (like AFFiNE's sidebar shows them).
  const parent = new Map();
  const walk = (b, owner) => {
    if ((b.flavour === 'affine:embed-linked-doc') && b.props?.pageId && byId.has(b.props.pageId) && b.props.pageId !== owner && !parent.has(b.props.pageId)) parent.set(b.props.pageId, owner);
    for (const c of b.children || []) walk(c, owner);
  };
  for (const s of snaps) walk(s.blocks, s.meta.id);
  for (const id of parent.keys()) { // break cycles
    const seen = new Set([id]);
    for (let p = parent.get(id); p; p = parent.get(p)) { if (seen.has(p)) { parent.delete(id); break; } seen.add(p); }
  }

  ctx.pages = new Map();
  const titleOf = (s) => (s.meta.title || plainOf(s.blocks?.props?.title) || '').trim();
  const create = async (s) => {
    if (ctx.pages.has(s.meta.id)) return ctx.pages.get(s.meta.id);
    const pid = parent.get(s.meta.id);
    const parentNote = pid ? await create(byId.get(pid)) : null;
    const n = await createNote(ctx.userId, { spaceId: ctx.spaceId, parentId: parentNote ? parentNote.noteId : ctx.rootId, title: titleOf(s) });
    const entry = { noteId: n.id, title: titleOf(s) || 'Untitled' };
    ctx.pages.set(s.meta.id, entry);
    ctx.stats.pages++;
    return entry;
  };
  for (const s of snaps.sort((a, b) => (a.meta.createDate || 0) - (b.meta.createDate || 0))) await create(s);

  for (const s of snaps) {
    const page = ctx.pages.get(s.meta.id);
    ctx.noteId = page.noteId;
    ctx.brushes = [];
    const blocks = await blockOf(s.blocks, ctx);
    const ink = brushesToInk(ctx.brushes);
    if (ink) blocks.push({ type: 'inkBlock', attrs: { id: ink.id, height: ink.height } });
    await fillPage(ctx, page.noteId, { title: titleOf(s), blocks, ink, createdAt: Number(s.meta.createDate) || null });
  }
}

// ---------------------------------------------------------------- Markdown (single files or folder zips)

// Notion appends " <32 hex id>" to file and folder names.
const cleanName = (n) => decodeURIComponent(n).replace(/\.(md|markdown)$/i, '').replace(/\s+[0-9a-f]{32}$/i, '').trim();

async function importMarkdown(ctx, mdFiles, files) {
  const byPath = new Map(files.map((f) => [f.name, f]));
  const pageByPath = new Map(); // md path → { noteId, title }
  const folderPage = new Map(); // folder path → noteId
  const assetCache = new Map();

  const parentFor = async (dir) => {
    if (!dir || dir === '.') return ctx.rootId;
    if (folderPage.has(dir)) return folderPage.get(dir);
    // A "Page.md" next to a "Page/" folder is that folder's page (Notion, Obsidian folder notes).
    const sibling = mdFiles.find((f) => f.name.replace(/\.(md|markdown)$/i, '') === dir);
    let id;
    if (sibling) id = (await ensurePage(sibling)).noteId;
    else {
      const n = await createNote(ctx.userId, { spaceId: ctx.spaceId, parentId: await parentFor(path.posix.dirname(dir)), title: cleanName(path.posix.basename(dir)), icon: '📁' });
      ctx.stats.pages++;
      id = n.id;
    }
    folderPage.set(dir, id);
    return id;
  };
  const ensurePage = async (f) => {
    if (pageByPath.has(f.name)) return pageByPath.get(f.name);
    const text = strFromU8(f.data);
    const h = /^\s*#\s+(.+)\n/.exec(text);
    const title = (h ? h[1] : cleanName(path.posix.basename(f.name))).trim();
    const entry = { noteId: null, title, text: h ? text.slice(h.index + h[0].length) : text };
    pageByPath.set(f.name, entry);
    const n = await createNote(ctx.userId, { spaceId: ctx.spaceId, parentId: await parentFor(path.posix.dirname(f.name)), title });
    entry.noteId = n.id;
    ctx.stats.pages++;
    return entry;
  };
  for (const f of mdFiles.sort((a, b) => a.name.localeCompare(b.name))) await ensurePage(f);

  for (const f of mdFiles) {
    const page = pageByPath.get(f.name);
    const dir = path.posix.dirname(f.name);
    const resolve = (href) => {
      const clean = decodeURIComponent(String(href).split('#')[0].split('?')[0].replace(/^<|>$/g, ''));
      return path.posix.normalize(path.posix.join(dir, clean));
    };
    // Relative images → uploaded assets.
    let md = page.text;
    const images = [...md.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)];
    for (const m of images) {
      if (/^(https?:|data:)/i.test(m[2])) continue;
      const file = byPath.get(resolve(m[2]));
      if (!file) { ctx.warnings.push(`Image not found in the archive: ${m[2]}`); continue; }
      const a = await assetFor(ctx, page.noteId, assetCache, file.name, file.data);
      md = md.replace(m[0], `![${m[1]}](/api/assets/${a.id})`);
    }
    const blocks = markdownToBlocks(md);
    // Links to other imported .md files → page mentions; [[Wiki links]] by title too.
    const titles = new Map([...pageByPath.values()].map((p) => [p.title.toLowerCase(), p]));
    const fix = (node) => {
      if (!node?.content) return node;
      node.content = node.content.flatMap((c) => {
        const href = c.marks?.find((m) => m.type === 'link')?.attrs?.href;
        if (c.type === 'text' && href && !/^[a-z]+:/i.test(href) && /\.(md|markdown)$/i.test(href.split('#')[0])) {
          const target = pageByPath.get(resolve(href));
          if (target) return [{ type: 'pageMention', attrs: { id: target.noteId, title: target.title } }];
        }
        const wiki = c.type === 'text' && !c.marks && /\[\[([^\]]+)\]\]/.test(c.text) ? c.text.split(/(\[\[[^\]]+\]\])/) : null;
        if (wiki) {
          return wiki.filter(Boolean).map((part) => {
            const w = /^\[\[([^\]|#]+)/.exec(part);
            const target = w && titles.get(w[1].trim().toLowerCase());
            return target ? { type: 'pageMention', attrs: { id: target.noteId, title: target.title } } : { type: 'text', text: part };
          });
        }
        return [fix(c)];
      });
      return node;
    };
    blocks.forEach(fix);
    await fillPage(ctx, page.noteId, { title: page.title, blocks });
  }
  const other = files.filter((f) => !/\.(md|markdown)$/i.test(f.name) && !/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(f.name));
  if (other.length) ctx.warnings.push(`${other.length} other file(s) in the archive were not imported`);
}

export default async function importRoutes(app) {
  const { config } = await import('../config.js');
  const { needSpace } = await import('../spaces.js');
  const { isUuid } = await import('../util/http.js');
  app.post('/api/import', async (req) => {
    const part = await req.file({ limits: { fileSize: config.maxImport } });
    if (!part) fail(400, 'No file');
    const fields = Object.fromEntries(Object.entries(part.fields).map(([k, v]) => [k, v?.value]));
    await needSpace(req.user.id, fields.spaceId, 'editor');
    const data = await part.toBuffer();
    if (part.file.truncated) fail(413, `Imports can be at most ${Math.round(config.maxImport / 1048576)} MB`);
    let parentId = null;
    if (isUuid(fields.parentId)) {
      const { needNote } = await import('../spaces.js');
      const n = await needNote(req.user.id, fields.parentId, 'editor');
      if (n.space_id !== fields.spaceId) fail(400, 'The parent page is in another space');
      parentId = n.id;
    }
    return importArchive(req.user.id, { spaceId: fields.spaceId, parentId, filename: part.filename || 'import', data });
  });
}
