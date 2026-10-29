// Stroke geometry — keep in step with server/src/ink/geometry.js so server renders (exports, AI) match the screen.
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

export function outline(stroke, last = true) {
  const tool = TOOLS[stroke.t] || TOOLS.pen;
  const pts = toTriples(stroke.p || []);
  const hasPressure = pts.some((x) => x[2] !== 0.5 && x[2] > 0);
  return getStroke(pts, {
    size: stroke.w || 3, thinning: tool.thinning, smoothing: tool.smoothing, streamline: tool.streamline,
    simulatePressure: !hasPressure, last, start: { cap: tool.cap !== false }, end: { cap: tool.cap !== false },
  });
}

export function path2d(points) {
  const p = new Path2D();
  const n = points.length;
  if (!n) return p;
  if (n < 4) { p.arc(points[0][0], points[0][1], 1, 0, Math.PI * 2); return p; }
  p.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < n; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % n];
    p.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  p.closePath();
  return p;
}

export function bounds(strokes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    const p = s.p || [];
    const pad = s.w || 3;
    for (let i = 0; i + 1 < p.length; i += 3) {
      minX = Math.min(minX, p[i] - pad); minY = Math.min(minY, p[i + 1] - pad);
      maxX = Math.max(maxX, p[i] + pad); maxY = Math.max(maxY, p[i + 1] + pad);
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Does the stroke pass within r of (x, y)? */
export function hits(stroke, x, y, r) {
  const p = stroke.p || [];
  const rr = r + (stroke.w || 3) / 2;
  if (p.length < 6) return Math.hypot(p[0] - x, p[1] - y) <= rr;
  for (let i = 0; i + 4 < p.length; i += 3) if (segDist(x, y, p[i], p[i + 1], p[i + 3], p[i + 4]) <= rr) return true;
  return false;
}

export function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Most of the stroke's points inside the lasso. */
export function strokeInLasso(stroke, poly) {
  const p = stroke.p || [];
  let n = 0, inside = 0;
  for (let i = 0; i + 1 < p.length; i += 3) { n++; if (inPolygon(p[i], p[i + 1], poly)) inside++; }
  return n && inside / n > 0.6;
}

export const sid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
