// Sign in with Halcyon and its shared spaces mirrored, against a fake Halcyon.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, signup, client } from './helpers.js';

let app, fake, base, spaces = [], logins = {}, mirrorSpaces, db;
const inject = (opts) => app.inject(opts);
const login = async (code) => {
  const start = await inject({ url: '/api/auth/halcyon/start' });
  assert.equal(start.statusCode, 302);
  const state = new URL(start.headers.location).searchParams.get('state');
  return inject({ url: `/api/auth/halcyon/callback?code=${code}&state=${encodeURIComponent(state)}`, cookies: { inkwell_sso: state } });
};
const session = (r) => r.cookies.find((c) => c.value && c.name !== 'inkwell_sso');
const asUser = async (r) => { const c = session(r); return (await inject({ url: '/api/spaces', cookies: { [c.name]: c.value } })).json(); };

before(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer shared-secret') { res.writeHead(401).end('{}'); return; }
      const send = (x, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(x)); };
      if (req.url === '/api/sso/spaces') return send(spaces);
      const who = logins[JSON.parse(body).code];
      return who ? send(who) : send({ error: 'expired' }, 400);
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${fake.address().port}`;
  process.env.INKWELL_HALCYON_URL = base;
  process.env.INKWELL_HALCYON_SECRET = 'shared-secret';
  ({ app } = await startServer());
  ({ mirrorSpaces } = await import('../src/mirror.js'));
  db = await import('../src/db/index.js');
  logins = { ann: { sub: '1', email: 'ann@firm.test', name: 'Ann' }, ben: { sub: '2', email: 'ben@firm.test', name: 'Ben' }, mal: { sub: '9', email: 'taken@firm.test', name: 'Mal' } };
});
after(async () => { await app.close(); fake.close(); });

test('a login from Halcyon makes the account, and the next one finds it', async () => {
  const first = await login('ann');
  assert.equal(first.statusCode, 302);
  assert.equal(first.headers.location, '/');
  assert.ok(session(first));
  await login('ann');
  assert.equal((await db.many("SELECT id FROM users WHERE email = 'ann@firm.test'")).length, 1);
});

test('a forged return is refused and an existing e-mail is not taken over', async () => {
  const r = await inject({ url: '/api/auth/halcyon/callback?code=ann&state=x', cookies: { inkwell_sso: 'y' } });
  assert.match(r.headers.location, /sso_error/);
  await signup(app, 'taken@firm.test', 'Real owner');
  const t = await login('mal');
  assert.match(decodeURIComponent(t.headers.location), /Sign in with its password/);
  assert.ok(!session(t));
});

test('a shared space comes with its members, followed when they change; pages and hand-added people stay', async () => {
  const b = await login('ben');
  const annId = (await db.one("SELECT id FROM users WHERE email = 'ann@firm.test'")).id;
  const benId = (await db.one("SELECT id FROM users WHERE email = 'ben@firm.test'")).id;
  const guest = await signup(app, 'guest@firm.test', 'Guest');
  // A mirror is made once; a person with the same e-mail but no Halcyon login gets nothing.
  spaces = [{ id: '7', name: 'Work', members: [{ sub: '1', role: 'owner' }, { sub: '2', role: 'member' }, { sub: '99', role: 'member' }] }];
  await mirrorSpaces();
  await mirrorSpaces();
  const mine = (await asUser(b)).filter((s) => s.name === 'Work');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].role, 'editor');
  const id = mine[0].id;
  const guestId = (await db.one("SELECT id FROM users WHERE email = 'guest@firm.test'")).id;
  await db.q("INSERT INTO space_members (space_id, user_id, role, position, added_at) VALUES ($1, $2, 'viewer', 0, 0)", id, guestId);
  spaces[0].name = 'Firm';
  spaces[0].members = [{ sub: '1', role: 'owner' }];
  await mirrorSpaces();
  assert.equal((await db.one('SELECT name FROM spaces WHERE id = $1', id)).name, 'Firm');
  const left = (await db.many('SELECT user_id FROM space_members WHERE space_id = $1', id)).map((m) => m.user_id);
  assert.ok(left.includes(annId) && left.includes(guestId));
  assert.ok(!left.includes(benId), 'removed in Halcyon, removed here');
  assert.ok(guest);
  spaces = [];
  await mirrorSpaces();
  assert.ok(await db.one('SELECT 1 FROM spaces WHERE id = $1', id), 'a space gone in Halcyon keeps its pages here');
});

test('a mail of a shared space is noted in its mirror', async () => {
  spaces = [{ id: '8', name: 'Studio', members: [{ sub: '1', role: 'owner' }] }];
  await mirrorSpaces();
  const r = await login('ann');
  const c = session(r);
  const n = (await inject({ method: 'POST', url: '/api/notes/from-item', cookies: { [c.name]: c.value }, payload: { kind: 'task', ref: '55', title: 'T', meta: { hspace: 'Studio' } } })).json();
  const s = await db.one("SELECT id FROM spaces WHERE settings_json->>'halcyonShared' = '8'");
  assert.equal(n.spaceId, s.id);
  assert.ok(client);
});
