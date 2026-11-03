// Page structure from handwriting (web/src/ink/structure.js — pure functions shared with the browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structure, sectionIds } from '../../web/src/ink/structure.js';

let n = 0;
const stroke = (pts, t = 'pen') => ({ id: `s${n++}`, t, w: 2, p: pts.flatMap(([x, y]) => [x, y, 0.5]) });
const along = (vertices, step = 3) => vertices.slice(1).flatMap((b, i) => {
  const a = vertices[i];
  const k = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
  return Array.from({ length: k }, (_, j) => [a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
}).concat([vertices[vertices.length - 1]]);
// A handwritten word: a zig-zag of the given letter height.
const word = (x, y, w, h) => stroke(along(Array.from({ length: Math.max(3, Math.round(w / 8)) }, (_, i) => [x + i * 8, y + (i % 2 ? 0 : -h)]), 2));
const line = (x, y, words, h = 22) => Array.from({ length: words }, (_, i) => word(x + i * 90, y, 70, h));

test('headings, dividers, to-dos, bullets, boxes and highlights are found', () => {
  const heading = line(60, 80, 2, 48);
  const body = [...line(60, 160, 4), ...line(60, 210, 3)];
  const divider = stroke(along([[40, 260], [900, 260]], 5));
  const box = stroke(along([[60, 300], [86, 300], [86, 326], [60, 326], [60, 301]], 2));
  const todo = line(110, 324, 3);
  const dot = stroke([[64, 392], [65, 393], [66, 392], [65, 391]]);
  const bulletText = line(100, 400, 3);
  const frame = stroke(along([[40, 450], [500, 450], [500, 560], [40, 560], [40, 452]], 4));
  const framed = line(80, 520, 3);
  const mark = stroke(along([[60, 200], [330, 200]], 4), 'hl');
  const strokes = [...heading, ...body, divider, box, ...todo, dot, ...bulletText, frame, ...framed, mark];
  const items = structure(strokes);
  const kinds = items.map((i) => i.kind);
  assert.ok(kinds.includes('heading'), kinds.join());
  assert.equal(items.find((i) => i.kind === 'heading').y0 < 100, true);
  assert.ok(kinds.includes('divider'), kinds.join());
  const t = items.find((i) => i.kind === 'todo');
  assert.ok(t && !t.done && t.box === box.id, kinds.join());
  assert.ok(kinds.includes('bullet'), kinds.join());
  assert.ok(items.some((i) => i.kind === 'box' && i.ids.includes(framed[0].id)), kinds.join());
  assert.ok(kinds.includes('highlight'), kinds.join());

  // Something written in the box: done. The heading's section ends at the divider.
  const tick = stroke(along([[64, 312], [72, 320], [82, 304]], 2));
  assert.equal(structure([...strokes, tick]).find((i) => i.kind === 'todo').done, true);
  const sec = sectionIds(strokes, items, items.find((i) => i.kind === 'heading'));
  assert.ok(sec.includes(body[0].id) && !sec.includes(divider.id) && !sec.includes(todo[0].id));
});

test('an underline makes a heading; plain lines of writing are left alone', () => {
  const title = line(60, 100, 2);
  const under = stroke(along([[55, 112], [240, 112]], 4));
  const rest = [...line(60, 160, 4), ...line(60, 210, 4)];
  const items = structure([...title, under, ...rest]);
  assert.deepEqual(items.map((i) => i.kind), ['heading']);
  assert.ok(items[0].ids.includes(under.id));
});

test('large writing inside a paragraph, a lone big word or a sketch is not a heading', () => {
  const para = [...line(60, 100, 4), ...line(60, 132, 4), ...line(60, 164, 4), ...line(60, 196, 4)];
  const shout = [word(420, 132, 70, 40)]; // one big word on a line of normal writing, no room around it
  const tight = line(60, 236, 3, 36); // larger, but right under the paragraph
  const sketch = line(60, 420, 2, 150); // far larger than writing: a drawing
  const items = structure([...para, ...shout, ...tight, ...sketch]);
  assert.deepEqual(items.filter((i) => i.kind === 'heading'), []);
});
