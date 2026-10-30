// Tags, connections between pages, annotated photos and the pen layer over typed pages.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { startServer, signup } from './helpers.js';

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
