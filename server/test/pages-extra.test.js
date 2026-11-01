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
