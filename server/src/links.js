// Links from a page to Halcyon items (email, event, task, contact), other pages and URLs — plus the reverse lookup
// Halcyon (or any client with an API token) uses to show "notes about this event / e-mail".
import { one, many, q, now } from './db/index.js';
import { fail, str, isUuid } from './util/http.js';
import { needNote, needSpace, userSpaceIds } from './spaces.js';
import { publish } from './events.js';
import { connections, scopesFor, spaceForConnection, tryEach, openUrl, eventsOn, call, byConn } from './integrations/halcyon.js';
import { createNote, noteOut } from './notes.js';
import { docFrom, extract, markdownToBlocks } from './docmodel.js';
import { TEMPLATES } from './templates.js';
import { config } from './config.js';

const KINDS = ['note', 'email', 'event', 'task', 'contact', 'url'];
// "2026-11-03 09:00" in the server's time zone (the pod runs in the host's zone, see deploy/podman-pod.sh).
const localStamp = (d) => new Date(d).toLocaleString('sv-SE', { hour12: false }).slice(0, 16);
const connOf = (l, conns) => byConn(conns, l.meta_json?.conn) || conns[0];
const linkOut = (l, conns) => ({ id: l.id, kind: l.kind, ref: l.ref, title: l.title, meta: l.meta_json, createdAt: l.created_at, openUrl: l.kind === 'url' ? l.ref : openUrl(connOf(l, conns), l) });

