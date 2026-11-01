import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { startServer, signup, waitFor } from './helpers.js';

let app, ann, bob;
before(async () => {
  ({ app } = await startServer());
  ann = await signup(app, 'ann@test.local', 'Ann');
  bob = await signup(app, 'bob@test.local', 'Bob');
});
after(() => app.close());

const space = (c, name) => c.spaces.find((s) => s.name === name);

function multipart(fields, name, data, type = 'application/octet-stream') {
  const b = 'b0undary';
  const head = Object.entries(fields).map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('');
  return { payload: Buffer.concat([Buffer.from(`${head}--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`)]),
    'content-type': `multipart/form-data; boundary=${b}` };
}

test('uploads and imports have no size cap and stream to disk', async () => {
  const sid = space(ann, 'Work').id;
  const big = Buffer.alloc(70 * 1024 * 1024, 7); // over the old 50 MB limit
  big.write('the end', big.length - 7);
  const m = multipart({ spaceId: sid }, 'big.bin', big);
  const r = await app.inject({ method: 'POST', url: '/api/assets', payload: m.payload, headers: { cookie: ann.cookie, 'content-type': m['content-type'] } });
  assert.equal(r.statusCode, 200, r.body);
  const up = JSON.parse(r.body);
  assert.equal(up.size, big.length);
  const got = await app.inject({ method: 'GET', url: up.url, headers: { cookie: ann.cookie } });
  assert.equal(got.rawPayload.length, big.length);
  assert.equal(got.rawPayload.subarray(-7).toString(), 'the end');

  // A zip with a picture over the in-memory threshold: the entry is extracted as a stream.
  const pic = Buffer.alloc(40 * 1024 * 1024, 1);
  pic.set([0x89, 0x50, 0x4e, 0x47]);
  const zip = Buffer.from(zipSync({ 'Notes/Big picture.md': strToU8('# Big picture\n\n![photo](img/photo.png)\n'), 'Notes/img/photo.png': pic }));
  const z = multipart({ spaceId: sid }, 'notes.zip', zip, 'application/zip');
  const ir = await app.inject({ method: 'POST', url: '/api/import', payload: z.payload, headers: { cookie: ann.cookie, 'content-type': z['content-type'] } });
  assert.equal(ir.statusCode, 200, ir.body);
  assert.equal(JSON.parse(ir.body).assets, 1);
  const { notes } = await ann.get(`/api/spaces/${sid}/tree`);
  const page = notes.find((n) => n.title === 'Big picture');
  const md = await ann.get(`/api/notes/${page.id}/export`);
  const id = /\/api\/assets\/([0-9a-f-]{36})/.exec(md)[1];
  const img = await app.inject({ method: 'GET', url: `/api/assets/${id}`, headers: { cookie: ann.cookie } });
  assert.equal(img.rawPayload.length, pic.length);
});

