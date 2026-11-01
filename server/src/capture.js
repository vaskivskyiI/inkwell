// A photo taken on one device for the page open on another: the phone takes the picture, the laptop or tablet that
// shows the page puts it where its cursor is. Devices report the page they work on (`active`); a desktop can ask the
// phone for a photo (`capture:request`); an uploaded photo is offered to the user's devices as a drop, which the
// device showing the page claims within a moment, else the server adds it at the end of the page.
import * as Y from 'yjs';
import { one, q, now } from './db/index.js';
import { fail, isUuid } from './util/http.js';
import { needNote } from './spaces.js';
import { notifyUser } from './events.js';
import { withDoc } from './collab.js';
import { appendBlocks, strokesOf } from './docmodel.js';

// A page worked on within this time is offered as the target on another device.
const ACTIVE_FOR = 2 * 3600 * 1000;
const CLAIM_WAIT = 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** Puts a picture at the end of a page: below the text, or below everything on a journal's paper. */
export async function placeAtEnd(noteId, kind, asset, size, user) {
  const ratio = size?.w > 0 && size?.h > 0 ? size.h / size.w : 0.75;
  await withDoc(noteId, (doc) => {
    if (kind !== 'journal') { appendBlocks(doc, [{ type: 'image', attrs: { src: `/api/assets/${asset.id}`, alt: asset.name || '' } }, { type: 'paragraph' }], 'rest'); return; }
    let bottom = 0;
    for (const s of strokesOf(doc, 'page')) for (let i = 1; i < (s.p?.length || 0); i += 3) bottom = Math.max(bottom, s.p[i]);
    for (const m of doc.getMap('images').values()) if (m instanceof Y.Map && m.get('canvas') === 'page') bottom = Math.max(bottom, m.get('y') + m.get('w') * m.get('ratio'));
    const w = 500, y = Math.round(bottom + 40);
    const m = new Y.Map();
    for (const [k, v] of Object.entries({ canvas: 'page', src: `/api/assets/${asset.id}`, x: 60, y, w, ratio, rot: 0, crop: [0, 0, 0, 0] })) m.set(k, v);
    doc.getMap('images').set(sid(), m);
    const meta = doc.getMap('meta');
    if ((meta.get('height') || 1400) < y + w * ratio + 80) meta.set('height', Math.ceil((y + w * ratio + 200) / 100) * 100);
  }, user);
}

export default async function captureRoutes(app) {
  // The page this device works on (sent while it is open and in front).
  app.post('/api/me/active', async (req) => {
    const id = req.body?.noteId;
    if (id === null) { await q('UPDATE users SET active_note = NULL WHERE id = $1', req.user.id); return { ok: true }; }
    await needNote(req.user.id, id, 'editor');
    await q('UPDATE users SET active_note = $2, active_at = $3 WHERE id = $1', req.user.id, id, now());
    return { ok: true };
  });

  // Where a photo from another device would go: the page last worked on, if recent and still writable.
  app.get('/api/capture/target', async (req) => {
    const u = await one('SELECT active_note, active_at FROM users WHERE id = $1', req.user.id);
    if (!u?.active_note || now() - Number(u.active_at) > ACTIVE_FOR) return { target: null };
    const n = await needNote(req.user.id, u.active_note, 'editor').catch(() => null);
    return { target: n && { id: n.id, title: n.title, icon: n.icon, kind: n.kind, at: Number(u.active_at) } };
  });

  // "Take it with my phone": the user's other devices offer their camera for this page.
  app.post('/api/notes/:id/capture-request', async (req) => {
    const n = await needNote(req.user.id, req.params.id, 'editor');
    notifyUser(req.user.id, 'capture:request', { noteId: n.id, title: n.title, icon: n.icon, kind: n.kind, from: String(req.body?.from || '').slice(0, 40) });
    return { ok: true };
  });

  // An uploaded picture for a page. `wait: false` skips offering it to the devices (a new page nobody shows yet).
  app.post('/api/notes/:id/drop', async (req) => {
    const n = await needNote(req.user.id, req.params.id, 'editor');
    if (!isUuid(req.body?.assetId)) fail(400, 'assetId missing');
    const asset = await one('SELECT id, name, mime, space_id FROM assets WHERE id = $1', req.body.assetId);
    if (!asset || !/^image\//.test(asset.mime)) fail(400, 'Only pictures can be dropped on a page');
    if (!(await one('SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2', asset.space_id, req.user.id))) fail(404, 'File not found');
    const size = { w: Number(req.body.w) || 0, h: Number(req.body.h) || 0 };
    const drop = await one('INSERT INTO drops (user_id, note_id, asset_id, created_at) VALUES ($1, $2, $3, $4) RETURNING id', req.user.id, n.id, asset.id, now());
    if (req.body.wait !== false) {
      notifyUser(req.user.id, 'note:drop', { dropId: drop.id, noteId: n.id, asset: { id: asset.id, url: `/api/assets/${asset.id}`, name: asset.name }, size, from: String(req.body.from || '').slice(0, 40) });
      for (const t0 = Date.now(); Date.now() - t0 < CLAIM_WAIT;) {
        await sleep(150);
        if ((await one('SELECT claimed_at FROM drops WHERE id = $1', drop.id))?.claimed_at) return { placed: 'device' };
      }
    }
    // Nobody took it: the server claims it itself (a late device claim then fails) and adds it at the end.
    if (!(await q('UPDATE drops SET claimed_at = $2 WHERE id = $1 AND claimed_at IS NULL', drop.id, now())).count) return { placed: 'device' };
    await placeAtEnd(n.id, n.kind, asset, size, req.user);
    return { placed: 'end' };
  });

  // The device showing the page takes the drop; only the first one gets it.
  app.post('/api/drops/:id/claim', async (req) => {
    if (!isUuid(req.params.id)) fail(404, 'Not found');
    const r = await q('UPDATE drops SET claimed_at = $3 WHERE id = $1 AND user_id = $2 AND claimed_at IS NULL', req.params.id, req.user.id, now());
    return { ok: r.count === 1 };
  });
}

export const purgeDrops = () => q('DELETE FROM drops WHERE created_at < $1', now() - 864e5);
