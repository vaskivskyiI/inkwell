// Accounts, sessions (httpOnly cookie for browsers) and API tokens (Bearer, for native apps and integrations).
import { one, many, q, tx, now } from './db/index.js';
import { config } from './config.js';
import { hashPassword, verifyPassword, randomToken, sha256 } from './util/crypto.js';
import { fail, str, isUuid } from './util/http.js';
import { getServerSetting } from './settings.js';

export const COOKIE = 'inkwell_session';
const SESSION_DAYS = 60;
const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'];
const PUBLIC = /^\/api\/(health|auth\/(state|login|signup|halcyon))(\/|$|\?)|^\/api\/public\//;

export const publicUser = (u) => u && ({ id: u.id, email: u.email, name: u.name, color: u.color, isAdmin: u.is_admin, halcyonLinked: !!u.halcyon_sub });

export async function createSession(userId, { kind = 'web', name = '', ua = '' } = {}) {
  const token = `${kind === 'api' ? 'ink_' : ''}${randomToken()}`;
  await q('INSERT INTO sessions (token_hash, user_id, kind, name, user_agent, created_at, expires_at, last_used_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $6)',
    sha256(token), userId, kind, str(name, 80), str(ua, 300), now(), kind === 'web' ? now() + SESSION_DAYS * 864e5 : null);
  return token;
}

const tokenOf = (req) => {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return req.cookies?.[COOKIE] || '';
};

export async function userForToken(token) {
  if (!token) return null;
  const s = await one(`SELECT s.token_hash, s.kind, s.expires_at, s.last_used_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1`, sha256(token));
  if (!s || s.disabled || (s.expires_at && s.expires_at < now())) return null;
  // Touch at most once an hour so reads don't turn into writes.
  if (!s.last_used_at || now() - s.last_used_at > 36e5) await q('UPDATE sessions SET last_used_at = $2 WHERE token_hash = $1', s.token_hash, now());
  return s;
}

export const authenticate = (req) => userForToken(tokenOf(req));

const attempts = new Map();
function throttle(key) {
  const t = now();
  const a = (attempts.get(key) || []).filter((x) => t - x < 15 * 60e3);
  if (a.length >= 10) fail(429, 'Too many attempts — try again in a few minutes');
  a.push(t); attempts.set(key, a);
}

export async function createUser({ email, name, password }) {
  email = str(email, 200).toLowerCase();
  name = str(name, 100) || email.split('@')[0];
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) fail(400, 'A valid e-mail address is required');
  if (String(password || '').length < 8) fail(400, 'The password needs at least 8 characters');
  if (await one('SELECT 1 FROM users WHERE email = $1', email)) fail(409, 'An account with this e-mail already exists');
  const { createSpace } = await import('./spaces.js');
  const { createWelcome } = await import('./notes.js');
  return tx(async () => {
    const first = !(await one('SELECT 1 FROM users LIMIT 1'));
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const u = await one('INSERT INTO users (email, name, password_hash, color, is_admin, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      email, name, hashPassword(password), color, first, now());
    const priv = await createSpace(u.id, { name: 'Private', icon: '🏠', color: '#6366f1' });
    await createSpace(u.id, { name: 'Work', icon: '💼', color: '#0ea5e9' });
    await createWelcome(u.id, priv.id);
    return u;
  });
}

/** Root-level preHandler: every /api route except the public ones needs a user. */
export async function requireUser(req) {
  if (!req.url.startsWith('/api/') || PUBLIC.test(req.url) || req.url.startsWith('/api/collab') || req.url.startsWith('/api/ws')) return;
  const u = await authenticate(req);
  if (!u) fail(401, 'Sign in required');
  req.user = u;
}

