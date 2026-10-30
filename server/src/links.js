// Links from a page to Halcyon items (email, event, task, contact), other pages and URLs — plus the reverse lookup
// Halcyon (or any client with an API token) uses to show "notes about this event / e-mail".
import { one, many, q, now } from './db/index.js';
import { fail, str, isUuid } from './util/http.js';
import { needNote, needSpace, userSpaceIds } from './spaces.js';
import { publish } from './events.js';
import { connection, openUrl, eventsOn, call } from './integrations/halcyon.js';
import { createNote, noteOut } from './notes.js';
import { TEMPLATES } from './templates.js';
import { config } from './config.js';

const KINDS = ['note', 'email', 'event', 'task', 'contact', 'url'];
// "2026-11-03 09:00" in the server's time zone (the pod runs in the host's zone, see deploy/podman-pod.sh).
const localStamp = (d) => new Date(d).toLocaleString('sv-SE', { hour12: false }).slice(0, 16);
const linkOut = (l, conn) => ({ id: l.id, kind: l.kind, ref: l.ref, title: l.title, meta: l.meta_json, createdAt: l.created_at, openUrl: l.kind === 'url' ? l.ref : openUrl(conn, l) });

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

export default async function linkRoutes(app) {
  app.get('/api/notes/:id/links', async (req) => {
    await needNote(req.user.id, req.params.id);
    const conn = await connection(req.user.id);
    return (await many("SELECT * FROM note_links WHERE note_id = $1 AND kind <> 'mention' ORDER BY created_at", req.params.id)).map((l) => linkOut(l, conn));
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
    return linkOut(l, await connection(req.user.id));
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
    return (await many(`SELECT l.ref, n.id, n.title, n.icon, n.kind, n.updated_at, left(n.text_content, 200) AS snippet FROM note_links l JOIN notes n ON n.id = l.note_id
      WHERE l.kind = $1 AND l.ref = ANY($2::text[]) AND n.deleted_at IS NULL AND n.space_id = ANY($3::uuid[]) ORDER BY n.updated_at DESC`, kind, refs, await userSpaceIds(req.user.id)))
      .map((r) => ({ ref: r.ref, id: r.id, title: r.title, icon: r.icon, kind: r.kind, updatedAt: r.updated_at, snippet: r.snippet, url: `${base}/#/n/${r.id}` }));
  });

  // "New meeting note": a page from a Halcyon event, linked to it, with attendees filled in.
  app.post('/api/notes/meeting', async (req) => {
    const b = req.body || {};
    await needSpace(req.user.id, b.spaceId, 'editor');
    let ev = b.event;
    if (!ev && b.eventId) ev = (await eventsOn(req.user.id, b.date)).find((e) => e.ref === String(b.eventId));
    if (!ev) fail(404, 'Event not found');
    const existing = await one(`SELECT n.* FROM note_links l JOIN notes n ON n.id = l.note_id WHERE l.kind = 'event' AND l.ref = $1 AND n.space_id = $2 AND n.deleted_at IS NULL LIMIT 1`, String(ev.ref), b.spaceId);
    if (existing && !b.force) return { ...noteOut(existing), existing: true };
    const start = ev.meta?.start ? new Date(ev.meta.start) : new Date();
    const md = TEMPLATES.meeting.md.replace('{{date}}', localStamp(start))
      .replace('**Attendees:** ', `${ev.meta?.location ? `**Where:** ${ev.meta.location}  \n` : ''}**Attendees:** ${(ev.meta?.attendees || []).join(', ')}`);
    const n = await createNote(req.user.id, { spaceId: b.spaceId, parentId: isUuid(b.parentId) ? b.parentId : null, title: ev.title, icon: '🗓️', markdown: md });
    await addLink(req.user.id, n.id, { kind: 'event', ref: ev.ref, title: ev.title, meta: ev.meta });
    return noteOut(n);
  });

  // A note for any Halcyon item (deep link `#/new?kind=…&ref=…` from Halcyon, or "Take notes" in Inkwell): the
  // existing linked note when there is one in the user's spaces, otherwise a new one linked to the item.
  app.post('/api/notes/from-item', async (req) => {
    const b = req.body || {};
    const kind = ['event', 'email', 'task'].includes(b.kind) ? b.kind : fail(400, 'kind must be event, email or task');
    const ref = str(b.ref, 200) || fail(400, 'Missing ref');
    const spaces = await userSpaceIds(req.user.id);
    const existing = await one(`SELECT n.* FROM note_links l JOIN notes n ON n.id = l.note_id
      WHERE l.kind = $1 AND l.ref = $2 AND n.space_id = ANY($3::uuid[]) AND n.deleted_at IS NULL ORDER BY n.updated_at DESC LIMIT 1`, kind, ref, spaces);
    if (existing) return { ...noteOut(existing), existing: true };
    let spaceId = isUuid(b.spaceId) && spaces.includes(b.spaceId) ? b.spaceId : null;
    if (spaceId && !(await one("SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2 AND role IN ('owner', 'editor')", spaceId, req.user.id))) spaceId = null;
    spaceId ||= (await one("SELECT space_id FROM space_members WHERE user_id = $1 AND role IN ('owner', 'editor') ORDER BY position LIMIT 1", req.user.id))?.space_id || fail(403, 'No space you can write in');
    const meta = { ...(b.meta && typeof b.meta === 'object' ? b.meta : {}) };
    let title = str(b.title, 300);
    // Fill in what the link did not carry when Halcyon is connected here.
    const conn = await connection(req.user.id);
    if (conn && kind === 'email' && (!title || !meta.from)) {
      try {
        const m = await call(conn, 'get_message', { id: Number(ref) });
        title ||= m.subject || '';
        Object.assign(meta, { from: meta.from || m.from, date: meta.date || m.date, summary: m.summary || '' });
      } catch { /* note without details */ }
    }
    const day = (d) => (d ? localStamp(d) : localStamp(Date.now()).slice(0, 10));
    const attendees = Array.isArray(meta.attendees) ? meta.attendees : String(meta.attendees || '').split(',').map((s) => s.trim()).filter(Boolean);
    let md, icon;
    if (kind === 'event') {
      icon = '🗓️';
      md = TEMPLATES.meeting.md.replace('{{date}}', day(meta.start))
        .replace('**Attendees:** ', `${meta.location ? `**Where:** ${meta.location}  \n` : ''}**Attendees:** ${attendees.join(', ')}`);
      meta.attendees = attendees;
    } else if (kind === 'email') {
      icon = '✉️';
      md = `${meta.from ? `**From:** ${meta.from}  \n` : ''}**Date:** ${day(meta.date)}\n\n${meta.summary ? `> ${meta.summary}\n\n` : ''}## Notes\n\n\n## Follow-ups\n- [ ] `;
    } else {
      icon = '☑️';
      md = `${meta.due ? `**Due:** ${day(meta.due).slice(0, 10)}\n\n` : ''}## Notes\n\n\n## Steps\n- [ ] `;
    }
    const n = await createNote(req.user.id, { spaceId, title: title || (kind === 'email' ? 'E-mail notes' : kind === 'task' ? 'Task notes' : 'Meeting notes'), icon, markdown: md });
    await addLink(req.user.id, n.id, { kind, ref, title: title || '', meta });
    return noteOut(n);
  });

  // Action items (from the AI summary or chosen in the page) → Halcyon tasks, linked back to the page.
  app.post('/api/notes/:id/tasks', async (req) => {
    const n = await needNote(req.user.id, req.params.id, 'editor');
    const conn = await connection(req.user.id);
    if (!conn) fail(409, 'Connect Halcyon first (Settings → Integrations)');
    const items = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, 30);
    const out = [];
    for (const it of items) {
      const title = str(it.text || it.title, 300);
      if (!title) continue;
      const t = await call(conn, 'create_task', { title, ...(it.due ? { due: str(it.due, 40) } : {}), notes: `From the Inkwell page "${n.title || 'Untitled'}"` });
      const ref = String(t?.id ?? t?.task?.id ?? title);
      await addLink(req.user.id, n.id, { kind: 'task', ref, title, meta: { due: it.due || null } });
      out.push({ title, ref });
    }
    publish(n.space_id, 'note:links', { noteId: n.id });
    return { created: out };
  });
}
