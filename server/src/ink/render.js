// Strokes → SVG (exports, public pages, thumbnails) → PNG (vision models need raster images).
import { outline, pathOf, bounds, TOOLS, CANVAS_WIDTH } from './geometry.js';

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const color = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#111827');

/** crop: tight box around the ink (for AI); otherwise the full logical canvas width. */
export function strokesToSvg(strokes, { crop = false, height, background = '#ffffff', dark = false, under = '' } = {}) {
  const b = bounds(strokes) || { minX: 0, minY: 0, maxX: CANVAS_WIDTH, maxY: 100 };
  const pad = 16;
  const x0 = crop ? Math.max(0, b.minX - pad) : 0;
  const y0 = crop ? Math.max(0, b.minY - pad) : 0;
  const w = crop ? b.maxX + pad - x0 : CANVAS_WIDTH;
  const h = crop ? b.maxY + pad - y0 : Math.max(height || 0, b.maxY + pad);
  const paths = strokes.map((s) => {
    const tool = TOOLS[s.t] || TOOLS.pen;
    let c = color(s.c);
    if (dark && /^#(000|000000|111827|1f2937)$/i.test(c)) c = '#e5e7eb';
    return `<path d="${pathOf(outline(s))}" fill="${esc(c)}"${tool.opacity < 1 ? ` fill-opacity="${tool.opacity}"` : ''}/>`;
  }).join('');
  const bg = background ? `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="${esc(background)}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0.toFixed(0)} ${y0.toFixed(0)} ${w.toFixed(0)} ${h.toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}">${bg}${under}${paths}</svg>`;
}

/**
 * The canvas cut into page-sized SVGs for print: each at most pageH units tall (the first firstH), cut where no
 * stroke crosses when there is such a place in the lower part of the page, so lines of writing stay whole.
 */
export function strokesToSvgPages(strokes, { height = 0, under = '', pageH = 1440, firstH = pageH } = {}) {
  const b = bounds(strokes);
  const total = Math.max(height || 0, b ? b.maxY + 16 : 0);
  if (!total) return [];
  const spans = strokes.map((s) => bounds([s]));
  const free = (y) => !spans.some((x) => x && x.minY - 4 < y && x.maxY + 4 > y);
  const pages = [];
  for (let y0 = 0, lim = firstH; y0 < total - 1; lim = pageH) {
    let y1 = Math.min(total, y0 + lim);
    if (y1 < total) for (let y = y1; y > y0 + lim * 0.55; y -= 4) if (free(y)) { y1 = y; break; }
    const h = y1 - y0;
    const paths = strokes.filter((s, i) => spans[i] && spans[i].maxY > y0 && spans[i].minY < y1).map((s) => {
      const tool = TOOLS[s.t] || TOOLS.pen;
      return `<path d="${pathOf(outline(s))}" fill="${esc(color(s.c))}"${tool.opacity < 1 ? ` fill-opacity="${tool.opacity}"` : ''}/>`;
    }).join('');
    pages.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${y0.toFixed(0)} ${CANVAS_WIDTH} ${h.toFixed(0)}" width="${CANVAS_WIDTH}" height="${h.toFixed(0)}">${under}${paths}</svg>`);
    y0 = y1;
  }
  return pages;
}

let Resvg = null;
/** PNG for vision models: cropped to the ink, scaled so the longer side is at most maxSide pixels. */
export async function strokesToPng(strokes, { maxSide = 1600 } = {}) {
  if (!Resvg) ({ Resvg } = await import('@resvg/resvg-js'));
  const svg = strokesToSvg(strokes, { crop: true });
  const [, , w, h] = /viewBox="([\d.-]+) ([\d.-]+) ([\d.]+) ([\d.]+)"/.exec(svg).slice(1).map(Number);
  // Upscale small handwriting (models read it better), never beyond maxSide.
  const scale = Math.min(maxSide / Math.max(w, h), 2.5);
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: Math.max(64, Math.round(w * scale)) }, background: '#ffffff' });
  return { png: r.render().asPng(), width: Math.round(w * scale), height: Math.round(h * scale) };
}
