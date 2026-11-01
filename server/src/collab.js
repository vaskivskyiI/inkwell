// Real-time co-editing: every page is a Y.Doc named "note:<id>", synced with the Hocuspocus protocol over
// /api/collab. Stored in notes.ydoc (debounced); on store the server derives title/text/search, keeps version
// snapshots, syncs page mentions and schedules background AI when the content really changed.
import * as Y from 'yjs';
import { Hocuspocus } from '@hocuspocus/server';
import { one, many, q, tx, now } from './db/index.js';
import { config } from './config.js';
import { RANK } from './spaces.js';
import { extract, docFrom } from './docmodel.js';
import { publish } from './events.js';
import { enqueue } from './ai/queue.js';
import { logger } from './util/log.js';
import { queueOutgoing } from './tasksync.js';

const log = logger('collab');
const VERSION_EVERY = 10 * 60e3;
let hp = null;

const noteIdOf = (name) => (/^note:([0-9a-f-]{36})$/.exec(name || '') || [])[1];

export async function recognitionsOf(noteId) {
  return Object.fromEntries((await many("SELECT canvas_id, text FROM ink_recognitions WHERE note_id = $1 AND text <> ''", noteId)).map((r) => [r.canvas_id, r.text]));
}

async function assetTexts(ids) {
  if (!ids.length) return {};
  return Object.fromEntries((await many('SELECT id, ai_text FROM assets WHERE id = ANY($1::uuid[]) AND ai_text IS NOT NULL', ids)).map((r) => [r.id, r.ai_text]));
}

/** The files a page uses, kept in step with its content. */
export async function syncAssetRefs(noteId, assets) {
  await q('DELETE FROM asset_refs WHERE note_id = $1 AND NOT (asset_id = ANY($2::uuid[]))', noteId, assets);
  if (assets.length) await q('INSERT INTO asset_refs (asset_id, note_id) SELECT id, $1 FROM assets WHERE id = ANY($2::uuid[]) ON CONFLICT DO NOTHING', noteId, assets);
}

// The calendar of notes knows when pages were worked on to the half hour (enough for any time zone's day).
const EDIT_SLOT = 30 * 60 * 1000;

/** Derives everything from the doc and saves it. Exported for tests and for jobs that change derived data (ink text). */
export async function persist(noteId, doc, userId) {
  const prev = await one('SELECT space_id, title, content_hash, updated_at, kind FROM notes WHERE id = $1', noteId);
  if (!prev) return null;
  const recognitions = await recognitionsOf(noteId);
  let info = extract(doc, { recognitions });
  // Images are described by AI in the background; their descriptions make them searchable.
  const texts = await assetTexts(info.assets);
  if (Object.keys(texts).length) info = extract(doc, { recognitions, assetText: (id) => texts[id] });
  const state = Y.encodeStateAsUpdate(doc);
  const changed = info.hash !== prev.content_hash;
  const t = now();
  await tx(async () => {
    if (!changed) { await q('UPDATE notes SET ydoc = $2 WHERE id = $1', noteId, state); return; }
    await q(`UPDATE notes SET ydoc = $2, title = $3, text_content = $4, tags = $5, content_hash = $6,
      search = setweight(to_tsvector('simple', $3), 'A') || setweight(to_tsvector('simple', $4), 'B'),
      updated_at = $7, updated_by = coalesce($8, updated_by) WHERE id = $1`, noteId, state, info.title, info.text, info.tags, info.hash, t, userId || null);
    await syncAssetRefs(noteId, info.assets);
    await q('INSERT INTO note_edits (note_id, slot, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', noteId, t - (t % EDIT_SLOT), userId || null);
    // Page mentions become backlinks.
    await q("DELETE FROM note_links WHERE note_id = $1 AND kind = 'mention' AND NOT (ref = ANY($2::text[]))", noteId, info.mentions);
    for (const m of info.mentions) {
      await q("INSERT INTO note_links (note_id, kind, ref, created_by, created_at) VALUES ($1, 'mention', $2, $3, $4) ON CONFLICT DO NOTHING", noteId, m, userId || null, t);
    }
    const last = await one('SELECT created_at FROM note_versions WHERE note_id = $1 ORDER BY created_at DESC LIMIT 1', noteId);
    if (!last || t - last.created_at > VERSION_EVERY) {
      await q('INSERT INTO note_versions (note_id, title, ydoc, created_by, created_at) VALUES ($1, $2, $3, $4, $5)', noteId, info.title, state, userId || null, t);
    }
  });
  if (!changed) return info;
  const owner = userId || (await one('SELECT created_by FROM notes WHERE id = $1', noteId))?.created_by;
  if (owner) {
    await enqueue(owner, 'analyze', noteId, { delay: config.aiDelay, priority: 5 });
    await enqueue(owner, 'embed', noteId, { delay: config.aiDelay, priority: 7 });
    const done = Object.fromEntries((await many('SELECT canvas_id, strokes_hash FROM ink_recognitions WHERE note_id = $1', noteId)).map((r) => [r.canvas_id, r.strokes_hash]));
    // Handwriting is read soon after the pen pauses — the transcription is what makes ink searchable.
    for (const c of info.canvases) if (done[c.id] !== c.hash) await enqueue(owner, 'ink', `${noteId}:${c.id}`, { delay: Math.min(config.aiDelay, 8), priority: 3 });
  }
  if (owner) await queueOutgoing(owner, noteId, doc).catch((e) => log.warn('task sync', e.message));
  publish(prev.space_id, 'note:updated', { note: { id: noteId, title: info.title, tags: info.tags, updatedAt: t, updatedBy: userId } });
  return info;
}

