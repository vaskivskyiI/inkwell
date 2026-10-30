// Pages: tree, create/move/trash/restore, favourites, recent, daily journal, templates, versions, export/import,
// public links. Page *content* lives in the Y.Doc (collab.js); changes to it from here go through withDoc().
import * as Y from 'yjs';
import { one, many, q, tx, now } from './db/index.js';
import { fail, str, isUuid } from './util/http.js';
import { randomToken } from './util/crypto.js';
import { needSpace, needNote, userSpaceIds } from './spaces.js';
import { publish } from './events.js';
import { buildDoc, encode, docFrom, markdownToBlocks, appendBlocks, setTitle, extract } from './docmodel.js';
import { pageHtml } from './html.js';
import { TEMPLATES, WELCOME_MD } from './templates.js';
import { withDoc, recognitionsOf } from './collab.js';
import { getSettings } from './settings.js';
import { enqueue } from './ai/queue.js';
import { config } from './config.js';

const TRASH_DAYS = 30;

export const noteOut = (n) => n && ({
  id: n.id, spaceId: n.space_id, parentId: n.parent_id, position: n.position, kind: n.kind, title: n.title, icon: n.icon,
  tags: n.tags || [], journalDate: n.journal_date, publicSlug: n.public_slug ?? undefined, createdBy: n.created_by,
  updatedBy: n.updated_by, createdAt: n.created_at, updatedAt: n.updated_at, deletedAt: n.deleted_at ?? undefined,
  role: n.role, favorite: n.favorite ?? undefined, hasChildren: n.has_children ?? undefined, snippet: n.snippet ?? undefined,
});

const TREE_COLS = 'n.id, n.space_id, n.parent_id, n.position, n.kind, n.title, n.icon, n.tags, n.journal_date, n.updated_at, n.created_at, n.created_by, n.updated_by';

async function positionFor(spaceId, parentId, afterId) {
  const sib = (sql, ...a) => one(sql, spaceId, parentId, ...a);
  const parentCond = 'space_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL';
  if (afterId === undefined) return ((await sib(`SELECT max(position) AS p FROM notes WHERE ${parentCond}`))?.p ?? -1) + 1;
  if (afterId === null) return ((await sib(`SELECT min(position) AS p FROM notes WHERE ${parentCond}`))?.p ?? 1) - 1;
  const a = await sib(`SELECT position FROM notes WHERE ${parentCond} AND id = $3`, afterId);
  if (!a) return positionFor(spaceId, parentId, undefined);
  const b = await sib(`SELECT min(position) AS p FROM notes WHERE ${parentCond} AND position > $3`, a.position);
  return b?.p == null ? a.position + 1 : (a.position + b.p) / 2;
}

export async function createNote(userId, { spaceId, parentId = null, afterId, kind = 'page', title = '', icon = '', markdown = '', blocks, journalDate = null, paper }) {
  if (parentId) {
    const p = await one('SELECT space_id FROM notes WHERE id = $1 AND deleted_at IS NULL', parentId);
    if (!p || p.space_id !== spaceId) fail(400, 'The parent page is not in this space');
  }
  const b = blocks || (markdown ? markdownToBlocks(markdown) : []);
  const doc = buildDoc({ title, blocks: b, paper: kind === 'journal' ? paper || 'ruled' : undefined });
  const info = extract(doc);
  const n = await one(`INSERT INTO notes (space_id, parent_id, position, kind, title, icon, text_content, tags, journal_date, ydoc, content_hash, search, created_by, updated_by, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '', setweight(to_tsvector('simple', $5), 'A') || setweight(to_tsvector('simple', $7), 'B'), $11, $11, $12, $12) RETURNING *`,
  spaceId, parentId, await positionFor(spaceId, parentId, afterId), kind === 'journal' ? 'journal' : 'page', str(title, 300), str(icon, 8),
  info.text, info.tags, journalDate, encode(doc), userId, now());
  publish(spaceId, 'note:created', { note: noteOut(n) });
  // Imported / templated content is analysed like typed content.
  if (info.text.trim().length > 40) {
    await enqueue(userId, 'analyze', n.id, { delay: config.aiDelay, priority: 6 });
    await enqueue(userId, 'embed', n.id, { delay: config.aiDelay, priority: 8 });
  }
  return n;
}

