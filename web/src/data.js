// Loading spaces/trees, the live event socket, and page documents (Yjs over one shared WebSocket, cached in
// IndexedDB so pages open instantly and can be edited offline).
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { IndexeddbPersistence } from 'y-indexeddb';
import { get, post, patch, del, flushOutbox, setReachHandler, setReachable, setQueuedPageHandler } from './api.js';
import { pendingPages, isPendingPage, pendingCount, loadOutbox, cacheDelete } from './offline.js';
import { store, setTree, patchNote, removeNotes, localSet, localGet, toast, findNote } from './store.js';

const wsUrl = (path) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;

export async function loadSpaces() {
  const spaces = await get('/api/spaces');
  const s = store.get();
  const spaceId = s.spaceId === 'all' || spaces.some((x) => x.id === s.spaceId) ? s.spaceId : spaces[0]?.id;
  store.set({ spaces, spaceId });
  localSet('spaceId', spaceId);
  return spaces;
}

export async function loadTree(spaceId) {
  if (!spaceId || spaceId === 'all') return;
  const { notes } = await get(`/api/spaces/${spaceId}/tree`);
  await loadOutbox();
  // Pages made offline are in the list until the server has them.
  const ids = new Set(notes.map((n) => n.id));
  setTree(spaceId, [...notes, ...pendingPages().filter((n) => n.spaceId === spaceId && !ids.has(n.id))]);
}

// ---- back online: what waited goes out, then the lists are read again (others may have changed things meanwhile)
let syncing = null;
export function syncOutbox() {
  if (syncing || !pendingCount()) return syncing;
  syncing = flushOutbox({ onDone: (op) => { if (op.url === '/api/notes' && op.method === 'POST') attachPending(op.body.id); } })
    .then((n) => { if (n) { toast(`Synced ${n} change${n === 1 ? '' : 's'} made offline`); return refreshAll(); } return null; })
    .catch(() => {}).finally(() => { syncing = null; });
  return syncing;
}
const refreshAll = () => loadSpaces().then(() => Promise.all(Object.keys(store.get().trees).map(loadTree))).then(() => loadFavorites()).catch(() => {});
setQueuedPageHandler(patchNote); // a page made offline shows in the list at once
setReachHandler((ok) => {
  if (!ok) { if (store.get().online) store.set({ online: false }); return; }
  if (pendingCount()) syncOutbox();
});
if (typeof window !== 'undefined') window.addEventListener('online', () => { loadOutbox().then(syncOutbox); });

export const loadFavorites = async () => store.set({ favorites: await get('/api/favorites') });

export function switchSpace(id) {
  store.set({ spaceId: id });
  localSet('spaceId', id);
  if (id !== 'all' && !store.get().trees[id]) loadTree(id);
}

// ---- events
const listeners = new Set();
export const onEvent = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
let sock = null, retry = 0;

export function connectEvents() {
  if (sock) return;
  sock = new WebSocket(wsUrl('/api/ws'));
  sock.onopen = () => {
    setReachable(true);
    if (retry) refreshAll(); // came back: catch up on anything missed
    loadOutbox().then(syncOutbox);
    retry = 0;
    store.set({ online: true });
  };
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const s = store.get();
    switch (m.type) {
      case 'note:created': if (s.trees[m.spaceId]) patchNote(m.note); break;
      case 'note:updated': patchNote(m.note); break;
      case 'note:removed': removeNotes(m.ids); break;
      case 'tree:changed': case 'trash:changed': if (s.trees[m.spaceId]) loadTree(m.spaceId); break;
      case 'spaces:changed': case 'space:changed': loadSpaces().catch(() => {}); break;
      default: break;
    }
    for (const fn of listeners) fn(m);
  };
  sock.onclose = (e) => {
    sock = null;
    store.set({ online: false });
    if (e.code !== 4401) setReachable(false);
    if (e.code === 4401) return;
    retry = Math.min(retry + 1, 6);
    setTimeout(connectEvents, 500 * 2 ** retry);
  };
}

// ---- page documents
let collabSocket = null;
function collabWs() {
  if (!collabSocket) collabSocket = new HocuspocusProviderWebsocket({ url: wsUrl('/api/collab') });
  return collabSocket;
}

