export class HttpError extends Error {
  constructor(status, message) { super(message); this.statusCode = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };

export const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
export const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
export const uuidOr404 = (v, what = 'Not found') => (isUuid(v) ? v : fail(404, what));

/** Streams newline-delimited JSON: onToken text chunks as {t}, then the final object as {done, ...}. */
export async function streamNdjson(reply, fn) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  const ctl = new AbortController();
  res.on('close', () => ctl.abort(new Error('client closed')));
  const write = (obj) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };
  try {
    const out = await fn({ onToken: (t) => write({ t }), write, signal: ctl.signal });
    write({ done: true, ...(out || {}) });
  } catch (e) {
    write({ error: e.message || String(e) });
  } finally { res.end(); }
}
