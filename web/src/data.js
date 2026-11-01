// Loading spaces/trees, the live event socket, and page documents (Yjs over one shared WebSocket, cached in
// IndexedDB so pages open instantly and can be edited offline).
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { IndexeddbPersistence } from 'y-indexeddb';
import { get, patch } from './api.js';
import { store, setTree, patchNote, removeNotes, localSet, toast } from './store.js';

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
  setTree(spaceId, notes);
}

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
    if (retry) { // came back: catch up on anything missed
      loadSpaces().then(() => Object.keys(store.get().trees).forEach(loadTree)).catch(() => {});
    }
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
    provider.attach?.();
    if (user) provider.setAwarenessField('user', { name: user.name, color: user.color, id: user.id });
    e = { doc, provider, idb, refs: 0, timer: null };
    open.set(noteId, e);
  }
  clearTimeout(e.timer);
  e.refs++;
  return {
    doc: e.doc, provider: e.provider, idb: e.idb,
    release() {
      e.refs--;
      // Keep recently used pages connected for a bit — switching back is then instant.
      if (e.refs <= 0) e.timer = setTimeout(() => { if (e.refs <= 0) { e.provider.destroy(); e.idb.destroy(); e.doc.destroy(); open.delete(noteId); } }, 60000);
    },
  };
}

/** Removes a deleted page's offline copy. */
export function forgetDoc(noteId) {
  try { indexedDB.deleteDatabase(`inkwell-note-${noteId}`); } catch { /* ignore */ }
}

/** Moves a page and its sub-pages; pages put in a space with other people need a yes first. */
export async function moveToSpace(id, space, place = {}) {
  if (space.members > 1 && !window.confirm(`Move this page and its sub-pages to “${space.name}”? Its ${space.members} members will see them.`)) return false;
  await patch(`/api/notes/${id}`, { ...place, spaceId: space.id });
  toast(`Moved to ${space.name}`);
  return true;
}
