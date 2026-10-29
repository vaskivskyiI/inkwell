// Stroke geometry shared in spirit with web/src/ink/geometry.js (keep the two in step): canvases use a logical
// width of 1000 units so ink looks the same on every screen size; points are flat [x, y, pressure, …].
import { getStroke } from 'perfect-freehand';

export const CANVAS_WIDTH = 1000;

export const TOOLS = {
  pen: { thinning: 0.6, smoothing: 0.5, streamline: 0.45, opacity: 1 },
  hl: { thinning: 0, smoothing: 0.5, streamline: 0.5, opacity: 0.35, cap: false },
};

export function toTriples(p) {
  const out = [];
  for (let i = 0; i + 1 < p.length; i += 3) out.push([p[i], p[i + 1], p[i + 2] ?? 0.5]);
  return out;
}

export function outline(stroke) {
  const tool = TOOLS[stroke.t] || TOOLS.pen;
  const pts = toTriples(stroke.p || []);
  const hasPressure = pts.some((x) => x[2] !== 0.5 && x[2] > 0);
  return getStroke(pts, {
    size: stroke.w || 3, thinning: tool.thinning, smoothing: tool.smoothing, streamline: tool.streamline,
    simulatePressure: !hasPressure, last: true,
    start: { cap: tool.cap !== false }, end: { cap: tool.cap !== false },
  });
}

const avg = (a, b) => (a + b) / 2;
export function pathOf(points) {
  const n = points.length;
  if (n < 4) {
    if (!n) return '';
    const [x, y] = points[0];
    return `M${x.toFixed(1)},${y.toFixed(1)}h0.1`;
  }
  let a = points[0], b = points[1];
  const c = points[2];
  let d = `M${a[0].toFixed(1)},${a[1].toFixed(1)} Q${b[0].toFixed(1)},${b[1].toFixed(1)} ${avg(b[0], c[0]).toFixed(1)},${avg(b[1], c[1]).toFixed(1)} T`;
  for (let i = 2; i < n - 1; i++) {
    a = points[i]; b = points[i + 1];
    d += `${avg(a[0], b[0]).toFixed(1)},${avg(a[1], b[1]).toFixed(1)} `;
  }
  return `${d}Z`;
}

export function bounds(strokes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    const p = s.p || [];
    const pad = (s.w || 3);
    for (let i = 0; i + 1 < p.length; i += 3) {
      if (p[i] - pad < minX) minX = p[i] - pad;
      if (p[i + 1] - pad < minY) minY = p[i + 1] - pad;
      if (p[i] + pad > maxX) maxX = p[i] + pad;
      if (p[i + 1] + pad > maxY) maxY = p[i + 1] + pad;
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}