export async function addLink(userId, noteId, { kind, ref, title, meta }) {
  if (!KINDS.includes(kind)) fail(400, 'Unknown link kind');
  ref = str(ref, 500);
  if (!ref) fail(400, 'Missing ref');
  if (kind === 'url' && !/^https?:\/\//i.test(ref)) fail(400, 'Only http(s) links');
  if (kind === 'note') await needNote(userId, ref);
  const l = await one(`INSERT INTO note_links (note_id, kind, ref, title, meta_json, created_by, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
    ON CONFLICT (note_id, kind, ref) DO UPDATE SET title = EXCLUDED.title, meta_json = EXCLUDED.meta_json RETURNING *`,
  noteId, kind, ref, str(title, 300), JSON.stringify(meta && typeof meta === 'object' ? meta : {}), userId, now());
  return l;
}

const dateOf = (d) => (d ? localStamp(d).slice(0, 10) : null);
// The day of a linked event: as the client saw it (`day`, its own time zone), else from the start in the server's zone.
const dayOf = (meta) => (/^\d{4}-\d{2}-\d{2}$/.test(meta?.day || '') ? meta.day : dateOf(meta?.start));

/** The user's writable space for a Halcyon space label (explicit association, else the same name), or null. */
async function spaceForLabel(userId, label) {
  if (!label) return null;
  const rows = await many(`SELECT s.id, s.name, s.settings_json FROM spaces s JOIN space_members m ON m.space_id = s.id AND m.user_id = $1
    WHERE m.role IN ('owner', 'editor') ORDER BY m.position`, userId);
  const l = String(label).toLowerCase();
  return (rows.find((s) => s.settings_json?.halcyonShared && s.name.toLowerCase() === l) // the mirror of a shared space
    || rows.find((s) => String(s.settings_json?.halcyonSpace ?? '').toLowerCase() === l)
    || rows.find((s) => s.settings_json?.halcyonSpace == null && s.name.toLowerCase() === l))?.id || null;
}

/**
 * The note for a Halcyon item: the existing one when there is one (for events, per occurrence: same event and day),
 * otherwise a new note linked to the item. Meeting notes carry the date in the title and pick up the open to-dos of
 * the previous note of the same meeting.
 */
export async function noteFromItem(userId, b) {
  const kind = ['event', 'email', 'task'].includes(b.kind) ? b.kind : fail(400, 'kind must be event, email or task');
  const ref = str(b.ref, 200) || fail(400, 'Missing ref');
  const meta = { ...(b.meta && typeof b.meta === 'object' ? b.meta : {}) };
  const spaces = await userSpaceIds(userId);
  const linked = await many(`SELECT n.*, l.meta_json AS link_meta FROM note_links l JOIN notes n ON n.id = l.note_id
    WHERE l.kind = $1 AND l.ref = $2 AND n.space_id = ANY($3::uuid[]) AND n.deleted_at IS NULL ORDER BY n.created_at DESC`, kind, ref, spaces);
  const same = kind === 'event' && dayOf(meta) ? linked.find((n) => dayOf(n.link_meta) === dayOf(meta)) : linked[0];
  if (same) return { ...noteOut(same), existing: true };

  const writable = async (id) => isUuid(id) && spaces.includes(id) && !!(await one("SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2 AND role IN ('owner', 'editor')", id, userId));
  // The item's mailbox and Halcyon space decide first; then earlier notes of this meeting; then the space the user is in;
  // then their first writable one.
  const conns = await connections(userId);
  const spaceId = (await spaceForConnection(userId, byConn(conns, meta.conn))) || (await spaceForLabel(userId, meta.hspace)) || ((await writable(linked[0]?.space_id)) ? linked[0].space_id : null)
    || ((await writable(b.spaceId)) ? b.spaceId : null)
    || (await one("SELECT space_id FROM space_members WHERE user_id = $1 AND role IN ('owner', 'editor') ORDER BY position LIMIT 1", userId))?.space_id
    || fail(403, 'No space you can write in');

  let title = str(b.title, 300);
  // A deep link from Halcyon does not say which mailbox the mail is in.
  if (conns.length && kind === 'email' && (!title || !meta.from || !meta.conn)) {
    try {
      const { conn, out: m } = await tryEach(conns, meta.conn, (c) => call(c, 'get_message', { id: Number(ref) }));
      title ||= m.subject || '';
      Object.assign(meta, { conn: conn.key, from: meta.from || m.from, date: meta.date || m.date, summary: meta.summary || m.summary || '' });
    } catch { /* note without details */ }
  }
  const stamp = (d) => (d ? localStamp(d) : localStamp(Date.now()).slice(0, 10));
  const attendees = Array.isArray(meta.attendees) ? meta.attendees : String(meta.attendees || '').split(',').map((s) => s.trim()).filter(Boolean);
  const extra = [];
  let md, icon, noteTitle = title;
  if (kind === 'event') {
    icon = '🗓️';
    meta.attendees = attendees;
    noteTitle = `${title || 'Meeting'} ${dayOf(meta) || dateOf(Date.now())}`;
    md = TEMPLATES.meeting.md.replace('{{date}}', stamp(meta.start))
      .replace('**Attendees:** ', `${meta.location ? `**Where:** ${meta.location}  \n` : ''}**Attendees:** ${attendees.join(', ')}`);
    const prev = title ? await one(`SELECT n.id, n.title, n.ydoc FROM note_links l JOIN notes n ON n.id = l.note_id
      WHERE l.kind = 'event' AND (l.ref = $1 OR lower(l.title) = lower($2)) AND n.space_id = ANY($3::uuid[]) AND n.deleted_at IS NULL ORDER BY n.created_at DESC LIMIT 1`, ref, title, spaces) : null;
    if (prev) {
      const open = [...extract(docFrom(prev.ydoc)).markdown.matchAll(/^\s*- \[ \] (.*\S.*)$/gm)].map((m) => m[1].trim()).slice(0, 30);
      extra.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'From last time' }] },
        { type: 'paragraph', content: [{ type: 'pageMention', attrs: { id: prev.id, title: prev.title } }] });
      if (open.length) extra.push(...markdownToBlocks(open.map((t) => `- [ ] ${t}`).join('\n')));
      meta.previous = prev.id;
    }
  } else if (kind === 'email') {
    icon = '✉️';
    md = `${meta.from ? `**From:** ${meta.from}  \n` : ''}**Date:** ${stamp(meta.date)}\n\n${meta.summary ? `> ${meta.summary}\n\n` : ''}## Notes\n\n\n## Follow-ups\n- [ ] `;
  } else {
    icon = '☑️';
    md = `${meta.due ? `**Due:** ${stamp(meta.due).slice(0, 10)}\n\n` : ''}## Notes\n\n\n## Steps\n- [ ] `;
  }
  const n = await createNote(userId, { spaceId, parentId: isUuid(b.parentId) ? b.parentId : null, title: noteTitle || (kind === 'email' ? 'E-mail notes' : 'Task notes'), icon, blocks: [...markdownToBlocks(md), ...extra] });
  await addLink(userId, n.id, { kind, ref, title, meta });
  if (meta.previous) await addLink(userId, n.id, { kind: 'note', ref: meta.previous, title: 'Previous meeting' });
  return noteOut(n);
}