const open = new Map(); // noteId → { doc, provider, idb, refs }

/** Opens (or reuses) a page document. Returns { doc, provider, release() }. */
export function openDoc(noteId, user) {
  let e = open.get(noteId);
  if (!e) {
    const doc = new Y.Doc();
    const idb = new IndexeddbPersistence(`inkwell-note-${noteId}`, doc);
    const provider = new HocuspocusProvider({
      websocketProvider: collabWs(), name: `note:${noteId}`, document: doc, token: 'session',
      onAuthenticationFailed: () => toast('You no longer have access to this page', { kind: 'error' }),
    });
    // A page made offline joins the server once the server has it (syncOutbox → attachPending).
    if (!isPendingPage(noteId)) provider.attach?.();
    if (user) provider.setAwarenessField('user', { name: user.name, color: user.color, id: user.id });
    e = { doc, provider, idb, refs: 0, timer: null };
    open.set(noteId, e);
  }
  clearTimeout(e.timer);
  e.refs++;
  if (e.refs === 1) { const o = readJson('offlineOpened'); o[noteId] = { at: Date.now(), clean: false }; localSet('offlineOpened', JSON.stringify(o)); }
  return {
    doc: e.doc, provider: e.provider, idb: e.idb,
    release() {
      e.refs--;
      // Keep recently used pages connected for a bit — switching back is then instant.
      if (e.refs <= 0) e.timer = setTimeout(() => { if (e.refs <= 0) { markOpened(noteId, e.provider); e.provider.destroy(); e.idb.destroy(); e.doc.destroy(); open.delete(noteId); } }, 60000);
    },
  };
}

export function attachPending(noteId) { open.get(noteId)?.provider.attach?.(); }

// ---- pages kept on this device for offline use. What to keep is chosen per device (Settings → Offline): only pages
// opened here, the most recently changed ones, those changed in a period, or all; in all or chosen spaces. Favourites
// are always kept. Pages to keep are fetched in the background, one at a time, when they changed since they were last
// kept. Copies no longer wanted are removed — except pages opened here in the last week, and any page with changes
// the server does not have yet.
export const DEFAULT_KEEP = { mode: 'days', days: 90, count: 300, spaces: null };
export function offlinePolicy() {
  try { return { ...DEFAULT_KEEP, ...JSON.parse(localGet('offlineKeep') || '{}') }; } catch { return { ...DEFAULT_KEEP }; }
}
export function setOfflinePolicy(p) {
  localSet('offlineKeep', JSON.stringify(p));
  keepOffline().catch(() => {});
}
const readJson = (k) => { try { return JSON.parse(localGet(k) || '{}') || {}; } catch { return {}; } };
const WEEK = 7 * 86400000;

/** The pages the policy wants on this device (from the page lists of all spaces). */
export function wantedPages(p = offlinePolicy()) {
  const favs = new Set(store.get().favorites.map((f) => f.id));
  let all = Object.values(store.get().trees).flat().filter((n) => !n.pending && !n.deletedAt && (!p.spaces || p.spaces.includes(n.spaceId)));
  all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (p.mode === 'opened') all = [];
  else if (p.mode === 'recent') all = all.slice(0, p.count);
  else if (p.mode === 'days') all = all.filter((n) => (n.updatedAt || 0) > Date.now() - p.days * 86400000);
  const ids = new Set(all.map((n) => n.id));
  for (const n of Object.values(store.get().trees).flat()) if (favs.has(n.id) && !ids.has(n.id) && !n.pending) { all.push(n); ids.add(n.id); }
  return all;
}

