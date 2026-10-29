import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { buildDoc, extract, markdownToBlocks, appendBlocks, strokesHash } from '../src/docmodel.js';
import { strokesToSvg, strokesToPng } from '../src/ink/render.js';
import { parseQuery } from '../src/search.js';
import { parseJson } from '../src/ai/router.js';
import { chunk } from '../src/ai/tasks.js';
import { pageHtml } from '../src/html.js';
import { encrypt, decrypt, hashPassword, verifyPassword } from '../src/util/crypto.js';

const MD = `# Plan

Some **bold** and _italic_ text with \`code\` and a [link](https://example.com).

- one
- two
  - nested
1. first
2. second

- [ ] open task
- [x] done task

> a quote

\`\`\`js
const x = 1;
\`\`\`

| A | B |
| --- | --- |
| 1 | 2 |

---

Tags: #project-x #idea`;

test('markdown → blocks → doc → markdown keeps structure', () => {
  const doc = buildDoc({ title: 'T', blocks: markdownToBlocks(MD) });
  const { markdown, text, tags, title } = extract(doc);
  assert.equal(title, 'T');
  for (const s of ['# Plan', '**bold**', '_italic_', '`code`', '[link](https://example.com)', '- one', '  - nested', '1. first', '2. second',
    '- [ ] open task', '- [x] done task', '> a quote', '```js\nconst x = 1;\n```', '| A | B |', '| 1 | 2 |', '---']) {
    assert.ok(markdown.includes(s), `markdown should contain ${JSON.stringify(s)}\n---\n${markdown}`);
  }
  assert.ok(!text.includes('**'), 'plain text has no markup');
  assert.ok(text.includes('open task'));
  assert.deepEqual(tags.sort(), ['idea', 'project-x']);
});

test('y-prosemirror shape: elements named by node type, marks as text attributes', () => {
  const doc = buildDoc({ blocks: markdownToBlocks('Hello **world**') });
  const p = doc.getXmlFragment('default').get(0);
  assert.equal(p.nodeName, 'paragraph');
  const delta = p.get(0).toDelta();
  assert.deepEqual(delta, [{ insert: 'Hello ' }, { insert: 'world', attributes: { bold: {} } }]);
});

test('ink blocks use their transcription; deleted blocks are ignored', () => {
  const doc = buildDoc({ blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Before' }] }, { type: 'inkBlock', attrs: { id: 'c1', height: 200 } }] });
  const ink = doc.getMap('ink');
  const a = new Y.Array(); a.push([{ id: 's1', t: 'pen', c: '#000000', w: 3, p: [10, 10, 0.5, 50, 40, 0.6, 90, 20, 0.5] }]);
  const b = new Y.Array(); b.push([{ id: 's2', t: 'pen', c: '#000000', w: 3, p: [1, 1, 0.5, 2, 2, 0.5] }]);
  ink.set('c1', a); ink.set('orphan', b);
  const before = extract(doc);
  assert.equal(before.canvases.length, 1);
  assert.equal(before.canvases[0].id, 'c1');
  assert.match(before.markdown, /not transcribed yet/);
  const after = extract(doc, { recognitions: { c1: 'hello from the pen' } });
  assert.match(after.markdown, /> hello from the pen/);
  assert.match(after.text, /hello from the pen/);
  assert.notEqual(before.hash, after.hash);
  assert.equal(strokesHash([{ id: 'a' }, { id: 'b' }]), strokesHash([{ id: 'a' }, { id: 'b' }]));
});

test('strokes render to SVG and PNG', async () => {
  const strokes = [{ id: 's', t: 'pen', c: '#1d4ed8', w: 4, p: [10, 10, 0.4, 60, 30, 0.7, 120, 15, 0.5, 180, 60, 0.6] }, { id: 'h', t: 'hl', c: '#facc15', w: 18, p: [5, 80, 0.5, 200, 80, 0.5] }];
  const svg = strokesToSvg(strokes);
  assert.match(svg, /<svg[^>]+viewBox="0 0 1000 /);
  assert.equal((svg.match(/<path /g) || []).length, 2);
  assert.match(svg, /fill-opacity="0.35"/);
  const { png, width, height } = await strokesToPng(strokes);
  assert.equal(Buffer.from(png).subarray(1, 4).toString(), 'PNG');
  assert.ok(width > 200 && height > 50);
});

test('html export escapes content and drops unsafe links', () => {
  const doc = buildDoc({ title: '<x>', blocks: markdownToBlocks('[bad](javascript:alert(1)) <script>alert(1)</script>') });
  const html = pageHtml(doc, { title: '<x>' });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('javascript:'));
  assert.match(html, /&lt;x&gt;/);
});

test('appendBlocks adds to an existing doc', () => {
  const doc = buildDoc({ blocks: markdownToBlocks('one') });
  appendBlocks(doc, markdownToBlocks('## two'));
  assert.equal(extract(doc).markdown, 'one\n\n## two');
});

test('search query operators', () => {
  assert.deepEqual(parseQuery('budget tag:Finance kind:journal #ideas in:work "exact words"'), { words: ['budget', 'exact', 'words'], tags: ['finance', 'ideas'], kind: 'journal', space: 'work' });
});

test('helpers: JSON from models, chunking, secrets, passwords', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Sure! {"a":2} hope that helps'), { a: 2 });
  const parts = chunk(`${'a'.repeat(800)}\n\n${'b'.repeat(800)}\n\n${'c'.repeat(100)}`);
  assert.equal(parts.length, 2);
  assert.equal(decrypt(encrypt('s3cret')), 's3cret');
  const h = hashPassword('pw-12345');
  assert.ok(verifyPassword('pw-12345', h));
  assert.ok(!verifyPassword('nope', h));
});
