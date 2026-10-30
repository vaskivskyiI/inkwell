import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, signup, client } from './helpers.js';

let app, ann, bob;
before(async () => {
  ({ app } = await startServer());
  ann = await signup(app, 'ann@test.local', 'Ann');
  bob = await signup(app, 'bob@test.local', 'Bob');
});
after(() => app.close());

const space = (c, name) => c.spaces.find((s) => s.name === name);

test('sign-up: first user is admin, gets Private + Work and a welcome page', async () => {
  assert.equal(ann.user.isAdmin, true);
  assert.equal(bob.user.isAdmin, false);
  assert.deepEqual(ann.spaces.map((s) => s.name), ['Private', 'Work']);
  const tree = await ann.get(`/api/spaces/${space(ann, 'Private').id}/tree`);
  assert.equal(tree.notes[0].title, 'Welcome to Inkwell');
  const anon = client(app);
  assert.equal(await anon.status('GET', '/api/spaces'), 401);
  assert.equal((await anon.get('/api/auth/state')).needsSetup, false);
});

test('login, wrong password, API tokens as Bearer', async () => {
  const c = client(app);
  assert.equal(await c.status('POST', '/api/auth/login', { email: 'ann@test.local', password: 'nope' }), 401);
  const { token } = await c.post('/api/auth/login', { email: 'ann@test.local', password: 'secret123', token: true, deviceName: 'Phone' });
  assert.match(token, /^ink_/);
  const r = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
  assert.equal(JSON.parse(r.body).email, 'ann@test.local');
  const tokens = await ann.get('/api/tokens');
  assert.ok(tokens.some((t) => t.name === 'Phone'));
});

test('pages: create nested, move, reorder, rename, trash and restore', async () => {
  const sid = space(ann, 'Work').id;
  const a = await ann.post('/api/notes', { spaceId: sid, title: 'Project A' });
  const b = await ann.post('/api/notes', { spaceId: sid, title: 'Child', parentId: a.id });
  const c = await ann.post('/api/notes', { spaceId: sid, title: 'Second child', parentId: a.id });
  const first = await ann.post('/api/notes', { spaceId: sid, title: 'First child', parentId: a.id, afterId: null });
  let tree = (await ann.get(`/api/spaces/${sid}/tree`)).notes;
  const kids = tree.filter((n) => n.parentId === a.id).sort((x, y) => x.position - y.position).map((n) => n.title);
  assert.deepEqual(kids, ['First child', 'Child', 'Second child']);
  // Move c between first and b.
  await ann.patch(`/api/notes/${c.id}`, { parentId: a.id, afterId: first.id });
  tree = (await ann.get(`/api/spaces/${sid}/tree`)).notes;
  assert.deepEqual(tree.filter((n) => n.parentId === a.id).sort((x, y) => x.position - y.position).map((n) => n.title), ['First child', 'Second child', 'Child']);
  // A page cannot become its own descendant.
  assert.equal(await ann.status('PATCH', `/api/notes/${a.id}`, { parentId: b.id }), 400);
  // Rename goes into the page document too.
  await ann.patch(`/api/notes/${b.id}`, { title: 'Renamed' });
  assert.equal((await ann.get(`/api/notes/${b.id}`)).title, 'Renamed');
  // Trash the parent: children go with it, restore brings all back.
  const del = await ann.del(`/api/notes/${a.id}`);
  assert.equal(del.ids.length, 4);
  assert.equal((await ann.get(`/api/spaces/${sid}/tree`)).notes.filter((n) => [a.id, b.id].includes(n.id)).length, 0);
  const trash = await ann.get('/api/trash');
  assert.deepEqual(trash.map((n) => n.id), [a.id], 'only the root of a deleted subtree is listed');
  await ann.post(`/api/notes/${a.id}/restore`);
  assert.equal((await ann.get(`/api/spaces/${sid}/tree`)).notes.filter((n) => n.parentId === a.id).length, 3);
  // Permanent delete only from the trash.
  assert.equal(await ann.status('DELETE', `/api/notes/${first.id}?permanent=1`), 400);
  await ann.del(`/api/notes/${first.id}`);
  await ann.del(`/api/notes/${first.id}?permanent=1`);
  assert.equal(await ann.status('GET', `/api/notes/${first.id}`), 404);
});

