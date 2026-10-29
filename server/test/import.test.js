// Importing an AFFiNE snapshot export and a Notion-style Markdown zip.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { startServer, signup } from './helpers.js';

let app, ann;
before(async () => {
  ({ app } = await startServer());
  ann = await signup(app, 'ann@test.local', 'Ann');
});
after(() => app.close());

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201e2216bc50000000049454e44ae426082', 'hex');
const T = (delta) => ({ '$blocksuite:internal:text$': true, delta: typeof delta === 'string' ? [{ insert: delta }] : delta });
const blk = (flavour, props = {}, children = []) => ({ type: 'block', id: Math.random().toString(36).slice(2), flavour, props, children });

async function upload(c, name, data, fields) {
  const boundary = 'b0undary';
  const head = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('');
  const body = Buffer.concat([Buffer.from(`${head}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/zip\r\n\r\n`), Buffer.from(data), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const r = await app.inject({ method: 'POST', url: '/api/import', payload: body, headers: { cookie: c.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(r.statusCode, 200, r.body);
  return JSON.parse(r.body);
}

test('AFFiNE snapshot export: structure, links, sub-pages, images and pen strokes', async () => {
  const space = ann.spaces.find((s) => s.name === 'Work').id;
  const docB = { type: 'page', meta: { id: 'docB', title: 'Budget details', createDate: 1700000000000, tags: [] },
    blocks: blk('affine:page', { title: T('Budget details') }, [blk('affine:note', {}, [blk('affine:paragraph', { type: 'text', text: T('Travel costs 1200 EUR') })])]) };
  const docA = { type: 'page', meta: { id: 'docA', title: 'Project plan', createDate: 1690000000000, tags: [] },
    blocks: blk('affine:page', { title: T('Project plan') }, [
      blk('affine:surface', { elements: { type: '$blocksuite:internal:native$', value: {
        e1: { type: 'brush', xywh: '[100,100,200,50]', points: [[0, 0, 0.5], [100, 25, 0.6], [200, 50, 0.5]], color: '#ff0000', lineWidth: 4 },
        e2: { type: 'shape', xywh: '[0,0,10,10]' },
      } } }),
      blk('affine:note', {}, [
        blk('affine:paragraph', { type: 'h1', text: T('Goals') }),
        blk('affine:paragraph', { type: 'text', text: T([{ insert: 'Ship ' }, { insert: 'beta', attributes: { bold: true } }, { insert: ', see ' }, { insert: ' ', attributes: { reference: { type: 'LinkedPage', pageId: 'docB' } } }, { insert: ' and ' }, { insert: 'site', attributes: { link: 'https://example.com' } }]) }),
        blk('affine:list', { type: 'bulleted', text: T('Design') }, [blk('affine:list', { type: 'bulleted', text: T('Mockups') })]),
        blk('affine:list', { type: 'bulleted', text: T('Build') }),
        blk('affine:list', { type: 'todo', checked: true, text: T('Kick-off') }),
        blk('affine:list', { type: 'todo', checked: false, text: T('Review') }),
        blk('affine:list', { type: 'numbered', text: T('First') }),
        blk('affine:code', { language: 'js', text: T('let x = 1;') }),
        blk('affine:paragraph', { type: 'quote', text: T('Be bold') }),
        blk('affine:divider'),
        blk('affine:image', { sourceId: 'img1', caption: 'Logo' }),
        blk('affine:callout', { emoji: '⚠️' }, [blk('affine:paragraph', { type: 'text', text: T('Careful') })]),
        blk('affine:table', {
          rows: { r1: { rowId: 'r1', order: 'a0' }, r2: { rowId: 'r2', order: 'a1' } },
          columns: { c1: { columnId: 'c1', order: 'a0' }, c2: { columnId: 'c2', order: 'a1' } },
          cells: { 'r1:c1': { text: T('Item') }, 'r1:c2': { text: T('Cost') }, 'r2:c1': { text: T('Laptop') }, 'r2:c2': { text: T('900') } },
        }),
        blk('affine:embed-linked-doc', { pageId: 'docB' }),
      ]),
    ]) };
  const zip = zipSync({
    'Project plan-docA.snapshot.json': strToU8(JSON.stringify(docA, null, 2)),
    'Budget details-docB.snapshot.json': strToU8(JSON.stringify(docB, null, 2)),
    'assets/img1.png': PNG,
  });
  const r = await upload(ann, 'workspace.bs.zip', zip, { spaceId: space });
  assert.equal(r.format, 'affine');
  assert.equal(r.pages, 2);
  assert.equal(r.assets, 1);
  assert.ok(r.warnings.some((w) => /Shapes/.test(w)));

  const tree = (await ann.get(`/api/spaces/${space}/tree`)).notes;
  const a = tree.find((n) => n.title === 'Project plan'), b = tree.find((n) => n.title === 'Budget details');
  assert.equal(a.parentId, r.rootId);
  assert.equal(b.parentId, a.id, 'a doc embedded as a linked card becomes a sub-page');
  assert.equal(a.createdAt, 1690000000000, 'creation date is kept');

  const md = await ann.get(`/api/notes/${a.id}/export`);
  for (const s of ['# Goals', 'Ship **beta**, see [[Budget details]] and [site](https://example.com)', '- Design\n  - Mockups\n- Build',
    '- [x] Kick-off\n- [ ] Review', '1. First', '```js\nlet x = 1;\n```', '> Be bold', '---', '![Logo](/api/assets/', '_Logo_', '> ⚠️ Careful',
    '| Item | Cost |', '| Laptop | 900 |']) assert.ok(md.includes(s), `missing ${JSON.stringify(s)} in\n${md}`);
  assert.equal((await ann.get(`/api/notes/${b.id}`)).backlinks[0].id, a.id);
  // Pen strokes from the edgeless canvas arrive as an ink block.
  const { readDoc } = await import('../src/collab.js');
  const doc = await readDoc(a.id);
  const ink = [...doc.getMap('ink').values()][0].toArray();
  assert.equal(ink.length, 1);
  assert.equal(ink[0].c, '#ff0000');
  assert.ok((await ann.get('/api/search?q=travel costs')).some((h) => h.id === b.id), 'imported text is searchable');
});

test('Markdown zip (Notion style): folders become parents, images and links survive', async () => {
  const space = ann.spaces.find((s) => s.name === 'Private').id;
  const hex = 'a'.repeat(32);
  const zip = zipSync({
    [`Trip ${hex}.md`]: strToU8(`# Trip\n\nSee [packing](Trip%20${hex}/Packing%20${'b'.repeat(32)}.md) and [[Packing]].\n\n![map](Trip%20${hex}/map.png)`),
    [`Trip ${hex}/Packing ${'b'.repeat(32)}.md`]: strToU8('- [ ] passport\n- [ ] charger'),
    [`Trip ${hex}/map.png`]: PNG,
    'Notes/Loose.md': strToU8('Just text'),
  });
  const r = await upload(ann, 'Export.zip', zip, { spaceId: space });
  assert.equal(r.format, 'markdown');
  assert.equal(r.pages, 4, 'Trip, Packing, the Notes folder and Loose');
  const tree = (await ann.get(`/api/spaces/${space}/tree`)).notes;
  const trip = tree.find((n) => n.title === 'Trip'), packing = tree.find((n) => n.title === 'Packing');
  assert.equal(packing.parentId, trip.id);
  assert.equal(tree.find((n) => n.title === 'Loose').parentId, tree.find((n) => n.title === 'Notes').id);
  const md = await ann.get(`/api/notes/${trip.id}/export`);
  assert.match(md, /See \[\[Packing\]\] and \[\[Packing\]\]\./);
  assert.match(md, /!\[map\]\(\/api\/assets\//);
  assert.match(await ann.get(`/api/notes/${packing.id}/export`), /- \[ \] passport/);
});

test('import needs editor access and something importable', async () => {
  const bob = await signup(app, 'bob@test.local');
  const r = await app.inject({ method: 'POST', url: '/api/import', payload: '--x\r\nContent-Disposition: form-data; name="spaceId"\r\n\r\n' + ann.spaces[0].id + '\r\n--x\r\nContent-Disposition: form-data; name="file"; filename="a.md"\r\n\r\nhi\r\n--x--\r\n', headers: { cookie: bob.cookie, 'content-type': 'multipart/form-data; boundary=x' } });
  assert.equal(r.statusCode, 404);
  const bad = await app.inject({ method: 'POST', url: '/api/import', payload: `--x\r\nContent-Disposition: form-data; name="spaceId"\r\n\r\n${ann.spaces[0].id}\r\n--x\r\nContent-Disposition: form-data; name="file"; filename="a.zip"\r\n\r\n${zipSync({ 'x.txt': strToU8('x') }).toString()}\r\n--x--\r\n`, headers: { cookie: ann.cookie, 'content-type': 'multipart/form-data; boundary=x' } });
  assert.equal(bad.statusCode, 400);
});
