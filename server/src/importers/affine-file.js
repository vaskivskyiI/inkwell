// AFFiNE's workspace export (`.affine`): a SQLite database of Yjs updates and files, not a zip. Newer versions keep one
// compacted snapshot per doc plus later updates (`snapshots`, `updates`); older ones only `updates`, with no doc id for
// the root doc. The root doc lists the pages; each page doc holds its blocks in a flat map. Here both become the same
// shape as a Snapshot export, so one importer handles them.
import * as Y from 'yjs';
import { fail } from '../util/http.js';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'application/pdf': 'pdf', 'video/mp4': 'mp4', 'audio/mpeg': 'mp3' };

export const isSqlite = (d) => Buffer.from(d.subarray(0, 15)).toString('latin1') === 'SQLite format 3';

// Old exports do not record a file's type.
function sniff(d) {
  const b = Buffer.from(d?.subarray(0, 12) ?? []);
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 0, 4) === '%PDF') return 'application/pdf';
  return '';
}

/** Yjs values → the plain values of a Snapshot export. */
function plain(v) {
  if (v instanceof Y.Text) return { delta: v.toDelta() };
  if (v instanceof Y.Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [k, plain(x)]));
  if (v instanceof Y.Array) return v.toArray().map(plain);
  return v;
}

/** `prop:rows.r1.order` → props.rows.r1.order: nested values are stored under flat keys. */
function propsOf(block) {
  const props = {};
  for (const [key, value] of block.entries()) {
    if (!key.startsWith('prop:')) continue;
    const parts = key.slice(5).split('.');
    let at = props;
    for (const p of parts.slice(0, -1)) at = at[p] ??= {};
    at[parts.at(-1)] = plain(value);
  }
  return props;
}

function treeOf(blocks, id, seen = new Set()) {
  const b = blocks.get(id);
  if (!(b instanceof Y.Map) || seen.has(id)) return null;
  seen.add(id);
  const kids = b.get('sys:children');
  return { id, flavour: b.get('sys:flavour'), props: propsOf(b), children: (kids instanceof Y.Array ? kids.toArray() : []).map((c) => treeOf(blocks, c, seen)).filter(Boolean) };
}

// Files are read one at a time when used, so a workspace with gigabytes of attachments never sits in memory.
async function readTables(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    if (!tables.has('updates') && !tables.has('snapshots')) fail(400, 'This database is not an AFFiNE workspace export');
    const rows = (sql) => db.prepare(sql).all();
    const docs = [...(tables.has('snapshots') ? rows('SELECT doc_id, data FROM snapshots') : []),
      ...(tables.has('updates') ? rows(`SELECT doc_id, data FROM updates ORDER BY ${[...db.prepare('PRAGMA table_info(updates)').all()].some((c) => c.name === 'id') ? 'id' : 'created_at'}`) : [])];
    const cols = tables.has('blobs') ? db.prepare('PRAGMA table_info(blobs)').all().map((c) => c.name) : [];
    const blobs = !cols.length ? [] : rows(`SELECT key, substr(data, 1, 12) AS head, length(data) AS size${cols.includes('mime') ? ', mime' : ''} FROM blobs${cols.includes('deleted_at') ? ' WHERE deleted_at IS NULL' : ''}`);
    const one = cols.length ? db.prepare('SELECT data FROM blobs WHERE key = ?') : null;
    return { docs, blobs, blob: (key) => Buffer.from(one.get(key).data), close: () => db.close() };
  } catch (e) { db.close(); throw e; }
}

/** { snaps: Snapshot-shaped docs, assets: Map blob key → { name, size, data }, close } — `file` is a path on disk. */
export async function readAffineFile(file, warnings) {
  const tables = await readTables(file).catch((e) => { if (e.statusCode) throw e; return fail(400, `Cannot read this .affine file: ${e.message}`); });
  try { return { ...parse(tables, warnings), close: tables.close }; } catch (e) { tables.close(); throw e; }
}

function parse(tables, warnings) {
  const docs = new Map();
  for (const { doc_id: id, data: bin } of tables.docs) {
    const key = id ?? '';
    if (!docs.has(key)) docs.set(key, new Y.Doc());
    try { Y.applyUpdate(docs.get(key), bin); } catch { warnings.push('A part of the workspace could not be read'); }
  }
  const pagesOf = (d) => { const p = d.getMap('meta').get('pages'); return p instanceof Y.Array ? p.toArray().map(plain) : []; };
  const [root] = [...docs.values()].filter((d) => pagesOf(d).length).sort((a, b) => pagesOf(b).length - pagesOf(a).length);
  if (!root) fail(400, 'No pages found in this .affine file');

  // Older workspaces address page docs by a guid kept in the root's `spaces` map.
  const spaces = root.getMap('spaces');
  const pageDoc = (id) => docs.get(id) || docs.get(spaces.get(id)?.guid) || docs.get(`space:${id}`);
  const snaps = [];
  let trashed = 0;
  for (const page of pagesOf(root)) {
    if (page.trash) { trashed++; continue; }
    const blocks = pageDoc(page.id)?.getMap('blocks');
    const rootId = blocks && [...blocks.entries()].find(([, b]) => b instanceof Y.Map && b.get('sys:flavour') === 'affine:page')?.[0];
    if (!rootId) { warnings.push(`The page “${page.title || page.id}” has no content in this file`); continue; }
    snaps.push({ meta: { id: page.id, title: page.title, createDate: page.createDate }, blocks: treeOf(blocks, rootId) });
  }
  if (trashed) warnings.push(`${trashed} page(s) in AFFiNE's trash were left out`);

  const assets = new Map(tables.blobs.map((b) => {
    const ext = EXT[b.mime] || EXT[sniff(b.head)];
    return [b.key, { name: ext ? `${b.key}.${ext}` : b.key, size: b.size, get data() { return tables.blob(b.key); } }];
  }));
  return { snaps, assets };
}
