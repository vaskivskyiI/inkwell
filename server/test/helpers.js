// Test helpers: an in-memory server (embedded Postgres), signed-in clients and the mock AI provider.
// node:test runs every file in its own process, so env set here applies before config.js is imported.
process.env.INKWELL_DB = 'memory';
process.env.INKWELL_DEMO = '1';
process.env.INKWELL_AI_DELAY = '0';
process.env.INKWELL_LOG_LEVEL = process.env.INKWELL_LOG_LEVEL || 'warn';
process.env.INKWELL_WEB_DIR = '/nonexistent';
process.env.INKWELL_DATA_DIR = process.env.INKWELL_DATA_DIR || (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'inkwell-test-'));

export async function startServer({ listen = false } = {}) {
  const { buildServer } = await import('../src/index.js');
  const app = await buildServer();
  if (listen) await app.listen({ port: 0, host: '127.0.0.1' });
  const port = listen ? app.server.address().port : 0;
  return { app, port };
}

/** A client bound to one session cookie. */
export function client(app) {
  let cookie = '';
  const req = async (method, url, body, headers = {}) => {
    const r = await app.inject({ method, url, payload: body, headers: { ...(cookie ? { cookie } : {}), ...headers } });
    const set = r.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    let data = r.body;
    try { data = JSON.parse(r.body); } catch { /* text */ }
    if (r.statusCode >= 400 && !headers['x-expect-error']) throw Object.assign(new Error(`${method} ${url} → ${r.statusCode}: ${r.body}`), { status: r.statusCode, data });
    return data;
  };
  return {
    get: (u, h) => req('GET', u, undefined, h), post: (u, b, h) => req('POST', u, b ?? {}, h), put: (u, b, h) => req('PUT', u, b ?? {}, h),
    patch: (u, b, h) => req('PATCH', u, b ?? {}, h), del: (u, h) => req('DELETE', u, undefined, h),
    status: async (method, url, body) => (await app.inject({ method, url, payload: body, headers: cookie ? { cookie } : {} })).statusCode,
    get cookie() { return cookie; },
  };
}

export async function signup(app, email, name = email.split('@')[0]) {
  const c = client(app);
  const r = await c.post('/api/auth/signup', { email, name, password: 'secret123' });
  c.user = r.user;
  c.spaces = await c.get('/api/spaces');
  return c;
}

export async function addMockAi(c) {
  const p = await c.post('/api/ai/providers', { type: 'mock', name: 'Mock' });
  return p.id;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 5000, interval = 25 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('waitFor timed out');
    await sleep(interval);
  }
}
