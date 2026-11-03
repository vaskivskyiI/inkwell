// The layout of a handwritten page, read the way a person reads a paper notebook: headings (larger or underlined
// writing), dividers (a long level line), to-dos (a small box at the start of a line, done when something is
// written in it), bullets, boxed or circled parts and highlighted lines. Pure functions on strokes in logical
// units (tested in server/test), so the page can mark them and act on them.
import { recognize } from './shapes.js';

const kinds = new Map(); // stroke id → recognised shape (strokes never change, only get replaced)

function info(s) {
  const pts = [];
  for (let i = 0; i + 1 < (s.p || []).length; i += 3) pts.push([s.p[i], s.p[i + 1]]);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  let kind = kinds.get(s.id);
  if (kind === undefined) {
    kind = pts.length > 2 && Math.max(x1 - x0, y1 - y0) >= 12 ? recognize(pts)?.kind || null : null;
    if (kinds.size > 20000) kinds.clear();
    kinds.set(s.id, kind);
  }
  return { s, id: s.id, kind, x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

const median = (a) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const inside = (o, b, pad = 2) => o.cx > b.x0 - pad && o.cx < b.x1 + pad && o.cy > b.y0 - pad && o.cy < b.y1 + pad;
const overlapX = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));

/**
 * strokes → items sorted top to bottom: { kind: 'heading' | 'divider' | 'todo' | 'bullet' | 'box' | 'circled' |
 * 'highlight', key, level?, done?, x0, y0, x1, y1, ids, mark? } — `mark` is the box of a to-do.
 */
