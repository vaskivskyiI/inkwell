// Sketch correction and the partial eraser (web/src/ink/shapes.js — pure functions shared with the browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognize, eraseFromStroke } from '../../web/src/ink/shapes.js';

// A hand-drawn version of a path: small wobble, uneven spacing.
const wobble = (pts, amp = 1.5) => pts.map(([x, y], i) => [x + Math.sin(i * 1.7) * amp, y + Math.cos(i * 2.3) * amp]);
const along = (vertices, n = 15) => vertices.slice(1).flatMap((b, i) => {
  const a = vertices[i];
  return Array.from({ length: n }, (_, k) => [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
}).concat([vertices[vertices.length - 1]]);

test('straight lines snap, nearly horizontal ones become horizontal', () => {
  const r = recognize(wobble(along([[10, 100], [300, 104]], 40)));
  assert.equal(r.kind, 'line');
  assert.ok(Math.abs(r.points[0][1] - r.points.at(-1)[1]) < 0.01, 'horizontal');
});

test('rectangles, triangles, circles and ellipses are recognised', () => {
  assert.equal(recognize(wobble(along([[50, 50], [250, 50], [250, 150], [50, 150], [52, 53]]))).kind, 'rectangle');
  assert.equal(recognize(wobble(along([[100, 20], [200, 200], [10, 200], [98, 24]]))).kind, 'triangle');
  const circle = Array.from({ length: 60 }, (_, i) => [200 + 80 * Math.cos(i / 9.3), 200 + 80 * Math.sin(i / 9.3)]);
  assert.equal(recognize(wobble(circle, 2)).kind, 'circle');
  const ellipse = Array.from({ length: 60 }, (_, i) => [200 + 150 * Math.cos(i / 9.3), 200 + 60 * Math.sin(i / 9.3)]);
  assert.equal(recognize(wobble(ellipse, 2)).kind, 'ellipse');
});

test('an angle becomes a straight polyline; handwriting is only smoothed; dots are left alone', () => {
  assert.equal(recognize(wobble(along([[10, 10], [150, 150], [300, 20]]))).kind, 'polyline');
  const scribble = Array.from({ length: 80 }, (_, i) => [i * 4, 50 + Math.sin(i / 2) * 20 + (i % 7) * 3]);
  assert.equal(recognize(scribble).kind, 'smooth');
  assert.equal(recognize([[5, 5], [6, 6], [7, 5]]), null);
});

test('partial eraser cuts a stroke in two and leaves untouched strokes alone', () => {
  let n = 0;
  const s = { id: 's', t: 'pen', c: '#000', w: 2, p: [0, 0, 0.5, 200, 0, 0.5] };
  const pieces = eraseFromStroke(s, 100, 0, 6, () => `n${++n}`);
  assert.equal(pieces.length, 2);
  assert.ok(pieces[0].p.at(-3) < 95 && pieces[1].p[0] > 105);
  assert.equal(pieces[0].c, '#000');
  assert.equal(eraseFromStroke(s, 100, 50, 6, () => 'x'), null);
});
