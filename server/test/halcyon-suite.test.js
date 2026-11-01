// Inkwell and Halcyon set up together: mailboxes, shared spaces and lookups trust the sign-on secret, with no per-user
// tokens; a shared space's AI models are chosen once by its owner.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, signup, addMockAi } from './helpers.js';

const SECRET = 'suite-secret';
// Halcyon user ids '1' (Ann) and '2' (Ben); shared user '7' (Lab) has both.
const SHARED = { 7: { name: 'Lab', members: [{ sub: '1', role: 'owner' }, { sub: '2', role: 'member' }] } };
const BOXES = {
  1: { tasks: [{ id: 10, title: 'Ann task', done: false }] },
  2: { tasks: [{ id: 20, title: 'Ben task', done: false }] },
  7: { tasks: [{ id: 70, title: 'Lab task', done: false }] },
};
const calls = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (x, s = 200) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(x));
    if (req.headers.authorization !== `Bearer ${SECRET}`) return send({}, 401);
    if (req.url === '/api/sso/spaces') return send(Object.entries(SHARED).map(([id, s]) => ({ id, ...s })));
    if (req.url !== '/api/mcp') return send({}, 404);
    const sub = req.headers['x-halcyon-sub'], target = req.headers['x-halcyon-target'];
    const may = sub && (target === sub || SHARED[target]?.members.some((m) => m.sub === sub));
    if (!may) return send({}, 401);
    const { id, params: { name, arguments: a } } = JSON.parse(body);
    calls.push({ sub, target, name, a });
    const box = BOXES[target];
    const reply = (result) => send({ jsonrpc: '2.0', id, result: { structuredContent: result, content: [{ text: JSON.stringify(result) }] } });
    if (name === 'list_spaces') return reply({ spaces: [] });
    if (name === 'list_tasks') return reply({ items: box.tasks.filter((t) => !a.ids || a.ids.includes(t.id)) });
    if (name === 'create_task') { const t = { id: 71, title: a.title, done: false }; box.tasks.push(t); return reply(t); }
    if (name === 'complete_task') { box.tasks.find((t) => t.id === a.id).done = a.done; return reply({ ok: true }); }
    return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ text: 'Unknown tool' }] } });
  });
});

let app, db, ann, ben, lab, resolve;
before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.INKWELL_HALCYON_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.INKWELL_HALCYON_SECRET = SECRET;
  ({ app } = await startServer());
  db = await import('../src/db/index.js');
  ({ resolve } = await import('../src/ai/router.js'));
  ann = await signup(app, 'ann@suite.test', 'Ann');
  ben = await signup(app, 'ben@suite.test', 'Ben');
  await db.q("UPDATE users SET halcyon_sub = '1' WHERE id = $1", ann.user.id);
  await db.q("UPDATE users SET halcyon_sub = '2' WHERE id = $1", ben.user.id);
  await (await import('../src/mirror.js')).mirrorSpaces();
  lab = (await ann.get('/api/spaces')).find((s) => s.name === 'Lab');
});
after(async () => { await app.close(); fake.close(); });

test('suite connections need no setup and call Halcyon with the secret, the person and the mailbox', async () => {
  const st = await ann.get('/api/integrations/halcyon');
  assert.deepEqual(st.connections.map((c) => [c.id, c.name, c.suite, c.shared]), [['suite', 'Ann', true, false], ['suite:7', 'Lab', true, true]]);
  assert.equal(JSON.stringify(st).includes(SECRET), false, 'the secret stays on the server');
  const tasks = await ann.get('/api/halcyon/search?kind=task');
  assert.deepEqual(tasks.map((t) => [t.title, t.meta.conn]).sort(), [['Ann task', 'suite@1'], ['Lab task', 'suite:7']]);
  assert.deepEqual(calls.filter((c) => c.name === 'list_tasks').map((c) => `${c.sub}>${c.target}`).sort(), ['1>1', '1>7']);
  // Set up by the administrator: not edited or removed here.
  assert.equal(await ann.status('PATCH', '/api/integrations/halcyon/connections/suite:7', { name: 'x' }), 404);
  await ann.del('/api/integrations/halcyon/connections/suite');
  assert.equal((await ann.get('/api/integrations/halcyon')).connections.length, 2);
});

