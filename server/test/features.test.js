// Tags, connections between pages, annotated photos and the pen layer over typed pages.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { startServer, signup, addMockAi } from './helpers.js';

let app, ann, withDoc;
before(async () => {
  ({ app } = await startServer());
  ({ withDoc } = await import('../src/collab.js'));
  ann = await signup(app, 'ann@test.local', 'Ann');
});
after(() => app.close());
const work = () => ann.spaces.find((s) => s.name === 'Work').id;

test('manual tags live in the page doc and merge with #hashtags', async () => {
  const n = await ann.post('/api/notes', { spaceId: work(), title: 'Tagged', markdown: 'About #budget planning' });
  await withDoc(n.id, (d) => { const t = new Y.Array(); t.push(['Finance', 'q4']); d.getMap('meta').set('tags', t); }, ann.user);
  const d = await ann.get(`/api/notes/${n.id}`);
  assert.deepEqual([...d.tags].sort(), ['budget', 'finance', 'q4']);
  const tags = await ann.get(`/api/tags?space=${work()}`);
  assert.ok(tags.some((t) => t.tag === 'finance' && t.count === 1));
  assert.ok((await ann.get('/api/search?q=tag:q4')).some((h) => h.id === n.id));
});

test('connections: links out, backlinks, cross-links, related by words, unlinked mentions', async () => {
  const solar = await ann.post('/api/notes', { spaceId: work(), title: 'Solar panels', markdown: 'Photovoltaic inverter installation on the garage roof, battery storage sizing.' });
  const roof = await ann.post('/api/notes', { spaceId: work(), title: 'Garage roof', markdown: 'Roof repair before the photovoltaic installation. Check the inverter cabling.' });
  const mention = await ann.post('/api/notes', { spaceId: work(), title: 'Shopping', markdown: 'Ask the installer about Solar panels warranty.' });
  const other = await ann.post('/api/notes', { spaceId: work(), title: 'Recipes', markdown: 'Pancakes with blueberries.' });
  await ann.post(`/api/notes/${solar.id}/links`, { kind: 'note', ref: other.id, title: 'Recipes', both: true });
  const c = await ann.get(`/api/notes/${solar.id}/connections`);
  assert.deepEqual(c.outgoing.map((x) => x.id), [other.id]);
  assert.deepEqual(c.backlinks.map((x) => x.id), [other.id], 'cross-link: the other page links back');
  assert.ok(c.related.some((x) => x.id === roof.id && x.via === 'words'), 'related without embeddings');
  assert.ok(!c.related.some((x) => x.id === other.id), 'linked pages are not repeated as related');
  assert.deepEqual(c.unlinked.map((x) => x.id), [mention.id]);
});

