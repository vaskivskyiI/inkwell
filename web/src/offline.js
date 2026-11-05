// Working without the server. What the app last read from it (spaces, page lists, page details, settings…) is kept
// in IndexedDB and answers when the server cannot be reached; page contents are kept by y-indexeddb (data.js).
// Changes that need the server — new pages, moves, trash, favourites — wait in an outbox, in order, and go out once it
// is reachable again. Pages made offline get their id here, so their content already syncs under the right name.
const DB = 'inkwell-offline';
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('cache'); r.result.createObjectStore('outbox', { autoIncrement: true }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}
async function run(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r?.result);
    t.onerror = () => rej(t.error);
  });
}

export const cacheGet = (url) => run('cache', 'readonly', (s) => s.get(url)).catch(() => undefined);
export const cachePut = (url, data) => run('cache', 'readwrite', (s) => s.put(data, url)).catch(() => {});
export const cacheDelete = (url) => run('cache', 'readwrite', (s) => s.delete(url)).catch(() => {});

// ---- the outbox
let ops = []; // [{ key, method, url, body }]
let loaded = null;
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn(ops.length));
export const onOutbox = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function loadOutbox() {
  if (!loaded) {
    loaded = db().then((d) => new Promise((res) => {
      const out = [];
      const req = d.transaction('outbox').objectStore('outbox').openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { out.push({ key: c.key, ...c.value }); c.continue(); } else res(out); };
      req.onerror = () => res([]);
    })).catch(() => []).then((list) => { ops = list; changed(); return ops; });
  }
  return loaded;
}
export const pendingCount = () => ops.length;

export async function enqueueOp(method, url, body) {
  await loadOutbox();
  const op = { method, url, body, at: Date.now() };
  op.key = await run('outbox', 'readwrite', (s) => s.add(op));
  ops.push(op);
  changed();
}

/** Pages made here that the server does not have yet (for the page lists, and to hold their sync back). */
export const pendingPages = () => ops.filter((o) => o.method === 'POST' && o.url === '/api/notes').map((o) => o.body.note);
export const isPendingPage = (id) => ops.some((o) => o.method === 'POST' && o.url === '/api/notes' && o.body.id === id);

// Which mutations can wait for the server. Anything else needs it now.
const QUEUEABLE = [
  ['POST', /^\/api\/notes$/], ['PATCH', /^\/api\/notes\/[\w-]+$/], ['DELETE', /^\/api\/notes\/[\w-]+$/], ['POST', /^\/api\/notes\/[\w-]+\/restore$/],
  ['PUT', /^\/api\/favorites\/[\w-]+$/], ['DELETE', /^\/api\/favorites\/[\w-]+$/],
];
export const queueable = (method, url) => QUEUEABLE.some(([m, re]) => m === method && re.test(url));

let flushing = null;
/** Sends what waited, in order. send(op) → resolves, or throws { network: true } (stop, try later) or another error (drop it). */
export function flushOutbox(send, { onDone, onDropped } = {}) {
  if (flushing) return flushing;
  flushing = (async () => {
    await loadOutbox();
    let sent = 0;
    while (ops.length) {
      const op = ops[0];
      try { await send(op); sent++; onDone?.(op); } catch (e) {
        if (e?.network) break;
        onDropped?.(op, e);
      }
      await run('outbox', 'readwrite', (s) => s.delete(op.key)).catch(() => {});
      ops.shift();
      changed();
    }
    return sent;
  })().finally(() => { flushing = null; });
  return flushing;
}

/** Signing out: nothing of this account stays on the device. */
export async function forgetAll() {
  try { (await db()).close(); } catch { /* not open */ }
  dbp = null; loaded = null; ops = [];
  await new Promise((res) => { const r = indexedDB.deleteDatabase(DB); r.onsuccess = r.onerror = r.onblocked = () => res(); });
  try {
    for (const d of (await indexedDB.databases?.()) || []) if (d.name?.startsWith('inkwell-note-')) indexedDB.deleteDatabase(d.name);
  } catch { /* the browser cannot list them */ }
  try { await caches.delete('inkwell-files'); } catch { /* no cache storage */ }
}