let keeping = false;
export async function keepOffline() {
  if (keeping || !store.get().online) return;
  keeping = true;
  try {
    const kept = readJson('offlineKept'); // id → [updatedAt, keptAt]
    const want = wantedPages();
    const ids = new Set(want.map((n) => n.id));
    // Copies not wanted any more.
    const opened = readJson('offlineOpened'); // id → { at, clean }
    for (const id of new Set([...Object.keys(kept), ...Object.keys(opened)])) {
      if (ids.has(id) || open.has(id) || isPendingPage(id)) continue;
      const o = opened[id];
      if (o && (!o.clean || o.at > Date.now() - WEEK)) continue;
      forgetDoc(id);
      delete kept[id]; delete opened[id];
    }
    localSet('offlineKept', JSON.stringify(kept)); localSet('offlineOpened', JSON.stringify(opened));
    const todo = want.filter((n) => kept[n.id]?.[0] !== n.updatedAt && !open.has(n.id));
    store.set({ offlineProgress: { done: 0, total: todo.length } });
    for (const [i, n] of todo.entries()) {
      if (!store.get().online) break;
      if (await keepPage(n.id)) { kept[n.id] = [n.updatedAt, Date.now()]; localSet('offlineKept', JSON.stringify(kept)); }
      store.set({ offlineProgress: { done: i + 1, total: todo.length } });
      await new Promise((r) => setTimeout(r, 150));
    }
  } finally { keeping = false; store.set({ offlineProgress: null }); }
}
/** Pages opened here: kept regardless for a week, and never dropped while they hold changes the server lacks. */
function markOpened(noteId, provider) {
  const o = readJson('offlineOpened');
  o[noteId] = { at: Date.now(), clean: !!provider.synced && !provider.hasUnsyncedChanges && !isPendingPage(noteId) };
  localSet('offlineOpened', JSON.stringify(o));
}
async function keepPage(id) {
  const doc = new Y.Doc();
  const idb = new IndexeddbPersistence(`inkwell-note-${id}`, doc);
  const provider = new HocuspocusProvider({ websocketProvider: collabWs(), name: `note:${id}`, document: doc, token: 'session' });
  try {
    await idb.whenSynced;
    provider.attach?.();
    const ok = await new Promise((res) => { const t = setTimeout(() => res(false), 15000); provider.on('synced', () => { clearTimeout(t); res(true); }); provider.on('authenticationFailed', () => { clearTimeout(t); res(false); }); });
    if (ok) await get(`/api/notes/${id}`).catch(() => {}); // its details, kept by api.js
    await new Promise((r) => setTimeout(r, 300)); // y-indexeddb writes a moment later
    return ok;
  } finally { provider.destroy(); idb.destroy(); doc.destroy(); }
}

/** Removes a deleted page's offline copy. */
export function forgetDoc(noteId) {
  try { indexedDB.deleteDatabase(`inkwell-note-${noteId}`); } catch { /* ignore */ }
  cacheDelete(`/api/notes/${noteId}`);
}

/** Moves a page and its sub-pages; pages put in a space with other people need a yes first. */
export const moveToSpace = (id, space, place = {}) => movePages([id], space, place);

/** Selected pages without those whose parent (or grand-parent…) is selected too: they move along anyway. */
export function topLevel(ids) {
  const set = new Set(ids);
  return ids.filter((id) => {
    for (let n = findNote(id), seen = 0; n?.parentId && seen < 100; n = findNote(n.parentId), seen++) if (set.has(n.parentId)) return false;
    return true;
  });
}

/** Puts pages (with their sub-pages) at one place, in the given order: into `parentId`, after `afterId`, in `space`. */
export async function movePages(ids, space, place = {}) {
  ids = topLevel(ids);
  const away = ids.filter((id) => findNote(id)?.spaceId !== space.id);
  const what = ids.length > 1 ? `these ${ids.length} pages and their sub-pages` : 'this page and its sub-pages';
  if (away.length && space.members > 1 && !window.confirm(`Move ${what} to “${space.name}”? Its ${space.members} members will see them.`)) return false;
  let afterId = place.afterId;
  for (const id of ids) {
    await patch(`/api/notes/${id}`, { ...place, ...(afterId !== undefined && { afterId }), ...(away.includes(id) && { spaceId: space.id }) });
    if (place.afterId !== undefined) afterId = id;
  }
  if (away.length) toast(ids.length > 1 ? `Moved ${ids.length} pages to ${space.name}` : `Moved to ${space.name}`);
  return true;
}

export async function trashPages(ids) {
  ids = topLevel(ids);
  for (const id of ids) { await del(`/api/notes/${id}`); forgetDoc(id); }
  toast(ids.length > 1 ? `${ids.length} pages moved to the trash` : 'Moved to the trash', {
    action: { label: 'Undo', onClick: () => Promise.all(ids.map((id) => post(`/api/notes/${id}/restore`))) },
  });
  return ids;
}
