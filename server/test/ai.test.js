// Background and on-demand AI with the deterministic mock provider, and Halcyon through a fake MCP endpoint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as Y from 'yjs';
import { startServer, signup, addMockAi } from './helpers.js';

let app, ann, drain, withDoc;
before(async () => {
  ({ app } = await startServer());
  ({ drain } = await import('../src/ai/queue.js'));
  ({ withDoc } = await import('../src/collab.js'));
  ann = await signup(app, 'ann@test.local', 'Ann');
});
after(() => app.close());

const work = () => ann.spaces.find((s) => s.name === 'Work').id;
const ndjson = (body) => String(body).trim().split('\n').map((l) => JSON.parse(l));

test('without a provider jobs wait; adding one resumes them', async () => {
  const n = await ann.post('/api/notes', { spaceId: work(), title: 'Waiting', markdown: 'This page waits for an AI provider to be configured by the user.' });
  await withDoc(n.id, (d) => d.getText('title').insert(0, '* '), ann.user); // a content change schedules analysis
  await drain();
  assert.equal((await ann.get(`/api/notes/${n.id}`)).insight, null);
  assert.equal((await ann.get('/api/ai/status')).chat, null);
  await addMockAi(ann);
  await drain();
  const d = await ann.get(`/api/notes/${n.id}`);
  assert.match(d.insight.summary, /^Summary: This page waits/);
});

test('analysis: summary, title, tags and open action items', async () => {
  const n = await ann.post('/api/notes', { spaceId: work(), title: '', markdown: 'Planning the conference logistics\n\n- [ ] book the venue\n- [x] invite speakers\n- [ ] order catering' });
  await ann.post(`/api/notes/${n.id}/ai/refresh`);
  await drain();
  const { insight } = await ann.get(`/api/notes/${n.id}`);
  assert.equal(insight.title, 'Planning the conference logistics');
  assert.deepEqual(insight.actions.map((a) => a.text), ['book the venue', 'order catering']);
  assert.ok(insight.tags.length > 0);
});

test('handwriting: strokes are rendered, read by the vision model, and become searchable text', async () => {
  const j = await ann.post('/api/journal', { date: '2026-03-04', spaceId: work() });
  await withDoc(j.id, (d) => {
    const arr = new Y.Array();
    arr.push([{ id: 's1', t: 'pen', c: '#000000', w: 3, p: [10, 10, 0.5, 60, 50, 0.6, 120, 20, 0.5] }, { id: 's2', t: 'pen', c: '#000000', w: 3, p: [200, 30, 0.5, 260, 70, 0.5] }]);
    d.getMap('ink').set('page', arr);
  }, ann.user);
  await drain();
  const d = await ann.get(`/api/notes/${j.id}`);
  assert.match(d.ink.page.text, /Handwritten note \(2 strokes\)/);
  assert.deepEqual(d.ink.page.data.todos, ['call Ana about the budget']);
  const hits = await ann.get('/api/search?q=Ana budget');
  assert.ok(hits.some((h) => h.id === j.id), 'handwriting is found by search');
  assert.match(await ann.get(`/api/notes/${j.id}/export`), /handwritten page/);
  // Unchanged ink is not read again; changed ink is.
  await ann.post(`/api/notes/${j.id}/ink/page/recognize`);
  await withDoc(j.id, (d2) => d2.getMap('ink').get('page').push([{ id: 's3', t: 'pen', c: '#000', w: 2, p: [1, 1, 0.5, 5, 5, 0.5] }]), ann.user);
  await drain();
  assert.match((await ann.get(`/api/notes/${j.id}`)).ink.page.text, /3 strokes/);
});

test('embeddings: semantic search and related pages', async () => {
  const a = await ann.post('/api/notes', { spaceId: work(), title: 'Gardening', markdown: 'tomatoes basil watering compost greenhouse seedlings' });
  const b = await ann.post('/api/notes', { spaceId: work(), title: 'More gardening', markdown: 'tomatoes compost greenhouse seedlings pruning' });
  await ann.post('/api/notes', { spaceId: work(), title: 'Taxes', markdown: 'invoice receipts deductions accountant deadline' });
  for (const n of [a, b]) await ann.post(`/api/notes/${n.id}/ai/refresh`);
  await drain();
  const hits = await ann.get('/api/search?q=greenhouse tomatoes');
  assert.ok(hits.find((h) => h.id === a.id).via.includes('meaning'));
  const rel = await ann.get(`/api/notes/${a.id}/related`);
  assert.equal(rel[0].id, b.id);
});

