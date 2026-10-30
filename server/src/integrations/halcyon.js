// Halcyon (mail, calendar, tasks) through its MCP endpoint: the user pastes Halcyon's URL and an assistant token
// (Halcyon → Settings → Assistants; "propose" access also allows creating tasks). Inkwell never sees mail passwords.
// A token reads one mailbox, the person's own or one shared space, so a user holds one connection per mailbox. The
// first is the main one. Items remember their connection in `meta.conn`; links made before that, or by another member
// of a space, have none we know and are tried on each connection.
import https from 'node:https';
import tls from 'node:tls';
import { one, many, q, now } from '../db/index.js';
import { encrypt, decrypt } from '../util/crypto.js';
import { fail, str, isUuid } from '../util/http.js';
import { logger } from '../util/log.js';

const log = logger('halcyon');
let rpcId = 1;

export async function connections(userId) {
  const rows = await many("SELECT id, name, base_url, token_enc, settings_json FROM integrations WHERE user_id = $1 AND kind = 'halcyon' ORDER BY created_at, id", userId);
  return rows.map((r) => ({ id: r.id, name: r.name, baseUrl: r.base_url, token: decrypt(r.token_enc), settings: r.settings_json, tls: r.settings_json?.tls }));
}

/** The connection with this id, else the main one, else null. */
export async function connection(userId, id) {
  const list = await connections(userId);
  return list.find((c) => c.id === id) || list[0] || null;
}

/** First answer from the item's connection, or from each in turn when its connection is not known here. */
export async function tryEach(list, id, fn) {
  const known = list.find((c) => c.id === id);
  let failure;
  for (const c of known ? [known] : list) {
    try { return { conn: c, out: await fn(c) }; } catch (e) { failure = e; }
  }
  throw failure;
}

// One mailbox that fails must not hide the others.
async function fromEach(list, fn) {
  const all = await Promise.allSettled(list.map(fn));
  const good = all.filter((r) => r.status === 'fulfilled');
  if (!good.length && all.length) throw all[0].reason;
  return good.flatMap((r) => r.value);
}

// Halcyon behind a private certificate authority or with a self-signed certificate: its CA (PEM) is added to Node's
// roots, or — when the user chose so — the certificate is not checked. Otherwise plain fetch, as before.
const tlsOptions = (t) => (t?.insecure ? { rejectUnauthorized: false } : t?.ca ? { ca: [...tls.rootCertificates, t.ca] } : null);
function postJson(url, { headers, body, signal, tls: t }) {
  const opts = url.startsWith('https:') && tlsOptions(t);
  if (!opts) return fetch(url, { method: 'POST', headers, body, signal });
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, signal, ...opts }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json: async () => JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const CERT = /self.signed|unable to verify|unable to get local issuer|certificate|CERT_|leaf signature/i;
function reachError(e) {
  const code = e.cause?.code || e.code || e.cause?.message || e.message;
  return CERT.test(`${code} ${e.cause?.message || ''} ${e.message}`)
    ? `Halcyon's certificate is not trusted (${code}) — add its certificate authority, or choose not to check it`
    : `Cannot reach Halcyon: ${code}`;
}

export async function call(conn, tool, args = {}, { timeoutMs = 20000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await postJson(`${conn.baseUrl}/api/mcp`, {
      signal: ctl.signal, tls: conn.tls,
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${conn.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: tool, arguments: args } }),
    });
    if (r.status === 401) fail(502, 'Halcyon refused the token — create a new one in Halcyon → Settings → Assistants');
    if (!r.ok) fail(502, `Halcyon answered ${r.status}`);
    const d = await r.json();
    if (d.error) fail(502, d.error.message || 'Halcyon error');
    if (d.result?.isError) fail(502, d.result.content?.[0]?.text || 'Halcyon tool failed');
    const sc = d.result?.structuredContent;
    return sc?.items ?? sc ?? JSON.parse(d.result?.content?.[0]?.text || 'null');
  } catch (e) {
    if (e.statusCode) throw e;
    log.warn(`${tool} failed: ${e.message}`);
    fail(502, e.name === 'AbortError' ? 'Halcyon did not answer in time' : reachError(e));
  } finally { clearTimeout(t); }
}

const NOT_CONNECTED = 'Connect Halcyon first (Settings → Integrations)';
async function needAll(userId) {
  const list = await connections(userId);
  return list.length ? list : fail(409, NOT_CONNECTED);
}

