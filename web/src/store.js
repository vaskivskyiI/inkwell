// Tiny global store (no library): state + subscribe, read with useStore(selector). Selectors must return stable
// values (primitives or objects kept in the state), not new objects per call.
import { useSyncExternalStore } from 'react';

let state = {
  user: null,
  authState: null,
  spaces: [],
  spaceId: localGet('spaceId'),
  trees: {},           // spaceId → notes[]
  favorites: [],
  settings: null,
  route: parseHash(),
  panel: localGet('panel') || '',  // '' | 'ai' | 'links' | 'ask' | 'history'
  sidebar: localGet('sidebar') !== '0',
  palette: false,
  toasts: [],
  online: true,
  halcyon: null,
  commentQuote: '',    // passage a new comment is about
  penLayer: false,     // handwriting on top of the open typed page
  inkText: {},         // noteId → canvasId → { text, data } (handwriting read by AI)
  inkTool: JSON.parse(localGet('inkTool') || 'null') || { tool: 'pen', color: '#1f2937', width: 3 },
};
const subs = new Set();

export const store = {
  get: () => state,
  set(patch) {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    for (const fn of subs) fn();
  },
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
};

export const useStore = (sel) => useSyncExternalStore(store.subscribe, () => sel(state));

export function localGet(k) { try { return localStorage.getItem(`inkwell:${k}`); } catch { return null; } }
export function localSet(k, v) { try { if (v === null || v === undefined) localStorage.removeItem(`inkwell:${k}`); else localStorage.setItem(`inkwell:${k}`, v); } catch { /* private mode */ } }

// ---- routing: #/ · #/n/<id> · #/settings/<section> · #/trash · #/search?q=
export function parseHash() {
  const h = (typeof location !== 'undefined' ? location.hash : '').replace(/^#\/?/, '');
  const [path, query = ''] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  return { name: parts[0] || 'home', id: parts[1] || null, section: parts[1] || null, query: Object.fromEntries(new URLSearchParams(query)) };
}
export const navigate = (hash) => { if (location.hash !== hash) location.hash = hash; else store.set({ route: parseHash() }); };
export const openNote = (id) => navigate(`#/n/${id}`);
if (typeof window !== 'undefined') window.addEventListener('hashchange', () => store.set({ route: parseHash() }));

// ---- toasts
let toastId = 0;
export function toast(text, { kind = 'info', duration = 3500, action } = {}) {
  const id = ++toastId;
  store.set((s) => ({ toasts: [...s.toasts, { id, text, kind, action }] }));
  setTimeout(() => store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), duration);
}
export const toastError = (e) => toast(e?.message || String(e), { kind: 'error', duration: 6000 });

// ---- tree helpers
export function setTree(spaceId, notes) { store.set((s) => ({ trees: { ...s.trees, [spaceId]: notes } })); }
export function patchNote(note) {
  store.set((s) => {
    const trees = { ...s.trees };
    for (const [sid, list] of Object.entries(trees)) {
      const i = list.findIndex((n) => n.id === note.id);
      if (i >= 0) {
        const next = [...list];
        next[i] = { ...next[i], ...note };
        trees[sid] = next;
      }
    }
    if (note.spaceId && trees[note.spaceId] && !trees[note.spaceId].some((n) => n.id === note.id)) trees[note.spaceId] = [...trees[note.spaceId], note];
    return { trees };
  });
}
export function removeNotes(ids) {
  const set = new Set(ids);
  store.set((s) => ({ trees: Object.fromEntries(Object.entries(s.trees).map(([k, v]) => [k, v.filter((n) => !set.has(n.id))])), favorites: s.favorites.filter((f) => !set.has(f.id)) }));
}
export function findNote(id) {
  for (const list of Object.values(state.trees)) { const n = list.find((x) => x.id === id); if (n) return n; }
  return null;
}
/** The space new pages go to: the selected one, or in "All spaces" the first the user can write in. */
export const currentSpace = () => state.spaces.find((s) => s.id === state.spaceId)
  || state.spaces.find((s) => ['owner', 'editor'].includes(s.role)) || state.spaces[0];
export const filterSpace = () => (state.spaceId === 'all' ? '' : state.spaceId || '');
