// Spaces (Private, Work, shared team spaces…) and who may do what in them.
import { one, many, q, tx, now } from './db/index.js';
import { fail, str, uuidOr404 } from './util/http.js';
import { publish, refreshMembership } from './events.js';

export const RANK = { viewer: 1, commenter: 2, editor: 3, owner: 4 };
const ROLES = Object.keys(RANK);

export async function roleOf(userId, spaceId) {
  const r = await one('SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2', spaceId, userId);
  return r?.role || null;
}

/** The user's role in the space, at least `min`; 404 when not a member (so space ids don't leak). */
export async function needSpace(userId, spaceId, min = 'viewer') {
  uuidOr404(spaceId, 'Space not found');
  const role = await roleOf(userId, spaceId);
  if (!role) fail(404, 'Space not found');
  if (RANK[role] < RANK[min]) fail(403, `This needs ${min} access to the space`);
  return role;
}

/** The note (with its space role) if the user may access it at `min` level. */
export async function needNote(userId, noteId, min = 'viewer', { trashed = false } = {}) {
  uuidOr404(noteId, 'Page not found');
  const n = await one(`SELECT n.id, n.space_id, n.parent_id, n.kind, n.title, n.icon, n.deleted_at, n.public_slug, n.created_by, n.journal_date, m.role
    FROM notes n JOIN space_members m ON m.space_id = n.space_id AND m.user_id = $2 WHERE n.id = $1`, noteId, userId);
  if (!n || (n.deleted_at && !trashed)) fail(404, 'Page not found');
  if (RANK[n.role] < RANK[min]) fail(403, `This needs ${min} access`);
  return n;
}

export async function userSpaceIds(userId) {
  return (await many('SELECT space_id FROM space_members WHERE user_id = $1', userId)).map((r) => r.space_id);
}