test('sharing: roles decide what members may do; non-members see nothing', async () => {
  const team = await ann.post('/api/spaces', { name: 'Team', icon: '👥' });
  const page = await ann.post('/api/notes', { spaceId: team.id, title: 'Shared plan', markdown: 'Ship the **beta** on Friday' });
  assert.equal(await bob.status('GET', `/api/notes/${page.id}`), 404);
  assert.equal(await bob.status('GET', `/api/spaces/${team.id}/tree`), 404);
  await ann.post(`/api/spaces/${team.id}/members`, { email: 'bob@test.local', role: 'viewer' });
  assert.ok((await bob.get('/api/spaces')).some((s) => s.id === team.id && s.role === 'viewer'));
  assert.equal((await bob.get(`/api/notes/${page.id}`)).title, 'Shared plan');
  assert.equal(await bob.status('PATCH', `/api/notes/${page.id}`, { title: 'x' }), 403);
  assert.equal(await bob.status('POST', '/api/notes', { spaceId: team.id, title: 'x' }), 403);
  await ann.patch(`/api/spaces/${team.id}/members/${bob.user.id}`, { role: 'editor' });
  const bobs = await bob.post('/api/notes', { spaceId: team.id, title: 'Bob was here' });
  assert.equal(bobs.spaceId, team.id);
  assert.equal(await bob.status('POST', `/api/spaces/${team.id}/members`, { email: 'x@y.z' }), 403);
  // The last owner cannot leave or be demoted.
  assert.equal(await ann.status('PATCH', `/api/spaces/${team.id}/members/${ann.user.id}`, { role: 'editor' }), 400);
  // Bob can see the space in search, then loses everything when removed.
  assert.ok((await bob.get('/api/search?q=beta')).some((r) => r.id === page.id));
  await ann.del(`/api/spaces/${team.id}/members/${bob.user.id}`);
  assert.equal(await bob.status('GET', `/api/notes/${page.id}`), 404);
  assert.ok(!(await bob.get('/api/search?q=beta')).some((r) => r.id === page.id));
  assert.equal(await ann.status('POST', `/api/spaces/${team.id}/members`, { email: 'nobody@test.local' }), 404);
});

test('moving a page to another space takes its sub-pages along', async () => {
  const work = space(ann, 'Work').id, priv = space(ann, 'Private').id;
  const p = await ann.post('/api/notes', { spaceId: work, title: 'Mover' });
  const k = await ann.post('/api/notes', { spaceId: work, title: 'Mover child', parentId: p.id });
  await ann.patch(`/api/notes/${p.id}`, { spaceId: priv });
  const tree = (await ann.get(`/api/spaces/${priv}/tree`)).notes;
  assert.ok(tree.some((n) => n.id === p.id && n.parentId === null));
  assert.ok(tree.some((n) => n.id === k.id && n.parentId === p.id));
  assert.equal(await bob.status('PATCH', `/api/notes/${p.id}`, { spaceId: space(bob, 'Work').id }), 404);
});

test('daily journal: one page per day, under "Journal", created once', async () => {
  const [a, b] = await Promise.all([ann.post('/api/journal', { date: '2026-10-29' }), ann.post('/api/journal', { date: '2026-10-29' })]);
  assert.equal(a.id, b.id);
  assert.equal(a.kind, 'journal');
  assert.equal(a.journalDate, '2026-10-29');
  const tree = (await ann.get(`/api/spaces/${a.spaceId}/tree`)).notes;
  assert.equal(tree.find((n) => n.id === tree.find((x) => x.id === a.id).parentId).title, 'Journal');
  const other = await ann.post('/api/journal', { date: '2026-10-30' });
  assert.notEqual(other.id, a.id);
});