test('inline AI streams Markdown; the assistant answers with cited pages', async () => {
  const n = await ann.post('/api/notes', { spaceId: work(), title: 'Launch', markdown: 'The launch date is the 14th of November.' });
  const r = await app.inject({ method: 'POST', url: '/api/ai/inline', payload: { action: 'shorten', text: 'A long sentence to shorten', noteId: n.id }, headers: { cookie: ann.cookie } });
  const lines = ndjson(r.body);
  assert.ok(lines.filter((l) => l.t).length > 1, 'streams in pieces');
  assert.equal(lines.at(-1).text, 'AI: A long sentence to shorten');
  const ask = await app.inject({ method: 'POST', url: '/api/ai/ask', payload: { question: 'When is the launch date?', spaceId: work() }, headers: { cookie: ann.cookie } });
  const done = ndjson(ask.body).at(-1);
  assert.match(done.text, /^From your notes \[\d\]/);
  assert.ok(done.sources.some((s) => s.id === n.id));
  assert.equal((await app.inject({ method: 'POST', url: '/api/ai/inline', payload: { action: 'nope' }, headers: { cookie: ann.cookie } })).statusCode, 400);
});

test('a space restricted to local AI never uses cloud providers', async () => {
  const s = await ann.post('/api/spaces', { name: 'Secret' });
  await ann.patch(`/api/spaces/${s.id}`, { settings: { localAiOnly: true } });
  const { resolve } = await import('../src/ai/router.js');
  const { q } = await import('../src/db/index.js');
  await q('DELETE FROM ai_providers');
  await ann.post('/api/ai/providers', { type: 'openai', name: 'Cloud', apiKey: 'sk-test' });
  assert.equal(await resolve(ann.user.id, 'chat', { spaceId: s.id }), null);
  assert.equal((await resolve(ann.user.id, 'chat', { spaceId: work() })).name, 'Cloud');
  await ann.post('/api/ai/providers', { type: 'ollama', name: 'Local', baseUrl: 'http://127.0.0.1:11434' });
  assert.equal((await resolve(ann.user.id, 'chat', { spaceId: s.id })).name, 'Local');
  const list = await ann.get('/api/ai/providers');
  assert.ok(list.every((p) => !('apiKey' in p) && !('apiKeyEnc' in p)), 'keys never leave the server');
  await q('DELETE FROM ai_providers');
  await addMockAi(ann);
});

test('Halcyon: connect, search, meeting note from an event, action items become tasks', async () => {
  const calls = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer hmcp_good') { res.writeHead(401).end('{}'); return; }
      const { id, params } = JSON.parse(body);
      calls.push(params);
      const data = {
        list_tasks: [{ id: 7, title: 'Existing task', due: null, done: false }],
        list_events: [{ id: 99, title: 'Design review', start: new Date().toISOString(), end: new Date(Date.now() + 36e5).toISOString(), local_start: '10:00', all_day: false, location: 'Room 4', attendees: ['Ann', 'Bob'] }],
        search_mail: [{ id: 501, subject: 'Budget draft', from: 'Bob <bob@x.y>', date: '2026-10-01T10:00:00Z', summary: 'Bob sends the budget' }],
        get_conversation: { summary: 'Budget agreed', messages: [{ id: 501, from: 'Bob <bob@x.y>', date: '2026-10-01T10:00:00Z', subject: 'Budget draft', attachments: ['b.xlsx'], text_untrusted: 'Here is the budget.' }] },
        create_task: { id: 1000 + calls.length, title: params.arguments.title },
      }[params.name];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: Array.isArray(data) ? { items: data } : data } }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  try {
    assert.equal(await ann.status('PUT', '/api/integrations/halcyon', { baseUrl: base, token: 'hmcp_bad' }), 502);
    await ann.put('/api/integrations/halcyon', { baseUrl: `${base}/`, token: 'hmcp_good' });
    assert.equal((await ann.get('/api/integrations/halcyon')).connected, true);
    const mail = await ann.get('/api/halcyon/search?kind=email&q=budget');
    assert.equal(mail[0].title, 'Budget draft');
    const events = await ann.get('/api/halcyon/events');
    assert.equal(events[0].title, 'Design review');
    const note = await ann.post('/api/notes/meeting', { spaceId: work(), event: events[0] });
    assert.match(note.title, /^Design review \d{4}-\d{2}-\d{2}$/);
    const md = await ann.get(`/api/notes/${note.id}/export`);
    assert.match(md, /\*\*Where:\*\* Room 4/);
    assert.match(md, /\*\*Attendees:\*\* Ann, Bob/);
    const again = await ann.post('/api/notes/meeting', { spaceId: work(), event: events[0] });
    assert.equal(again.id, note.id, 'the same event opens the existing note');
    const links = await ann.get(`/api/notes/${note.id}/links`);
    assert.equal(links[0].kind, 'event');
    assert.match(links[0].openUrl, /#\/calendar$/);
    await ann.post(`/api/notes/${note.id}/links`, mail[0]);
    const emailLink = (await ann.get(`/api/notes/${note.id}/links`)).find((l) => l.kind === 'email');
    assert.match(emailLink.openUrl, /#\/mail\/unified\/501$/);
    const shown = await ann.get(`/api/notes/${note.id}/links/${emailLink.id}/mail`);
    assert.deepEqual([shown.summary, shown.messages[0].text, shown.messages[0].attachments], ['Budget agreed', 'Here is the budget.', ['b.xlsx']]);
    assert.equal(await ann.status('GET', `/api/notes/${note.id}/links/${links[0].id}/mail`), 404, 'only e-mails');
    const t = await ann.post(`/api/notes/${note.id}/tasks`, { items: [{ text: 'Send slides', due: '2026-11-02' }] });
    assert.equal(t.created.length, 1);
    assert.equal(calls.at(-1).name, 'create_task');
    assert.equal(calls.at(-1).arguments.due, '2026-11-02');
    assert.ok((await ann.get(`/api/notes/${note.id}/links`)).some((l) => l.kind === 'task' && l.title === 'Send slides'));
  } finally { fake.close(); }
});