export function collab() {
  if (hp) return hp;
  const extensions = [];
  hp = new Hocuspocus({
    name: 'inkwell',
    quiet: true,
    debounce: 2000,
    maxDebounce: 10000,
    timeout: 30000,
    extensions,
    async onConnect({ documentName, context, connectionConfig }) {
      const id = noteIdOf(documentName);
      const user = context?.user;
      if (!id || !user) throw new Error('Forbidden');
      const r = await one(`SELECT m.role FROM notes n JOIN space_members m ON m.space_id = n.space_id AND m.user_id = $2
        WHERE n.id = $1 AND n.deleted_at IS NULL`, id, user.id);
      if (!r) throw new Error('Forbidden');
      if (RANK[r.role] < RANK.editor) connectionConfig.readOnly = true;
    },
    async onLoadDocument({ documentName, document }) {
      const id = noteIdOf(documentName);
      const n = id && await one('SELECT ydoc FROM notes WHERE id = $1', id);
      if (n?.ydoc?.length) Y.applyUpdate(document, n.ydoc);
      return document;
    },
    async onStoreDocument({ documentName, document, lastContext }) {
      const id = noteIdOf(documentName);
      if (!id) return;
      try { await persist(id, document, lastContext?.user?.id); } catch (e) { log.error(`store ${id} failed`, e); throw e; }
    },
  });
  if (config.redisUrl) {
    // Several instances: co-editors connected to different instances meet through Redis.
    import('@hocuspocus/extension-redis').then(({ Redis }) => {
      const u = new URL(config.redisUrl);
      extensions.push(new Redis({ host: u.hostname, port: Number(u.port) || 6379, options: { password: u.password || undefined } }));
      log.info('redis sync enabled');
    }).catch((e) => log.error('INKWELL_REDIS_URL is set but @hocuspocus/extension-redis is not installed', e.message));
  }
  return hp;
}

/** Fastify websocket handler → Hocuspocus. The user is resolved from the cookie / token before the upgrade. */
export function handleSocket(socket, req, user) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const request = new Request(`http://localhost${req.url}`, { headers });
  const conn = collab().handleConnection(socket, request, { user: { id: user.id, name: user.name, color: user.color } });
  socket.on('message', (data, isBinary) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    if (isBinary === false) return;
    conn.handleMessage(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  });
  socket.on('close', (code, reason) => conn.handleClose({ code, reason: reason?.toString() || '' }));
  socket.on('pong', () => conn.touch?.());
  socket.on('error', () => {});
}

/** Server-side edit of a page (rename, restore, AI insert, append template) — co-editors receive it live. */
export async function withDoc(noteId, fn, user) {
  const c = await collab().openDirectConnection(`note:${noteId}`, { user: user && { id: user.id, name: user.name } });
  try { await c.transact((doc) => fn(doc)); } finally { await c.disconnect(); }
}

/** Current state of a page (the live doc if someone is editing it, else from the database). */
export async function readDoc(noteId) {
  const live = hp?.documents.get(`note:${noteId}`);
  if (live) return live;
  const n = await one('SELECT ydoc FROM notes WHERE id = $1', noteId);
  return docFrom(n?.ydoc);
}

export async function stopCollab() {
  if (!hp) return;
  hp.flushPendingStores?.();
  for (const d of [...hp.documents.values()]) { try { await hp.unloadDocument(d); } catch { /* ignore */ } }
  hp = null;
}
