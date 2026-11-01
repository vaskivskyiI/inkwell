// Halcyon's shared spaces mirrored here: each gets one Inkwell space, and who may open it follows who is in it there.
// Only users who signed in with Halcyon are matched, by that login: an e-mail address alone proves nothing here. Halcyon
// decides for those users only; people added by hand stay, the space's owner stays, and no page is ever deleted. An
// existing space of the same name is not taken over: its pages might be private.
import { many, one, q, now } from './db/index.js';
import { config } from './config.js';
import { createSpace } from './spaces.js';
import { refreshMembership } from './events.js';

// An empty space of the same name (older accounts started with an empty "Work") gives way to the mirror of that name; anything with pages or other
// members stays, however it is named.
async function dropEmptyTwin(userId, name, keep) {
  const twin = await one(`SELECT s.id FROM spaces s WHERE s.owner_id = $1 AND lower(s.name) = lower($2) AND s.id <> $3 AND s.settings_json->>'halcyonShared' IS NULL
    AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.space_id = s.id) AND NOT EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = s.id AND m.user_id <> $1)`, userId, name, keep);
  if (twin) await q('DELETE FROM spaces WHERE id = $1', twin.id);
}

export async function mirrorSpaces() {
  if (!config.halcyonUrl || !config.halcyonSecret) return 0;
  const { askHalcyon } = await import('./sso.js');
  const spaces = await askHalcyon('/api/sso/spaces');
  const users = new Map((await many('SELECT id, halcyon_sub FROM users WHERE halcyon_sub IS NOT NULL')).map((u) => [u.halcyon_sub, u.id]));
  let changed = 0;
  for (const sp of Array.isArray(spaces) ? spaces : []) {
    const wanted = new Map(sp.members.filter((m) => users.has(m.sub)).map((m) => [users.get(m.sub), m.role === 'owner' ? 'owner' : 'editor']));
    let s = await one("SELECT * FROM spaces WHERE settings_json->>'halcyonShared' = $1", sp.id);
    if (!s) {
      if (!wanted.size) continue; // nobody here yet
      const owner = [...wanted].find(([, r]) => r === 'owner')?.[0] || [...wanted.keys()][0];
      s = await createSpace(owner, { name: sp.name });
      await q("UPDATE spaces SET settings_json = settings_json || jsonb_build_object('halcyonShared', $1::text) WHERE id = $2", sp.id, s.id);
      await dropEmptyTwin(owner, sp.name, s.id);
      refreshMembership(owner);
      changed++;
    } else if (s.name !== sp.name) await q('UPDATE spaces SET name = $1, updated_at = $2 WHERE id = $3', sp.name, now(), s.id);
    const members = await many('SELECT m.user_id, u.halcyon_sub FROM space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = $1', s.id);
    for (const [uid, role] of wanted) {
      if (members.some((m) => m.user_id === uid)) continue;
      const pos = (await one('SELECT coalesce(max(position), -1) + 1 AS p FROM space_members WHERE user_id = $1', uid)).p;
      await q('INSERT INTO space_members (space_id, user_id, role, position, added_at) VALUES ($1, $2, $3, $4, $5)', s.id, uid, role, pos, now());
      await dropEmptyTwin(uid, sp.name, s.id);
      refreshMembership(uid);
      changed++;
    }
    for (const m of members) {
      if (!m.halcyon_sub || wanted.has(m.user_id) || m.user_id === s.owner_id) continue;
      await q('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', s.id, m.user_id);
      refreshMembership(m.user_id);
      changed++;
    }
  }
  return changed;
}