export default async function linkRoutes(app) {
  app.get('/api/notes/:id/links', async (req) => {
    await needNote(req.user.id, req.params.id);
    const conns = await connections(req.user.id);
    return (await many("SELECT * FROM note_links WHERE note_id = $1 AND kind <> 'mention' ORDER BY created_at", req.params.id)).map((l) => linkOut(l, conns));
  });

  app.post('/api/notes/:id/links', async (req) => {
    const n = await needNote(req.user.id, req.params.id, 'editor');
    const l = await addLink(req.user.id, n.id, req.body || {});
    publish(n.space_id, 'note:links', { noteId: n.id });
    // A cross-link: the other page links back (when the user may edit it).
    if (req.body?.kind === 'note' && req.body?.both) {
      const other = await needNote(req.user.id, l.ref).catch(() => null);
      if (other && ['owner', 'editor'].includes(other.role)) {
        await addLink(req.user.id, other.id, { kind: 'note', ref: n.id, title: n.title });
        publish(other.space_id, 'note:links', { noteId: other.id });
      }
    }
    return linkOut(l, await connections(req.user.id));
  });

  // Everything a page is connected to: pages it links/mentions, pages that link here, related pages (AI) and pages
  // that name this one in their text without linking it yet.
  app.get('/api/notes/:id/connections', async (req) => {
    const n = await needNote(req.user.id, req.params.id);
    const spaces = await userSpaceIds(req.user.id);
    const card = 'n.id, n.title, n.icon, n.kind, n.space_id AS "spaceId", n.updated_at AS "updatedAt"';
    const [out, back] = await Promise.all([
      many(`SELECT DISTINCT ON (n.id) ${card}, l.kind AS via FROM note_links l JOIN notes n ON n.id::text = l.ref
        WHERE l.note_id = $1 AND l.kind IN ('note', 'mention') AND n.deleted_at IS NULL AND n.space_id = ANY($2::uuid[]) ORDER BY n.id, l.kind DESC`, n.id, spaces),
      many(`SELECT DISTINCT ON (n.id) ${card}, l.kind AS via FROM note_links l JOIN notes n ON n.id = l.note_id
        WHERE l.ref = $1 AND l.kind IN ('note', 'mention') AND n.deleted_at IS NULL AND n.space_id = ANY($2::uuid[]) ORDER BY n.id, l.kind DESC`, n.id, spaces),
    ]);
    const linked = new Set([n.id, ...out.map((x) => x.id), ...back.map((x) => x.id)]);
    const { related } = await import('./search.js');
    const rel = (await related(req.user.id, n.id, 8)).filter((r) => !linked.has(r.id));
    const title = (n.title || '').trim();
    const unlinked = title.length >= 4 ? (await many(`SELECT ${card}, left(n.text_content, 4000) AS text FROM notes n
      WHERE n.id <> $1 AND n.deleted_at IS NULL AND n.space_id = ANY($2::uuid[]) AND n.search @@ phraseto_tsquery('simple', $3)
      ORDER BY n.updated_at DESC LIMIT 20`, n.id, spaces, title))
      .filter((x) => !linked.has(x.id) && x.text.toLowerCase().includes(title.toLowerCase())).slice(0, 8).map(({ text, ...x }) => x) : [];
    return { outgoing: out, backlinks: back, related: rel, unlinked };
  });

  // The text of a linked e-mail and its conversation, read from Halcyon when asked; Inkwell keeps none of it.
  app.get('/api/notes/:id/links/:linkId/mail', async (req) => {
    const n = await needNote(req.user.id, req.params.id);
    const l = isUuid(req.params.linkId) ? await one("SELECT ref, meta_json FROM note_links WHERE id = $1 AND note_id = $2 AND kind = 'email'", req.params.linkId, n.id) : null;
    if (!l) fail(404, 'Not found');
    const conns = await connections(req.user.id);
    if (!conns.length) fail(409, 'Connect Halcyon first (Settings → Integrations)');
    const id = Number(l.ref);
    // A token reads one Halcyon mailbox: mail of a shared space needs that space's token.
    const { conn, out: c } = await tryEach(conns, l.meta_json?.conn, (x) => call(x, 'get_conversation', { message_id: id })).catch((e) => {
      if (/No message/.test(e.message)) fail(404, 'No Halcyon connection here can read this e-mail. If it is in a shared space, add that space\'s token under Settings → Integrations');
      throw e;
    });
    const list = c?.messages?.length ? c.messages : [await call(conn, 'get_message', { id })];
    return { summary: c?.summary || null, messages: list.map((m) => ({ id: m.id, from: m.from, to: m.to, date: m.date, subject: m.subject, attachments: m.attachments || [], text: m.text_untrusted || '' })) };
  });

  app.delete('/api/notes/:id/links/:linkId', async (req) => {
    const n = await needNote(req.user.id, req.params.id, 'editor');
    await q('DELETE FROM note_links WHERE id = $1 AND note_id = $2', isUuid(req.params.linkId) ? req.params.linkId : null, n.id);
    publish(n.space_id, 'note:links', { noteId: n.id });
    return { ok: true };
  });

  // Reverse lookup: pages (the caller can see) linked to an e-mail / event / task.
  app.get('/api/links/lookup', async (req) => {
    const kind = KINDS.includes(req.query.kind) ? req.query.kind : fail(400, 'Unknown kind');
    const refs = String(req.query.ref || '').split(',').map((r) => r.trim()).filter(Boolean).slice(0, 100);
    if (!refs.length) return [];
    const base = config.publicUrl;
    return (await many(`SELECT l.ref, l.meta_json, n.id, n.title, n.icon, n.kind, n.updated_at, left(n.text_content, 200) AS snippet FROM note_links l JOIN notes n ON n.id = l.note_id
      WHERE l.kind = $1 AND l.ref = ANY($2::text[]) AND n.deleted_at IS NULL AND n.space_id = ANY($3::uuid[]) ORDER BY n.updated_at DESC`, kind, refs, await userSpaceIds(req.user.id)))
      .map((r) => ({ ref: r.ref, id: r.id, title: r.title, icon: r.icon, kind: r.kind, updatedAt: r.updated_at, snippet: r.snippet, url: `${base}/#/n/${r.id}`, date: dayOf(r.meta_json) }));
  });

  // "New meeting note" from a Halcyon event object (older clients; the app uses from-item).
  app.post('/api/notes/meeting', async (req) => {
    const b = req.body || {};
    await needSpace(req.user.id, b.spaceId, 'editor');
    let ev = b.event;
    if (!ev && b.eventId) ev = (await eventsOn(req.user.id, b.date)).find((e) => e.ref === String(b.eventId));
    if (!ev) fail(404, 'Event not found');
    return noteFromItem(req.user.id, { kind: 'event', ref: ev.ref, title: ev.title, meta: ev.meta, spaceId: b.spaceId, parentId: b.parentId });
  });

  // A note for any Halcyon item (deep link `#/new?kind=…&ref=…` from Halcyon, or "Note" on Home).
  app.post('/api/notes/from-item', async (req) => noteFromItem(req.user.id, req.body || {}));

  // Smart categories: notes grouped by what they are about, whatever their place in the tree. Meetings that recur
  // (same event name) and senders with several notes get their own sub-category.
  app.get('/api/smart', async (req) => {
    let spaces = await userSpaceIds(req.user.id);
    if (isUuid(req.query.space)) spaces = spaces.filter((s) => s === req.query.space);
    const rows = await many(`SELECT n.id, n.title, n.icon, n.kind, n.space_id, n.updated_at, n.created_at, l.kind AS lk, l.title AS lt, l.meta_json
      FROM notes n LEFT JOIN note_links l ON l.note_id = n.id AND l.kind IN ('event', 'email', 'task')
      WHERE n.space_id = ANY($1::uuid[]) AND n.deleted_at IS NULL AND (l.id IS NOT NULL OR n.kind = 'journal')
      ORDER BY n.created_at DESC LIMIT 3000`, spaces);
    const card = (r) => ({ id: r.id, title: r.title, icon: r.icon, kind: r.kind, spaceId: r.space_id, updatedAt: r.updated_at, createdAt: r.created_at });
    const group = (id, label, list, keyOf, min) => {
      const by = new Map();
      for (const r of list) { const k = keyOf?.(r); if (k) { if (!by.has(k.toLowerCase())) by.set(k.toLowerCase(), { label: k, rows: [] }); by.get(k.toLowerCase()).rows.push(r); } }
      const subs = [...by.values()].filter((s) => s.rows.length >= min);
      const inSub = new Set(subs.flatMap((s) => s.rows.map((r) => r.id)));
      return { id, label, count: new Set(list.map((r) => r.id)).size,
        subs: subs.sort((a, b) => b.rows.length - a.rows.length).map((s) => ({ id: s.label.toLowerCase(), label: s.label, count: s.rows.length, notes: s.rows.map(card) })),
        notes: list.filter((r) => !inSub.has(r.id)).map(card) };
    };
    const of = (k) => rows.filter((r) => r.lk === k);
    const person = (r) => String(r.meta_json?.from || '').replace(/<.*>/, '').trim();
    const seen = new Set();
    return [
      group('meetings', 'Meetings', of('event'), (r) => r.lt, 2),
      group('tasks', 'Tasks', of('task')),
      group('emails', 'E-mails', of('email'), person, 2),
      group('journals', 'Handwritten', rows.filter((r) => r.kind === 'journal' && !seen.has(r.id) && seen.add(r.id))),
    ].filter((g) => g.count);
  });

  // Action items (from the AI summary or chosen in the page) → Halcyon tasks, linked back to the page.
  app.post('/api/notes/:id/tasks', async (req) => {
    const n = await needNote(req.user.id, req.params.id, 'editor');
    const [{ conn }] = await scopesFor(req.user.id, n.space_id); // the mailbox of this page's space
    const items = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, 30);
    const out = [];
    for (const it of items) {
      const title = str(it.text || it.title, 300);
      if (!title) continue;
      const t = await call(conn, 'create_task', { title, ...(it.due ? { due: str(it.due, 40) } : {}), notes: `From the Inkwell page "${n.title || 'Untitled'}"` });
      const ref = String(t?.id ?? t?.task?.id ?? title);
      await addLink(req.user.id, n.id, { kind: 'task', ref, title, meta: { due: it.due || null, conn: conn.key } });
      out.push({ title, ref });
    }
    publish(n.space_id, 'note:links', { noteId: n.id });
    return { created: out };
  });
}
