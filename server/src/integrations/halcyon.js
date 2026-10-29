// Halcyon (mail, calendar, tasks) through its MCP endpoint: the user pastes Halcyon's URL and an assistant token
// (Halcyon → Settings → Assistants; "propose" access also allows creating tasks). Inkwell never sees mail passwords.
import { one, q, now } from '../db/index.js';
import { encrypt, decrypt } from '../util/crypto.js';
import { fail, str } from '../util/http.js';
import { logger } from '../util/log.js';

const log = logger('halcyon');
let rpcId = 1;

export async function connection(userId) {
  const r = await one("SELECT base_url, token_enc, settings_json FROM integrations WHERE user_id = $1 AND kind = 'halcyon'", userId);
  return r && { baseUrl: r.base_url, token: decrypt(r.token_enc), settings: r.settings_json };
}

export async function call(conn, tool, args = {}, { timeoutMs = 20000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${conn.baseUrl}/api/mcp`, {
      method: 'POST', signal: ctl.signal,
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
    fail(502, e.name === 'AbortError' ? 'Halcyon did not answer in time' : `Cannot reach Halcyon: ${e.cause?.code || e.message}`);
  } finally { clearTimeout(t); }
}

async function need(userId) {
  return (await connection(userId)) || fail(409, 'Connect Halcyon first (Settings → Integrations)');
}

// Results in one shape for the link picker: { kind, ref, title, subtitle, date, meta }.
const mailOut = (m) => ({ kind: 'email', ref: String(m.id), title: m.subject || '(no subject)', subtitle: m.from, date: m.date, meta: { from: m.from, date: m.date, summary: m.summary || '' } });
const eventOut = (e) => ({ kind: 'event', ref: String(e.id), title: e.title || '(no title)', subtitle: [e.local_start || e.start, e.location].filter(Boolean).join(' · '), date: e.start, meta: { start: e.start, end: e.end, allDay: e.all_day, location: e.location, attendees: e.attendees || [] } });
const taskOut = (t) => ({ kind: 'task', ref: String(t.id), title: t.title, subtitle: t.due ? `due ${t.due.slice(0, 10)}` : (t.done ? 'done' : ''), date: t.due, meta: { due: t.due, done: t.done } });
const contactOut = (c) => ({ kind: 'contact', ref: String(c.id ?? c.email ?? c.name), title: c.name || c.email, subtitle: [c.email || c.emails?.[0], c.organization || c.company].filter(Boolean).join(' · '), meta: { email: c.email || c.emails?.[0] || '' } });

export async function searchHalcyon(userId, kind, query) {
  const conn = await need(userId);
  const qs = String(query || '').trim().toLowerCase();
  if (kind === 'email') return (await call(conn, 'search_mail', { query: qs || 'is:unread', limit: 15 }) || []).map(mailOut);
  if (kind === 'event') {
    const from = new Date(Date.now() - 30 * 864e5).toISOString(), to = new Date(Date.now() + 60 * 864e5).toISOString();
    const all = (await call(conn, 'list_events', { from, to }) || []).map(eventOut);
    const hits = qs ? all.filter((e) => `${e.title} ${e.subtitle} ${(e.meta.attendees || []).join(' ')}`.toLowerCase().includes(qs)) : all;
    // Closest to now first.
    return hits.sort((a, b) => Math.abs(Date.parse(a.date) - Date.now()) - Math.abs(Date.parse(b.date) - Date.now())).slice(0, 25);
  }
  if (kind === 'task') {
    const all = (await call(conn, 'list_tasks', { include_done: false }) || []).map(taskOut);
    return (qs ? all.filter((t) => t.title.toLowerCase().includes(qs)) : all).slice(0, 25);
  }
  if (kind === 'contact') return qs ? (await call(conn, 'search_contacts', { query: qs }) || []).slice(0, 15).map(contactOut) : [];
  fail(400, 'Unknown kind');
}

/** Today's (or a day's) meetings, for "New meeting note". */
export async function eventsOn(userId, date) {
  const conn = await need(userId);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? new Date(`${date}T00:00:00`) : new Date(new Date().toDateString());
  const to = new Date(d.getTime() + 864e5);
  return (await call(conn, 'list_events', { from: d.toISOString(), to: to.toISOString() }) || []).map(eventOut).sort((a, b) => String(a.date).localeCompare(String(b.date)));
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
  app.get('/api/integrations/halcyon', async (req) => {
    const c = await connection(req.user.id);
    return c ? { connected: true, baseUrl: c.baseUrl, settings: c.settings } : { connected: false };
  });

  app.put('/api/integrations/halcyon', async (req) => {
    const baseUrl = str(req.body?.baseUrl, 300).replace(/\/+$/, '').replace(/\/api\/mcp$/, '');
    const token = str(req.body?.token, 300);
    if (!/^https?:\/\//.test(baseUrl)) fail(400, 'Enter Halcyon\'s address, e.g. https://mail.example.com');
    if (!token) fail(400, 'Paste an assistant token from Halcyon → Settings → Assistants');
    // Check before saving, so a typo shows up now rather than in the link picker.
    await call({ baseUrl, token }, 'list_tasks', {});
    await q(`INSERT INTO integrations (user_id, kind, base_url, token_enc, created_at) VALUES ($1, 'halcyon', $2, $3, $4)
      ON CONFLICT (user_id, kind) DO UPDATE SET base_url = EXCLUDED.base_url, token_enc = EXCLUDED.token_enc`, req.user.id, baseUrl, encrypt(token), now());
    return { connected: true, baseUrl };
  });

  app.delete('/api/integrations/halcyon', async (req) => {
    await q("DELETE FROM integrations WHERE user_id = $1 AND kind = 'halcyon'", req.user.id);
    return { ok: true };
  });

  app.get('/api/halcyon/search', async (req) => searchHalcyon(req.user.id, req.query.kind, req.query.q));
  app.get('/api/halcyon/events', async (req) => eventsOn(req.user.id, req.query.date));
  app.get('/api/halcyon/message/:id', async (req) => call(await need(req.user.id), 'get_message', { id: Number(req.params.id) || 0 }));

  app.post('/api/halcyon/tasks', async (req) => {
    const conn = await need(req.user.id);
    const b = req.body || {};
    const out = await call(conn, 'create_task', { title: str(b.title, 300), ...(b.due ? { due: str(b.due, 40) } : {}), ...(b.notes ? { notes: str(b.notes, 4000) } : {}) });
    return { ok: true, task: out };
  });
}