test('annotated photo and pen layer reach export, search text and the AI', async () => {
  const n = await ann.post('/api/notes', { spaceId: work(), title: 'Site visit', markdown: 'Notes from the visit' });
  await withDoc(n.id, (d) => {
    const el = new Y.XmlElement('inkBlock');
    el.setAttribute('id', 'ph1'); el.setAttribute('height', 300); el.setAttribute('bg', '/api/assets/00000000-0000-0000-0000-000000000001');
    d.getXmlFragment('default').insert(1, [el]);
    const a = new Y.Array(); a.push([{ id: 's', t: 'pen', c: '#dc2626', w: 3, p: [10, 10, 0.5, 90, 90, 0.5] }]);
    d.getMap('ink').set('ph1', a);
    const o = new Y.Array(); o.push([{ id: 'o', t: 'pen', c: '#000', w: 3, p: [5, 5, 0.5, 50, 5, 0.5] }]);
    d.getMap('ink').set('overlay', o);
  }, ann.user);
  const md = await ann.get(`/api/notes/${n.id}/export`);
  assert.match(md, /!\[annotated photo\]\(\/api\/assets\/0{8}-/);
  const html = await ann.get(`/api/notes/${n.id}/export?format=html`);
  assert.match(html, /<figure class="ink photo"><img src="\/api\/assets\/[^"]+" alt=""><div class="over"><svg/);
  assert.match(html, /Handwritten on the page/);
  const { extract } = await import('../src/docmodel.js');
  const { readDoc } = await import('../src/collab.js');
  const ids = extract(await readDoc(n.id)).canvases.map((c) => c.id).sort();
  assert.deepEqual(ids, ['overlay', 'ph1'], 'both canvases are sent to handwriting recognition');
});

test('journals and pages nest in both directions', async () => {
  const page = await ann.post('/api/notes', { spaceId: work(), title: 'Project' });
  const journal = await ann.post('/api/notes', { spaceId: work(), kind: 'journal', title: 'Sketches', parentId: page.id });
  const sub = await ann.post('/api/notes', { spaceId: work(), title: 'Typed notes', parentId: journal.id });
  const tree = (await ann.get(`/api/spaces/${work()}/tree`)).notes;
  assert.equal(tree.find((x) => x.id === journal.id).parentId, page.id);
  assert.equal(tree.find((x) => x.id === journal.id).kind, 'journal');
  assert.equal(tree.find((x) => x.id === sub.id).parentId, journal.id);
});

test('a note for a Halcyon item: created once, linked, with the item details', async () => {
  const ev = await ann.post('/api/notes/from-item', { kind: 'event', ref: '77', title: 'Board meeting', spaceId: work(),
    meta: { start: '2026-11-03T09:00:00Z', location: 'Room 2', attendees: 'Ann, Bob' } });
  assert.equal(ev.title, 'Board meeting 2026-11-03');
  const md = await ann.get(`/api/notes/${ev.id}/export`);
  assert.match(md, /\*\*Where:\*\* Room 2/);
  assert.match(md, /\*\*Attendees:\*\* Ann, Bob/);
  const again = await ann.post('/api/notes/from-item', { kind: 'event', ref: '77', title: 'Board meeting' });
  assert.equal(again.id, ev.id);
  assert.equal(again.existing, true);
  assert.equal((await ann.get('/api/links/lookup?kind=event&ref=77'))[0].id, ev.id);
  const mail = await ann.post('/api/notes/from-item', { kind: 'email', ref: '501', title: 'Budget draft', meta: { from: 'Bob <bob@x.y>' } });
  assert.match(await ann.get(`/api/notes/${mail.id}/export`), /\*\*From:\*\* Bob <bob@x\.y>[\s\S]*## Follow-ups/);
  const task = await ann.post('/api/notes/from-item', { kind: 'task', ref: '9', title: 'Send slides', meta: { due: '2026-11-04' } });
  assert.match(await ann.get(`/api/notes/${task.id}/export`), /\*\*Due:\*\* 2026-11-04/);
  assert.equal(await ann.status('POST', '/api/notes/from-item', { kind: 'calendar', ref: '1' }), 400);
});

test('recurring meetings: dated titles, one note per day, open to-dos carried over, smart categories', async () => {
  const a = await ann.post('/api/notes/from-item', { kind: 'event', ref: '500', title: 'Koordinacija vodij', spaceId: work(), meta: { start: '2026-10-06T08:00:00Z' } });
  assert.match(a.title, /^Koordinacija vodij 2026-10-06$/);
  await ann.post(`/api/notes/${a.id}/append`, { markdown: '- [ ] Pripravi poročilo\n- [x] Že narejeno' });
  const b = await ann.post('/api/notes/from-item', { kind: 'event', ref: '500', title: 'Koordinacija vodij', meta: { start: '2026-10-13T08:00:00Z' } });
  assert.notEqual(b.id, a.id, 'each occurrence has its own note');
  const again = await ann.post('/api/notes/from-item', { kind: 'event', ref: '500', title: 'Koordinacija vodij', meta: { start: '2026-10-13T09:00:00Z' } });
  assert.equal(again.id, b.id, 'same day, same note');
  const md = await ann.get(`/api/notes/${b.id}/export`);
  assert.match(md, /## From last time[\s\S]*\[\[Koordinacija vodij 2026-10-06\]\][\s\S]*- \[ \] Pripravi poročilo/);
  assert.doesNotMatch(md, /Že narejeno/);
  await ann.post('/api/notes/from-item', { kind: 'event', ref: '600', title: 'One-off', spaceId: work(), meta: { start: '2026-10-14T08:00:00Z' } });
  const smart = await ann.get(`/api/smart?space=${work()}`);
  const meetings = smart.find((g) => g.id === 'meetings');
  const sub = meetings.subs.find((s) => s.label === 'Koordinacija vodij');
  assert.equal(sub.count, 2);
  assert.deepEqual(new Set(sub.notes.map((n) => n.id)), new Set([a.id, b.id]));
  assert.ok(meetings.notes.some((n) => n.title.startsWith('One-off')));
  assert.equal((await ann.get('/api/links/lookup?kind=event&ref=500')).find((r) => r.id === a.id).date, '2026-10-06');
});

test('a Halcyon space label puts the note in the associated space', async () => {
  const lab = await ann.post('/api/spaces', { name: 'Lab' });
  const other = await ann.post('/api/spaces', { name: 'Elsewhere' });
  await ann.patch(`/api/spaces/${other.id}`, { settings: { halcyonSpace: 'Projekti' } });
  const byName = await ann.post('/api/notes/from-item', { kind: 'task', ref: '700', title: 'A', spaceId: work(), meta: { hspace: 'lab' } });
  assert.equal(byName.spaceId, lab.id, 'same name, any case');
  const byChoice = await ann.post('/api/notes/from-item', { kind: 'task', ref: '701', title: 'B', spaceId: work(), meta: { hspace: 'Projekti' } });
  assert.equal(byChoice.spaceId, other.id, 'chosen association');
  const none = await ann.post('/api/notes/from-item', { kind: 'task', ref: '702', title: 'C', spaceId: work(), meta: { hspace: 'Unknown' } });
  assert.equal(none.spaceId, work(), 'no match: the current space');
});

test('the client\'s day decides which occurrence a note belongs to', async () => {
  // 23:30 UTC on the 5th is already the 6th for a user east of Greenwich.
  const a = await ann.post('/api/notes/from-item', { kind: 'event', ref: '800', title: 'Late call', spaceId: work(), meta: { start: '2026-10-05T23:30:00Z', day: '2026-10-06' } });
  assert.match(a.title, /2026-10-06$/);
  assert.equal((await ann.get('/api/links/lookup?kind=event&ref=800'))[0].date, '2026-10-06');
  const again = await ann.post('/api/notes/from-item', { kind: 'event', ref: '800', title: 'Late call', meta: { start: '2026-10-05T23:45:00Z', day: '2026-10-06' } });
  assert.equal(again.id, a.id);
});

test('comments: quotes, replies, @mentions become notifications; commenters may comment, viewers not', async () => {
  const bob = await signup(app, 'bob@test.local', 'Bob Kos');
  const team = await ann.post('/api/spaces', { name: 'Comment team' });
  await ann.post(`/api/spaces/${team.id}/members`, { email: 'bob@test.local', role: 'commenter' });
  const n = await ann.post('/api/notes', { spaceId: team.id, title: 'Draft', markdown: 'Text' });
  const c = await ann.post(`/api/notes/${n.id}/comments`, { body: 'What do you think, @bob?', quote: 'Text' });
  assert.equal(c.quote, 'Text');
  const list = await bob.get('/api/notifications');
  assert.match(list[0].text, /mentioned you in “Draft”/);
  const r = await bob.post(`/api/notes/${n.id}/comments`, { body: 'Good', parentId: c.id });
  assert.equal(r.parentId, c.id);
  assert.match((await ann.get('/api/notifications'))[0].text, /replied/);
  await ann.patch(`/api/comments/${c.id}`, { resolved: true });
  assert.equal((await bob.get(`/api/notes/${n.id}/comments`))[0].resolved, true);
  await ann.patch(`/api/spaces/${team.id}/members/${bob.user.id}`, { role: 'viewer' });
  assert.equal(await bob.status('POST', `/api/notes/${n.id}/comments`, { body: 'x' }), 403);
});

test('to-dos and Halcyon tasks follow each other', async () => {
  const http = await import('node:http');
  const { drain } = await import('../src/ai/queue.js');
  const { pullTasks } = await import('../src/tasksync.js');
  const tasks = { 41: false };
  const calls = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { id, params } = JSON.parse(body);
      calls.push(params);
      if (params.name === 'complete_task') tasks[params.arguments.id] = params.arguments.done;
      const out = params.name === 'list_tasks' ? Object.entries(tasks).map(([i, done]) => ({ id: Number(i), title: 'x', done })) : params.name === 'create_task' ? { id: 41 } : [];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: Array.isArray(out) ? { items: out } : out } }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  try {
    await ann.put('/api/integrations/halcyon', { baseUrl: `http://127.0.0.1:${fake.address().port}`, token: 'hmcp_x' });
    const n = await ann.post('/api/notes', { spaceId: work(), title: 'Sync', markdown: '- [ ] Call Ana' });
    await ann.post(`/api/notes/${n.id}/tasks`, { items: [{ text: 'Call Ana' }] });
    // Ticked in Halcyon → ticked here.
    tasks[41] = true;
    assert.equal((await pullTasks(ann.user)).changed, 1);
    assert.match(await ann.get(`/api/notes/${n.id}/export`), /- \[x\] Call Ana/);
    // Unticked here → reopened in Halcyon.
    const { setTodoChecked } = await import('../src/docmodel.js');
    await withDoc(n.id, (d) => setTodoChecked(d, 'Call Ana', false), ann.user);
    await new Promise((r) => setTimeout(r, 2200));
    await drain();
    assert.equal(tasks[41], false);
    assert.equal(calls.filter((c) => c.name === 'complete_task').at(-1).arguments.done, false);
  } finally { fake.close(); await ann.del('/api/integrations/halcyon'); }
});

test('recordings are transcribed and join the page text; the weekly review reads recent pages', async () => {
  await addMockAi(ann);
  const { drain } = await import('../src/ai/queue.js');
  const n = await ann.post('/api/notes', { spaceId: work(), title: 'Standup' });
  const boundary = 'b0';
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="noteId"\r\n\r\n${n.id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="r.webm"\r\nContent-Type: audio/webm;codecs=opus\r\n\r\n`), Buffer.from('fakeaudio'), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const up = JSON.parse((await app.inject({ method: 'POST', url: '/api/assets', payload: body, headers: { cookie: ann.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` } })).body);
  assert.equal(up.mime, 'audio/webm');
  await withDoc(n.id, (d) => { const el = new Y.XmlElement('audioBlock'); el.setAttribute('src', up.url); d.getXmlFragment('default').insert(0, [el]); }, ann.user);
  await new Promise((r) => setTimeout(r, 1200));
  await drain();
  assert.match((await ann.get(`/api/assets/${up.id}/text`)).text, /ship on Friday/);
  assert.ok((await ann.get('/api/search?q=ship friday')).some((h) => h.id === n.id));
  const r = await app.inject({ method: 'POST', url: '/api/ai/review', payload: { spaceId: work(), days: 7 }, headers: { cookie: ann.cookie } });
  const last = JSON.parse(r.body.trim().split('\n').at(-1));
  assert.ok(last.done && last.pages > 0);
});

