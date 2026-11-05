// REST helpers. Errors carry the server's message; 401 sends the app back to sign-in. Without the server, reads come
// from what was kept (offline.js) and changes that can wait are queued.
import * as offline from './offline.js';

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };
let onReach = () => {}, onQueuedPage = () => {};
/** fn(true | false): whether the server answered the last request. */
export const setReachHandler = (fn) => { onReach = fn; };
export const setQueuedPageHandler = (fn) => { onQueuedPage = fn; };
// Known to be unreachable (a request just failed, the event socket is closed): kept answers and the outbox are used
// straight away instead of waiting for each connection attempt to fail. The event socket says when it is back.
let reachable = true;
export const setReachable = (ok) => { reachable = ok; };

/** The server cannot be reached (no network, server down, the proxy in front says so): offline, not an error of the request. */
export class OfflineError extends ApiError {
  constructor() { super('Offline — this needs the server', 0); this.network = true; }
}
const proxyDown = (r) => [502, 503, 504].includes(r.status) && !(r.headers.get('content-type') || '').includes('json');
// GETs whose answers are kept for offline use: JSON from the API, not files, streams or sign-in.
const keep = (url) => !/^\/api\/(assets|uploads|auth\/(?!state)|ws|collab|public|capture\/drop)/.test(url);

async function send(method, url, opts) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new OfflineError();
  let r;
  try { r = await fetch(url, opts); } catch (e) { if (e?.name === 'AbortError') throw e; throw new OfflineError(); }
  if (proxyDown(r)) throw new OfflineError();
  return r;
}

// crypto.randomUUID needs https (or localhost); a server on the LAN over http has only getRandomValues.
export function uuid() {
  if (crypto.randomUUID) try { return crypto.randomUUID(); } catch { /* not a secure context */ }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function api(method, url, body, { raw = false, signal } = {}) {
  // A new page gets its id here, so it can be made offline and its content synced under that id later.
  if (method === 'POST' && url === '/api/notes' && body && !body.id) body = { ...body, id: uuid() };
  const opts = { method, signal, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body instanceof Blob) { opts.body = body; opts.headers['content-type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const json = !(body instanceof FormData || body instanceof Blob);
  // Changes that can wait, while earlier ones still wait: behind them, so they reach the server in order.
  if (method !== 'GET' && json && !raw && offline.queueable(method, url) && offline.pendingCount()) return later(method, url, body);
  if (!reachable && !raw) {
    if (method === 'GET' && keep(url)) { const c = await offline.cacheGet(url); if (c !== undefined) return c; }
    if (method !== 'GET' && json && offline.queueable(method, url)) return later(method, url, body);
  }
  let r;
  try { r = await send(method, url, opts); } catch (e) {
    if (!e.network) throw e;
    reachable = false;
    onReach(false);
    if (method === 'GET' && !raw && keep(url)) { const c = await offline.cacheGet(url); if (c !== undefined) return c; }
    if (method !== 'GET' && json && !raw && offline.queueable(method, url)) return later(method, url, body);
    throw e;
  }
  reachable = true;
  onReach(true);
  if (r.status === 401 && !url.startsWith('/api/auth/')) onUnauthorized();
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { msg = (await r.json()).error || msg; } catch { /* not json */ }
    throw new ApiError(msg, r.status);
  }
  if (raw) return r;
  const type = r.headers.get('content-type') || '';
  if (!type.includes('json')) return r.text();
  const data = await r.json();
  if (method === 'GET' && keep(url)) offline.cachePut(url, data);
  return data;
}

// A change kept for later. A new page answers as the server would (it has its id already), and its page and details
// are there to open; the rest answer {}.
async function later(method, url, body) {
  if (method === 'POST' && url === '/api/notes') {
    const note = { id: body.id, spaceId: body.spaceId, parentId: body.parentId || null, kind: body.kind === 'journal' ? 'journal' : 'page', title: body.title || '', icon: body.icon || '',
      tags: [], createdAt: Date.now(), updatedAt: Date.now(), role: 'owner', pending: true };
    await offline.enqueueOp(method, url, { ...body, note });
    await offline.cachePut(`/api/notes/${note.id}`, { ...note, insight: null, links: [], backlinks: [], ink: {} });
    onQueuedPage(note);
    return note;
  }
  await offline.enqueueOp(method, url, body);
  return {};
}

/** Sends what waited for the server. Resolves with how many went; pages made offline then sync their content. */
export function flushOutbox({ onDone } = {}) {
  return offline.flushOutbox(async (op) => {
    const { note, ...b } = op.body || {}; // eslint-disable-line no-unused-vars
    const r = await send(op.method, op.url, { method: op.method, credentials: 'same-origin', headers: op.body !== undefined ? { 'content-type': 'application/json' } : {}, body: op.body !== undefined ? JSON.stringify(b) : undefined });
    if (r.status === 401) { onUnauthorized(); throw new OfflineError(); } // after signing in again
    if (!r.ok) { let msg = `${r.status}`; try { msg = (await r.json()).error || msg; } catch { /* not json */ } throw new ApiError(msg, r.status); }
  }, { onDone, onDropped: (op, e) => console.warn('dropped change', op.method, op.url, e?.message) }); // eslint-disable-line no-console
}

export const get = (u, o) => api('GET', u, undefined, o);
export const post = (u, b, o) => api('POST', u, b ?? {}, o);
export const put = (u, b, o) => api('PUT', u, b ?? {}, o);
export const patch = (u, b, o) => api('PATCH', u, b ?? {}, o);
export const del = (u, o) => api('DELETE', u, undefined, o);

/** NDJSON stream: onToken(text) for each chunk; resolves with the final {done…} object. */
export async function stream(url, body, { onToken, signal } = {}) {
  const r = await api('POST', url, body, { raw: true, signal });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', final = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.error) throw new ApiError(m.error, 500);
      if (m.t) onToken?.(m.t);
      if (m.done) final = m;
    }
  }
  return final;
}

// Files go up in pieces: a proxy in front may cap one request (nginx allows 1 MB unless told otherwise), and a
// dropped connection only costs one piece. A piece the proxy refuses as too large is halved, and remembered.
let piece = 8 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sends a file in pieces; resolves with the upload id that /api/assets and /api/import accept. */
export async function sendFile(file, { onProgress } = {}) {
  const { id } = await post('/api/uploads');
  let off = 0, tries = 0;
  onProgress?.(0);
  while (off < file.size) {
    try {
      off = (await api('PUT', `/api/uploads/${id}?offset=${off}`, file.slice(off, off + piece))).size;
      tries = 0;
      onProgress?.(off / file.size);
    } catch (e) {
      if (e.status === 413 && piece > 256 * 1024) { piece /= 2; continue; }
      if ([401, 403, 404].includes(e.status) || ++tries > 6) throw e;
      await sleep(Math.min(1000 * 2 ** tries, 30000));
      off = (await get(`/api/uploads/${id}`)).size; // where the server got to
    }
  }
  return id;
}

const SMALL = 512 * 1024;

export async function upload(file, { noteId, spaceId, onProgress } = {}) {
  if (file.size > SMALL) {
    const uploadId = await sendFile(file, { onProgress });
    return post('/api/assets', { uploadId, name: file.name || 'file', mime: file.type, noteId, spaceId });
  }
  const fd = new FormData();
  if (noteId) fd.append('noteId', noteId);
  if (spaceId) fd.append('spaceId', spaceId);
  fd.append('file', file, file.name || 'file');
  return api('POST', '/api/assets', fd);
}