export async function createWelcome(userId, spaceId) {
  return createNote(userId, { spaceId, title: 'Welcome to Inkwell', icon: '👋', markdown: WELCOME_MD });
}

const fillTemplate = (md) => md.replaceAll('{{date}}', new Date().toISOString().slice(0, 10));

async function descendants(noteId, { includeDeleted = false } = {}) {
  return (await many(`WITH RECURSIVE t AS (SELECT id FROM notes WHERE id = $1
    UNION ALL SELECT n.id FROM notes n JOIN t ON n.parent_id = t.id ${includeDeleted ? '' : 'WHERE n.deleted_at IS NULL'}) SELECT id FROM t`, noteId)).map((r) => r.id);
}

export async function noteDetail(userId, id) {
  const base = await needNote(userId, id, 'viewer', { trashed: true });
  const n = await one(`SELECT n.*, $2::text AS role, EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = $3 AND f.note_id = n.id) AS favorite
    FROM notes n WHERE n.id = $1`, id, base.role, userId);
  const [insight, links, backlinks, ink, members] = await Promise.all([
    one('SELECT summary, title, tags_json, actions_json, updated_at, error FROM ai_insights WHERE note_id = $1', id),
    many('SELECT id, kind, ref, title, meta_json, created_at FROM note_links WHERE note_id = $1 AND kind <> $2 ORDER BY created_at', id, 'mention'),
    many(`SELECT DISTINCT n.id, n.title, n.icon, n.kind FROM note_links l JOIN notes n ON n.id = l.note_id
      WHERE l.kind IN ('note', 'mention') AND l.ref = $1 AND n.deleted_at IS NULL AND n.space_id = ANY($2::uuid[])`, id, await userSpaceIds(userId)),
    many('SELECT canvas_id, text, data_json, updated_at, error FROM ink_recognitions WHERE note_id = $1', id),
    many('SELECT u.id, u.name, u.color FROM users u WHERE u.id = ANY($1::uuid[])', [n.created_by, n.updated_by].filter(Boolean)),
  ]);
  const people = Object.fromEntries(members.map((m) => [m.id, { name: m.name, color: m.color }]));
  return {
    ...noteOut(n), createdByUser: people[n.created_by], updatedByUser: people[n.updated_by],
    insight: insight && { summary: insight.summary, title: insight.title, tags: insight.tags_json, actions: insight.actions_json, updatedAt: insight.updated_at, error: insight.error },
    links: links.map((l) => ({ id: l.id, kind: l.kind, ref: l.ref, title: l.title, meta: l.meta_json, createdAt: l.created_at })),
    backlinks,
    ink: Object.fromEntries(ink.map((r) => [r.canvas_id, { text: r.text, data: r.data_json, updatedAt: r.updated_at, error: r.error }])),
  };
}

async function markdownOf(noteId) {
  const n = await one('SELECT title, ydoc FROM notes WHERE id = $1', noteId);
  const doc = docFrom(n.ydoc);
  const info = extract(doc, { recognitions: await recognitionsOf(noteId) });
  return { title: info.title || n.title, markdown: info.markdown, doc };
}

export async function purgeTrash() {
  await q('DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < $1', now() - TRASH_DAYS * 864e5);
}