export async function createSpace(userId, { name, icon = '', color = '#6366f1' }) {
  return tx(async () => {
    const pos = (await one('SELECT coalesce(max(position), -1) + 1 AS p FROM space_members WHERE user_id = $1', userId)).p;
    const s = await one('INSERT INTO spaces (name, icon, color, owner_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5) RETURNING *',
      str(name, 80) || 'Space', str(icon, 8), /^#[0-9a-f]{6}$/i.test(color) ? color : '#6366f1', userId, now());
    await q("INSERT INTO space_members (space_id, user_id, role, position, added_at) VALUES ($1, $2, 'owner', $3, $4)", s.id, userId, pos, now());
    return s;
  });
}

const spaceOut = (s) => ({
  id: s.id, name: s.name, icon: s.icon, color: s.color, role: s.role, ownerId: s.owner_id,
  members: s.members, settings: s.settings_json, createdAt: s.created_at,
});

export async function listSpaces(userId) {
  return (await many(`SELECT s.*, m.role, m.position, (SELECT count(*) FROM space_members x WHERE x.space_id = s.id)::int AS members
    FROM spaces s JOIN space_members m ON m.space_id = s.id AND m.user_id = $1 ORDER BY m.position, s.created_at`, userId)).map(spaceOut);
}

export default async function spaceRoutes(app) {
  app.get('/api/spaces', async (req) => listSpaces(req.user.id));

  app.post('/api/spaces', async (req) => {
    const s = await createSpace(req.user.id, req.body || {});
    await refreshMembership(req.user.id);
    return spaceOut({ ...s, role: 'owner', members: 1 });
  });

  app.patch('/api/spaces/:id', async (req) => {
    await needSpace(req.user.id, req.params.id, 'owner');
    const { name, icon, color, settings } = req.body || {};
    await q(`UPDATE spaces SET name = coalesce($2, name), icon = coalesce($3, icon), color = coalesce($4, color),
      settings_json = settings_json || $5::jsonb, updated_at = $6 WHERE id = $1`, req.params.id,
    name !== undefined ? str(name, 80) || null : null, icon !== undefined ? str(icon, 8) : null,
    color && /^#[0-9a-f]{6}$/i.test(color) ? color : null, JSON.stringify(settings && typeof settings === 'object' ? pickSpaceSettings(settings) : {}), now());
    publish(req.params.id, 'space:changed', { id: req.params.id });
    return { ok: true };
  });

  // Reorder the sidebar list (per user).
  app.post('/api/spaces/order', async (req) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    await tx(async () => { for (let i = 0; i < ids.length; i++) await q('UPDATE space_members SET position = $3 WHERE space_id = $1 AND user_id = $2', ids[i], req.user.id, i); });
    return { ok: true };
  });

  // `moveTo`: its pages (with their sub-pages, files and trash) go to that space first; without it they are deleted.
  app.delete('/api/spaces/:id', async (req) => {
    const id = req.params.id;
    await needSpace(req.user.id, id, 'owner');
    if ((await one("SELECT count(*)::int AS n FROM space_members WHERE user_id = $1 AND role = 'owner'", req.user.id)).n <= 1) fail(400, 'You need to keep at least one space of your own');
    const to = req.query.moveTo;
    if (to !== undefined) {
      if (to === id) fail(400, 'Choose another space for the pages');
      await needSpace(req.user.id, to, 'editor');
    }
    const members = await many('SELECT user_id FROM space_members WHERE space_id = $1', id);
    let moved = 0;
    await tx(async () => {
      if (to !== undefined) {
        // A space has one journal page per day: one that would clash becomes an ordinary dated page.
        await q(`UPDATE notes m SET journal_date = NULL WHERE m.space_id = $1 AND m.journal_date IS NOT NULL AND EXISTS (
          SELECT 1 FROM notes o WHERE o.space_id = $2 AND o.journal_date = m.journal_date AND o.deleted_at IS NULL)`, id, to);
        // Top-level pages come after the target's own, in their order.
        const base = (await one('SELECT coalesce(max(position), -1) + 1 AS p FROM notes WHERE space_id = $1 AND parent_id IS NULL', to)).p;
        const lowest = (await one('SELECT coalesce(min(position), 0) AS p FROM notes WHERE space_id = $1 AND parent_id IS NULL', id)).p;
        await q('UPDATE notes SET position = position - $2 + $3 WHERE space_id = $1 AND parent_id IS NULL', id, lowest, base);
        moved = (await q('UPDATE notes SET space_id = $2 WHERE space_id = $1', id, to)).count;
        await q('UPDATE assets SET space_id = $2 WHERE space_id = $1', id, to);
      }
      await q('DELETE FROM spaces WHERE id = $1', id);
    });
    if (to !== undefined) publish(to, 'tree:changed', {});
    for (const m of members) await refreshMembership(m.user_id);
    return { ok: true, moved };
  });

  // ---- members
  app.get('/api/spaces/:id/members', async (req) => {
    await needSpace(req.user.id, req.params.id);
    return (await many(`SELECT u.id, u.name, u.email, u.color, m.role, m.added_at FROM space_members m JOIN users u ON u.id = m.user_id
      WHERE m.space_id = $1 ORDER BY m.added_at`, req.params.id)).map((m) => ({ id: m.id, name: m.name, email: m.email, color: m.color, role: m.role, addedAt: m.added_at }));
  });

  app.post('/api/spaces/:id/members', async (req) => {
    await needSpace(req.user.id, req.params.id, 'owner');
    const email = str(req.body?.email, 200).toLowerCase();
    const role = ROLES.includes(req.body?.role) ? req.body.role : 'editor';
    const u = await one('SELECT id, name, email, color FROM users WHERE email = $1 AND NOT disabled', email);
    if (!u) fail(404, `No Inkwell user with the e-mail ${email} — they need an account on this server first`);
    await q(`INSERT INTO space_members (space_id, user_id, role, position, added_at)
      VALUES ($1, $2, $3, (SELECT coalesce(max(position), -1) + 1 FROM space_members WHERE user_id = $2), $4)
      ON CONFLICT (space_id, user_id) DO UPDATE SET role = EXCLUDED.role`, req.params.id, u.id, role, now());
    await refreshMembership(u.id);
    publish(req.params.id, 'space:members', { id: req.params.id });
    return { ...u, role };
  });

  app.patch('/api/spaces/:id/members/:userId', async (req) => {
    await needSpace(req.user.id, req.params.id, 'owner');
    const role = ROLES.includes(req.body?.role) ? req.body.role : fail(400, 'Unknown role');
    if (role !== 'owner' && await lastOwner(req.params.id, req.params.userId)) fail(400, 'A space needs at least one owner');
    await q('UPDATE space_members SET role = $3 WHERE space_id = $1 AND user_id = $2', req.params.id, req.params.userId, role);
    publish(req.params.id, 'space:members', { id: req.params.id });
    return { ok: true };
  });

  // Owners remove anyone; everyone may leave.
  app.delete('/api/spaces/:id/members/:userId', async (req) => {
    if (req.params.userId !== req.user.id) await needSpace(req.user.id, req.params.id, 'owner');
    else await needSpace(req.user.id, req.params.id);
    if (await lastOwner(req.params.id, req.params.userId)) fail(400, 'A space needs at least one owner — delete it or make someone else owner first');
    await q('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', req.params.id, req.params.userId);
    await refreshMembership(req.params.userId);
    publish(req.params.id, 'space:members', { id: req.params.id });
    return { ok: true };
  });
}

async function lastOwner(spaceId, userId) {
  const r = await one(`SELECT (SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2) AS role,
    (SELECT count(*)::int FROM space_members WHERE space_id = $1 AND role = 'owner') AS owners`, spaceId, userId);
  return r.role === 'owner' && r.owners <= 1;
}

// Space-level settings: `localAiOnly` keeps the space's content away from cloud AI providers.
function pickSpaceSettings(s) {
  const out = {};
  if (s.localAiOnly !== undefined) out.localAiOnly = !!s.localAiOnly;
  if (s.aiEnabled !== undefined) out.aiEnabled = !!s.aiEnabled;
  // The associated Halcyon space: null = the one with the same name, '' = none.
  if (s.halcyonSpace !== undefined) out.halcyonSpace = s.halcyonSpace === null ? null : str(s.halcyonSpace, 40);
  // The Halcyon connection of the member who set it; others keep the automatic choice. null = automatic.
  if (s.halcyonConnection !== undefined) out.halcyonConnection = s.halcyonConnection === null ? null : str(s.halcyonConnection, 40);
  return out;
}