// Results in one shape for the link picker: { kind, ref, title, subtitle, date, meta }.
const mailOut = (m) => ({ kind: 'email', ref: String(m.id), title: m.subject || '(no subject)', subtitle: m.from, date: m.date, meta: { from: m.from, date: m.date, summary: m.summary || '', hspace: m.space || '' } });
const eventOut = (e) => ({ kind: 'event', ref: String(e.id), title: e.title || '(no title)', subtitle: [e.local_start || e.start, e.location].filter(Boolean).join(' · '), date: e.start, meta: { start: e.start, end: e.end, allDay: e.all_day, location: e.location, attendees: e.attendees || [], hspace: e.space || '' } });
const taskOut = (t) => ({ kind: 'task', ref: String(t.id), title: t.title, subtitle: t.due ? `due ${t.due.slice(0, 10)}` : (t.done ? 'done' : ''), date: t.due, meta: { due: t.due, done: t.done, hspace: t.space || '' } });
const contactOut = (c) => ({ kind: 'contact', ref: String(c.id ?? c.email ?? c.name), title: c.name || c.email, subtitle: [c.email || c.emails?.[0], c.organization || c.company].filter(Boolean).join(' · '), meta: { email: c.email || c.emails?.[0] || '' } });

// Marks where an item came from; the mailbox's name is shown only when there is more than one to tell apart.
const fromConn = (conn, several, it) => ({
  ...it, openUrl: openUrl(conn, it), subtitle: [several && conn.name, it.subtitle].filter(Boolean).join(' · '),
  meta: { ...it.meta, conn: conn.id, ...(several ? { source: conn.name } : {}) },
});

async function searchOne(conn, kind, qs) {
  if (kind === 'email') return (await call(conn, 'search_mail', { query: qs || 'is:unread', limit: 15 }) || []).map(mailOut);
  if (kind === 'event') {
    const from = new Date(Date.now() - 30 * 864e5).toISOString(), to = new Date(Date.now() + 60 * 864e5).toISOString();
    const all = (await call(conn, 'list_events', { from, to }) || []).map(eventOut);
    return qs ? all.filter((e) => `${e.title} ${e.subtitle} ${(e.meta.attendees || []).join(' ')}`.toLowerCase().includes(qs)) : all;
  }
  if (kind === 'task') {
    const all = (await call(conn, 'list_tasks', { include_done: false }) || []).map(taskOut);
    return qs ? all.filter((t) => t.title.toLowerCase().includes(qs)) : all;
  }
  return qs ? (await call(conn, 'search_contacts', { query: qs }) || []).map(contactOut) : [];
}

export async function searchHalcyon(userId, kind, query) {
  if (!['email', 'event', 'task', 'contact'].includes(kind)) fail(400, 'Unknown kind');
  const list = await needAll(userId);
  const qs = String(query || '').trim().toLowerCase();
  const hits = await fromEach(list, async (c) => (await searchOne(c, kind, qs)).map((it) => fromConn(c, list.length > 1, it)));
  if (kind === 'event') return hits.sort((a, b) => Math.abs(Date.parse(a.date) - Date.now()) - Math.abs(Date.parse(b.date) - Date.now())).slice(0, 25); // closest to now first
  if (kind === 'email') return hits.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 15);
  return hits.slice(0, kind === 'task' ? 25 : 15);
}