export function structure(strokes, { width = 1000 } = {}) {
  const all = strokes.filter((s) => s.p?.length >= 3).map(info);
  const pen = all.filter((o) => o.s.t !== 'hl'), hl = all.filter((o) => o.s.t === 'hl');
  const level = [], squares = [], rings = [], writing = [];
  for (const o of pen) {
    if (o.kind === 'line' && o.w >= 40 && o.h <= Math.max(8, 0.06 * o.w)) level.push(o);
    else if (o.kind === 'rectangle' || (o.kind === 'polygon' && o.w > 10 && o.h > 10 && o.w / o.h < 1.8 && o.h / o.w < 1.8 && o.w < 80)) squares.push(o);
    else if ((o.kind === 'circle' || o.kind === 'ellipse') && o.w > 40) rings.push(o);
    else if (o.h < 220) writing.push(o);
  }
  // Boxes and rings around writing; small empty-ish squares are to-do boxes.
  const encloses = (b) => writing.filter((o) => o !== b && inside(o, b) && o.w < b.w * 0.95);
  const boxes = [], checks = [];
  for (const b of squares) {
    const inner = encloses(b);
    const small = b.w < 80 && b.h < 80 && b.w / b.h < 1.7 && b.h / b.w < 1.7;
    if (small && inner.length <= 3) checks.push({ b, inner });
    else if (inner.length) boxes.push({ b, inner });
    else writing.push(b);
  }
  const circled = rings.map((b) => ({ b, inner: encloses(b) })).filter((r) => r.inner.length);
  for (const r of rings) if (!circled.some((c) => c.b === r)) writing.push(r);
  const checkInk = new Set(checks.flatMap((c) => c.inner));

  // Lines of writing: strokes whose middles fall within one band.
  const lines = [];
  for (const o of writing.filter((x) => !checkInk.has(x)).sort((a, b) => a.cy - b.cy)) {
    const l = lines[lines.length - 1];
    const lh = l ? Math.max(14, median(l.items.filter((x) => x.h >= 6).map((x) => x.h)) || l.y1 - l.y0) : 0;
    if (l && o.cy <= l.mid + lh * 0.6 && o.cy >= l.mid - lh * 0.6) {
      l.items.push(o); l.x0 = Math.min(l.x0, o.x0); l.x1 = Math.max(l.x1, o.x1); l.y0 = Math.min(l.y0, o.y0); l.y1 = Math.max(l.y1, o.y1);
      l.mid = l.items.reduce((s, x) => s + x.cy, 0) / l.items.length;
    } else lines.push({ items: [o], x0: o.x0, x1: o.x1, y0: o.y0, y1: o.y1, mid: o.cy });
  }
  for (const l of lines) {
    l.h = median(l.items.filter((x) => x.h >= 6).map((x) => x.h)) || (l.y1 - l.y0);
    l.items.sort((a, b) => a.x0 - b.x0);
  }
  const wordy = lines.filter((l) => l.items.length > 2);
  const typical = median((wordy.length >= 2 ? wordy : lines.filter((l) => l.items.length > 1)).map((l) => l.h)) || median(lines.map((l) => l.h)) || 30;

  const items = [];
  const add = (kind, o, extra = {}) => items.push({ kind, key: `${kind}:${o.key || o.items?.[0]?.id || o.id}`, x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1, ...extra });

  // Level lines: underline the writing just above them, or divide the page.
  const underlined = new Set();
  for (const u of level) {
    const above = lines.filter((l) => l.y1 <= u.cy + 6 && u.cy - l.y1 < Math.max(30, 0.9 * l.h) && overlapX(l, u) > 0.5 * Math.min(l.x1 - l.x0, u.w));
    const l = above.sort((a, b) => b.y1 - a.y1)[0];
    if (l) { underlined.add(l); l.under = u; } else if (u.w >= 0.3 * width) add('divider', u, { ids: [u.id] });
  }

  lines.forEach((l, i) => {
    // Larger writing is a heading only when it stands on its own: several lines to compare with, a few words wide,
    // not a drawing (far larger) and with room above it — a big word in the middle of a paragraph is not one.
    const prev = lines[i - 1], next = lines[i + 1];
    const alone = (!prev || l.y0 - prev.y1 > 0.35 * typical) && (!next || next.y0 - l.y1 > 0.2 * typical);
    const big = lines.length > 2 && l.h >= 1.6 * typical && l.h <= 4 * typical && l.x1 - l.x0 >= 2.5 * typical && alone;
    if (big || underlined.has(l)) {
      add('heading', l, { level: l.h >= 2.1 * typical ? 1 : big ? 2 : 3, ids: [...l.items.map((x) => x.id), ...(l.under ? [l.under.id] : [])] });
    } else {
      // A dot or a short dash first, then a gap, then the words.
      const [first, second] = l.items;
      const h = Math.max(l.h, 12);
      if (first && second && first.w <= 0.9 * h && first.h <= 0.45 * h && Math.abs(first.cy - l.mid) < 0.4 * h && second.x0 - first.x1 > 0.25 * h) add('bullet', { ...l, key: first.id }, { ids: l.items.map((x) => x.id) });
    }
  });

  for (const { b, inner } of checks) {
    const l = lines.find((x) => b.cy > x.mid - Math.max(x.h, b.h) && b.cy < x.mid + Math.max(x.h, b.h) && x.x0 >= b.x1 - 6 && x.x0 - b.x1 < 4 * Math.max(x.h, 20));
    if (l) add('todo', { ...l, x0: b.x0, key: b.id }, { done: inner.length > 0, mark: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }, box: b.id, ids: [b.id, ...inner.map((x) => x.id), ...l.items.map((x) => x.id)] });
  }
  for (const { b, inner } of boxes) add('box', b, { ids: [b.id, ...inner.map((x) => x.id)] });
  for (const { b, inner } of circled) add('circled', b, { ids: [b.id, ...inner.map((x) => x.id)] });
  for (const h of hl) {
    const l = lines.find((x) => h.cy > x.y0 - 4 && h.cy < x.y1 + 4 && overlapX(x, h) > 0.3 * h.w);
    if (l && !items.some((i) => i.kind === 'highlight' && i.y0 === l.y0)) add('highlight', { ...l, key: h.id }, { ids: [h.id, ...l.items.map((x) => x.id)] });
  }
  return items.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

/** The strokes from a heading down to the next heading of the same or a higher level, or a divider. */
export function sectionIds(strokes, items, heading) {
  const end = items.find((i) => i.y0 > heading.y1 && ((i.kind === 'heading' && i.level <= heading.level) || i.kind === 'divider'));
  const stop = end ? end.y0 - 2 : Infinity;
  return strokes.filter((s) => {
    let y = 0, n = 0;
    for (let i = 1; i < s.p.length; i += 3) { y += s.p[i]; n++; }
    y /= n || 1;
    return y >= heading.y0 - 4 && y < stop;
  }).map((s) => s.id);
}