test('a mirrored space uses its shared mailbox for every member, and its task links work for each of them', async () => {
  for (const [c, sub] of [[ann, '1'], [ben, '2']]) {
    calls.length = 0;
    assert.deepEqual((await c.get(`/api/halcyon/tasks?space=${lab.id}`)).map((t) => t.title), ['Lab task']);
    assert.deepEqual(calls.map((x) => `${x.sub}>${x.target}`), [`${sub}>7`, `${sub}>7`]); // list_spaces, list_tasks
  }
  // Ann sends a to-do to Halcyon from a page of the space; Ben, who set nothing up, sees it ticked when done there.
  const page = await ann.post('/api/notes', { spaceId: lab.id, title: 'Plan', markdown: '- [ ] Order parts' });
  await ann.post(`/api/notes/${page.id}/tasks`, { items: [{ text: 'Order parts' }] });
  const [link] = await ben.get(`/api/notes/${page.id}/links`);
  assert.equal(link.meta.conn, 'suite:7');
  BOXES[7].tasks.find((t) => t.id === 71).done = true;
  calls.length = 0;
  assert.equal((await ben.post('/api/halcyon/pull-tasks')).changed, 1);
  assert.deepEqual(calls.map((x) => `${x.sub}>${x.target}`), ['2>7'], 'only the shared mailbox is asked, as Ben');
  assert.match(await ben.get(`/api/notes/${page.id}/export`), /- \[x\] Order parts/);
  // Someone Halcyon no longer lets in is refused there, and Inkwell says so.
  SHARED[7].members = SHARED[7].members.filter((m) => m.sub !== '2');
  const r = await app.inject({ url: `/api/halcyon/tasks?space=${lab.id}`, headers: { cookie: ben.cookie } });
  assert.equal(r.statusCode, 502);
  assert.match(r.body, /no longer a member/);
  SHARED[7].members.push({ sub: '2', role: 'member' });
});

test('Halcyon looks up pages with the secret on the two lookup paths only', async () => {
  const as = (sub, secret = SECRET) => ({ authorization: `Bearer ${secret}`, 'x-halcyon-sub': sub });
  const get = (url, headers) => app.inject({ url, headers });
  const page = await ann.post('/api/notes', { spaceId: ann.spaces[0].id, title: 'Budget notes' });
  await ann.post(`/api/notes/${page.id}/links`, { kind: 'event', ref: '555', title: 'Budget' });
  const recent = await get('/api/recent?limit=5', as('1'));
  assert.equal(recent.statusCode, 200);
  assert.ok(recent.json().some((n) => n.id === page.id));
  const found = await get('/api/links/lookup?kind=event&ref=555', as('1'));
  assert.equal(found.statusCode, 200);
  assert.deepEqual(found.json().map((x) => x.id), [page.id]);
  assert.deepEqual((await get('/api/links/lookup?kind=event&ref=555', as('2'))).json(), [], 'Ben does not see Ann\'s private page');
  assert.equal((await get('/api/recent', as('1', 'wrong-secret'))).statusCode, 401);
  assert.equal((await get('/api/recent', as('404'))).statusCode, 401, 'no user with this Halcyon login');
  assert.equal((await get('/api/recent', { authorization: `Bearer ${SECRET}` })).statusCode, 401, 'the secret alone is no one');
  assert.equal((await get('/api/spaces', as('1'))).statusCode, 401);
  assert.equal((await get(`/api/notes/${page.id}`, as('1'))).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: `/api/notes/${page.id}/links`, headers: as('1'), payload: { kind: 'url', ref: 'https://x.test' } })).statusCode, 401);
});

test('a shared space\'s AI models are set once by its owner and used for every member\'s work', async () => {
  const annAi = await addMockAi(ann);
  const benAi = await addMockAi(ben);
  await ben.put('/api/settings', { ai: { chat: { providerId: benAi, model: 'ben-model' } } });
  assert.equal(await ben.status('PATCH', `/api/spaces/${lab.id}`, { settings: { ai: { chat: { providerId: benAi, model: 'x' } } } }), 403);
  assert.equal(await ann.status('PATCH', `/api/spaces/${lab.id}`, { settings: { ai: { chat: { providerId: benAi, model: 'x' } } } }), 400, 'not hers to give');
  await ann.patch(`/api/spaces/${lab.id}`, { settings: { ai: { chat: { providerId: annAi, model: 'lab-model' } } } });
  await ann.patch(`/api/spaces/${lab.id}`, { settings: { ai: { embed: null } } }); // other tasks keep the choice
  const r = await resolve(ben.user.id, 'chat', { spaceId: lab.id });
  assert.equal(r.model, 'lab-model');
  assert.equal((await resolve(ben.user.id, 'chat', { spaceId: ben.spaces[0].id })).model, 'ben-model', 'elsewhere Ben\'s own choice');
  const seen = await ben.get(`/api/spaces/${lab.id}/ai`);
  assert.deepEqual(seen.chat, { providerId: annAi, model: 'lab-model', provider: 'Mock' });
  assert.equal(seen.vision, null);
  // Back to automatic: each person's own.
  await ann.patch(`/api/spaces/${lab.id}`, { settings: { ai: { chat: null } } });
  assert.equal((await resolve(ben.user.id, 'chat', { spaceId: lab.id })).model, 'ben-model');
});
