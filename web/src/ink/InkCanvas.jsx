// A handwriting surface bound to a Y.Array of strokes (doc.ink[canvasId]). Logical width 1000 units, scaled to the
// element's width, so ink lands in the same place on every device. Pen, highlighter, eraser (whole strokes or
// partial, also the pen's eraser button), lasso select/move, shape correction (Shapes mode, or hold the pen still at
// the end of a stroke), pinch / Ctrl+wheel zoom. Touch scrolls instead of drawing once a pen has been used.
import { useEffect, useLayoutEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import * as Y from 'yjs';
import { CANVAS_WIDTH, TOOLS, outline, path2d, hits, strokeInLasso, bounds, sid } from './geometry.js';
import { recognize, eraseFromStroke } from './shapes.js';
import { useStore, store } from '../store.js';

const LOCAL = { local: true };
const MAX_ZOOM = 3;
let penSeen = false;
export const penOnlyActive = () => {
  const mode = store.get().settings?.penOnly || 'auto';
  return mode === 'on' || (mode === 'auto' && penSeen);
};

const scrollParent = (el) => {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement;
};

export const InkCanvas = forwardRef(function InkCanvas({ doc, canvasId, height, onHeightChange, autoGrow = false, minHeight = 200, readOnly = false, paper = 'plain', background, onTap, children, onStrokesChange, zoomable = true }, ref) {
  const wrap = useRef(null), base = useRef(null), live = useRef(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const tool = useStore((s) => s.inkTool);
  const strokes = useRef([]);
  const paths = useRef(new Map());
  const yarr = useRef(null);
  const undo = useRef(null);
  const sel = useRef({ ids: new Set(), box: null });
  const [, force] = useState(0);
  const scale = (width * zoom) / CANVAS_WIDTH || 1;

  useImperativeHandle(ref, () => ({
    undo: () => undo.current?.undo(), redo: () => undo.current?.redo(),
    canUndo: () => !!undo.current?.undoStack.length, canRedo: () => !!undo.current?.redoStack.length,
    clearSelection, deleteSelection, strokes: () => strokes.current, clear: () => { const a = yarr.current; if (a?.length) doc.transact(() => a.delete(0, a.length), LOCAL); },
    zoomIn: () => zoomTo(zoom * 1.25), zoomOut: () => zoomTo(zoom / 1.25), zoomReset: () => zoomTo(1), zoom: () => zoom,
  }));

  // ---- bind to the Y.Array (created lazily, possibly by another device)
  useEffect(() => {
    const ink = doc.getMap('ink');
    let arr = null;
    const sync = () => {
      strokes.current = arr ? arr.toArray() : [];
      const ids = new Set(strokes.current.map((s) => s.id));
      for (const id of paths.current.keys()) if (!ids.has(id)) paths.current.delete(id);
      for (const id of [...sel.current.ids]) if (!ids.has(id)) sel.current.ids.delete(id);
      schedule();
      latest.current.onStrokesChange?.(strokes.current);
      if (latest.current.autoGrow) latest.current.grow();
    };
    const attach = () => {
      const a = ink.get(canvasId);
      if (a === arr) return;
      arr?.unobserve(sync);
      arr = a instanceof Y.Array ? a : null;
      yarr.current = arr;
      undo.current?.destroy();
      undo.current = arr ? new Y.UndoManager(arr, { trackedOrigins: new Set([LOCAL]), captureTimeout: 300 }) : null;
      arr?.observe(sync);
      sync();
    };
    const onMap = (e) => { if (e.keysChanged.has(canvasId)) attach(); };
    ink.observe(onMap);
    attach();
    return () => { ink.unobserve(onMap); arr?.unobserve(sync); undo.current?.destroy(); };
  }, [doc, canvasId]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = wrap.current;
    const measure = () => { const w = Math.round(el.clientWidth); if (w) setWidth(w); };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    // Editor node views can mount detached and be attached later without a resize notification: keep checking
    // for a moment until a real width shows up.
    let tries = 0, raf2 = 0;
    const poll = () => { measure(); if (!el.clientWidth && tries++ < 120) raf2 = requestAnimationFrame(poll); };
    raf2 = requestAnimationFrame(poll);
    return () => { ro.disconnect(); cancelAnimationFrame(raf2); };
  }, []);
  // Width can also change without a resize event reaching us (e.g. moved between containers): re-check on render.
  useEffect(() => { const w = Math.round(wrap.current?.clientWidth || 0); if (w && Math.abs(w - width) > 1) setWidth(w); });

  const h = Math.max(height || minHeight, minHeight);

  function grow() {
    const b = bounds(strokes.current);
    const need = Math.max(minHeight, (b?.maxY || 0) + 600);
    if (onHeightChange && Math.abs(need - h) > 40 && need > h) onHeightChange(need);
  }

  // ---- zoom: keeps the point under the fingers / cursor where it is
  const anchor = useRef(null);
  function zoomTo(z, clientX, clientY) {
    const nz = Math.min(MAX_ZOOM, Math.max(1, z));
    if (Math.abs(nz - zoom) < 0.001) return;
    const r = live.current?.getBoundingClientRect();
    if (r) {
      const cx = clientX ?? r.left + Math.min(r.width, wrap.current.clientWidth) / 2;
      const cy = clientY ?? Math.max(r.top, 0) + Math.min(r.height, window.innerHeight) / 2;
      anchor.current = { lx: (cx - r.left) / scale, ly: (cy - r.top) / scale, cx, cy, s0: scale };
    }
    setZoom(nz);
  }
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a || !wrap.current) return;
    anchor.current = null;
    const wr = wrap.current.getBoundingClientRect();
    wrap.current.scrollLeft = a.lx * scale - (a.cx - wr.left);
    const sp = scrollParent(wrap.current);
    if (sp) sp.scrollTop += a.ly * (scale - a.s0);
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Ctrl+wheel (and trackpad pinch, which browsers report as Ctrl+wheel) zooms the canvas, not the page.
    const el = wrap.current;
    const onWheel = (e) => {
      if (!zoomable || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      latest.current.zoomTo(latest.current.zoom * Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomable]);

  // ---- drawing (observers live across renders: they reach the current render's functions through `latest`)
  const raf = useRef(0);
  const latest = useRef({});
  latest.current = { redraw, grow, autoGrow, onStrokesChange, zoomTo, zoom };
  function schedule() { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(() => latest.current.redraw()); }

  function setup(c) {
    // Large zoomed canvases get a lower pixel ratio so they stay within browser canvas limits.
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2.5 / zoom));
    const W = Math.round(width * zoom * dpr), H = Math.round(h * scale * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d');
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    return ctx;
  }

  function pathOf(s) {
    let p = paths.current.get(s.id);
    if (!p) { p = path2d(outline(s)); paths.current.set(s.id, p); }
    return p;
  }

  function redraw() {
    if (!base.current || !width) return;
    const ctx = setup(base.current);
    ctx.clearRect(0, 0, CANVAS_WIDTH, h);
    const dark = document.documentElement.dataset.theme === 'dark' && !background;
    for (const s of strokes.current) {
      ctx.globalAlpha = (TOOLS[s.t] || TOOLS.pen).opacity;
      ctx.fillStyle = dark && /^#(000000|111827|1f2937)$/i.test(s.c) ? '#e5e7eb' : s.c || '#1f2937';
      ctx.fill(pathOf(s));
    }
    ctx.globalAlpha = 1;
    if (sel.current.ids.size) {
      const chosen = strokes.current.filter((s) => sel.current.ids.has(s.id));
      ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 1.5 / scale;
      for (const s of chosen) ctx.stroke(pathOf(s));
      const b = bounds(chosen);
      if (b) { ctx.setLineDash([6 / scale, 4 / scale]); ctx.strokeRect(b.minX - 6, b.minY - 6, b.maxX - b.minX + 12, b.maxY - b.minY + 12); ctx.setLineDash([]); sel.current.box = b; }
    }
  }
  useEffect(schedule, [width, h, zoom]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function clearSelection() { sel.current = { ids: new Set(), box: null }; schedule(); force((x) => x + 1); }
  function deleteSelection() {
    const a = yarr.current;
    if (!a || !sel.current.ids.size) return;
    doc.transact(() => { for (let i = a.length - 1; i >= 0; i--) if (sel.current.ids.has(a.get(i).id)) a.delete(i, 1); }, LOCAL);
    clearSelection();
  }

  const ensureArray = () => {
    if (yarr.current) return yarr.current;
    doc.transact(() => { if (!doc.getMap('ink').get(canvasId)) doc.getMap('ink').set(canvasId, new Y.Array()); }, LOCAL);
    yarr.current = doc.getMap('ink').get(canvasId);
    return yarr.current;
  };

  // ---- pointer input
  const g = useRef(null); // active gesture
  const touches = useRef(new Map()); // touch pointers, for pinch
  const pt = (e) => {
    const r = live.current.getBoundingClientRect();
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale, e.pointerType === 'pen' || e.pressure !== 0.5 ? Math.max(0.05, Math.min(1, e.pressure || 0.5)) : 0.5];
  };

  function startPinch() {
    const [a, b] = [...touches.current.values()];
    if (g.current?.hold) clearTimeout(g.current.hold);
    g.current = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: zoom };
    clearLive();
  }

  function onDown(e) {
    if (e.pointerType === 'pen') penSeen = true;
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (zoomable && touches.current.size === 2) { e.preventDefault(); startPinch(); return; }
    }
    if (readOnly) {
      if (e.pointerType === 'touch') g.current = { kind: 'scroll', y: e.clientY, x: e.clientX, el: scrollParent(wrap.current) };
      return;
    }
    if (e.pointerType === 'touch' && penOnlyActive()) {
      g.current = { kind: 'scroll', y: e.clientY, x: e.clientX, el: scrollParent(wrap.current) };
      return;
    }
    if (e.button === 2) return;
    e.preventDefault();
    live.current.setPointerCapture(e.pointerId);
    const p = pt(e);
    const eraser = e.button === 5 || (e.buttons & 32) || tool.tool === 'eraser';
    if (tool.tool === 'text' && onTap) { g.current = { kind: 'tap', p }; return; }
    if (eraser) { g.current = { kind: 'erase' }; erase(p); return; }
    if (tool.tool === 'lasso') {
      const b = sel.current.box;
      if (b && sel.current.ids.size && p[0] > b.minX - 8 && p[0] < b.maxX + 8 && p[1] > b.minY - 8 && p[1] < b.maxY + 8) g.current = { kind: 'move', from: p, dx: 0, dy: 0 };
      else { clearSelection(); g.current = { kind: 'lasso', poly: [[p[0], p[1]]] }; }
      return;
    }
    clearSelection();
    g.current = { kind: 'draw', stroke: { id: sid(), t: tool.tool === 'hl' ? 'hl' : 'pen', c: tool.tool === 'hl' ? hlColor(tool.color) : tool.color, w: tool.tool === 'hl' ? tool.width * 5 : tool.width, p: [...p] } };
    armHold();
    drawLive();
  }

  // Hold the pen still at the end of a stroke → it snaps to the shape it looks like.
  function armHold() {
    const gs = g.current;
    clearTimeout(gs.hold);
    gs.hold = setTimeout(() => {
      if (g.current !== gs || gs.snapped || tool.tool === 'hl') return;
      const r = shapeOf(gs.stroke, { minSize: 0 });
      if (r && r.kind !== 'smooth') { gs.stroke.p = r.p; gs.snapped = r.kind; drawLive(); }
    }, 550);
  }

  function onMove(e) {
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const gs = g.current;
    if (!gs) return;
    if (gs.kind === 'pinch') {
      const [a, b] = [...touches.current.values()];
      if (!a || !b) return;
      zoomTo(gs.z0 * (Math.hypot(a.x - b.x, a.y - b.y) / gs.d0), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (gs.kind === 'scroll') { gs.el.scrollBy(0, gs.y - e.clientY); wrap.current.scrollLeft += gs.x - e.clientX; gs.x = e.clientX; gs.y = e.clientY; return; }
    const events = e.getCoalescedEvents?.() || [e];
    if (gs.kind === 'draw') {
      if (gs.snapped) return;
      const p0 = gs.stroke.p;
      for (const ev of events) gs.stroke.p.push(...pt(ev));
      const n = p0.length;
      if (n > 6 && Math.hypot(p0[n - 3] - p0[n - 6], p0[n - 2] - p0[n - 5]) > 1.5 / Math.max(scale, 0.3)) armHold();
      drawLive();
    } else if (gs.kind === 'erase') for (const ev of events) erase(pt(ev));
    else if (gs.kind === 'lasso') { const p = pt(e); gs.poly.push([p[0], p[1]]); drawLive(); }
    else if (gs.kind === 'move') { const p = pt(e); gs.dx = p[0] - gs.from[0]; gs.dy = p[1] - gs.from[1]; drawLive(); }
  }

  function onUp(e) {
    if (e?.pointerType === 'touch') touches.current.delete(e.pointerId);
    const gs = g.current;
    if (gs?.kind === 'pinch') { if (touches.current.size < 2) g.current = null; return; }
    g.current = null;
    if (!gs) return;
    clearTimeout(gs.hold);
    clearLive();
    if (gs.kind === 'draw') {
      const s = gs.stroke;
      // Shapes mode: larger strokes are straightened or smoothed when lifted (handwriting is left alone).
      if (!gs.snapped && tool.shapes && s.t === 'pen') { const r = shapeOf(s, { minSize: 60 }); if (r) s.p = r.p; }
      s.p = s.p.map((v, i) => (i % 3 === 2 ? Math.round(v * 100) / 100 : Math.round(v * 10) / 10));
      const a = ensureArray();
      doc.transact(() => a.push([s]), LOCAL);
      if (onHeightChange && !autoGrow) {
        const b = bounds([s]);
        if (b && b.maxY > h - 20) onHeightChange(Math.ceil((b.maxY + 60) / 20) * 20);
      }
    } else if (gs.kind === 'tap') onTap?.(gs.p[0], gs.p[1]);
    else if (gs.kind === 'lasso' && gs.poly.length > 3) {
      sel.current = { ids: new Set(strokes.current.filter((s) => strokeInLasso(s, gs.poly)).map((s) => s.id)), box: null };
      schedule(); force((x) => x + 1);
    } else if (gs.kind === 'move' && (gs.dx || gs.dy)) {
      const a = yarr.current;
      const moved = [];
      doc.transact(() => {
        for (let i = a.length - 1; i >= 0; i--) {
          const s = a.get(i);
          if (!sel.current.ids.has(s.id)) continue;
          a.delete(i, 1);
          moved.unshift({ ...s, id: sid(), p: s.p.map((v, j) => (j % 3 === 0 ? Math.round((v + gs.dx) * 10) / 10 : j % 3 === 1 ? Math.round((v + gs.dy) * 10) / 10 : v)) });
        }
        a.push(moved);
      }, LOCAL);
      sel.current = { ids: new Set(moved.map((s) => s.id)), box: null };
      schedule();
    }
  }

  function erase(p) {
    const a = yarr.current;
    if (!a) return;
    const partial = tool.eraser === 'point';
    const r = (partial ? 10 : 8) / Math.max(scale, 0.3);
    doc.transact(() => {
      for (let i = a.length - 1; i >= 0; i--) {
        const s = a.get(i);
        if (!hits(s, p[0], p[1], r)) continue;
        if (!partial) { a.delete(i, 1); continue; }
        const pieces = eraseFromStroke(s, p[0], p[1], r, sid);
        if (!pieces) continue;
        a.delete(i, 1);
        if (pieces.length) a.insert(i, pieces);
      }
    }, LOCAL);
    const ctx = setup(live.current);
    ctx.clearRect(0, 0, CANVAS_WIDTH, h);
    ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 1 / scale;
    ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.stroke();
  }

  function clearLive() { if (live.current) setup(live.current).clearRect(0, 0, CANVAS_WIDTH, h); }

  function drawLive() {
    const gs = g.current;
    const ctx = setup(live.current);
    ctx.clearRect(0, 0, CANVAS_WIDTH, h);
    if (gs?.kind === 'draw') {
      ctx.globalAlpha = (TOOLS[gs.stroke.t] || TOOLS.pen).opacity;
      ctx.fillStyle = gs.stroke.c;
      ctx.fill(path2d(outline(gs.stroke, !!gs.snapped)));
    } else if (gs?.kind === 'lasso') {
      ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 1.5 / scale; ctx.setLineDash([5 / scale, 4 / scale]);
      ctx.beginPath(); gs.poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
    } else if (gs?.kind === 'move') {
      ctx.translate(gs.dx, gs.dy);
      ctx.globalAlpha = 0.6;
      for (const s of strokes.current) if (sel.current.ids.has(s.id)) { ctx.fillStyle = s.c; ctx.fill(pathOf(s)); }
    }
  }

  function onKey(e) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.current.ids.size) { e.preventDefault(); deleteSelection(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) undo.current?.redo(); else undo.current?.undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); e.stopPropagation(); undo.current?.redo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomTo(zoom * 1.25); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); zoomTo(zoom / 1.25); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); zoomTo(1); }
    else if (e.key === 'Escape') clearSelection();
  }

  const step = { ruled: 32, grid: 32, dotted: 32 }[paper];
  const s = step * scale;
  const bg = paper === 'ruled' ? { backgroundImage: 'linear-gradient(var(--paper-line) 1px, transparent 1px)', backgroundSize: `100% ${s}px`, backgroundPosition: `0 ${s - 1}px` }
    : paper === 'grid' ? { backgroundImage: 'linear-gradient(var(--paper-line) 1px, transparent 1px), linear-gradient(90deg, var(--paper-line) 1px, transparent 1px)', backgroundSize: `${s}px ${s}px` }
      : paper === 'dotted' ? { backgroundImage: 'radial-gradient(var(--paper-dot) 1.2px, transparent 1.4px)', backgroundSize: `${s}px ${s}px` } : {};

  const cursor = readOnly ? 'default' : tool.tool === 'eraser' ? 'cell' : tool.tool === 'lasso' ? 'crosshair' : tool.tool === 'text' ? 'text' : 'crosshair';
  const W = width * zoom, H = h * scale;
  return (
    <div ref={wrap} className={`ink-canvas${zoom > 1 ? ' zoomed' : ''}`} style={{ height: H }} tabIndex={readOnly ? -1 : 0} onKeyDown={onKey}>
      <div className="ink-inner" style={{ width: W || '100%', height: H, ...bg }}>
        {background && <img className="ink-photo" src={background} alt="" draggable={false} />}
        <canvas ref={base} style={{ width: W, height: H }} />
        <canvas ref={live} className="ink-live" style={{ width: W, height: H, cursor, touchAction: 'none' }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onContextMenu={(e) => e.preventDefault()} />
        {children?.(scale)}
      </div>
      {zoom > 1 && <button className="zoom-badge" onClick={() => zoomTo(1)} title="Back to 100% (Ctrl+0)">{Math.round(zoom * 100)}%</button>}
    </div>
  );
});

// Stroke → corrected points with an even pressure (so the line has one width), or null.
function shapeOf(stroke, { minSize }) {
  const pts = [];
  for (let i = 0; i + 1 < stroke.p.length; i += 3) pts.push([stroke.p[i], stroke.p[i + 1]]);
  const b = bounds([{ ...stroke, w: 0 }]);
  if (!b || Math.hypot(b.maxX - b.minX, b.maxY - b.minY) < minSize) return null;
  const r = recognize(pts);
  if (!r) return null;
  const pr = r.kind === 'smooth' ? null : 0.6;
  const press = (i) => pr ?? stroke.p[Math.min(stroke.p.length - 1, Math.round((i / r.points.length) * (pts.length - 1)) * 3 + 2)] ?? 0.5;
  return { kind: r.kind, p: r.points.flatMap(([x, y], i) => [x, y, press(i)]) };
}

const hlColor = (c) => (/^#(1f2937|000000|111827)$/i.test(c) ? '#facc15' : c);
