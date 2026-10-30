// One user, two Halcyon mailboxes with different tokens: own mail and a shared space.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, signup, sleep } from './helpers.js';

const MAILBOXES = {
  hmcp_mine: { spaces: ['Work'], mail: [{ id: 1, subject: 'Budget mine', from: 'a@x', date: '2026-10-01T10:00:00Z', space: 'Work' }], tasks: [{ id: 10, title: 'My task', done: false }], events: [{ id: 20, title: 'My standup', start: new Date().toISOString() }] },
  hmcp_lab: { spaces: [], mail: [{ id: 2, subject: 'Budget lab', from: 'b@x', date: '2026-10-02T10:00:00Z' }], tasks: [{ id: 11, title: 'Lab task', done: false }], events: [] },
};
const calls = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const token = (req.headers.authorization || '').slice(7);
    const box = MAILBOXES[token];
    if (!box) { res.statusCode = 401; res.end('{}'); return; }
    const { id, params: { name, arguments: a } } = JSON.parse(body);
    calls.push({ token, name, a });
    const reply = (result, isError) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { isError, structuredContent: result, content: [{ text: JSON.stringify(result) }] } }));
    const denied = (text) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { isError: true, content: [{ text }] } }));
    if (name === 'list_spaces') return reply({ spaces: box.spaces });
    if (name === 'list_tasks') return reply({ items: box.tasks.filter((t) => !a.ids || a.ids.includes(t.id)) });
    if (name === 'list_events') return reply({ items: box.events });
    if (name === 'search_mail' || name === 'list_open_items') return reply({ items: box.mail });
    if (name === 'create_task') return reply({ id: 99, title: a.title });
    const m = box.mail.find((x) => x.id === (a.id ?? a.message_id));
    if (name === 'get_message') return m ? reply(m) : denied('No message');
    if (name === 'get_conversation') return m ? reply({ messages: [{ ...m, text_untrusted: `Text of ${m.subject}` }] }) : denied('No message');
    if (name === 'complete_task') {
      const t = box.tasks.find((x) => x.id === a.id);
      if (!t) return denied('No task');
      t.done = a.done;
      return reply({ ok: true });
    }
    return denied('Unknown tool');
  });
});