export default async function authRoutes(app) {
  app.get('/api/auth/state', async (req) => {
    const u = await authenticate(req);
    const hasUsers = !!(await one('SELECT 1 FROM users LIMIT 1'));
    return { user: publicUser(u), needsSetup: !hasUsers, allowSignup: !hasUsers || (await getServerSetting('allowSignup', config.allowSignup)), halcyonLogin: !!(config.halcyonUrl && config.halcyonSecret), halcyonUrl: config.halcyonSecret ? config.halcyonUrl : '' };
  });

  app.post('/api/auth/signup', async (req, reply) => {
    throttle(`signup:${req.ip}`);
    const hasUsers = !!(await one('SELECT 1 FROM users LIMIT 1'));
    if (hasUsers && !(await getServerSetting('allowSignup', config.allowSignup))) fail(403, 'Sign-up is disabled on this server — ask the administrator');
    const u = await createUser(req.body || {});
    const token = await createSession(u.id, { ua: req.headers['user-agent'] });
    setCookie(reply, token);
    return { user: publicUser(u) };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { email, password, token: wantToken, deviceName } = req.body || {};
    throttle(`login:${req.ip}:${str(email).toLowerCase()}`);
    const u = await one('SELECT * FROM users WHERE email = $1', str(email, 200).toLowerCase());
    if (!u || u.disabled || !verifyPassword(password, u.password_hash)) fail(401, 'Wrong e-mail or password');
    // Native apps ask for a long-lived API token instead of a cookie.
    if (wantToken) return { user: publicUser(u), token: await createSession(u.id, { kind: 'api', name: deviceName || 'Device', ua: req.headers['user-agent'] }) };
    setCookie(reply, await createSession(u.id, { ua: req.headers['user-agent'] }));
    return { user: publicUser(u) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const t = req.cookies?.[COOKIE];
    if (t) await q('DELETE FROM sessions WHERE token_hash = $1', sha256(t));
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => publicUser(req.user));
  app.patch('/api/me', async (req) => {
    const { name, color, password, newPassword } = req.body || {};
    if (name !== undefined) await q('UPDATE users SET name = $2 WHERE id = $1', req.user.id, str(name, 100) || req.user.name);
    if (color && /^#[0-9a-f]{6}$/i.test(color)) await q('UPDATE users SET color = $2 WHERE id = $1', req.user.id, color);
    if (newPassword) {
      if (!verifyPassword(password, req.user.password_hash)) fail(403, 'The current password is wrong');
      if (String(newPassword).length < 8) fail(400, 'The password needs at least 8 characters');
      await q('UPDATE users SET password_hash = $2 WHERE id = $1', req.user.id, hashPassword(newPassword));
      await q("DELETE FROM sessions WHERE user_id = $1 AND kind = 'web' AND token_hash <> $2", req.user.id, req.user.token_hash);
    }
    return publicUser(await one('SELECT * FROM users WHERE id = $1', req.user.id));
  });

  // API tokens (native apps, Halcyon and other integrations).
  app.get('/api/tokens', async (req) => (await many("SELECT token_hash, name, created_at, last_used_at FROM sessions WHERE user_id = $1 AND kind = 'api' ORDER BY created_at", req.user.id))
    .map((t) => ({ id: t.token_hash.slice(0, 16), name: t.name, createdAt: t.created_at, lastUsedAt: t.last_used_at })));
  app.post('/api/tokens', async (req) => ({ token: await createSession(req.user.id, { kind: 'api', name: str(req.body?.name, 80) || 'Token', ua: 'api' }) }));
  app.delete('/api/tokens/:id', async (req) => {
    await q("DELETE FROM sessions WHERE user_id = $1 AND kind = 'api' AND left(token_hash, 16) = $2", req.user.id, str(req.params.id, 16));
    return { ok: true };
  });

  // Administration
  const admin = (req) => { if (!req.user.is_admin) fail(403, 'Administrators only'); };
  app.get('/api/admin/users', async (req) => {
    admin(req);
    return (await many(`SELECT u.*, (SELECT count(*) FROM space_members m WHERE m.user_id = u.id)::int AS spaces FROM users u ORDER BY created_at`))
      .map((u) => ({ ...publicUser(u), disabled: u.disabled, createdAt: u.created_at, spaces: u.spaces }));
  });
  app.post('/api/admin/users', async (req) => {
    admin(req);
    const u = await createUser(req.body || {});
    if (req.body?.isAdmin) await q('UPDATE users SET is_admin = true WHERE id = $1', u.id);
    return { id: u.id };
  });
  app.patch('/api/admin/users/:id', async (req) => {
    admin(req);
    const { disabled, isAdmin, name, email, password } = req.body || {};
    const u = await one('SELECT id FROM users WHERE id = $1', isUuid(req.params.id) ? req.params.id : null);
    if (!u) fail(404, 'User not found');
    if (u.id === req.user.id && (disabled || isAdmin === false)) fail(400, 'You cannot lock yourself out');
    if (name !== undefined) {
      if (!str(name, 100)) fail(400, 'A name is required');
      await q('UPDATE users SET name = $2 WHERE id = $1', u.id, str(name, 100));
    }
    if (email !== undefined) {
      const e = str(email, 200).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+$/.test(e)) fail(400, 'A valid e-mail address is required');
      if (await one('SELECT 1 FROM users WHERE email = $1 AND id <> $2', e, u.id)) fail(409, 'An account with this e-mail already exists');
      await q('UPDATE users SET email = $2 WHERE id = $1', u.id, e);
    }
    if (password) {
      if (String(password).length < 8) fail(400, 'The password needs at least 8 characters');
      await q('UPDATE users SET password_hash = $2 WHERE id = $1', u.id, hashPassword(password));
      // A reset may answer a lost device or password, so everything signed in with the old one ends, tokens included.
      await q('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', u.id, req.user.token_hash);
    }
    if (disabled !== undefined) {
      await q('UPDATE users SET disabled = $2 WHERE id = $1', req.params.id, !!disabled);
      if (disabled) await q('DELETE FROM sessions WHERE user_id = $1', req.params.id);
    }
    if (isAdmin !== undefined) await q('UPDATE users SET is_admin = $2 WHERE id = $1', req.params.id, !!isAdmin);
    return { ok: true };
  });
}

export function setCookie(reply, token) {
  reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: SESSION_DAYS * 86400 });
}
