import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { openDb, closeDb, q } from './db/index.js';
import authRoutes, { authenticate, userForToken, publicUser, requireUser } from './auth.js';
import spaceRoutes from './spaces.js';
import noteRoutes, { purgeTrash } from './notes.js';
import assetRoutes, { deleteOrphanFiles } from './assets.js';
import searchRoutes from './search.js';
import aiRoutes from './routes/ai.js';
import linkRoutes from './links.js';
import halcyonRoutes from './integrations/halcyon.js';
import { handleSocket, stopCollab } from './collab.js';
import { initEvents, addClient } from './events.js';
import { startQueue, stopQueue } from './ai/queue.js';
import './ai/tasks.js';
import { logger } from './util/log.js';

const log = logger('server');

// A browser's cookie rides along on cross-site WebSocket upgrades too: only accept cookie auth from our own origin.
async function socketUser(req) {
  const token = new URL(req.url, 'http://x').searchParams.get('token');
  if (token) return userForToken(token);
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host && !(config.publicUrl && origin === new URL(config.publicUrl).origin)) return null;
  return authenticate(req);
}

export async function buildServer() {
  await openDb();
  await initEvents();
  const app = Fastify({ logger: false, trustProxy: config.trustProxy, bodyLimit: 20 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUpload, files: 1 } });
  await app.register(websocket, { options: { maxPayload: 32 * 1024 * 1024 } });

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode || 500;
    if (!err.statusCode) log.error(`${req.method} ${req.url}`, err);
    reply.code(status).send({ error: status >= 500 && !err.statusCode ? 'Internal error' : err.message });
  });

  app.get('/api/health', async () => { await q('SELECT 1'); return { ok: true, version: '0.1.0' }; });
  app.addHook('preHandler', requireUser);

  await app.register(authRoutes);
  await app.register(spaceRoutes);
  await app.register(noteRoutes);
  await app.register(assetRoutes);
  await app.register(searchRoutes);
  await app.register(aiRoutes);
  await app.register(linkRoutes);
  await app.register(halcyonRoutes);

  // Page content (Yjs / Hocuspocus protocol). Native apps pass ?token=<api token>.
  app.register(async (scope) => {
    scope.get('/api/collab', { websocket: true }, async (socket, req) => {
      const user = await socketUser(req);
      if (!user) { socket.close(4401, 'Unauthorized'); return; }
      handleSocket(socket, req, user);
    });
    // Everything else that changes: tree, AI results, membership.
    scope.get('/api/ws', { websocket: true }, async (socket, req) => {
      const user = await socketUser(req);
      if (!user) { socket.close(4401, 'Unauthorized'); return; }
      const remove = await addClient(user.id, (m) => { if (socket.readyState === 1) socket.send(JSON.stringify(m)); });
      socket.send(JSON.stringify({ type: 'hello', user: publicUser(user) }));
      const ping = setInterval(() => { if (socket.readyState === 1) socket.ping(); }, 30000);
      socket.on('message', (raw) => { if (String(raw) === 'ping') socket.send('{"type":"pong"}'); });
      socket.on('close', () => { clearInterval(ping); remove(); });
    });
  });

  if (fs.existsSync(path.join(config.webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: true, index: false, cacheControl: false, setHeaders: (res, file) => {
      res.setHeader('cache-control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
    } });
    const html = () => fs.readFileSync(path.join(config.webDir, 'index.html'));
    app.get('/', (req, reply) => reply.type('text/html').header('cache-control', 'no-cache').send(html()));
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.type('text/html').send(html())));
  }

  app.addHook('onClose', async () => { stopQueue(); await stopCollab(); await closeDb(); });
  return app;
}

function housekeeping() {
  const run = () => { purgeTrash().catch((e) => log.warn('trash purge', e.message)); deleteOrphanFiles().catch((e) => log.warn('orphan files', e.message)); };
  setTimeout(run, 60e3).unref();
  setInterval(run, 6 * 3600e3).unref();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = await buildServer();
  startQueue();
  housekeeping();
  await app.listen({ port: config.port, host: config.host });
  log.info(`Inkwell listening on http://${config.host}:${config.port}`);
  const stop = async (sig) => { log.info(`${sig}: shutting down`); await app.close(); process.exit(0); };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}
