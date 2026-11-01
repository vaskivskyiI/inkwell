// "Sign in with Halcyon": the same login for both apps when they are set up together (INKWELL_HALCYON_URL and
// INKWELL_HALCYON_SECRET here, HALCYON_SSO_SECRET and this callback in HALCYON_SSO_REDIRECTS there). Halcyon answers with a
// one-time code; the login itself is fetched server to server. Passwords keep working, so Inkwell also stands alone.
import crypto from 'node:crypto';
import { one, q } from './db/index.js';
import { config } from './config.js';
import { fail } from './util/http.js';
import { logger } from './util/log.js';
import { COOKIE, authenticate, createSession, createUser, setCookie } from './auth.js';
import { sha256 } from './util/crypto.js';
import { postJson, suiteTls } from './integrations/halcyon.js';
import { mirrorSpaces } from './mirror.js';

const log = logger('sso');
const STATE = 'inkwell_sso';
const enabled = () => !!(config.halcyonUrl && config.halcyonSecret);
const callback = (req) => `${config.publicUrl || `${req.protocol}://${req.headers.host}`}/api/auth/halcyon/callback`;

/** A request from this server to Halcyon, with the shared secret. */
export async function askHalcyon(path, body = {}) {
  const r = await postJson(`${config.halcyonUrl}${path}`, { body: JSON.stringify(body), signal: AbortSignal.timeout(15000), tls: suiteTls(),
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${config.halcyonSecret}` } });
  const data = await r.json().catch(() => null);
  if (!r.ok) fail(502, data?.error || `Halcyon answered ${r.status}`);
  return data;
}

/**
 * The Inkwell user of a Halcyon login. An account that already has this e-mail is not taken over by the address alone
 * (Inkwell does not check addresses): its owner signs in with their password once and links it under Settings → Profile.
 */
async function userFor(who, current) {
  const known = await one('SELECT * FROM users WHERE halcyon_sub = $1', who.sub);
  if (current) {
    if (known && known.id !== current.id) fail(409, 'This Halcyon login is already linked to another Inkwell account');
    await q('UPDATE users SET halcyon_sub = $1 WHERE id = $2', who.sub, current.id);
    return current;
  }
  if (known) return known;
  if (await one('SELECT 1 FROM users WHERE email = $1', String(who.email).toLowerCase())) fail(409, 'An Inkwell account with this e-mail exists. Sign in with its password and link Halcyon under Settings → Profile');
  const u = await createUser({ email: who.email, name: who.name, password: crypto.randomBytes(32).toString('base64url') });
  await q('UPDATE users SET halcyon_sub = $1 WHERE id = $2', who.sub, u.id);
  return u;
}

export default async function ssoRoutes(app) {
  // ?link=1: from Settings, for the account that is signed in.
  app.get('/api/auth/halcyon/start', async (req, reply) => {
    if (!enabled()) return reply.code(404).send({ error: 'Halcyon sign-in is not set up' });
    const state = `${req.query.link ? 'link.' : ''}${crypto.randomBytes(24).toString('base64url')}`;
    reply.setCookie(STATE, state, { path: '/api/auth/halcyon', httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: 300 });
    return reply.redirect(`${config.halcyonUrl}/api/sso/authorize?redirect_uri=${encodeURIComponent(callback(req))}&state=${encodeURIComponent(state)}`);
  });

  // Signing out of the suite from Halcyon: this app's session ends too, and the browser goes back there.
  app.get('/api/auth/halcyon/logout', async (req, reply) => {
    const back = String(req.query.return || '');
    let origin = '';
    try { origin = new URL(back).origin; } catch { /* no address */ }
    const t = req.cookies?.[COOKIE];
    if (t) await q('DELETE FROM sessions WHERE token_hash = $1', sha256(t));
    reply.clearCookie(COOKIE, { path: '/' });
    return reply.redirect(enabled() && origin === new URL(config.halcyonUrl).origin ? back : '/?signedout=1');
  });

  app.get('/api/auth/halcyon/callback', async (req, reply) => {
    const state = req.cookies?.[STATE];
    reply.clearCookie(STATE, { path: '/api/auth/halcyon' });
    try {
      if (!enabled() || !state || state !== req.query.state) fail(400, 'This sign-in was not started here, try again');
      const who = await askHalcyon('/api/sso/token', { code: String(req.query.code || ''), redirect_uri: callback(req) });
      const current = state.startsWith('link.') ? await authenticate(req) : null;
      if (state.startsWith('link.') && !current) fail(401, 'Sign in first');
      const u = await userFor(who, current);
      if (u.disabled) fail(403, 'This account is disabled');
      if (!current) setCookie(reply, await createSession(u.id, { ua: req.headers['user-agent'] }));
      mirrorSpaces().catch((e) => log.warn(`spaces: ${e.message}`));
      return reply.redirect(current ? '/#/settings/profile' : '/');
    } catch (e) {
      return reply.redirect(`/?sso_error=${encodeURIComponent(e.message)}`);
    }
  });
}
