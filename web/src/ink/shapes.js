// Sketch correction: turns a freehand stroke into the shape it was meant to be (straight line, straight-edged
// polyline, triangle, rectangle, polygon, circle, ellipse) or, when it is none of these, smooths it.
// Pure functions on [x, y] points (logical canvas units) so they can be tested outside the browser.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pathLen = (pts) => pts.reduce((s, p, i) => (i ? s + dist(pts[i - 1], p) : 0), 0);

function segDev(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1e-9;
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / l;
}

/** Ramer–Douglas–Peucker simplification. */
export function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let max = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) { const d = segDev(pts[i], pts[0], pts[pts.length - 1]); if (d > max) { max = d; idx = i; } }
  if (max <= eps) return [pts[0], pts[pts.length - 1]];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}

/** Evenly spaced points along a polyline (closed: back to the start). */
export function densify(vertices, step = 4, closed = false) {
  const v = closed ? [...vertices, vertices[0]] : vertices;
  const out = [v[0]];
  for (let i = 1; i < v.length; i++) {
    const n = Math.max(1, Math.round(dist(v[i - 1], v[i]) / step));
    for (let k = 1; k <= n; k++) out.push([v[i - 1][0] + ((v[i][0] - v[i - 1][0]) * k) / n, v[i - 1][1] + ((v[i][1] - v[i - 1][1]) * k) / n]);
  }
  return out;
}

const angleAt = (a, b, c) => {
  const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / ((Math.hypot(...v1) * Math.hypot(...v2)) || 1e-9);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
};

function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, diag: Math.hypot(x1 - x0, y1 - y0) };
}

