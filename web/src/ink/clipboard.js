// Copy / cut / paste of handwriting. On the system clipboard the strokes go as HTML: a picture of them (for other
// apps: Word, mail) that carries the strokes themselves in data-inkwell-ink, so pasting into any Inkwell canvas or page
// — on this or another device, in this or another page — gives back real ink. A copy inside the app is also kept
// here, for when the clipboard cannot be read (no permission, Android's WebView).
import * as Y from 'yjs';
import { outline, bounds, sid } from './geometry.js';

let kept = null; // { strokes, at }

const svgPath = (pts) => {
  if (pts.length < 4) return pts.length ? `M${pts[0][0] - 1},${pts[0][1]}a1,1 0 1,0 2,0a1,1 0 1,0 -2,0` : '';
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    d += `Q${x0.toFixed(1)},${y0.toFixed(1)} ${((x0 + x1) / 2).toFixed(1)},${((y0 + y1) / 2).toFixed(1)}`;
  }
  return `${d}Z`;
};

/** Strokes as a standalone SVG picture, cropped to them. */
export function strokesSvg(strokes) {
  const b = bounds(strokes);
  if (!b) return '';
  const x = Math.floor(b.minX - 4), y = Math.floor(b.minY - 4), w = Math.ceil(b.maxX - b.minX + 8), h = Math.ceil(b.maxY - b.minY + 8);
  const paths = strokes.map((s) => `<path d="${svgPath(outline(s))}" fill="${s.c || '#1f2937'}"${s.t === 'hl' ? ' fill-opacity="0.35"' : ''}/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}">${paths}</svg>`;
}

const clean = (strokes) => strokes.map(({ a, ...s }) => s); // eslint-disable-line no-unused-vars
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The HTML that goes on the clipboard for these strokes (already where they are shown: offsets applied). */
export function inkHtml(strokes) {
  const data = btoa(unescape(encodeURIComponent(JSON.stringify({ v: 1, strokes: clean(strokes) }))));
  const svg = strokesSvg(strokes);
  return `<img alt="Handwriting" data-inkwell-ink="${data}" src="data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}">`;
}

/** Strokes from clipboard HTML, or null when it holds no Inkwell ink. */
export function inkFromHtml(html) {
  const m = /data-inkwell-ink="([A-Za-z0-9+/=]+)"/.exec(html || '');
  if (!m) return null;
  try {
    const d = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
    const strokes = (d.strokes || []).filter((s) => Array.isArray(s?.p) && s.p.every((v) => typeof v === 'number'));
    return strokes.length ? strokes : null;
  } catch { return null; }
}

/** Keeps a copy and fills a `copy`/`cut` event's clipboard. */
export function putInk(e, strokes) {
  kept = { strokes: clean(strokes), at: Date.now() };
  e.clipboardData.setData('text/html', inkHtml(strokes));
  e.clipboardData.setData('text/plain', '');
}

/** From a menu (no clipboard event): the system clipboard where allowed, and always the kept copy. */
export async function writeInk(strokes) {
  kept = { strokes: clean(strokes), at: Date.now() };
  try {
    const html = inkHtml(strokes);
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([''], { type: 'text/plain' }) })]);
  } catch { /* the kept copy still pastes inside the app */ }
}

/** For a menu's Paste: the clipboard's ink, else the copy kept here. */
export async function readInk() {
  try {
    for (const item of await navigator.clipboard.read()) {
      if (!item.types.includes('text/html')) continue;
      const ink = inkFromHtml(await (await item.getType('text/html')).text());
      if (ink) return ink;
    }
  } catch { /* not allowed: fall back */ }
  return kept?.strokes || null;
}

export const hasKeptInk = () => !!kept;

/** The strokes moved so their top-left corner lands at (x, y), with new ids. */
export function placeAt(strokes, x, y) {
  const b = bounds(strokes);
  const dx = Math.round((x - b.minX) * 10) / 10, dy = Math.round((Math.max(0, y) - b.minY) * 10) / 10;
  return strokes.map((s) => ({ ...s, id: sid(), p: s.p.map((v, i) => (i % 3 === 0 ? Math.round((v + dx) * 10) / 10 : i % 3 === 1 ? Math.round((v + dy) * 10) / 10 : v)) }));
}

/** Ink pasted into a typed page: a drawing block of its own with the strokes (kept where they were across). */
export function inkBlockFrom(doc, ink) {
  const b = bounds(ink);
  const id = sid();
  const strokes = placeAt(ink, b.minX, 20);
  doc.transact(() => { const a = new Y.Array(); a.push(strokes); doc.getMap('ink').set(id, a); });
  return [{ type: 'inkBlock', attrs: { id, height: Math.max(80, Math.ceil((b.maxY - b.minY + 40) / 10) * 10) } }, { type: 'paragraph' }];
}