test('a page edited as Markdown keeps handwriting, makes callouts and page links, and notices a co-editor', async () => {
  const sid = space(ann, 'Work').id;
  const target = await ann.post('/api/notes', { spaceId: sid, title: 'Roadmap' });
  const p = await ann.post('/api/notes', { spaceId: sid, title: 'Plan', markdown: '# Goals\n\n- one\n- two' });
  const { withDoc } = await import('../src/collab.js');
  const { appendBlocks } = await import('../src/docmodel.js');
  await withDoc(p.id, (d) => appendBlocks(d, [{ type: 'inkBlock', attrs: { id: 'ink1', height: 200 } }, { type: 'callout', attrs: { emoji: '⚠️' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Careful' }] }] }]), ann.user);

  const src = await ann.get(`/api/notes/${p.id}/markdown`);
  assert.match(src.markdown, /^# Goals/);
  assert.match(src.markdown, /<!-- keep:0 ✍️ handwriting/);
  assert.match(src.markdown, /> \[!⚠️\]\n> Careful/);
  assert.equal(src.keep[0].type, 'inkBlock');

  const edited = src.markdown.replace('- two', '- two\n- three, see [[roadmap#Q1]]') + '\n\n> [!TIP] Use **Markdown**';
  await ann.put(`/api/notes/${p.id}/markdown`, { markdown: edited, keep: src.keep, base: src.base });
  const after = await ann.get(`/api/notes/${p.id}/markdown`);
  assert.match(after.markdown, /- three, see \[\[Roadmap#Q1\]\]/);
  assert.match(after.markdown, /> \[!💡\]\n> Use \*\*Markdown\*\*/);
  assert.equal(after.keep[0].attrs.id, 'ink1');

  // Someone else changed the page after this Markdown was loaded.
  await withDoc(p.id, (d) => appendBlocks(d, [{ type: 'paragraph', content: [{ type: 'text', text: 'From Bob' }] }]), ann.user);
  assert.equal(await ann.status('PUT', `/api/notes/${p.id}/markdown`, { markdown: 'mine', keep: [], base: after.base }), 409);
  await ann.put(`/api/notes/${p.id}/markdown`, { markdown: 'mine', keep: [], base: after.base, force: true });
  assert.equal((await ann.get(`/api/notes/${p.id}/markdown`)).markdown, 'mine');
  assert.equal(await bob.status('GET', `/api/notes/${p.id}/markdown`), 404);
});

test('calendar: pages created and worked on in a range, only my work, other people see only their spaces', async () => {
  const sid = space(ann, 'Work').id;
  const t0 = Date.now();
  const p = await ann.post('/api/notes', { spaceId: sid, title: 'Diary of today' });
  const { withDoc } = await import('../src/collab.js');
  const { appendBlocks } = await import('../src/docmodel.js');
  await withDoc(p.id, (d) => appendBlocks(d, [{ type: 'paragraph', content: [{ type: 'text', text: 'worked on it' }] }]), ann.user);
  const range = `from=${t0 - 864e5}&to=${t0 + 864e5}`;
  const rows = await waitFor(async () => { const r = await ann.get(`/api/calendar?${range}`); const n = r.find((x) => x.id === p.id); return n?.edits.length && r; });
  const n = rows.find((x) => x.id === p.id);
  assert.ok(n.createdAt >= t0 && n.edits[0] <= Date.now());
  assert.ok((await ann.get(`/api/calendar?${range}&mine=1&space=${sid}`)).some((x) => x.id === p.id));
  assert.ok(!(await bob.get(`/api/calendar?${range}`)).some((x) => x.id === p.id));
  assert.equal(await bob.status('GET', `/api/calendar?${range}&space=${sid}`), 404);
  assert.ok(!(await ann.get(`/api/calendar?from=${t0 - 30 * 864e5}&to=${t0 - 20 * 864e5}`)).some((x) => x.id === p.id));
  assert.equal(await ann.status('GET', '/api/calendar?from=1&to=0'), 400);
});

test('photo from another device: active page, request, drop claimed by a device or placed at the end', async () => {
  const sid = space(ann, 'Work').id;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201e2216bc50000000049454e44ae426082', 'hex');
  const page = await ann.post('/api/notes', { spaceId: sid, title: 'Lecture' });
  const journal = await ann.post('/api/notes', { spaceId: sid, title: 'Sketches', kind: 'journal' });
  const uploadTo = async (noteId) => {
    const m = multipart({ noteId }, 'photo.png', png, 'image/png');
    return JSON.parse((await app.inject({ method: 'POST', url: '/api/assets', payload: m.payload, headers: { cookie: ann.cookie, 'content-type': m['content-type'] } })).body);
  };

  assert.equal((await ann.get('/api/capture/target')).target, null);
  await ann.post('/api/me/active', { noteId: page.id });
  assert.equal((await ann.get('/api/capture/target')).target.title, 'Lecture');
  assert.equal(await bob.status('POST', '/api/me/active', { noteId: page.id }), 404);
  assert.equal((await bob.get('/api/capture/target')).target, null);
  await ann.post(`/api/notes/${page.id}/capture-request`, { from: 'desk' });

  // A device showing the page claims the drop: the server leaves the page alone.
  const a1 = await uploadTo(page.id);
  const pending = ann.post(`/api/notes/${page.id}/drop`, { assetId: a1.id, w: 400, h: 300 });
  const { one } = await import('../src/db/index.js');
  const drop = await waitFor(() => one('SELECT id FROM drops WHERE asset_id = $1', a1.id));
  assert.equal((await ann.post(`/api/drops/${drop.id}/claim`)).ok, true);
  assert.equal((await ann.post(`/api/drops/${drop.id}/claim`)).ok, false);
  assert.equal(await bob.post(`/api/drops/${drop.id}/claim`).then((r) => r.ok), false);
  assert.equal((await pending).placed, 'device');
  assert.doesNotMatch(await ann.get(`/api/notes/${page.id}/export`), /api\/assets/);

  // Nobody claims it: at the end of the page, or on the journal's paper below everything.
  const a2 = await uploadTo(page.id);
  assert.equal((await ann.post(`/api/notes/${page.id}/drop`, { assetId: a2.id, w: 400, h: 300, wait: false })).placed, 'end');
  assert.ok((await ann.get(`/api/notes/${page.id}/export`)).includes(`](/api/assets/${a2.id})`), 'picture at the end');
  const a3 = await uploadTo(journal.id);
  assert.equal((await ann.post(`/api/notes/${journal.id}/drop`, { assetId: a3.id, w: 400, h: 200, wait: false })).placed, 'end');
  const { withDoc } = await import('../src/collab.js');
  await withDoc(journal.id, (d) => {
    const [img] = [...d.getMap('images').values()];
    assert.equal(img.get('src'), `/api/assets/${a3.id}`);
    assert.equal(img.get('ratio'), 0.5);
  }, ann.user);
  assert.equal(await bob.status('POST', `/api/notes/${page.id}/drop`, { assetId: a2.id }), 404);
});
