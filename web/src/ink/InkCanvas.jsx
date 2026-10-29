// A handwriting surface bound to a Y.Array of strokes (doc.ink[canvasId]). Logical width 1000 units, scaled to the
// element's width, so ink lands in the same place on every device. Pen, highlighter, stroke eraser (also the pen's
// eraser button), lasso select/move; touch scrolls instead of drawing once a pen has been used ("pen only").
import { useEffect, useLayoutEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import * as Y from 'yjs';
import { CANVAS_WIDTH, TOOLS, outline, path2d, hits, strokeInLasso, bounds, sid } from './geometry.js';
import { useStore, store } from '../store.js';

const LOCAL = { local: true };
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

export const InkCanvas = forwardRef(function InkCanvas({ doc, canvasId, height, onHeightChange, autoGrow = false, minHeight = 200, readOnly = false, paper = 'plain', onTap, children, onStrokesChange }, ref) {
  const wrap = useRef(null), base = useRef(null), live = useRef(null);
  const [width, setWidth] = useState(0);
  const tool = useStore((s) => s.inkTool);
  const strokes = useRef([]);
  const paths = useRef(new Map());
  const yarr = useRef(null);
  const undo = useRef(null);
  const sel = useRef({ ids: new Set(), box: null });
  const [, force] = useState(0);
  const scale = width / CANVAS_WIDTH || 1;

  useImperativeHandle(ref, () => ({
    undo: () => undo.current?.undo(), redo: () => undo.current?.redo(),
    canUndo: () => !!undo.current?.undoStack.length, canRedo: () => !!undo.current?.redoStack.length,
    clearSelection, deleteSelection, strokes: () => strokes.current, clear: () => { const a = yarr.current; if (a?.length) doc.transact(() => a.delete(0, a.length), LOCAL); },
  }));

  // ---- bind to the Y.Array (created lazily, possibly by another device)
  useEffect(() => {
    const ink = doc.getMap('ink');
    let arr = null;
    const sync = () => {
      strokes.current = arr ? arr.toArray() : [];
      const live = new Set(strokes.current.map((s) => s.id));
      for (const id of paths.current.keys()) if (!live.has(id)) paths.current.delete(id);
      for (const id of [...sel.current.ids]) if (!live.has(id)) sel.current.ids.delete(id);
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
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const h = Math.max(height || minHeight, minHeight);

  function grow() {
    const b = bounds(strokes.current);
    const need = Math.max(minHeight, (b?.maxY || 0) + 600);
    if (onHeightChange && Math.abs(need - h) > 40 && need > h) onHeightChange(need);
  }

  // ---- drawing (observers live across renders: they reach the current render's functions through `latest`)
  const raf = useRef(0);
  const latest = useRef({});
  latest.current = { redraw, grow, autoGrow, onStrokesChange };
  function schedule() { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(() => latest.current.redraw()); }

  function setup(c) {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(width * dpr), H = Math.round(h * scale * dpr);
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
    const dark = document.documentElement.dataset.theme === 'dark';
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
  useEffect(schedule, [width, h]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const pt = (e) => {
    const r = live.current.getBoundingClientRect();
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale, e.pointerType === 'pen' || e.pressure !== 0.5 ? Math.max(0.05, Math.min(1, e.pressure || 0.5)) : 0.5];
  };

  function onDown(e) {
    if (e.pointerType === 'pen') penSeen = true;
    if (readOnly) return;
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
    drawLive();
  }

  function onMove(e) {
    const gs = g.current;
    if (!gs) return;
    if (gs.kind === 'scroll') { gs.el.scrollBy(gs.x - e.clientX, gs.y - e.clientY); gs.x = e.clientX; gs.y = e.clientY; return; }
    const events = e.getCoalescedEvents?.() || [e];
    if (gs.kind === 'draw') { for (const ev of events) gs.stroke.p.push(...pt(ev)); drawLive(); }
    else if (gs.kind === 'erase') for (const ev of events) erase(pt(ev));
    else if (gs.kind === 'lasso') { const p = pt(e); gs.poly.push([p[0], p[1]]); drawLive(); }
    else if (gs.kind === 'move') { const p = pt(e); gs.dx = p[0] - gs.from[0]; gs.dy = p[1] - gs.from[1]; drawLive(); }
  }

  function onUp() {
    const gs = g.current;
    g.current = null;
    if (!gs) return;
    clearLive();
    if (gs.kind === 'draw') {
      const s = gs.stroke;
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
    const r = 8 / Math.max(scale, 0.3);
    const hit = [];
    a.forEach((s, i) => { if (hits(s, p[0], p[1], r)) hit.push(i); });
    if (hit.length) doc.transact(() => { for (const i of hit.reverse()) a.delete(i, 1); }, LOCAL);
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
      ctx.fill(path2d(outline(gs.stroke, false)));
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
    else if (e.key === 'Escape') clearSelection();
  }

  const step = { ruled: 32, grid: 32, dotted: 32 }[paper];
  const s = step * scale;
  const bg = paper === 'ruled' ? { backgroundImage: 'linear-gradient(var(--paper-line) 1px, transparent 1px)', backgroundSize: `100% ${s}px`, backgroundPosition: `0 ${s - 1}px` }
    : paper === 'grid' ? { backgroundImage: 'linear-gradient(var(--paper-line) 1px, transparent 1px), linear-gradient(90deg, var(--paper-line) 1px, transparent 1px)', backgroundSize: `${s}px ${s}px` }
      : paper === 'dotted' ? { backgroundImage: 'radial-gradient(var(--paper-dot) 1.2px, transparent 1.4px)', backgroundSize: `${s}px ${s}px` } : {};

  const cursor = readOnly ? 'default' : tool.tool === 'eraser' ? 'cell' : tool.tool === 'lasso' ? 'crosshair' : tool.tool === 'text' ? 'text' : 'crosshair';
  return (
    <div ref={wrap} className="ink-canvas" style={{ height: h * scale, ...bg }} tabIndex={readOnly ? -1 : 0} onKeyDown={onKey}>
      <canvas ref={base} style={{ width: '100%', height: h * scale }} />
      <canvas ref={live} className="ink-live" style={{ width: '100%', height: h * scale, cursor, touchAction: 'none' }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onContextMenu={(e) => e.preventDefault()} />
      {children?.(scale)}
    </div>
  );
});

const hlColor = (c) => (/^#(1f2937|000000|111827)$/i.test(c) ? '#facc15' : c);
