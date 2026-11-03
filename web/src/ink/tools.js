// The pen in hand: tool, and per instrument its own colour and size (a highlighter is broader than a pen).
// Kept on this device. Older saved settings had one colour and width for both.
import { store, localSet } from '../store.js';

export const COLORS = ['#1f2937', '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c'];
export const HL = ['#facc15', '#4ade80', '#60a5fa', '#f472b6'];
export const SIZES = { pen: [0.75, 1.25, 2, 3, 5], hl: [6, 10, 16, 24] };
export const RANGE = { pen: [0.5, 40, 0.25], hl: [3, 120, 1] };
// The custom palette: a few greys and the usual hues in three shades.
export const PALETTE = ['#000000', '#374151', '#6b7280', '#9ca3af', '#d1d5db', '#ffffff',
  '#7f1d1d', '#b91c1c', '#ef4444', '#fca5a5', '#7c2d12', '#c2410c', '#f97316', '#fdba74',
  '#713f12', '#a16207', '#eab308', '#fde047', '#14532d', '#15803d', '#22c55e', '#86efac',
  '#134e4a', '#0f766e', '#14b8a6', '#5eead4', '#1e3a8a', '#1d4ed8', '#3b82f6', '#93c5fd',
  '#4c1d95', '#6d28d9', '#8b5cf6', '#c4b5fd', '#831843', '#be185d', '#ec4899', '#f9a8d4'];

const kindOf = (tool) => (tool === 'hl' ? 'hl' : 'pen');
const isDark = (c) => /^#(1f2937|000000|111827)$/i.test(c || '');

export function toolSize(t, tool = t.tool) {
  const k = kindOf(tool);
  return t.sizes?.[k] ?? (k === 'hl' ? (t.width || 3) * 5 : t.width || 3);
}

export function toolColor(t, tool = t.tool) {
  const k = kindOf(tool);
  const c = t.colors?.[k] ?? t.color ?? '#1f2937';
  return k === 'hl' && isDark(c) ? '#facc15' : c;
}

export function setInkTool(patch) {
  const next = { ...store.get().inkTool, ...patch };
  store.set({ inkTool: next });
  localSet('inkTool', JSON.stringify(next));
}

export function setToolSize(size) {
  const t = store.get().inkTool;
  setInkTool({ sizes: { ...t.sizes, [kindOf(t.tool)]: size } });
}

/** custom: remembered among the last few colours picked from the palette. */
export function setToolColor(color, { custom = false } = {}) {
  const t = store.get().inkTool;
  const recent = custom ? [color, ...(t.recent || []).filter((c) => c.toLowerCase() !== color.toLowerCase())].slice(0, 8) : t.recent;
  setInkTool({ colors: { ...t.colors, [kindOf(t.tool)]: color }, ...(t.tool === 'hl' ? {} : { color }), recent });
}
