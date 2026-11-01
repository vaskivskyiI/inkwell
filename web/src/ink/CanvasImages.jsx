// Pictures on a canvas: shared objects under the ink, in the page doc's `images` map (id → Y.Map { canvas, src, x, y,
// w, ratio, rot, crop: [left, top, right, bottom] as fractions of the picture }). x, y, w are logical canvas units.
// With the Select tool a picture can be moved, scaled, rotated and cropped; with the pen you write on top of it.
import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Crop, RotateCw, Trash2, Check } from 'lucide-react';
import { upload } from '../api.js';
import { store, useStore, toastError } from '../store.js';
import { sid } from './geometry.js';

export const LOCAL = { local: true }; // transaction origin the canvas undo tracks

const cropOf = (m) => m.get('crop') || [0, 0, 0, 0];
const fullW = (m) => { const [l, , r] = cropOf(m); return m.get('w') / (1 - l - r); };
const heightOf = (m) => { const [, t, , b] = cropOf(m); return fullW(m) * m.get('ratio') * (1 - t - b); };
const setAll = (m, patch) => m.doc.transact(() => { for (const [k, v] of Object.entries(patch)) m.set(k, v); }, LOCAL);

const naturalSize = (file) => new Promise((res) => {
  const url = URL.createObjectURL(file);
  const i = new window.Image();
  i.onload = () => { res({ w: i.naturalWidth, h: i.naturalHeight }); URL.revokeObjectURL(url); };
  i.onerror = () => { res({ w: 4, h: 3 }); URL.revokeObjectURL(url); };
  i.src = url;
});

export async function addCanvasImage(doc, canvasId, file, noteId, center) {
  try {
    const size = await naturalSize(file);
    const a = await upload(file, { noteId });
    const id = placeCanvasImage(doc, canvasId, a.url, size, center);
    store.set({ pickedImage: id, inkTool: { ...store.get().inkTool, tool: 'pick' } });
  } catch (e) { toastError(e); }
}

/** Puts an uploaded picture on a canvas, centred on `center` (logical units). */
export function placeCanvasImage(doc, canvasId, src, size, center) {
  const id = sid();
  const w = Math.min(500, size?.w || 500), ratio = size?.w > 0 && size?.h > 0 ? size.h / size.w : 0.75;
  doc.transact(() => {
    const m = new Y.Map();
    for (const [k, v] of Object.entries({ canvas: canvasId, src, x: Math.max(0, Math.round(center.x - w / 2)), y: Math.max(0, Math.round(center.y - (w * ratio) / 2)), w, ratio, rot: 0, crop: [0, 0, 0, 0] })) m.set(k, v);
    doc.getMap('images').set(id, m);
  }, LOCAL);
  return id;
}

/** Insert space moves pictures below the line too. */
export function shiftImages(doc, canvasId, y0, dy) {
  for (const m of doc.getMap('images').values()) if (m.get('canvas') === canvasId && m.get('y') + heightOf(m) / 2 >= y0) m.set('y', Math.max(0, m.get('y') + dy));
}

export function CanvasImages({ doc, canvasId, scale, active, readOnly, onBottom }) {
  const map = doc.getMap('images');
  const [, force] = useState(0);
  useEffect(() => {
    const on = () => force((n) => n + 1);
    map.observeDeep(on);
    return () => map.unobserveDeep(on);
  }, [map]);
  const items = [...map.entries()].filter(([, m]) => m.get('canvas') === canvasId);
  return (
    <div className="canvas-images" style={{ pointerEvents: active && !readOnly ? 'auto' : 'none' }} onPointerDown={(e) => { if (e.target === e.currentTarget) store.set({ pickedImage: null }); }}>
      {items.map(([id, m]) => <CanvasImage key={id} id={id} m={m} map={map} scale={scale} active={active && !readOnly} onBottom={onBottom} />)}
    </div>
  );
}

