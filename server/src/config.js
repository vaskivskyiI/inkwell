// All configuration comes from environment variables (read once at import time).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const dataDir = path.resolve(env.INKWELL_DATA_DIR || path.join(root, 'data'));

export const config = {
  root,
  port: num(env.INKWELL_PORT, 8080),
  host: env.INKWELL_HOST || '127.0.0.1',
  dataDir,
  assetsDir: path.join(dataDir, 'assets'),
  // Postgres connection string; empty → embedded PGlite in <dataDir>/pg (or in memory when INKWELL_DATA_DIR=memory:).
  databaseUrl: env.INKWELL_DATABASE_URL || '',
  dbPool: num(env.INKWELL_DB_POOL, 20),
  memoryDb: env.INKWELL_DB === 'memory',
  secret: env.INKWELL_SECRET || '',
  publicUrl: (env.INKWELL_PUBLIC_URL || '').replace(/\/+$/, ''),
  secureCookies: bool(env.INKWELL_SECURE_COOKIES),
  trustProxy: env.INKWELL_TRUST_PROXY || '127.0.0.1,::1',
  allowSignup: bool(env.INKWELL_ALLOW_SIGNUP, true),
  redisUrl: env.INKWELL_REDIS_URL || '',
  webDir: path.resolve(env.INKWELL_WEB_DIR || path.join(root, 'web/dist')),
  workers: num(env.INKWELL_WORKERS, 2),
  // Seconds of quiet after an edit before background AI re-analyses a page.
  aiDelay: num(env.INKWELL_AI_DELAY, 45),
  maxUpload: num(env.INKWELL_MAX_UPLOAD_MB, 50) * 1024 * 1024,
  maxImport: num(env.INKWELL_MAX_IMPORT_MB, 500) * 1024 * 1024,
  demo: bool(env.INKWELL_DEMO),
  logLevel: env.INKWELL_LOG_LEVEL || 'info',
  // Optional server-wide AI provider configured by the operator (users can add their own in Settings).
  ai: {
    type: env.INKWELL_AI_TYPE || '',
    baseUrl: env.INKWELL_AI_URL || '',
    apiKey: env.INKWELL_AI_KEY || '',
    chatModel: env.INKWELL_AI_CHAT_MODEL || '',
    visionModel: env.INKWELL_AI_VISION_MODEL || '',
    embedModel: env.INKWELL_AI_EMBED_MODEL || '',
  },
};