/** Chaikin corner cutting: a gentle smoothing that keeps the overall form. */
export function smooth(pts, passes = 2) {
  let p = pts;
  for (let k = 0; k < passes && p.length > 2; k++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [a, b] = [p[i], p[i + 1]];
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

/**
 * Recognises what a stroke should be. Returns { kind, points } — kind is 'line', 'polyline', 'triangle', 'rectangle',
 * 'polygon', 'circle', 'ellipse' or 'smooth' — or null for strokes too short to judge (dots, tiny marks, letters).
 */
export function recognize(pts) {
  if (pts.length < 3) return null;
  const len = pathLen(pts);
  const b = bbox(pts);
  if (len < 24 || b.diag < 18) return null;
  const start = pts[0], end = pts[pts.length - 1];
  const chord = dist(start, end);

  // Straight line: almost no deviation from the chord.
  const maxDev = Math.max(...pts.map((p) => segDev(p, start, end)));
  if (chord > 0.85 * len && maxDev < Math.max(3, 0.06 * chord)) return { kind: 'line', points: densify(snapAngle([start, end])) };

  const closed = chord < Math.max(14, 0.18 * Math.max(b.w, b.h)) && len > 2.5 * Math.max(b.w, b.h) * 0.8;
  const eps = Math.max(4, 0.07 * b.diag);
  let v = rdp(pts, eps);
  if (closed) {
    if (v.length > 2 && dist(v[0], v[v.length - 1]) < Math.max(14, 0.2 * Math.max(b.w, b.h))) v = v.slice(0, -1);
    // Corners closer than a sixth of the size are one corner.
    v = v.filter((p, i) => i === 0 || dist(p, v[i - 1]) > 0.12 * b.diag);
    // An ellipse/circle first: points all lie near the bbox ellipse.
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, rx = b.w / 2, ry = b.h / 2;
    const err = pts.reduce((s, [x, y]) => s + Math.abs(Math.hypot((x - cx) / (rx || 1), (y - cy) / (ry || 1)) - 1), 0) / pts.length;
    if (err < 0.1 && v.length > 4) {
      const round = Math.abs(rx - ry) / Math.max(rx, ry) < 0.18;
      const r = (rx + ry) / 2;
      return { kind: round ? 'circle' : 'ellipse', points: ellipsePoints(cx, cy, round ? r : rx, round ? r : ry) };
    }
    if (v.length === 3) return { kind: 'triangle', points: densify(v, 4, true) };
    if (v.length === 4) {
      const right = v.every((p, i) => Math.abs(angleAt(v[(i + 3) % 4], p, v[(i + 1) % 4]) - 90) < 22);
      if (right) {
        const axis = Math.abs(Math.atan2(v[1][1] - v[0][1], v[1][0] - v[0][0]) * 180 / Math.PI) % 90;
        if (axis < 12 || axis > 78) return { kind: 'rectangle', points: densify([[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]], 4, true) };
      }
      return { kind: right ? 'rectangle' : 'polygon', points: densify(v, 4, true) };
    }
    if (v.length >= 5 && v.length <= 8 && err >= 0.1) return { kind: 'polygon', points: densify(v, 4, true) };
    if (err < 0.16) {
      const r = (rx + ry) / 2;
      const round = Math.abs(rx - ry) / Math.max(rx, ry) < 0.18;
      return { kind: round ? 'circle' : 'ellipse', points: ellipsePoints(cx, cy, round ? r : rx, round ? r : ry) };
    }
  } else if (v.length >= 3 && v.length <= 5) {
    // Straight-edged open shapes (angles, arrows, zig-zags): every segment must be straight.
    const fits = pts.every((p) => Math.min(...v.slice(1).map((q, i) => segDistTo(p, v[i], q))) < Math.max(4, 0.05 * b.diag));
    if (fits) return { kind: 'polyline', points: densify(v) };
  }
  return { kind: 'smooth', points: smooth(pts) };
}

function segDistTo(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// Nearly horizontal/vertical/diagonal lines snap to the exact angle.
function snapAngle([a, b]) {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const step = Math.PI / 4;
  const snapped = Math.round(ang / step) * step;
  if (Math.abs(ang - snapped) > (4 * Math.PI) / 180) return [a, b];
  const l = dist(a, b);
  return [a, [a[0] + Math.cos(snapped) * l, a[1] + Math.sin(snapped) * l]];
}

function ellipsePoints(cx, cy, rx, ry) {
  const n = Math.max(24, Math.round((Math.PI * (rx + ry)) / 4));
  return Array.from({ length: n + 1 }, (_, i) => [cx + rx * Math.cos((2 * Math.PI * i) / n), cy + ry * Math.sin((2 * Math.PI * i) / n)]);
}

/**
 * Pixel-style eraser: removes the parts of a stroke within r of (x, y) and returns the remaining pieces
 * (each ≥ 2 points) as new strokes. Returns null when the eraser does not touch the stroke.
 */
export function eraseFromStroke(stroke, x, y, r, newId) {
  const p = stroke.p || [];
  const rr = r + (stroke.w || 3) / 2;
  const pts = [];
  for (let i = 0; i + 1 < p.length; i += 3) pts.push([p[i], p[i + 1], p[i + 2] ?? 0.5]);
  // Densify so a long straight segment through the eraser is cut, not skipped.
  const dense = [];
  for (let i = 0; i < pts.length; i++) {
    if (i) {
      const a = pts[i - 1], b = pts[i];
      const n = Math.floor(dist(a, b) / Math.max(1, rr / 2));
      for (let k = 1; k < n; k++) dense.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, a[2] + ((b[2] - a[2]) * k) / n]);
    }
    dense.push(pts[i]);
  }
  if (!dense.some((q) => Math.hypot(q[0] - x, q[1] - y) <= rr)) return null;
  const pieces = [];
  let cur = [];
  for (const q of dense) {
    if (Math.hypot(q[0] - x, q[1] - y) <= rr) { if (cur.length > 1) pieces.push(cur); cur = []; } else cur.push(q);
  }
  if (cur.length > 1) pieces.push(cur);
  const r1 = (v) => Math.round(v * 10) / 10;
  return pieces.map((seg) => ({ ...stroke, id: newId(), p: seg.flatMap(([a, b, c]) => [r1(a), r1(b), Math.round(c * 100) / 100]) }));
}