test('repeating tasks: one completion per tick, a moved due date ticks the to-do, polling never unticks', async () => {
  const http = await import('node:http');
  const { drain } = await import('../src/ai/queue.js');
  const { pullTasks } = await import('../src/tasksync.js');
  const { setTodoChecked } = await import('../src/docmodel.js');
  const task = { id: 51, title: 'x', done: false, due: '2026-11-02T08:00:00.000Z', repeats: true };
  let completions = 0;
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { id, params } = JSON.parse(body);
      let out = [];
      if (params.name === 'list_tasks') out = [task];
      if (params.name === 'create_task') out = { id: 51 };
      if (params.name === 'complete_task') { completions++; task.due = '2026-11-09T08:00:00.000Z'; out = { id: 51, done: false, next_due: task.due, completed_id: 900 + completions }; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: Array.isArray(out) ? { items: out } : out } }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  try {
    await ann.put('/api/integrations/halcyon', { baseUrl: `http://127.0.0.1:${fake.address().port}`, token: 'hmcp_x' });
    const n = await ann.post('/api/notes', { spaceId: work(), title: 'Weekly', markdown: '- [ ] Water plants' });
    await ann.post(`/api/notes/${n.id}/tasks`, { items: [{ text: 'Water plants' }] });
    await pullTasks(ann.user); // learns the due date
    // Ticked here: sent once, and the poll that sees it open again changes nothing.
    await withDoc(n.id, (d) => setTodoChecked(d, 'Water plants', true), ann.user);
    await new Promise((r) => setTimeout(r, 2200));
    await drain();
    assert.equal(completions, 1);
    await pullTasks(ann.user);
    assert.match(await ann.get(`/api/notes/${n.id}/export`), /- \[x\] Water plants/);
    // Unticked here: nothing is sent.
    await withDoc(n.id, (d) => setTodoChecked(d, 'Water plants', false), ann.user);
    await new Promise((r) => setTimeout(r, 2200));
    await drain();
    assert.equal(completions, 1);
    // Ticked in Halcyon: only the due date moves.
    task.due = '2026-11-16T08:00:00.000Z';
    await pullTasks(ann.user);
    assert.match(await ann.get(`/api/notes/${n.id}/export`), /- \[x\] Water plants/);
    assert.equal(completions, 1);
  } finally { fake.close(); await ann.del('/api/integrations/halcyon'); }
});