export default async function noteRoutes(app) {
  app.get('/api/spaces/:id/tree', async (req) => {
    const role = await needSpace(req.user.id, req.params.id);
    const rows = await many(`SELECT ${TREE_COLS} FROM notes n WHERE n.space_id = $1 AND n.deleted_at IS NULL ORDER BY n.position`, req.params.id);
    return { role, notes: rows.map(noteOut) };
  });

  app.post('/api/notes', async (req) => {
    const b = req.body || {};
    await needSpace(req.user.id, b.spaceId, 'editor');
    // Quick photo: a page that starts with the picture ready to draw on.
    if (b.photo?.assetId && isUuid(b.photo.assetId)) {
      const a = await one('SELECT id FROM assets WHERE id = $1 AND space_id = $2', b.photo.assetId, b.spaceId) || fail(404, 'Photo not found');
      const height = Math.min(4000, Math.max(80, Math.round(Number(b.photo.height) || 700)));
      const n = await createNote(req.user.id, { spaceId: b.spaceId, title: str(b.title, 300), icon: '📷',
        blocks: [{ type: 'inkBlock', attrs: { id: randomToken(8), height, bg: `/api/assets/${a.id}` } }, { type: 'paragraph' }] });
      await q('UPDATE assets SET note_id = $2 WHERE id = $1', a.id, n.id);
      return noteOut(n);
    }
    const t = b.template && TEMPLATES[b.template];
    const n = await createNote(req.user.id, {
      spaceId: b.spaceId, parentId: isUuid(b.parentId) ? b.parentId : null, afterId: b.afterId === null || isUuid(b.afterId) ? b.afterId : undefined,
      kind: b.kind, title: str(b.title, 300) || (t && b.kind !== 'journal' ? `${t.name} ${new Date().toISOString().slice(0, 10)}` : ''),
      icon: b.icon || t?.icon || '', markdown: t ? fillTemplate(t.md) : str(b.markdown, 2e6), paper: b.paper || (await getSettings(req.user.id)).paper,
    });
    return noteOut(n);
  });

  app.get('/api/templates', async () => Object.entries(TEMPLATES).map(([id, t]) => ({ id, name: t.name, icon: t.icon })));

  app.get('/api/notes/:id', async (req) => noteDetail(req.user.id, req.params.id));

  app.patch('/api/notes/:id', async (req) => {
    const n = await needNote(req.user.id, req.params.id, 'editor');
    const b = req.body || {};
    if (b.icon !== undefined) await q('UPDATE notes SET icon = $2 WHERE id = $1', n.id, str(b.icon, 8));
    if (b.title !== undefined) {
      const title = str(b.title, 300);
      await q('UPDATE notes SET title = $2 WHERE id = $1', n.id, title);
      await withDoc(n.id, (doc) => setTitle(doc, title, 'rest'), req.user);
    }
    if (b.paper !== undefined && ['ruled', 'grid', 'dotted', 'plain'].includes(b.paper)) await withDoc(n.id, (doc) => doc.getMap('meta').set('paper', b.paper), req.user);
    if (b.spaceId !== undefined && b.spaceId !== n.space_id) {
      await needNote(req.user.id, n.id, 'editor');
      await needSpace(req.user.id, b.spaceId, 'editor');
      const ids = await descendants(n.id);
      await tx(async () => {
        await q('UPDATE notes SET space_id = $2, parent_id = NULL, position = $3 WHERE id = $1', n.id, b.spaceId, await positionFor(b.spaceId, null, undefined));
        await q('UPDATE notes SET space_id = $2 WHERE id = ANY($1::uuid[])', ids, b.spaceId);
        await q('UPDATE assets SET space_id = $2 WHERE note_id = ANY($1::uuid[])', ids, b.spaceId);
      });
      publish(n.space_id, 'note:removed', { ids });
      publish(b.spaceId, 'tree:changed', {});
    } else if (b.parentId !== undefined || b.afterId !== undefined) {
      const parentId = isUuid(b.parentId) ? b.parentId : null;
      if (parentId) {
        if ((await descendants(n.id)).includes(parentId)) fail(400, 'A page cannot be moved into its own sub-page');
        const p = await one('SELECT space_id FROM notes WHERE id = $1 AND deleted_at IS NULL', parentId);
        if (!p || p.space_id !== n.space_id) fail(400, 'The parent page is not in this space');
      }
      const pos = await positionFor(n.space_id, parentId, b.afterId === null || isUuid(b.afterId) ? b.afterId : undefined);
      await q('UPDATE notes SET parent_id = $2, position = $3 WHERE id = $1', n.id, parentId, pos);
    }
    const out = await one(`SELECT ${TREE_COLS} FROM notes n WHERE id = $1`, n.id);
    if (b.spaceId === undefined || b.spaceId === n.space_id) publish(out.space_id, 'note:updated', { note: noteOut(out) });
    return noteOut(out);
  });

  // Trash: the page and its sub-pages; restore brings them back; permanent delete only from the trash.
  app.delete('/api/notes/:id', async (req) => {
    const n = await needNote(req.user.id, req.params.id, 'editor', { trashed: true });
    if (req.query.permanent === '1') {
      if (!n.deleted_at) fail(400, 'Move the page to the trash first');
      await q('DELETE FROM notes WHERE id = $1', n.id);
      publish(n.space_id, 'trash:changed', {});
      return { ok: true };
    }
    const ids = await descendants(n.id);
    await q('UPDATE notes SET deleted_at = $2 WHERE id = ANY($1::uuid[])', ids, now());
    await q('DELETE FROM favorites WHERE note_id = ANY($1::uuid[])', ids);
    publish(n.space_id, 'note:removed', { ids });
    return { ok: true, ids };
  });

  app.post('/api/notes/:id/restore', async (req) => {
    const n = await needNote(req.user.id, req.params.id, 'editor', { trashed: true });
    const ids = await descendants(n.id, { includeDeleted: true });
    const parentGone = n.parent_id && (await one('SELECT deleted_at FROM notes WHERE id = $1', n.parent_id))?.deleted_at;
    await q('UPDATE notes SET deleted_at = NULL WHERE id = ANY($1::uuid[]) AND deleted_at >= (SELECT deleted_at FROM notes WHERE id = $2)', ids, n.id);
    if (parentGone) await q('UPDATE notes SET parent_id = NULL WHERE id = $1', n.id);
    publish(n.space_id, 'tree:changed', {});
    return { ok: true };
  });

  app.get('/api/trash', async (req) => {
    const spaces = await userSpaceIds(req.user.id);
    // Only the roots of what was deleted together (a deleted page whose parent is not deleted).
    return (await many(`SELECT ${TREE_COLS}, n.deleted_at FROM notes n LEFT JOIN notes p ON p.id = n.parent_id
      WHERE n.space_id = ANY($1::uuid[]) AND n.deleted_at IS NOT NULL AND (p.id IS NULL OR p.deleted_at IS NULL OR p.deleted_at <> n.deleted_at)
      ORDER BY n.deleted_at DESC LIMIT 500`, spaces)).map(noteOut);
  });

  app.post('/api/notes/:id/duplicate', async (req) => {
    const n = await needNote(req.user.id, req.params.id, 'viewer');
    await needSpace(req.user.id, n.space_id, 'editor');
    const src = await one('SELECT ydoc, title, icon, kind, text_content, tags FROM notes WHERE id = $1', n.id);
    const doc = docFrom(src.ydoc);
    const title = `${src.title || 'Untitled'} (copy)`;
    setTitle(doc, title);
    const copy = await one(`INSERT INTO notes (space_id, parent_id, position, kind, title, icon, text_content, tags, ydoc, search, created_by, updated_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, setweight(to_tsvector('simple', $5), 'A') || setweight(to_tsvector('simple', $7), 'B'), $10, $10, $11, $11) RETURNING *`,
    n.space_id, n.parent_id, await positionFor(n.space_id, n.parent_id, n.id), src.kind, title, src.icon, src.text_content, src.tags, encode(doc), req.user.id, now());
    publish(n.space_id, 'note:created', { note: noteOut(copy) });
    return noteOut(copy);
  });

  // Inserts a template or Markdown at the end of an existing page.
  app.post('/api/notes/:id/append', async (req) => {
    const n = await needNote(req.user.id, req.params.id, 'editor');
    const t = req.body?.template && TEMPLATES[req.body.template];
    const blocks = markdownToBlocks(t ? fillTemplate(t.md) : str(req.body?.markdown, 2e6));
    await withDoc(n.id, (doc) => appendBlocks(doc, blocks, 'rest'), req.user);
    return { ok: true };
  });

  // Markdown → editor JSON (the web editor inserts AI output and pasted Markdown with this).
  app.post('/api/markdown/blocks', async (req) => ({ blocks: markdownToBlocks(str(req.body?.markdown, 2e6)) }));

  // ---- favourites & recent
  app.get('/api/favorites', async (req) => (await many(`SELECT ${TREE_COLS} FROM favorites f JOIN notes n ON n.id = f.note_id
    JOIN space_members m ON m.space_id = n.space_id AND m.user_id = f.user_id WHERE f.user_id = $1 AND n.deleted_at IS NULL ORDER BY f.created_at`, req.user.id)).map(noteOut));
  app.put('/api/favorites/:id', async (req) => {
    await needNote(req.user.id, req.params.id);
    await q('INSERT INTO favorites (user_id, note_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', req.user.id, req.params.id, now());
    return { ok: true };
  });
  app.delete('/api/favorites/:id', async (req) => {
    await q('DELETE FROM favorites WHERE user_id = $1 AND note_id = $2', req.user.id, req.params.id);
    return { ok: true };
  });

  app.get('/api/recent', async (req) => {
    const spaces = req.query.space && isUuid(req.query.space) ? [req.query.space] : await userSpaceIds(req.user.id);
    return (await many(`SELECT ${TREE_COLS}, left(n.text_content, 160) AS snippet FROM notes n JOIN space_members m ON m.space_id = n.space_id AND m.user_id = $2
      WHERE n.space_id = ANY($1::uuid[]) AND n.deleted_at IS NULL ORDER BY n.updated_at DESC LIMIT $3`, spaces, req.user.id, Math.min(Number(req.query.limit) || 20, 100))).map(noteOut);
  });

  // ---- daily journal: one journal page per day in the user's journal space, created on first open.
  app.post('/api/journal', async (req) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.date || '') ? req.body.date : new Date().toISOString().slice(0, 10);
    const settings = await getSettings(req.user.id);
    let spaceId = isUuid(req.body?.spaceId) ? req.body.spaceId : settings.journalSpace;
    if (!spaceId || !(await one("SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2 AND role IN ('owner', 'editor')", spaceId, req.user.id))) {
      spaceId = (await one("SELECT space_id FROM space_members WHERE user_id = $1 AND role = 'owner' ORDER BY position LIMIT 1", req.user.id)).space_id;
    }
    const found = await one('SELECT * FROM notes WHERE space_id = $1 AND journal_date = $2 AND deleted_at IS NULL', spaceId, date);
    if (found) return noteOut(found);
    // Daily pages are collected under a "Journal" page so the tree stays tidy.
    let parent = await one("SELECT id FROM notes WHERE space_id = $1 AND parent_id IS NULL AND title = 'Journal' AND icon = '📓' AND deleted_at IS NULL LIMIT 1", spaceId);
    if (!parent) parent = await createNote(req.user.id, { spaceId, title: 'Journal', icon: '📓' });
    const label = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    try {
      return noteOut(await createNote(req.user.id, { spaceId, parentId: parent.id, afterId: null, kind: 'journal', title: label, icon: '✍️', journalDate: date, paper: settings.paper }));
    } catch (e) {
      // Two devices opened "Today" at once: the unique index let one win.
      const again = await one('SELECT * FROM notes WHERE space_id = $1 AND journal_date = $2 AND deleted_at IS NULL', spaceId, date);
      if (again) return noteOut(again);
      throw e;
    }
  });

  // ---- versions
  app.get('/api/notes/:id/versions', async (req) => {
    await needNote(req.user.id, req.params.id);
    return (await many(`SELECT v.id, v.title, v.created_at, u.name AS by FROM note_versions v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.note_id = $1 ORDER BY v.created_at DESC LIMIT 200`, req.params.id)).map((v) => ({ id: Number(v.id), title: v.title, createdAt: v.created_at, by: v.by }));
  });
  app.get('/api/notes/:id/versions/:vid', async (req) => {
    await needNote(req.user.id, req.params.id);
    const v = await one('SELECT ydoc, title, created_at FROM note_versions WHERE id = $1 AND note_id = $2', Number(req.params.vid) || 0, req.params.id);
    if (!v) fail(404, 'Version not found');
    const doc = docFrom(v.ydoc);
    return { title: v.title, createdAt: v.created_at, markdown: extract(doc).markdown, html: pageHtml(doc, { title: v.title }) };
  });
  app.post('/api/notes/:id/versions/:vid/restore', async (req) => {
    const n = await needNote(req.user.id, req.params.id, 'editor');
    const v = await one('SELECT ydoc FROM note_versions WHERE id = $1 AND note_id = $2', Number(req.params.vid) || 0, n.id);
    if (!v) fail(404, 'Version not found');
    const old = docFrom(v.ydoc);
    // Restoring is an ordinary edit (so co-editors receive it and it can itself be undone by another restore).
    await withDoc(n.id, (doc) => {
      const frag = doc.getXmlFragment('default');
      frag.delete(0, frag.length);
      frag.insert(0, old.getXmlFragment('default').toArray().map((x) => x.clone()));
      setTitle(doc, old.getText('title').toString());
      const ink = doc.getMap('ink');
      for (const k of [...ink.keys()]) ink.delete(k);
      for (const [k, arr] of old.getMap('ink').entries()) { const a = new Y.Array(); a.push(arr.toArray()); ink.set(k, a); }
    }, req.user);
    return { ok: true };
  });

  // ---- export / import
  app.get('/api/notes/:id/export', async (req, reply) => {
    const n = await needNote(req.user.id, req.params.id);
    const { title, markdown, doc } = await markdownOf(n.id);
    const file = (title || 'Untitled').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
    if (req.query.format === 'html') {
      reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file)}.html`).type('text/html; charset=utf-8');
      return pageHtml(doc, { title });
    }
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file)}.md`).type('text/markdown; charset=utf-8');
    return `# ${title || 'Untitled'}\n\n${markdown}\n`;
  });

  app.post('/api/notes/import', async (req) => {
    const b = req.body || {};
    await needSpace(req.user.id, b.spaceId, 'editor');
    let md = str(b.markdown, 5e6);
    let title = str(b.title, 300);
    const h = /^#\s+(.+)\n+/.exec(md);
    if (h && !title) { title = h[1].trim(); md = md.slice(h[0].length); }
    return noteOut(await createNote(req.user.id, { spaceId: b.spaceId, parentId: isUuid(b.parentId) ? b.parentId : null, title: title || 'Imported', markdown: md }));
  });

  // ---- public read-only link
  app.post('/api/notes/:id/publish', async (req) => {
    const n = await needNote(req.user.id, req.params.id, 'editor');
    if (req.body?.enabled === false) { await q('UPDATE notes SET public_slug = NULL WHERE id = $1', n.id); return { slug: null }; }
    const slug = n.public_slug || randomToken(12);
    await q('UPDATE notes SET public_slug = $2 WHERE id = $1', n.id, slug);
    return { slug };
  });

  app.get('/api/public/:slug', async (req, reply) => {
    const n = await one('SELECT id, title, ydoc FROM notes WHERE public_slug = $1 AND deleted_at IS NULL', str(req.params.slug, 40));
    if (!n) fail(404, 'This page is not shared (any more)');
    reply.type('text/html; charset=utf-8').header('x-robots-tag', 'noindex');
    reply.header('content-security-policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    return pageHtml(docFrom(n.ydoc), { title: n.title, asset: (u) => u.replace(/^\/api\/assets\//, `/api/public/${req.params.slug}/assets/`) });
  });
}