test('templates, favourites, recent, duplicate, export/import, Markdown blocks', async () => {
  const sid = space(ann, 'Work').id;
  const m = await ann.post('/api/notes', { spaceId: sid, template: 'meeting' });
  assert.match(m.title, /^Meeting notes \d{4}-\d{2}-\d{2}$/);
  const md = await ann.get(`/api/notes/${m.id}/export`);
  assert.match(md, /## Action items\n\n- \[ \]/);
  await ann.put(`/api/favorites/${m.id}`);
  assert.ok((await ann.get('/api/favorites')).some((n) => n.id === m.id));
  assert.equal((await ann.get('/api/recent?limit=1'))[0].id, m.id);
  const copy = await ann.post(`/api/notes/${m.id}/duplicate`);
  assert.match(copy.title, /\(copy\)$/);
  assert.match(await ann.get(`/api/notes/${copy.id}/export`), /## Agenda/);
  const html = await ann.get(`/api/notes/${m.id}/export?format=html`);
  assert.match(html, /<h2>Agenda<\/h2>/);
  const imp = await ann.post('/api/notes/import', { spaceId: sid, markdown: '# Imported page\n\nHello *there*' });
  assert.equal(imp.title, 'Imported page');
  assert.match(await ann.get(`/api/notes/${imp.id}/export`), /Hello _there_/);
  const { blocks } = await ann.post('/api/markdown/blocks', { markdown: '- [ ] a' });
  assert.equal(blocks[0].type, 'taskList');
  await ann.post(`/api/notes/${imp.id}/append`, { markdown: '## Added' });
  assert.match(await ann.get(`/api/notes/${imp.id}/export`), /## Added/);
});

test('public link: read-only HTML for anyone, revocable', async () => {
  const sid = space(ann, 'Work').id;
  const p = await ann.post('/api/notes', { spaceId: sid, title: 'Public page', markdown: 'Visible to all' });
  const { slug } = await ann.post(`/api/notes/${p.id}/publish`);
  const anon = client(app);
  assert.match(await anon.get(`/api/public/${slug}`), /Visible to all/);
  await ann.post(`/api/notes/${p.id}/publish`, { enabled: false });
  assert.equal(await anon.status('GET', `/api/public/${slug}`), 404);
});

test('search: words, prefixes, tags, kind and space filters', async () => {
  const sid = space(ann, 'Work').id;
  const p = await ann.post('/api/notes', { spaceId: sid, title: 'Quarterly budget', markdown: 'Discuss the marketing spend #finance' });
  const hits = await ann.get('/api/search?q=budg');
  assert.equal(hits[0].id, p.id);
  assert.ok((await ann.get('/api/search?q=marketing')).some((h) => h.id === p.id && /«marketing»/.test(h.snippet)));
  assert.ok((await ann.get('/api/search?q=tag:finance')).some((h) => h.id === p.id));
  assert.ok(!(await ann.get('/api/search?q=budget kind:journal')).some((h) => h.id === p.id));
  assert.ok(!(await ann.get('/api/search?q=budget in:private')).some((h) => h.id === p.id));
  assert.ok(!(await bob.get('/api/search?q=budget')).some((h) => h.id === p.id));
});

test('assets: upload into a page, access follows the space', async () => {
  const sid = space(ann, 'Work').id;
  const p = await ann.post('/api/notes', { spaceId: sid, title: 'With image' });
  const boundary = 'x-boundary';
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201e2216bc50000000049454e44ae426082', 'hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="noteId"\r\n\r\n${p.id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dot.png"\r\nContent-Type: image/png\r\n\r\n`),
    png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const up = JSON.parse((await app.inject({ method: 'POST', url: '/api/assets', payload: body, headers: { cookie: ann.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` } })).body);
  assert.match(up.url, /^\/api\/assets\//);
  const got = await app.inject({ method: 'GET', url: up.url, headers: { cookie: ann.cookie } });
  assert.equal(got.statusCode, 200);
  assert.equal(got.headers['content-type'], 'image/png');
  assert.match(got.headers['content-security-policy'], /sandbox/);
  assert.equal((await app.inject({ method: 'GET', url: up.url, headers: { cookie: bob.cookie } })).statusCode, 404);
});

test('links: URLs and pages, reverse lookup by kind/ref', async () => {
  const sid = space(ann, 'Work').id;
  const p = await ann.post('/api/notes', { spaceId: sid, title: 'Linked page' });
  const other = await ann.post('/api/notes', { spaceId: sid, title: 'Other page' });
  await ann.post(`/api/notes/${p.id}/links`, { kind: 'url', ref: 'https://example.com/spec', title: 'Spec' });
  await ann.post(`/api/notes/${p.id}/links`, { kind: 'event', ref: '42', title: 'Kick-off', meta: { start: '2026-11-01T09:00:00Z' } });
  await ann.post(`/api/notes/${p.id}/links`, { kind: 'note', ref: other.id, title: 'Other page' });
  assert.equal(await ann.status('POST', `/api/notes/${p.id}/links`, { kind: 'url', ref: 'javascript:alert(1)' }), 400);
  const links = await ann.get(`/api/notes/${p.id}/links`);
  assert.deepEqual(links.map((l) => l.kind).sort(), ['event', 'note', 'url']);
  assert.equal((await ann.get(`/api/notes/${other.id}`)).backlinks[0].id, p.id);
  const found = await ann.get('/api/links/lookup?kind=event&ref=42,43');
  assert.equal(found[0].id, p.id);
  assert.deepEqual(await bob.get('/api/links/lookup?kind=event&ref=42'), []);
});

test('admin: list users, disable a user, sign-up switch', async () => {
  const users = await ann.get('/api/admin/users');
  assert.equal(users.length, 2);
  assert.equal(await bob.status('GET', '/api/admin/users'), 403);
  await ann.put('/api/admin/settings', { allowSignup: false });
  assert.equal(await client(app).status('POST', '/api/auth/signup', { email: 'eve@test.local', password: 'secret123' }), 403);
  await ann.put('/api/admin/settings', { allowSignup: true });
  const eve = await signup(app, 'eve@test.local');
  await ann.patch(`/api/admin/users/${eve.user.id}`, { disabled: true });
  assert.equal(await eve.status('GET', '/api/me'), 401);
});

test('admin: add and edit users', async () => {
  assert.equal(await bob.status('POST', '/api/admin/users', { email: 'x@test.local', password: 'secret123' }), 403);
  const { id } = await ann.post('/api/admin/users', { email: 'Zoe@test.local', name: 'Zoe', password: 'secret123', isAdmin: true });
  let u = (await ann.get('/api/admin/users')).find((x) => x.id === id);
  assert.deepEqual([u.email, u.name, u.isAdmin, u.spaces], ['zoe@test.local', 'Zoe', true, 2]);
  assert.equal(await ann.status('POST', '/api/admin/users', { email: 'zoe@test.local', password: 'secret123' }), 409);

  const zoe = client(app);
  await zoe.post('/api/auth/login', { email: 'zoe@test.local', password: 'secret123' });
  await ann.patch(`/api/admin/users/${id}`, { name: 'Zoe B', email: 'zoe.b@test.local', password: 'another123' });
  u = (await ann.get('/api/admin/users')).find((x) => x.id === id);
  assert.deepEqual([u.email, u.name], ['zoe.b@test.local', 'Zoe B']);
  assert.equal(await zoe.status('GET', '/api/me'), 401, 'a new password ends old sessions');
  await zoe.post('/api/auth/login', { email: 'zoe.b@test.local', password: 'another123' });

  assert.equal(await ann.status('PATCH', `/api/admin/users/${id}`, { email: bob.user.email }), 409);
  assert.equal(await ann.status('PATCH', `/api/admin/users/${id}`, { password: 'short' }), 400);
  assert.equal(await ann.status('PATCH', '/api/admin/users/nope', { name: 'x' }), 404);
  await ann.patch(`/api/admin/users/${ann.user.id}`, { password: 'secret123' });
  await ann.get('/api/me'); // the admin's own session survives their own reset
});
