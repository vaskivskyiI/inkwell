// Real WebSocket co-editing: two devices on one page, persistence, read-only viewers, live server edits.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { startServer, signup, waitFor, sleep } from './helpers.js';

let app, port, ann, bob, annToken, bobToken;
const providers = [];

before(async () => {
  ({ app, port } = await startServer({ listen: true }));
  ann = await signup(app, 'ann@test.local', 'Ann');
  bob = await signup(app, 'bob@test.local', 'Bob');
  annToken = (await ann.post('/api/tokens', { name: 'test' })).token;
  bobToken = (await bob.post('/api/tokens', { name: 'test' })).token;
});
after(async () => {
  for (const p of providers) { p.destroy(); p.configuration.websocketProvider.destroy(); }
  await sleep(100);
  await app.close();
});

function connect(noteId, token) {
  const doc = new Y.Doc();
  const ws = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/api/collab?token=${token}`, WebSocketPolyfill: WebSocket });
  let synced = false, failed = null;
  const p = new HocuspocusProvider({ websocketProvider: ws, name: `note:${noteId}`, document: doc, token: 'x',
    onSynced: () => { synced = true; }, onAuthenticationFailed: (e) => { failed = e; } });
  p.attach?.();
  providers.push(p);
  return { doc, p, synced: () => synced, failed: () => failed };
}

const typeInto = (doc, text) => doc.transact(() => {
  const frag = doc.getXmlFragment('default');
  const para = new Y.XmlElement('paragraph');
  para.insert(0, [new Y.XmlText(text)]);
  frag.insert(frag.length, [para]);
});
const bodyText = (doc) => doc.getXmlFragment('default').toArray().map((p) => p.toArray().map((t) => t.toString()).join('')).join('\n');

test('two devices edit one page at once and converge; the server stores the result', async () => {
  const sid = ann.spaces[0].id;
  const note = await ann.post('/api/notes', { spaceId: sid, title: 'Live', markdown: 'Start' });
  const a = connect(note.id, annToken), b = connect(note.id, annToken);
  await waitFor(() => a.synced() && b.synced());
  assert.equal(bodyText(a.doc), 'Start', 'initial content arrives from the database');
  typeInto(a.doc, 'from A');
  typeInto(b.doc, 'from B');
  await waitFor(() => bodyText(a.doc).includes('from B') && bodyText(b.doc).includes('from A'));
  assert.equal(bodyText(a.doc), bodyText(b.doc));
  // Title is collaborative too, and lands in the tree.
  a.doc.getText('title').insert(a.doc.getText('title').length, ' edited');
  await waitFor(async () => (await ann.get(`/api/notes/${note.id}`)).title === 'Live edited', { timeout: 15000 });
  const exported = await ann.get(`/api/notes/${note.id}/export`);
  assert.match(exported, /from A/);
  assert.match(exported, /from B/);
  // Search sees what was typed live.
  assert.ok((await ann.get('/api/search?q=from')).some((h) => h.id === note.id));
  // A version snapshot exists.
  assert.ok((await ann.get(`/api/notes/${note.id}/versions`)).length >= 1);
});

test('ink strokes sync like text', async () => {
  const note = await ann.post('/api/journal', { date: '2026-01-02' });
  const a = connect(note.id, annToken), b = connect(note.id, annToken);
  await waitFor(() => a.synced() && b.synced());
  a.doc.transact(() => {
    const ink = a.doc.getMap('ink');
    if (!ink.get('page')) ink.set('page', new Y.Array());
  });
  await waitFor(() => b.doc.getMap('ink').get('page'));
  a.doc.getMap('ink').get('page').push([{ id: 'a1', t: 'pen', c: '#000000', w: 3, p: [10, 10, 0.5, 40, 40, 0.5] }]);
  b.doc.getMap('ink').get('page').push([{ id: 'b1', t: 'pen', c: '#ff0000', w: 3, p: [100, 10, 0.5, 140, 40, 0.5] }]);
  await waitFor(() => a.doc.getMap('ink').get('page').length === 2 && b.doc.getMap('ink').get('page').length === 2);
  assert.equal(a.doc.getMap('ink').get('page').get(0).id, b.doc.getMap('ink').get('page').get(0).id);
});

test('viewers receive edits but cannot change the page; strangers cannot open it', async () => {
  const team = await ann.post('/api/spaces', { name: 'Readers' });
  const note = await ann.post('/api/notes', { spaceId: team.id, title: 'Read only', markdown: 'Original' });
  const stranger = connect(note.id, bobToken);
  await sleep(600);
  assert.equal(stranger.synced(), false, 'non-member does not get the document');
  await ann.post(`/api/spaces/${team.id}/members`, { email: 'bob@test.local', role: 'viewer' });
  const owner = connect(note.id, annToken), viewer = connect(note.id, bobToken);
  await waitFor(() => owner.synced() && viewer.synced());
  assert.equal(bodyText(viewer.doc), 'Original');
  typeInto(viewer.doc, 'vandalism');
  typeInto(owner.doc, 'owner text');
  await waitFor(() => bodyText(viewer.doc).includes('owner text'));
  await sleep(300);
  assert.ok(!bodyText(owner.doc).includes('vandalism'), 'viewer edits never reach others');
  await waitFor(async () => /owner text/.test(await ann.get(`/api/notes/${note.id}/export`)), { timeout: 15000 });
  assert.doesNotMatch(await ann.get(`/api/notes/${note.id}/export`), /vandalism/);
});

test('server-side edits (rename, append, restore) reach connected devices live', async () => {
  const note = await ann.post('/api/notes', { spaceId: ann.spaces[0].id, title: 'Server edits', markdown: 'v1' });
  const a = connect(note.id, annToken);
  await waitFor(() => a.synced());
  await ann.patch(`/api/notes/${note.id}`, { title: 'Renamed by REST' });
  await waitFor(() => a.doc.getText('title').toString() === 'Renamed by REST');
  await ann.post(`/api/notes/${note.id}/append`, { markdown: 'appended' });
  await waitFor(() => bodyText(a.doc).includes('appended'));
  const [v] = await ann.get(`/api/notes/${note.id}/versions`);
  assert.ok(v, 'a version exists');
  typeInto(a.doc, 'later change');
  await waitFor(() => bodyText(a.doc).includes('later change'));
  await ann.post(`/api/notes/${note.id}/versions/${v.id}/restore`);
  await waitFor(() => !bodyText(a.doc).includes('later change'));
});

test('page mentions become backlinks', async () => {
  const target = await ann.post('/api/notes', { spaceId: ann.spaces[0].id, title: 'Target' });
  const src = await ann.post('/api/notes', { spaceId: ann.spaces[0].id, title: 'Source' });
  const a = connect(src.id, annToken);
  await waitFor(() => a.synced());
  a.doc.transact(() => {
    const para = new Y.XmlElement('paragraph');
    const m = new Y.XmlElement('pageMention');
    m.setAttribute('id', target.id); m.setAttribute('title', 'Target');
    para.insert(0, [new Y.XmlText('see '), m]);
    a.doc.getXmlFragment('default').insert(0, [para]);
  });
  await waitFor(async () => (await ann.get(`/api/notes/${target.id}`)).backlinks.some((b) => b.id === src.id), { timeout: 15000 });
});

test('event socket: tree changes reach other members', async () => {
  const msgs = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${annToken}`);
  ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
  await waitFor(() => msgs.some((m) => m.type === 'hello'));
  const n = await ann.post('/api/notes', { spaceId: ann.spaces[0].id, title: 'Event me' });
  await waitFor(() => msgs.some((m) => m.type === 'note:created' && m.note.id === n.id));
  ws.close();
  // Cross-site pages cannot ride on the cookie.
  const evil = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { cookie: ann.cookie, origin: 'https://evil.example' } });
  const code = await new Promise((r) => evil.on('close', (c) => r(c)));
  assert.equal(code, 4401);
});