/** Today's (or a day's) meetings, for "New meeting note". */
export async function eventsOn(userId, date, spaceId) {
  const scopes = await scopesFor(userId, spaceId);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? new Date(`${date}T00:00:00`) : new Date(new Date().toDateString());
  const to = new Date(d.getTime() + 864e5);
  const events = await fromEach(scopes, async ({ conn, label }) => (await call(conn, 'list_events', { from: d.toISOString(), to: to.toISOString(), ...spaceArg(label) }) || []).map((e) => fromConn(conn, scopes.length > 1, eventOut(e))));
  return events.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

const spaceArg = (space) => (space ? { space } : {});
async function spaceNames(conn) {
  try { const r = await call(conn, 'list_spaces', {}); return Array.isArray(r?.spaces) ? r.spaces : []; } catch { return []; }
}

/**
 * Which mailboxes an Inkwell space shows, and under which Halcyon space label: { conn, label }[].
 * The connection chosen in its settings, else connections with the space's name, else all of them. Among several,
 * those that have the Halcyon space win: "Work" should not list everything of a shared mailbox without a "Work".
 */
export async function scopesFor(userId, spaceId) {
  const list = await needAll(userId);
  const s = isUuid(spaceId) ? await one('SELECT name, settings_json FROM spaces WHERE id = $1', spaceId) : null;
  if (!s) return list.map((conn) => ({ conn, label: '' }));
  const explicit = s.settings_json?.halcyonSpace;
  const wanted = String(explicit ?? s.name).toLowerCase();
  const chosen = list.find((c) => c.id === s.settings_json?.halcyonConnection);
  const named = list.filter((c) => c.name.toLowerCase() === s.name.toLowerCase());
  const pick = chosen ? [chosen] : named.length ? named : list;
  const scopes = await Promise.all(pick.map(async (conn) => {
    const found = wanted && (await spaceNames(conn)).find((n) => n.toLowerCase() === wanted);
    return { conn, label: explicit ?? found ?? '', found: !!found };
  }));
  const hits = scopes.filter((x) => x.found);
  return hits.length ? hits : scopes;
}

/** The writable Inkwell space tied to a connection (chosen in its settings, or the same name), or null. */
export async function spaceForConnection(userId, conn) {
  if (!conn) return null;
  const rows = await many(`SELECT s.id, s.name, s.settings_json FROM spaces s JOIN space_members m ON m.space_id = s.id AND m.user_id = $1
    WHERE m.role IN ('owner', 'editor') ORDER BY m.position`, userId);
  return (rows.find((s) => s.settings_json?.halcyonConnection === conn.id) || rows.find((s) => s.name.toLowerCase() === conn.name.toLowerCase()))?.id || null;
}

export const openUrl = (conn, link) => {
  if (!conn) return null;
  if (link.kind === 'email') return `${conn.baseUrl}/#/mail/unified/${encodeURIComponent(link.ref)}`;
  if (link.kind === 'event') return `${conn.baseUrl}/#/calendar`;
  if (link.kind === 'task') return `${conn.baseUrl}/#/tasks`;
  if (link.kind === 'contact') return `${conn.baseUrl}/#/contacts`;
  return null;
};

export default async function halcyonRoutes(app) {
  const state = async (userId) => {
    const list = await connections(userId);
    if (!list.length) return { connected: false, connections: [] };
    return { connected: true, baseUrl: list[0].baseUrl, settings: list[0].settings, connections: list.map(({ id, name, baseUrl, settings }) => ({ id, name, baseUrl, settings })) };
  };

  // Checked before saving, so a typo shows up now rather than in the link picker.
  const checked = async (b, saved = {}) => {
    const baseUrl = (b.baseUrl !== undefined ? str(b.baseUrl, 300) : saved.baseUrl || '').replace(/\/+$/, '').replace(/\/api\/mcp$/, '');
    const token = str(b.token, 300) || saved.token;
    if (!/^https?:\/\//.test(baseUrl)) fail(400, 'Enter Halcyon\'s address, e.g. https://mail.example.com');
    if (!token) fail(400, 'Paste an assistant token from Halcyon → Settings → Assistants');
    const ca = str(b.tls?.ca, 20000).trim();
    if (ca && !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(ca)) fail(400, 'Paste the certificate authority as PEM (-----BEGIN CERTIFICATE----- …)');
    const t = b.tls === undefined ? saved.tls || null : b.tls?.insecure ? { insecure: true } : ca ? { ca } : null;
    await call({ baseUrl, token, tls: t }, 'list_tasks', {});
    return { baseUrl, token, t };
  };
  const insert = async (userId, name, { baseUrl, token, t }) => q(`INSERT INTO integrations (user_id, kind, name, base_url, token_enc, settings_json, created_at) VALUES ($1, 'halcyon', $2, $3, $4, $5::jsonb, $6)`,
    userId, name, baseUrl, encrypt(token), JSON.stringify(t ? { tls: t } : {}), now());
  const update = (id, name, { baseUrl, token, t }) => q(`UPDATE integrations SET name = $2, base_url = $3, token_enc = $4, settings_json = (settings_json - 'tls') || $5::jsonb WHERE id = $1`,
    id, name, baseUrl, encrypt(token), JSON.stringify(t ? { tls: t } : {}));

  app.get('/api/integrations/halcyon', async (req) => state(req.user.id));

  // The main connection, as one call.
  app.put('/api/integrations/halcyon', async (req) => {
    const main = (await connections(req.user.id))[0];
    const c = await checked(req.body || {});
    if (main) await update(main.id, main.name, c); else await insert(req.user.id, 'My mail', c);
    return state(req.user.id);
  });

  app.post('/api/integrations/halcyon/connections', async (req) => {
    const list = await connections(req.user.id);
    const name = str(req.body?.name, 60) || (list.length ? `Shared ${list.length}` : 'My mail');
    if (list.some((c) => c.name.toLowerCase() === name.toLowerCase())) fail(409, 'You already have a connection with this name');
    await insert(req.user.id, name, await checked(req.body || {}));
    return state(req.user.id);
  });

  app.patch('/api/integrations/halcyon/connections/:id', async (req) => {
    const list = await connections(req.user.id);
    const conn = list.find((c) => c.id === req.params.id) || fail(404, 'Connection not found');
    const b = req.body || {};
    const name = str(b.name, 60) || conn.name;
    if (list.some((c) => c.id !== conn.id && c.name.toLowerCase() === name.toLowerCase())) fail(409, 'You already have a connection with this name');
    await update(conn.id, name, await checked(b, conn));
    return state(req.user.id);
  });

  app.delete('/api/integrations/halcyon/connections/:id', async (req) => {
    await q("DELETE FROM integrations WHERE id = $1 AND user_id = $2 AND kind = 'halcyon'", isUuid(req.params.id) ? req.params.id : null, req.user.id);
    return state(req.user.id);
  });

  app.delete('/api/integrations/halcyon', async (req) => {
    await q("DELETE FROM integrations WHERE user_id = $1 AND kind = 'halcyon'", req.user.id);
    return { ok: true };
  });

  app.get('/api/halcyon/search', async (req) => searchHalcyon(req.user.id, req.query.kind, req.query.q));
  // Halcyon's space names, of one connection or all; older Halcyon versions do not offer the tool.
  app.get('/api/halcyon/spaces', async (req) => {
    const list = await connections(req.user.id);
    const from = list.filter((c) => !req.query.connection || c.id === req.query.connection);
    return [...new Set((await Promise.all(from.map(spaceNames))).flat())];
  });
  app.get('/api/halcyon/events', async (req) => eventsOn(req.user.id, req.query.date, req.query.space));
  // Today dashboard: open tasks (overdue and due soon first) and e-mails waiting for a reply or an action.
  app.get('/api/halcyon/tasks', async (req) => {
    const scopes = await scopesFor(req.user.id, req.query.space);
    const tasks = await fromEach(scopes, async ({ conn, label }) => (await call(conn, 'list_tasks', { include_done: false, ...spaceArg(label) }) || []).map((t) => fromConn(conn, scopes.length > 1, taskOut(t))));
    return tasks.sort((a, b) => (a.date ? Date.parse(a.date) : Infinity) - (b.date ? Date.parse(b.date) : Infinity)).slice(0, 30);
  });
  app.get('/api/halcyon/open-items', async (req) => {
    const scopes = await scopesFor(req.user.id, req.query.space);
    return fromEach(scopes, async ({ conn, label }) => (await call(conn, 'list_open_items', { kind: 'both', limit: 20, ...spaceArg(label) }) || [])
      .map((m) => { const it = fromConn(conn, scopes.length > 1, mailOut(m)); return { ...it, meta: { ...it.meta, action: m.action || null, needsReply: !!m.needs_reply } }; }));
  });
  app.get('/api/halcyon/message/:id', async (req) => (await tryEach(await needAll(req.user.id), req.query.connection, (c) => call(c, 'get_message', { id: Number(req.params.id) || 0 }))).out);

  app.post('/api/halcyon/pull-tasks', async (req) => (await import('../tasksync.js')).pullTasks(req.user));

  app.post('/api/halcyon/tasks', async (req) => {
    const b = req.body || {};
    const conn = (await connection(req.user.id, b.connection)) || fail(409, NOT_CONNECTED);
    const out = await call(conn, 'create_task', { title: str(b.title, 300), ...(b.due ? { due: str(b.due, 40) } : {}), ...(b.notes ? { notes: str(b.notes, 4000) } : {}) });
    return { ok: true, task: out };
  });
}