let app, ann, base, drain, withDoc;
before(async () => {
  ({ app } = await startServer());
  ({ drain } = await import('../src/ai/queue.js'));
  ({ withDoc } = await import('../src/collab.js'));
  ann = await signup(app, 'multi@test.local', 'Ann');
  await new Promise((r) => { fake.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${fake.address().port}`;
});
after(async () => { fake.close(); await app.close(); });

const work = () => ann.spaces.find((s) => s.name === 'Work').id;

test('own mail and a shared space side by side, each with its own token', async () => {
  await ann.put('/api/integrations/halcyon', { baseUrl: base, token: 'hmcp_mine' });
  assert.equal(await ann.status('POST', '/api/integrations/halcyon/connections', { name: 'Bad', baseUrl: base, token: 'hmcp_nope' }), 502);
  assert.equal(await ann.status('POST', '/api/integrations/halcyon/connections', { name: 'my mail', baseUrl: base, token: 'hmcp_lab' }), 409);
  const st = await ann.post('/api/integrations/halcyon/connections', { name: 'Lab', baseUrl: base, token: 'hmcp_lab' });
  assert.deepEqual(st.connections.map((c) => c.name), ['My mail', 'Lab']);
  assert.equal(JSON.stringify(st).includes('hmcp_'), false, 'tokens stay on the server');
  const [mine, lab] = st.connections;

  // Search reads both, newest first, and says where each item came from.
  const mail = await ann.get('/api/halcyon/search?kind=email&q=budget');
  assert.deepEqual(mail.map((m) => [m.title, m.meta.conn, m.meta.source]), [['Budget lab', lab.id, 'Lab'], ['Budget mine', mine.id, 'My mail']]);

  // One mailbox being down leaves the other.
  const saved = MAILBOXES.hmcp_lab;
  delete MAILBOXES.hmcp_lab;
  assert.deepEqual((await ann.get('/api/halcyon/search?kind=task')).map((t) => t.title), ['My task']);
  MAILBOXES.hmcp_lab = saved;

  // "Work" exists only in my mailbox, so the shared one stays out of it; a space named like a connection shows that one.
  assert.deepEqual((await ann.get(`/api/halcyon/tasks?space=${work()}`)).map((t) => t.title), ['My task']);
  assert.equal(calls.filter((c) => c.name === 'list_tasks').at(-1).a.space, 'Work');
  const labSpace = await ann.post('/api/spaces', { name: 'Lab' });
  assert.deepEqual((await ann.get(`/api/halcyon/tasks?space=${labSpace.id}`)).map((t) => t.title), ['Lab task']);
  // Or the space names its connection.
  await ann.patch(`/api/spaces/${work()}`, { settings: { halcyonConnection: lab.id } });
  assert.deepEqual((await ann.get(`/api/halcyon/tasks?space=${work()}`)).map((t) => t.title), ['Lab task']);
  await ann.patch(`/api/spaces/${work()}`, { settings: { halcyonConnection: null } });

  // A note from shared mail lands in the shared space, and its text is read with the shared token.
  const labMail = mail[0];
  const note = await ann.post('/api/notes/from-item', { kind: 'email', ref: labMail.ref, title: labMail.title, meta: labMail.meta, spaceId: work() });
  assert.equal(note.spaceId, labSpace.id);
  const [link] = await ann.get(`/api/notes/${note.id}/links`);
  assert.equal(link.meta.conn, lab.id);
  assert.match((await ann.get(`/api/notes/${note.id}/links/${link.id}/mail`)).messages[0].text, /Budget lab/);

  // Older link, or one from another member: nothing says which mailbox, so each is tried; the deep link learns it.
  const deep = await ann.post('/api/notes/from-item', { kind: 'email', ref: '2', title: 'Deep', meta: { from: 'b@x' }, spaceId: work() });
  assert.equal(deep.id, note.id, 'same e-mail, same note');
  const plain = await ann.post('/api/notes', { spaceId: work(), title: 'Old' });
  const old = await ann.post(`/api/notes/${plain.id}/links`, { kind: 'email', ref: '2', title: 'Old link' });
  assert.match((await ann.get(`/api/notes/${plain.id}/links/${old.id}/mail`)).messages[0].text, /Budget lab/);
  const gone = await ann.post(`/api/notes/${plain.id}/links`, { kind: 'email', ref: '77', title: 'Elsewhere' });
  const r = await app.inject({ url: `/api/notes/${plain.id}/links/${gone.id}/mail`, headers: { cookie: ann.cookie } });
  assert.equal(r.statusCode, 404);
  assert.match(r.body, /shared space/);

  // Tasks go to the mailbox of the page's space, and ticks go back with that token.
  const page = await ann.post('/api/notes', { spaceId: labSpace.id, title: 'Plan', markdown: '- [ ] Lab task' });
  await ann.post(`/api/notes/${page.id}/tasks`, { items: [{ text: 'New lab job' }] });
  assert.equal(calls.filter((c) => c.name === 'create_task').at(-1).token, 'hmcp_lab');
  await ann.post(`/api/notes/${page.id}/links`, { kind: 'task', ref: '11', title: 'Lab task' }); // no connection known
  const { setTodoChecked } = await import('../src/docmodel.js');
  await withDoc(page.id, (d) => setTodoChecked(d, 'Lab task', true), ann.user);
  await sleep(2200);
  await drain();
  assert.equal(MAILBOXES.hmcp_lab.tasks[0].done, true);
  assert.equal(calls.filter((c) => c.name === 'complete_task').at(-1).token, 'hmcp_lab');

  // Done in the shared space → ticked here, on the poll.
  MAILBOXES.hmcp_lab.tasks[0].done = false;
  await ann.post('/api/halcyon/pull-tasks');
  assert.match((await ann.get(`/api/notes/${page.id}/export`)), /- \[ \] Lab task/);

  // Editing keeps the saved token unless a new one comes; a wrong one is refused.
  const edited = await ann.patch(`/api/integrations/halcyon/connections/${lab.id}`, { name: 'Lab shared' });
  assert.equal(edited.connections[1].name, 'Lab shared');
  assert.equal(await ann.status('PATCH', `/api/integrations/halcyon/connections/${lab.id}`, { token: 'hmcp_nope' }), 502);
  const bob = await signup(app, 'multi-bob@test.local');
  assert.equal(await bob.status('PATCH', `/api/integrations/halcyon/connections/${lab.id}`, { name: 'x' }), 404);
  await bob.del(`/api/integrations/halcyon/connections/${lab.id}`);
  assert.equal((await ann.get('/api/integrations/halcyon')).connections.length, 2, 'not theirs to remove');

  const left = await ann.del(`/api/integrations/halcyon/connections/${lab.id}`);
  assert.deepEqual(left.connections.map((c) => c.name), ['My mail']);
  assert.equal(left.connected, true);
});
