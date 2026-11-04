// Handwriting on the clipboard (web/src/ink/clipboard.js): a picture for other apps that carries the strokes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { inkHtml, inkFromHtml, placeAt, inkBlockFrom } from '../../web/src/ink/clipboard.js';

const strokes = [
  { id: 'a', t: 'pen', c: '#1f2937', w: 2, a: { b: 'x', o: 3 }, p: [100, 200, 0.5, 180, 220, 0.6, 240, 210, 0.5] },
  { id: 'b', t: 'hl', c: '#fde047', w: 14, p: [120, 260, 0.5, 300, 262, 0.5] },
];

test('copied ink round-trips through clipboard HTML, without anchors; other HTML is not ink', () => {
  const html = inkHtml(strokes);
  assert.match(html, /^<img alt="Handwriting" data-inkwell-ink="[A-Za-z0-9+/=]+" src="data:image\/svg\+xml;base64,/);
  const back = inkFromHtml(`<meta charset="utf-8">${html}`);
  assert.deepEqual(back.map((s) => s.p), strokes.map((s) => s.p));
  assert.equal(back[0].a, undefined);
  assert.equal(inkFromHtml('<p>hello</p>'), null);
  assert.equal(inkFromHtml('<img data-inkwell-ink="bm9wZQ==">'), null);
});

test('pasted ink lands with its corner at a point, with new ids; into a page as a drawing block', () => {
  const placed = placeAt(strokes, 500, 40);
  assert.notEqual(placed[0].id, 'a');
  const xs = placed.flatMap((s) => s.p.filter((_, i) => i % 3 === 0)), ys = placed.flatMap((s) => s.p.filter((_, i) => i % 3 === 1));
  assert.ok(Math.min(...xs) > 500 && Math.min(...xs) < 520, String(Math.min(...xs)));
  assert.ok(Math.min(...ys) > 40 && Math.min(...ys) < 60, String(Math.min(...ys)));
  const doc = new Y.Doc();
  const [block, para] = inkBlockFrom(doc, strokes);
  assert.equal(block.type, 'inkBlock');
  assert.equal(para.type, 'paragraph');
  assert.equal(doc.getMap('ink').get(block.attrs.id).length, 2);
  assert.ok(block.attrs.height >= 80);
});