test('providers can be edited; models are listed with their tasks and suggestions', async () => {
  const { describeModels } = await import('../src/ai/models.js');
  const [gpt, emb, tts] = describeModels('openai', [{ id: 'gpt-4.1-mini-2025' }, { id: 'text-embedding-3-small', embedding: true }, { id: 'gpt-4o-mini-tts' }]);
  assert.deepEqual([gpt.tasks, gpt.suggested], [['chat', 'vision'], ['chat', 'vision']]);
  assert.deepEqual([emb.tasks, emb.suggested], [['embed'], ['embed']]);
  assert.deepEqual(tts.tasks, []);
  assert.deepEqual(describeModels('ollama', [{ id: 'qwen2.5vl:7b' }])[0].tasks, ['chat', 'vision']);

  const { id } = await ann.post('/api/ai/providers', { type: 'openai', name: 'Editable', apiKey: 'sk-keep' });
  await ann.patch(`/api/ai/providers/${id}`, { name: 'Renamed', type: 'mock', baseUrl: '', apiKey: '' });
  const p = (await ann.get('/api/ai/providers')).find((x) => x.id === id);
  assert.deepEqual([p.name, p.type, p.hasKey], ['Renamed', 'mock', true]);
  assert.deepEqual((await ann.post('/api/ai/models', { id }))[0].id, 'mock');
  assert.ok((await ann.get('/api/ai/types')).find((t) => t.id === 'anthropic').advice.vision.models.length);

  // A shared key must not be pointed at an address of a plain user's choosing.
  const shared = await ann.post('/api/ai/providers', { type: 'mock', name: 'Shared', shared: true });
  const bob = await signup(app, 'bob-models@test.local');
  assert.equal((await bob.post('/api/ai/models', { id: shared.id }))[0].id, 'mock');
  assert.equal(await bob.status('POST', '/api/ai/models', { id: shared.id, baseUrl: 'http://attacker.test' }), 403);
  await ann.del(`/api/ai/providers/${id}`);
  await ann.del(`/api/ai/providers/${shared.id}`);
});

test('failed work can be retried, also when the same job failed more than once', async () => {
  const { q } = await import('../src/db/index.js');
  const n = await ann.post('/api/notes', { spaceId: work(), title: 'Failed twice' });
  const t = Date.now();
  for (const age of [2, 1]) await q("INSERT INTO jobs (user_id, type, ref, status, attempts, error, run_after, created_at, updated_at) VALUES ($1, 'embed', $2, 'failed', 4, 'boom', $3, $3, $3)", ann.user.id, n.id, t - age);
  assert.equal((await ann.get('/api/ai/failed')).length, 2);
  assert.deepEqual(await ann.post('/api/ai/failed/retry'), { queued: 1 });
  assert.equal((await ann.get('/api/ai/failed')).length, 0);
  await drain();
  assert.equal((await ann.get('/api/ai/failed')).length, 0, 'it worked this time');
});
