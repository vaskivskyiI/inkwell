// Comments on a page (commenters and up), optionally on a quoted passage, with @mentions and replies; mentions and
// replies become notifications.
import { one, many, q, now } from './db/index.js';
import { fail, str, isUuid } from './util/http.js';
import { needNote, RANK } from './spaces.js';
import { publish, notifyUser } from './events.js';

const out = (c) => ({ id: c.id, noteId: c.note_id, parentId: c.parent_id, userId: c.user_id, author: c.author, color: c.color, quote: c.quote, body: c.body, resolved: c.resolved, createdAt: c.created_at });

async function notify(userId, noteId, actorId, text) {
  if (userId === actorId) return;
  await q('INSERT INTO notifications (user_id, kind, note_id, actor_id, text, created_at) VALUES ($1, $2, $3, $4, $5, $6)', userId, 'comment', noteId, actorId, text, now());
  notifyUser(userId, 'notification:new', { noteId });
}

/** Members named as @first or @first.last or @e-mail in the text. */
export function mentioned(body, members) {
  const tokens = [...String(body).matchAll(/(?:^|\s)@([\p{L}\p{N}._@-]+)/gu)].map((m) => m[1].toLowerCase().replace(/[.,]+$/, ''));
  return members.filter((m) => tokens.some((t) => t === m.email.toLowerCase() || t === m.name.toLowerCase().replace(/\s+/g, '.') || t === m.name.toLowerCase().split(/\s+/)[0]));
}

export default async function commentRoutes(app) {
  app.get('/api/notes/:id/comments', async (req) => {
    await needNote(req.user.id, req.params.id);
    return (await many(`SELECT c.*, u.name AS author, u.color FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.note_id = $1 ORDER BY c.created_at`, req.params.id)).map(out);
  });

  app.post('/api/notes/:id/comments', async (req) => {
    const n = await needNote(req.user.id, req.params.id, 'commenter');
    const b = req.body || {};
    const body = str(b.body, 8000) || fail(400, 'Write something first');
    const parentId = isUuid(b.parentId) ? b.parentId : null;
    const parent = parentId ? await one('SELECT user_id FROM comments WHERE id = $1 AND note_id = $2', parentId, n.id) : null;
    if (parentId && !parent) fail(404, 'Comment not found');
    const c = await one('INSERT INTO comments (note_id, parent_id, user_id, quote, body, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', n.id, parentId, req.user.id, str(b.quote, 500), body, now());
    const members = await many('SELECT u.id, u.name, u.email FROM space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = $1', n.space_id);
    const who = new Set(mentioned(body, members).map((m) => m.id));
    for (const id of who) await notify(id, n.id, req.user.id, `${req.user.name} mentioned you in “${n.title || 'Untitled'}”: ${body.slice(0, 120)}`);
    if (parent?.user_id && !who.has(parent.user_id)) await notify(parent.user_id, n.id, req.user.id, `${req.user.name} replied in “${n.title || 'Untitled'}”: ${body.slice(0, 120)}`);
    publish(n.space_id, 'note:comments', { noteId: n.id });
    return out({ ...c, author: req.user.name, color: req.user.color });
  });

  const own = async (req) => {
    const c = await one('SELECT * FROM comments WHERE id = $1', isUuid(req.params.id) ? req.params.id : null) || fail(404, 'Comment not found');
    const n = await needNote(req.user.id, c.note_id, 'commenter');
    return { c, n, mine: c.user_id === req.user.id, editor: RANK[n.role] >= RANK.editor };
  };

  app.patch('/api/comments/:id', async (req) => {
    const { c, n, mine, editor } = await own(req);
    const b = req.body || {};
    if (b.resolved !== undefined) await q('UPDATE comments SET resolved = $2 WHERE id = $1', c.id, !!b.resolved);
    if (b.body !== undefined) { if (!mine) fail(403, 'Only the author can edit a comment'); await q('UPDATE comments SET body = $2 WHERE id = $1', c.id, str(b.body, 8000)); }
    if (b.resolved !== undefined && !mine && !editor) fail(403, 'Only the author or an editor can resolve this');
    publish(n.space_id, 'note:comments', { noteId: n.id });
    return { ok: true };
  });

  app.delete('/api/comments/:id', async (req) => {
    const { c, n, mine, editor } = await own(req);
    if (!mine && !editor) fail(403, 'Only the author or an editor can delete this');
    await q('DELETE FROM comments WHERE id = $1', c.id);
    publish(n.space_id, 'note:comments', { noteId: n.id });
    return { ok: true };
  });

  app.get('/api/notifications', async (req) => (await many(`SELECT x.id, x.note_id, x.text, x.read, x.created_at, n.title FROM notifications x JOIN notes n ON n.id = x.note_id
    WHERE x.user_id = $1 ORDER BY x.created_at DESC LIMIT 50`, req.user.id)).map((x) => ({ id: x.id, noteId: x.note_id, text: x.text, read: x.read, createdAt: x.created_at })));

  app.post('/api/notifications/read', async (req) => {
    await q('UPDATE notifications SET read = true WHERE user_id = $1 AND NOT read', req.user.id);
    return { ok: true };
  });
}