function CanvasImage({ id, m, map, scale, active, onBottom }) {
  const picked = useStore((s) => s.pickedImage === id) && active;
  const [cropping, setCropping] = useState(false);
  const box = useRef(null);
  const gesture = useRef(null);
  useEffect(() => { if (!picked) setCropping(false); }, [picked]);

  const x = m.get('x'), y = m.get('y'), w = m.get('w'), rot = m.get('rot') || 0, h = heightOf(m);
  const [l, t, r, b] = cropOf(m);

  const start = (kind) => (e) => {
    if (!active) return;
    e.preventDefault(); e.stopPropagation();
    store.set({ pickedImage: id });
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = box.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    gesture.current = { kind, sx: e.clientX, sy: e.clientY, cx, cy, x, y, w, h, crop: [l, t, r, b], d0: Math.hypot(e.clientX - cx, e.clientY - cy) || 1, full: fullW(m) };
  };
  const move = (e) => {
    const g = gesture.current;
    if (!g) return;
    const dx = (e.clientX - g.sx) / scale, dy = (e.clientY - g.sy) / scale;
    if (g.kind === 'move') setAll(m, { x: Math.round(g.x + dx), y: Math.max(0, Math.round(g.y + dy)) });
    else if (g.kind === 'scale') {
      const f = Math.max(0.05, Math.hypot(e.clientX - g.cx, e.clientY - g.cy) / g.d0);
      setAll(m, { w: Math.round(g.w * f), x: Math.round(g.x + (g.w * (1 - f)) / 2), y: Math.round(g.y + (g.h * (1 - f)) / 2) });
    } else if (g.kind === 'rotate') {
      let a = (Math.atan2(e.clientY - g.cy, e.clientX - g.cx) * 180) / Math.PI + 90;
      const snap = Math.round(a / 90) * 90;
      if (Math.abs(a - snap) < 4) a = snap; // straight angles are easy to hit
      setAll(m, { rot: Math.round(((a % 360) + 360) % 360) });
    } else {
      // Cropping: the picture stays where it is, only an edge moves (in the picture's own direction).
      const rad = (-rot * Math.PI) / 180;
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad), ly = dx * Math.sin(rad) + dy * Math.cos(rad);
      const [cl, ct, cr, cb] = g.crop, fh = g.full * m.get('ratio');
      const clamp = (v, other) => Math.max(0, Math.min(0.9 - other, v));
      if (g.kind === 'left') { const n = clamp(cl + lx / g.full, cr); setAll(m, { crop: [n, ct, cr, cb], x: Math.round(g.x + (n - cl) * g.full), w: g.full * (1 - n - cr) }); }
      if (g.kind === 'right') { const n = clamp(cr - lx / g.full, cl); setAll(m, { crop: [cl, ct, n, cb], w: g.full * (1 - cl - n) }); }
      if (g.kind === 'top') { const n = clamp(ct + ly / fh, cb); setAll(m, { crop: [cl, n, cr, cb], y: Math.round(g.y + (n - ct) * fh) }); }
      if (g.kind === 'bottom') setAll(m, { crop: [cl, ct, cr, clamp(cb - ly / fh, ct)] });
    }
  };
  const end = () => { if (gesture.current) { gesture.current = null; onBottom?.(m.get('y') + heightOf(m)); } };
  const on = (kind) => ({ onPointerDown: start(kind), onPointerMove: move, onPointerUp: end, onPointerCancel: end });

  // Below the picture, however it is turned: above it would cover the rotate handle.
  const rad = (rot * Math.PI) / 180;
  const barTop = (y + h / 2 + (Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad))) / 2) * scale + 14;
  const iw = 100 / (1 - l - r), ih = 100 / (1 - t - b);
  return (
    <>
      <div ref={box} className={`canvas-image${picked ? ' picked' : ''}`} style={{ left: x * scale, top: y * scale, width: w * scale, height: h * scale, transform: rot ? `rotate(${rot}deg)` : undefined }} {...on('move')}>
        <div className="clip"><img src={m.get('src')} alt="" draggable={false} style={{ width: `${iw}%`, height: `${ih}%`, left: `${-l * iw}%`, top: `${-t * ih}%` }} /></div>
        {picked && !cropping && <>
          <span className="rot-handle" title="Rotate" {...on('rotate')} />
          {['nw', 'ne', 'sw', 'se'].map((c) => <span key={c} className={`corner ${c}`} title="Scale" {...on('scale')} />)}
        </>}
        {picked && cropping && ['left', 'right', 'top', 'bottom'].map((c) => <span key={c} className={`crop-edge ${c}`} title="Crop" {...on(c)} />)}
      </div>
      {picked && (
        <div className="image-bar" style={{ left: x * scale, top: barTop }} onPointerDown={(e) => e.stopPropagation()}>
          <button className={cropping ? 'on' : ''} onClick={() => setCropping(!cropping)}>{cropping ? <Check size={15} /> : <Crop size={15} />} {cropping ? 'Done' : 'Crop'}</button>
          <button onClick={() => setAll(m, { rot: (rot + 90) % 360 })} title="Rotate by 90°"><RotateCw size={15} /></button>
          <button className="danger" title="Remove picture" onClick={() => { m.doc.transact(() => map.delete(id), LOCAL); store.set({ pickedImage: null }); }}><Trash2 size={15} /></button>
        </div>
      )}
    </>
  );
}
