// REST helpers. Errors carry the server's message; 401 sends the app back to sign-in.
export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(method, url, body, { raw = false, signal } = {}) {
  const opts = { method, signal, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body instanceof Blob) { opts.body = body; opts.headers['content-type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const r = await fetch(url, opts);
  if (r.status === 401 && !url.startsWith('/api/auth/')) onUnauthorized();
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { msg = (await r.json()).error || msg; } catch { /* not json */ }
    throw new ApiError(msg, r.status);
  }
  if (raw) return r;
  const type = r.headers.get('content-type') || '';
  return type.includes('json') ? r.json() : r.text();
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
