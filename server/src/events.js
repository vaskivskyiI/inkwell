// Real-time events for everything outside page content (tree changes, AI results, membership): browser tabs and
// native apps keep one /api/ws socket. Across several server instances events travel over Postgres NOTIFY.
import crypto from 'node:crypto';
import { many, listen, pgNotify } from './db/index.js';
import { logger } from './util/log.js';

const log = logger('events');
const INSTANCE = crypto.randomUUID();
const CHANNEL = 'inkwell_events';
const clients = new Set(); // { userId, spaces: Set<spaceId>, send(obj) }

export async function initEvents() {
  await listen(CHANNEL, (raw) => {
    try {
      const m = JSON.parse(raw);
      if (m.origin !== INSTANCE) dispatch(m);
    } catch (e) { log.warn('bad event', e.message); }
  });
}

async function spacesOf(userId) {
  return new Set((await many('SELECT space_id FROM space_members WHERE user_id = $1', userId)).map((r) => r.space_id));
}

export async function addClient(userId, send) {
  const c = { userId, spaces: await spacesOf(userId), send };
  clients.add(c);
  return () => clients.delete(c);
}

function dispatch({ spaceId, userId, type, payload }) {
  for (const c of clients) {
    if (userId ? c.userId !== userId : !c.spaces.has(spaceId)) continue;
    const send = () => { try { c.send({ type, ...payload }); } catch { /* socket gone */ } };
    // Membership changed (possibly on another instance): re-read this device's spaces before telling it.
    if (type === 'spaces:changed') spacesOf(c.userId).then((s) => { c.spaces = s; send(); }, () => {});
    else send();
  }
}

function emit(m) {
  dispatch(m);
  const raw = JSON.stringify({ ...m, origin: INSTANCE });
  if (raw.length < 7900) pgNotify(CHANNEL, raw)?.catch?.((e) => log.warn('notify failed', e.message));
}

/** To everyone who is a member of the space. */
export const publish = (spaceId, type, payload = {}) => emit({ spaceId, type, payload: { spaceId, ...payload } });
/** To one user (all their devices). */
export const notifyUser = (userId, type, payload = {}) => emit({ userId, type, payload });

/** After membership changes: every instance re-reads the user's spaces, then tells their devices. */
export const refreshMembership = (userId) => notifyUser(userId, 'spaces:changed');

export const connectedUsers = () => new Set([...clients].map((c) => c.userId));