test('files: one copy per upload, removed only when no page uses them any more', async () => {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const { config } = await import('../src/config.js');
  const { collectAssets } = await import('../src/assets.js');
  const up = async (noteId, name, content = 'same bytes') => {
    const b = 'b1';
    const body = `--${b}\r\nContent-Disposition: form-data; name="noteId"\r\n\r\n${noteId}\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n${content}\r\n--${b}--\r\n`;
    return JSON.parse((await app.inject({ method: 'POST', url: '/api/assets', payload: body, headers: { cookie: ann.cookie, 'content-type': `multipart/form-data; boundary=${b}` } })).body);
  };
  const addLink = (id, a) => ann.post(`/api/notes/${id}/append`, { markdown: `[📎 ${a.name}](${a.url})` });
  const n1 = await ann.post('/api/notes', { spaceId: work(), title: 'Files 1' });
  const n2 = await ann.post('/api/notes', { spaceId: work(), title: 'Files 2' });
  const a = await up(n1.id, 'report.pdf');
  const b = await up(n2.id, 'copy of report.pdf');
  assert.equal(b.id, a.id, 'the same file in a space is one record');
  assert.equal(b.name, 'copy of report.pdf', 'the link keeps the name it was uploaded with');
  const { one } = await import('../src/db/index.js');
  const { sha256 } = await one('SELECT sha256 FROM assets WHERE id = $1', a.id);
  const file = path.join(config.assetsDir, sha256.slice(0, 2), sha256);
  await addLink(n1.id, a);
  await addLink(n2.id, b);
  await collectAssets({ graceMs: 0 });
  assert.equal((await ann.get(`/api/notes/${n1.id}/export`)).includes(a.url), true);
  assert.ok(await fsp.stat(file), 'in use: kept');
  // First page drops it: the other still uses it.
  const { withDoc } = await import('../src/collab.js');
  const clear = (id) => withDoc(id, (d) => { const f = d.getXmlFragment('default'); f.delete(0, f.length); }, ann.user);
  await clear(n1.id);
  await collectAssets({ graceMs: 0 });
  assert.ok(await fsp.stat(file), 'one page still uses it');
  // In the trash it still counts; gone for good it does not.
  await ann.del(`/api/notes/${n2.id}`);
  await collectAssets({ graceMs: 0 });
  assert.ok(await fsp.stat(file), 'restorable from the trash');
  await ann.del(`/api/notes/${n2.id}?permanent=1`);
  await collectAssets({ graceMs: 864e5 });
  assert.ok(await fsp.stat(file), 'grace period');
  assert.equal((await collectAssets({ graceMs: 0 })).removed, 1);
  await assert.rejects(fsp.stat(file));
  assert.equal(await ann.status('GET', a.url), 404);
  // Used again during the grace period: stays.
  const c = await up(n1.id, 'new.pdf', 'other bytes');
  await collectAssets({ graceMs: 864e5 });
  await addLink(n1.id, c);
  assert.equal((await collectAssets({ graceMs: 0 })).removed, 0);
  assert.equal(await ann.status('GET', c.url), 200);
});

test('a page moved to another space keeps its files readable there', async () => {
  const bob2 = await signup(app, 'carol@test.local', 'Carol');
  const team = await ann.post('/api/spaces', { name: 'Moved to' });
  await ann.post(`/api/spaces/${team.id}/members`, { email: 'carol@test.local', role: 'editor' });
  const n = await ann.post('/api/notes', { spaceId: work(), title: 'Mover file' });
  const b = 'b2';
  const body = `--${b}\r\nContent-Disposition: form-data; name="noteId"\r\n\r\n${n.id}\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="x.pdf"\r\nContent-Type: application/pdf\r\n\r\nmover\r\n--${b}--\r\n`;
  const a = JSON.parse((await app.inject({ method: 'POST', url: '/api/assets', payload: body, headers: { cookie: ann.cookie, 'content-type': `multipart/form-data; boundary=${b}` } })).body);
  await ann.post(`/api/notes/${n.id}/append`, { markdown: `[f](${a.url})` });
  assert.equal(await bob2.status('GET', a.url), 404);
  await ann.patch(`/api/notes/${n.id}`, { spaceId: team.id });
  assert.equal(await bob2.status('GET', a.url), 200);
});
