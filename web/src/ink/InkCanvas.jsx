// A handwriting surface bound to a Y.Array of strokes (doc.ink[canvasId]). Logical width 1000 units, scaled to the
// element's width, so ink lands in the same place on every device. Pen, highlighter, eraser (whole strokes or
// partial, also the pen's eraser button), lasso select/move, shape correction (Shapes mode, or hold the pen still at
// the end of a stroke), pinch / Ctrl+wheel zoom. Only the pen draws, unless "Draw with finger and mouse" is on
// (inkTool.finger): otherwise one finger or the mouse moves the paper, two fingers move and zoom it, and a palm next
// to the pen is ignored.
import { useEffect, useLayoutEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { Trash2, Copy, Scissors, ClipboardPaste, BoxSelect, Undo2, Redo2 } from 'lucide-react';
import * as Y from 'yjs';
import { CANVAS_WIDTH, TOOLS, outline, path2d, hits, strokeInLasso, bounds, sid } from './geometry.js';
import { recognize, eraseFromStroke } from './shapes.js';
import { keepKeyboardAway } from './keyboard.js';
import { CanvasImages, LOCAL, shiftImages, imagesBottom } from './CanvasImages.jsx';
import { useStore, store, toast, localGet, localSet } from '../store.js';
import { toolSize, toolColor } from './tools.js';
import { putInk, inkFromHtml, writeInk, readInk, placeAt } from './clipboard.js';
import { openContextMenu, pressedJustNow } from '../ui/ContextMenu.jsx';

const MAX_ZOOM = 3;
let penAt = 0; // last time the pen touched or hovered: touches right after are the hand resting on the screen
let drewAt = 0; // last stroke end: a pen held still at the end of a stroke is not a right-click
export const penOnlyActive = () => !store.get().inkTool?.finger;
const INKING = ['pen', 'hl', 'eraser'];
let hinted = false;
// Someone without a pen tries to draw: say once how.
function fingerHint() {
  if (hinted || localGet('fingerHint')) return;
  hinted = true;
  localSet('fingerHint', '1');
  toast('Only the pen writes here. To draw with a finger or the mouse, turn on ✋ in the toolbar.');
}

const scrollParent = (el) => {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement;
};


// offsetOf(stroke) → vertical shift in logical units (ink anchored to text that moved); anchorFor(stroke) → anchor
// stored on new strokes; redrawKey: changes when offsets may have changed.
export const InkCanvas = forwardRef(function InkCanvas({ doc, canvasId, height, onHeightChange, autoGrow = false, minHeight = 200, readOnly = false, paper = 'plain', background, onTap, children, onStrokesChange, zoomable = true, offsetOf, anchorFor, redrawKey, spaceable = true, onSpace, images = false, toolOverride, contentBottom }, ref) {
  const offOf = (s) => (s.a && offsetOf ? offsetOf(s) || 0 : 0);
  // The stroke where it is shown (points shifted by its offset), for hit tests and selection.
  const shown = (s) => { const o = offOf(s); return o ? { ...s, p: s.p.map((v, i) => (i % 3 === 1 ? v + o : v)) } : s; };
  const wrap = useRef(null), base = useRef(null), live = useRef(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const stored = useStore((s) => s.inkTool);
  const tool = toolOverride ? { ...stored, ...toolOverride } : stored;
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
    clearSelection, deleteSelection, strokes: () => strokes.current, copySelection: () => writeInk(selected()), selectAll,
    select: (ids) => { sel.current = { ids: new Set(ids), box: null }; schedule(); force((x) => x + 1); wrap.current?.focus({ preventScroll: true }); },
    // Insert / close space from a handle outside the canvas (a divider's grip): the drag continues here.
    startSpace: (e, y) => { if (readOnly) return; e.preventDefault(); live.current.setPointerCapture(e.pointerId); beginSpace(y, e); }, clear: () => { const a = yarr.current; if (a?.length) doc.transact(() => a.delete(0, a.length), LOCAL); },
    // Where a new picture goes: the middle of what is on screen, in canvas units.
    viewCenter: () => { const v = visible(); return { x: v.cx, y: v.cy }; },
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
      const scope = [...(arr ? [arr] : []), ...(images ? [doc.getMap('images')] : [])];
      undo.current = scope.length ? new Y.UndoManager(scope, { trackedOrigins: new Set([LOCAL]), captureTimeout: 300 }) : null;
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

  // Done writing (the canvas lost focus, or the page closes): paper added earlier and left empty goes again. A canvas
  // with nothing on it keeps the size it was given.
  function shrink() {
    if (!onHeightChange || readOnly || g.current) return;
    const b = bounds(strokes.current.map(shown));
    const bottom = Math.max(b?.maxY || 0, images ? imagesBottom(doc, canvasId) : 0, contentBottom?.() || 0);
    if (!bottom && !autoGrow) return;
    const need = Math.max(minHeight, Math.ceil((bottom + (autoGrow ? 600 : 40)) / 20) * 20);
    if (h - need > (autoGrow ? 400 : 80)) onHeightChange(need);
  }
  // A journal also on leaving the page (a drawing block in a typed page may be leaving because it was deleted).
  useEffect(() => () => { if (latest.current.autoGrow) try { latest.current.shrink(); } catch { /* doc already gone */ } }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
  latest.current = { redraw, grow, autoGrow, onStrokesChange, zoomTo, zoom, shrink, edgeTick };
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
      const off = offOf(s);
      if (off) { ctx.save(); ctx.translate(0, off); ctx.fill(pathOf(s)); ctx.restore(); } else ctx.fill(pathOf(s));
    }
    ctx.globalAlpha = 1;
    if (sel.current.ids.size) {
      const chosen = strokes.current.filter((s) => sel.current.ids.has(s.id));
      ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 1.5 / scale;
      for (const s of chosen) { ctx.save(); ctx.translate(0, offOf(s)); ctx.stroke(pathOf(s)); ctx.restore(); }
      const b = bounds(chosen.map(shown));
      if (b) { ctx.setLineDash([6 / scale, 4 / scale]); ctx.strokeRect(b.minX - 6, b.minY - 6, b.maxX - b.minX + 12, b.maxY - b.minY + 12); ctx.setLineDash([]); sel.current.box = b; }
    }
  }
  useEffect(schedule, [width, h, zoom, redrawKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function clearSelection() { sel.current = { ids: new Set(), box: null }; schedule(); force((x) => x + 1); }
  function setSelection(ids) { sel.current = { ids: new Set(ids), box: null }; schedule(); force((x) => x + 1); }
  function selectAll() { setSelection(strokes.current.map((s) => s.id)); wrap.current?.focus({ preventScroll: true }); }
  const selected = () => strokes.current.filter((s) => sel.current.ids.has(s.id)).map(shown);
  // The part of the canvas on screen, in canvas units.
  function visible() {
    const r = live.current.getBoundingClientRect();
    const sp = scrollParent(wrap.current);
    const box = sp && sp !== document.scrollingElement ? sp.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const top = (Math.max(r.top, box.top, 0) - r.top) / scale, bottom = (Math.min(r.bottom, box.bottom, window.innerHeight) - r.top) / scale;
    const left = (Math.max(r.left, 0) - r.left) / scale, right = (Math.min(r.right, window.innerWidth, wrap.current.getBoundingClientRect().right) - r.left) / scale;
    return { top, bottom, left, right, cx: (left + right) / 2, cy: (top + Math.max(top, bottom)) / 2 };
  }
  // Pasted ink: at the given point (a menu), else where it was copied from when that is on screen (a little lower
  // while the same ink is still there), else in the middle of the screen. It comes in selected, ready to be moved.
  function paste(ink, at) {
    if (readOnly || !ink?.length) return;
    const b = bounds(ink);
    const w = b.maxX - b.minX, hh = b.maxY - b.minY;
    const v = visible();
    let x, y;
    if (at) { x = at.x; y = at.y; }
    else if (b.minY >= v.top && b.maxY <= v.bottom) {
      x = b.minX; y = b.minY;
      const fx = ink[0].p[0] - b.minX, fy = ink[0].p[1] - b.minY;
      const taken = (px, py) => strokes.current.some((s) => Math.abs(s.p[0] - px) < 0.5 && Math.abs(s.p[1] + offOf(s) - py) < 0.5);
      for (let i = 0; i < 30 && taken(x + fx, y + fy); i++) { x += 24; y += 24; }
    } else { x = v.cx - w / 2; y = v.cy - hh / 2; }
    x = Math.max(0, Math.min(x, CANVAS_WIDTH - w));
    const placed = placeAt(ink, x, y).map((s) => { const anchor = anchorFor?.(s); return anchor ? { ...s, a: anchor } : s; });
    const a = ensureArray();
    doc.transact(() => a.push(placed), LOCAL);
    const bottom = bounds(placed).maxY;
    if (onHeightChange && bottom > h - (autoGrow ? 300 : 20)) onHeightChange(Math.ceil((bottom + (autoGrow ? 600 : 60)) / 20) * 20);
    setSelection(placed.map((s) => s.id));
    wrap.current?.focus({ preventScroll: true });
  }
  function cut() { writeInk(selected()); deleteSelection(); }
  // Right-click, the pen's barrel button, or a long press.
  function menu(e) {
    const r = live.current.getBoundingClientRect();
    const at = { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
    const has = sel.current.ids.size > 0;
    openContextMenu(e, [
      { label: 'Cut', icon: Scissors, keys: 'Ctrl+X', disabled: !has, hidden: readOnly, onClick: cut },
      { label: 'Copy', icon: Copy, keys: 'Ctrl+C', disabled: !has, onClick: () => writeInk(selected()) },
      { label: 'Paste', icon: ClipboardPaste, keys: 'Ctrl+V', hidden: readOnly, onClick: async () => { const ink = await readInk(); if (ink) paste(ink, at); else toast('Nothing to paste: copy some handwriting first'); } },
      { label: 'Delete', icon: Trash2, keys: 'Del', disabled: !has, hidden: readOnly, danger: true, onClick: deleteSelection },
      { divider: true },
      { label: 'Select all', icon: BoxSelect, keys: 'Ctrl+A', disabled: !strokes.current.length, onClick: selectAll },
      { label: 'Undo', icon: Undo2, keys: 'Ctrl+Z', hidden: readOnly, disabled: !undo.current?.undoStack.length, onClick: () => undo.current?.undo() },
      { label: 'Redo', icon: Redo2, keys: 'Ctrl+Y', hidden: readOnly, disabled: !undo.current?.redoStack.length, onClick: () => undo.current?.redo() },
    ]);
  }
  function onContextMenu(e) {
    e.preventDefault();
    if (pressedJustNow() || Date.now() - drewAt < 800) return;
    const gs = g.current;
    if (gs && !(gs.kind === 'idle' || (gs.kind === 'scroll' && gs.moved < 10) || (gs.kind === 'move' && !gs.dx && !gs.dy))) return;
    clearTimeout(press.current);
    g.current = null; clearLive();
    e.stopPropagation();
    menu(e);
  }
  // A finger held still on the paper (or on the selection) opens the menu.
  const press = useRef(0);
  function armPress(e) {
    clearTimeout(press.current);
    if (e.pointerType !== 'touch') return;
    const gs = g.current, x = e.clientX, y = e.clientY;
    if (!gs || !['scroll', 'idle', 'move'].includes(gs.kind)) return;
    gs.px = x; gs.py = y;
    press.current = setTimeout(() => {
      if (g.current !== gs || (gs.kind === 'move' && (gs.dx || gs.dy)) || (gs.kind === 'scroll' && gs.moved > 10)) return;
      g.current = null; clearLive();
      menu({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} });
    }, 550);
  }
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
    g.current = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, el: scrollParent(wrap.current) };
    clearLive();
  }

  function beginSpace(y, e) {
    // Everything lower down moves; dragging up only closes empty space.
    const below = strokes.current.filter((s) => middleY(shown(s)) >= y);
    const top = bounds(below.map(shown))?.minY ?? Infinity;
    g.current = { kind: 'space', y0: y, dy: 0, ids: new Set(below.map((s) => s.id)), minDy: top === Infinity ? 0 : y - top, pid: e.pointerId, type: e.pointerType };
    drawLive();
  }

  const selBox = () => (sel.current.ids.size ? bounds(strokes.current.filter((s) => sel.current.ids.has(s.id)).map(shown)) : null);
  const inSel = (p) => { const b = selBox(); return !!b && p[0] > b.minX - 14 && p[0] < b.maxX + 14 && p[1] > b.minY - 14 && p[1] < b.maxY + 14; };

  function onDown(e) { down(e); armPress(e); }
  function down(e) {
    if (e.pointerType === 'pen') penAt = Date.now();
    if (e.pointerType !== 'touch') pointerKind(e);
    keepKeyboardAway();
    const own = { pid: e.pointerId, type: e.pointerType };
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // The hand resting on the screen while the pen writes or hovers: not a gesture.
      if ((g.current && g.current.type !== 'touch') || Date.now() - penAt < 700) { e.preventDefault(); return; }
      // Two fingers move the paper (and zoom it).
      if (touches.current.size === 2) { e.preventDefault(); startPinch(); return; }
    }
    if (readOnly) {
      if (e.pointerType === 'touch') g.current = { kind: 'scroll', y: e.clientY, x: e.clientX, el: scrollParent(wrap.current), ...own };
      return;
    }
    if (e.button === 2) return;
    const p = pt(e);
    const eraser = e.button === 5 || (e.buttons & 32) || tool.tool === 'eraser';
    // A selection moves with the pen, the mouse or a finger; a tap anywhere else lets it go.
    if (sel.current.ids.size && !eraser) {
      if (inSel(p)) {
        e.preventDefault();
        live.current.setPointerCapture(e.pointerId);
        g.current = { kind: 'move', from: p, dx: 0, dy: 0, ...own };
        return;
      }
      clearSelection();
      if (e.pointerType === 'touch') { e.preventDefault(); g.current = { kind: 'idle', ...own }; return; }
    }
    // A finger or the mouse with a drawing tool moves the paper (unless they may draw); the pen always draws.
    if (e.pointerType !== 'pen' && !eraser && INKING.includes(tool.tool) && !tool.finger) {
      if (e.pointerType === 'mouse') { e.preventDefault(); live.current.setPointerCapture(e.pointerId); }
      g.current = { kind: 'scroll', y: e.clientY, x: e.clientX, el: scrollParent(wrap.current), moved: 0, ...own };
      return;
    }
    e.preventDefault();
    wrap.current?.focus({ preventScroll: true }); // keys (undo, tools) work here, and no text has focus
    live.current.setPointerCapture(e.pointerId);
    if (tool.tool === 'text' && onTap) { g.current = { kind: 'tap', p, ...own }; return; }
    if (eraser) { g.current = { kind: 'erase', ...own }; erase(p); return; }
    if (tool.tool === 'space' && spaceable) { beginSpace(p[1], e); return; }
    if (tool.tool === 'lasso') { g.current = { kind: 'lasso', poly: [[p[0], p[1]]], ...own }; return; }
    const kind = tool.tool === 'hl' ? 'hl' : 'pen';
    g.current = { kind: 'draw', stroke: { id: sid(), t: kind, c: toolColor(tool, kind), w: toolSize(tool, kind), p: [...p] }, ...own };
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

  // The pen over the paper writes where its tip is: no cursor then (a mouse gets one, a hand when it moves the paper).
  const [penHover, setPenHover] = useState(false);
  const pointerKind = (e) => { const pen = e.pointerType === 'pen'; if (pen !== penHover) setPenHover(pen); };

  function onMove(e) {
    if (e.pointerType !== 'touch') pointerKind(e);
    if (e.pointerType === 'pen') penAt = Date.now(); // hovering counts: the palm comes down before the pen does
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const gs = g.current;
    if (!gs) return;
    if (gs.kind === 'pinch') {
      const [a, b] = [...touches.current.values()];
      if (!a || !b) return;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      gs.el?.scrollBy(0, gs.my - my);
      wrap.current.scrollLeft += gs.mx - mx;
      gs.mx = mx; gs.my = my;
      if (zoomable) zoomTo(gs.z0 * (Math.hypot(a.x - b.x, a.y - b.y) / gs.d0), mx, my);
      return;
    }
    // Only the pointer that started the gesture moves it (not a palm or a second finger).
    if (e.pointerId !== gs.pid || gs.kind === 'idle') return;
    if (gs.kind === 'scroll') { gs.moved += Math.abs(gs.y - e.clientY) + Math.abs(gs.x - e.clientX); gs.el.scrollBy(0, gs.y - e.clientY); wrap.current.scrollLeft += gs.x - e.clientX; gs.x = e.clientX; gs.y = e.clientY; return; }
    const events = e.getCoalescedEvents?.() || [e];
    if (gs.kind === 'draw') {
      if (gs.snapped) return;
      const p0 = gs.stroke.p;
      for (const ev of events) gs.stroke.p.push(...pt(ev));
      const n = p0.length;
      // Near the bottom: more paper before the pen gets there.
      const y = p0[n - 2];
      if (onHeightChange) {
        const need = autoGrow ? (y > h - 350 ? Math.ceil((y + 1000) / 100) * 100 : 0) : (y > h - 30 ? Math.ceil((y + 80) / 20) * 20 : 0);
        if (need > h) onHeightChange(need);
      }
      if (n > 6 && Math.hypot(p0[n - 3] - p0[n - 6], p0[n - 2] - p0[n - 5]) > 1.5 / Math.max(scale, 0.3)) armHold();
      drawLive();
    } else if (gs.kind === 'erase') for (const ev of events) erase(pt(ev));
    else if (gs.kind === 'lasso') { const p = pt(e); gs.poly.push([p[0], p[1]]); drawLive(); edge(gs, e); }
    else if (gs.kind === 'move') { if (gs.px != null && Math.hypot(e.clientX - gs.px, e.clientY - gs.py) < 8) return; gs.px = null; moveTo(gs, pt(e)); edge(gs, e); }
    else if (gs.kind === 'space') { gs.dy = Math.max(Math.min(0, gs.minDy), pt(e)[1] - gs.y0); drawLive(); }
  }

  // Moving the selection: it stays on the paper; near the bottom more paper comes.
  function moveTo(gs, p) {
    const b = selBox();
    if (!b) return;
    gs.dx = Math.max(-b.minX, Math.min(CANVAS_WIDTH - b.maxX, p[0] - gs.from[0]));
    gs.dy = Math.max(-b.minY, p[1] - gs.from[1]);
    if (onHeightChange && b.maxY + gs.dy > h - 150) onHeightChange(Math.ceil((b.maxY + gs.dy + (autoGrow ? 600 : 200)) / 20) * 20);
    drawLive();
  }
  // Moving a selection or drawing a lasso near the edge of the screen: the paper scrolls along, so ink can go to a
  // part of the page that was not on screen.
  const auto = useRef(0);
  function edge(gs, e) {
    gs.cx = e.clientX; gs.cy = e.clientY;
    if (!auto.current) auto.current = requestAnimationFrame(() => latest.current.edgeTick());
  }
  function edgeTick() {
    auto.current = 0;
    const gs = g.current;
    if (!gs || !['move', 'lasso'].includes(gs.kind) || gs.cx == null || !wrap.current) return;
    const sp = scrollParent(wrap.current);
    const box = sp && sp !== document.scrollingElement ? sp.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const wr = wrap.current.getBoundingClientRect();
    const top = Math.max(box.top, 0), bottom = Math.min(box.bottom, window.innerHeight);
    const E = 56, speed = (d) => Math.min(24, Math.ceil(d / 3));
    const vy = gs.cy < top + E ? -speed(top + E - gs.cy) : gs.cy > bottom - E ? speed(gs.cy - (bottom - E)) : 0;
    const vx = zoom <= 1 ? 0 : gs.cx < wr.left + E ? -speed(wr.left + E - gs.cx) : gs.cx > wr.right - E ? speed(gs.cx - (wr.right - E)) : 0;
    const y0 = sp.scrollTop, x0 = wrap.current.scrollLeft;
    if (vy) sp.scrollBy(0, vy);
    if (vx) wrap.current.scrollLeft += vx;
    if (sp.scrollTop === y0 && wrap.current.scrollLeft === x0) return;
    const p = pt({ clientX: gs.cx, clientY: gs.cy, pointerType: 'mouse', pressure: 0.5 });
    if (gs.kind === 'move') moveTo(gs, p); else { gs.poly.push([p[0], p[1]]); drawLive(); }
    auto.current = requestAnimationFrame(() => latest.current.edgeTick());
  }

  function onUp(e) {
    clearTimeout(press.current);
    if (e?.pointerType === 'touch') touches.current.delete(e.pointerId);
    if (e?.pointerType === 'pen') penAt = Date.now();
    const gs = g.current;
    if (gs?.kind === 'pinch') { if (touches.current.size < 2) g.current = null; return; }
    if (!gs || (e && e.pointerId !== gs.pid)) return;
    g.current = null;
    // The mouse dragged on the paper and nothing happened: it may be someone without a pen.
    if (gs.kind === 'scroll' && gs.type === 'mouse' && !readOnly) fingerHint();
    clearTimeout(gs.hold);
    clearLive();
    if (gs.kind === 'draw') {
      drewAt = Date.now();
      const s = gs.stroke;
      // Shapes mode: larger strokes are straightened or smoothed when lifted (handwriting is left alone).
      if (!gs.snapped && tool.shapes && s.t === 'pen') { const r = shapeOf(s, { minSize: 60 }); if (r) s.p = r.p; }
      // A long horizontal line is a divider: always straightened.
      else if (!gs.snapped && s.t === 'pen') { const d = dividerOf(s); if (d) s.p = d; }
      s.p = s.p.map((v, i) => (i % 3 === 2 ? Math.round(v * 100) / 100 : Math.round(v * 10) / 10));
      const a = ensureArray();
      const anchor = anchorFor?.(s);
      if (anchor) s.a = anchor;
      doc.transact(() => a.push([s]), LOCAL);
      if (onHeightChange && !autoGrow) {
        const b = bounds([s]);
        if (b && b.maxY > h - 20) onHeightChange(Math.ceil((b.maxY + 60) / 20) * 20);
      }
    } else if (gs.kind === 'space' && Math.abs(gs.dy) >= 2) {
      const a = yarr.current;
      const dy = Math.round(gs.dy);
      if (a?.length && gs.ids.size) {
        doc.transact(() => {
          const moved = [];
          for (let i = a.length - 1; i >= 0; i--) {
            const s = a.get(i);
            if (!gs.ids.has(s.id)) continue;
            a.delete(i, 1);
            moved.unshift({ ...s, id: sid(), p: s.p.map((v, j) => (j % 3 === 1 ? Math.round((v + dy) * 10) / 10 : v)) });
          }
          a.push(moved);
        }, LOCAL);
      }
      if (images) doc.transact(() => shiftImages(doc, canvasId, gs.y0, dy), LOCAL);
      onSpace?.(gs.y0, dy);
      if (dy > 0 && onHeightChange) onHeightChange(Math.ceil((h + dy) / 10) * 10);
    } else if (gs.kind === 'tap') onTap?.(gs.p[0], gs.p[1]);
    else if (gs.kind === 'lasso' && gs.poly.length > 3) {
      sel.current = { ids: new Set(strokes.current.filter((s) => strokeInLasso(shown(s), gs.poly)).map((s) => s.id)), box: null };
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
      schedule(); force((x) => x + 1);
      const bottom = bounds(moved.map(shown))?.maxY || 0;
      if (onHeightChange && bottom > h - 20) onHeightChange(Math.ceil((bottom + (autoGrow ? 600 : 60)) / 20) * 20);
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
        const off = offOf(s);
        if (!hits(s, p[0], p[1] - off, r)) continue;
        if (!partial) { a.delete(i, 1); continue; }
        const pieces = eraseFromStroke(s, p[0], p[1] - off, r, sid);
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
    } else if (gs?.kind === 'space') {
      // The opening space and where the lower part will go.
      ctx.fillStyle = 'rgba(37, 99, 235, .12)';
      ctx.fillRect(0, Math.min(gs.y0, gs.y0 + gs.dy), CANVAS_WIDTH, Math.abs(gs.dy));
      ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1.5 / scale; ctx.setLineDash([8 / scale, 5 / scale]);
      ctx.beginPath(); ctx.moveTo(0, gs.y0); ctx.lineTo(CANVAS_WIDTH, gs.y0); ctx.stroke(); ctx.setLineDash([]);
      ctx.translate(0, gs.dy);
      ctx.globalAlpha = 0.55;
      for (const s of strokes.current) if (gs.ids.has(s.id)) { ctx.fillStyle = s.c; ctx.fill(pathOf(s)); }
    } else if (gs?.kind === 'move') {
      ctx.translate(gs.dx, gs.dy);
      ctx.globalAlpha = 0.6;
      for (const s of strokes.current) if (sel.current.ids.has(s.id)) { ctx.fillStyle = s.c; ctx.save(); ctx.translate(0, offOf(s)); ctx.fill(pathOf(s)); ctx.restore(); }
    }
  }

  function onKey(e) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.current.ids.size) { e.preventDefault(); deleteSelection(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) undo.current?.redo(); else undo.current?.undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); e.stopPropagation(); undo.current?.redo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomTo(zoom * 1.25); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); zoomTo(zoom / 1.25); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); zoomTo(1); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); selectAll(); }
    else if (e.key === 'Escape') clearSelection();
  }
  // Ctrl+C / Ctrl+X / Ctrl+V while the paper has focus (and the same from the browser's own Edit menu).
  function onCopy(e) { if (!sel.current.ids.size) return; e.preventDefault(); e.stopPropagation(); putInk(e, selected()); }
  function onCut(e) { if (!sel.current.ids.size || readOnly) return; onCopy(e); deleteSelection(); }
  function onPaste(e) {
    const ink = inkFromHtml(e.clipboardData?.getData('text/html'));
    if (!ink || readOnly) return; // pictures and text: whoever holds the canvas (a journal) takes them
    e.preventDefault(); e.stopPropagation();
    paste(ink);
  }

  const step = { ruled: 32, grid: 32, dotted: 32 }[paper];
  const s = step * scale;
  const bg = paper === 'ruled' ? { backgroundImage: 'linear-gradient(var(--paper-line) 1px, transparent 1px)', backgroundSize: `100% ${s}px`, backgroundPosition: `0 ${s - 1}px` }
    : paper === 'grid' ? { backgroundImage: 'linear-gradient(var(--paper-line) 1px, transparent 1px), linear-gradient(90deg, var(--paper-line) 1px, transparent 1px)', backgroundSize: `${s}px ${s}px` }
      : paper === 'dotted' ? { backgroundImage: 'radial-gradient(var(--paper-dot) 1.2px, transparent 1.4px)', backgroundSize: `${s}px ${s}px` } : {};

  const cursor = readOnly ? 'default' : penHover && INKING.includes(tool.tool) ? 'none' : INKING.includes(tool.tool) && !tool.finger ? 'grab' : tool.tool === 'space' && spaceable ? 'row-resize' : tool.tool === 'eraser' ? 'cell' : tool.tool === 'lasso' ? 'crosshair' : tool.tool === 'text' ? 'text' : 'crosshair';
  const W = width * zoom, H = h * scale;
  const sb = !readOnly && !g.current && selBox();
  return (
    <div ref={wrap} className={`ink-canvas${zoom > 1 ? ' zoomed' : ''}`} style={{ height: H }} tabIndex={readOnly ? -1 : 0} onKeyDown={onKey} onCopy={onCopy} onCut={onCut} onPaste={onPaste}
      onBlur={(e) => { if (!wrap.current?.contains(e.relatedTarget)) shrink(); }}>
      <div className="ink-inner" style={{ width: W || '100%', height: H, ...bg }}>
        {background && <img className="ink-photo" src={background} alt="" draggable={false} />}
        {images && <CanvasImages doc={doc} canvasId={canvasId} scale={scale} active={tool.tool === 'pick'} readOnly={readOnly} onBottom={(b) => { if (onHeightChange && b > h - 40) onHeightChange(Math.ceil((b + 120) / 10) * 10); }} />}
        <canvas ref={base} style={{ width: W, height: H, pointerEvents: 'none' }} />
        <canvas ref={live} className="ink-live" style={{ width: W, height: H, cursor, touchAction: 'none', pointerEvents: tool.tool === 'pick' && images ? 'none' : undefined }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onContextMenu={onContextMenu} />
        {children?.(scale)}
        {sb && <div className="ink-sel-bar" style={{ left: Math.max(0, Math.min(sb.maxX * scale - 100, W - 104)), top: Math.max(0, sb.minY * scale - 42) }}>
          <button title="Cut (Ctrl+X)" aria-label="Cut the selection" onPointerDown={(e) => e.preventDefault()} onClick={cut}><Scissors size={15} /></button>
          <button title="Copy (Ctrl+C)" aria-label="Copy the selection" onPointerDown={(e) => e.preventDefault()} onClick={() => { writeInk(selected()); toast('Copied: paste with Ctrl+V, or hold a finger on the paper'); }}><Copy size={15} /></button>
          <button title="Delete the selection" aria-label="Delete the selection" onPointerDown={(e) => e.preventDefault()} onClick={deleteSelection}><Trash2 size={15} /></button>
        </div>}
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

// A pen stroke drawn as a long, nearly level line → its points as an exactly level line, or null.
function dividerOf(stroke) {
  const r = shapeOf(stroke, { minSize: 250 });
  if (r?.kind !== 'line') return null;
  const xs = r.p.filter((_, i) => i % 3 === 0), ys = r.p.filter((_, i) => i % 3 === 1);
  const dx = Math.max(...xs) - Math.min(...xs), dy = Math.max(...ys) - Math.min(...ys);
  if (dx < 250 || dy > 0.08 * dx) return null;
  const y = ys.reduce((a, b) => a + b, 0) / ys.length;
  return r.p.map((v, i) => (i % 3 === 1 ? y : v));
}

const middleY = (s) => { const b = bounds([{ ...s, w: 0 }]); return b ? (b.minY + b.maxY) / 2 : 0; };
