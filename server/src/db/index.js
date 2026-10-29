// One database API over two engines: PostgreSQL (`pg`, production) and PGlite (embedded Postgres in WASM, for
// development and tests). Both use $1… placeholders. Inside tx() every q/one/many call automatically runs on the
// transaction's connection (AsyncLocalStorage), so helpers compose without passing a client around.
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config.js';
import { migrate } from './schema.js';
import { logger } from '../util/log.js';

const log = logger('db');
const als = new AsyncLocalStorage();
let engine = null; // { query(text, params), transaction(fn), close(), kind, listen?(channel, fn), notify?(channel, payload) }

export const now = () => Date.now();

export async function openDb() {
  if (engine) return engine;
  if (config.databaseUrl) {
    const { default: pg } = await import('pg');
    pg.types.setTypeParser(20, (v) => Number(v)); // bigint epoch-ms timestamps → numbers
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
    pool.on('error', (e) => log.error('pool error', e.message));
    let listener = null;
    const handlers = new Map();
    engine = {
      kind: 'postgres',
      query: (text, params) => pool.query(text, params),
      async transaction(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn({ query: (t, p) => client.query(t, p) });
          await client.query('COMMIT');
          return out;
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally { client.release(); }
      },
      async listen(channel, fn) {
        if (!listener) {
          listener = await pool.connect();
          listener.on('notification', (m) => handlers.get(m.channel)?.(m.payload));
        }
        handlers.set(channel, fn);
        await listener.query(`LISTEN ${channel}`);
      },
      notify: (channel, payload) => pool.query('SELECT pg_notify($1, $2)', [channel, payload]),
      async close() { listener?.release(); await pool.end(); },
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const { vector } = await import('@electric-sql/pglite-pgvector');
    let dir;
    if (!config.memoryDb) { dir = path.join(config.dataDir, 'pg'); fs.mkdirSync(dir, { recursive: true }); }
    const opts = { extensions: { vector }, parsers: { 20: (v) => Number(v) } };
    const db = dir ? new PGlite(dir, opts) : new PGlite(opts);
    await db.waitReady;
    engine = {
      kind: 'pglite',
      query: (text, params) => db.query(text, params),
      transaction: (fn) => db.transaction((t) => fn({ query: (q, p) => t.query(q, p) })),
      async close() { await db.close(); },
    };
  }
  await migrate({ q, one, many, tx, exec: (sql) => engine.query(sql) });
  log.info(`database ready (${engine.kind})`);
  return engine;
}

export const dbKind = () => engine?.kind;

const runner = () => als.getStore() || engine;

export async function q(text, ...params) {
  const r = await runner().query(text, params);
  return { rows: r.rows, count: r.rowCount ?? r.affectedRows ?? r.rows.length };
}
export const one = async (text, ...params) => (await q(text, ...params)).rows[0] || null;
export const many = async (text, ...params) => (await q(text, ...params)).rows;

export async function tx(fn) {
  if (als.getStore()) return fn(); // already inside a transaction
  return engine.transaction((client) => als.run(client, fn));
}

/** Timers inherit the async context: work scheduled from inside tx() must not run on its (closed) connection. */
export const outsideTx = (fn) => als.exit(fn);

export const listen =(channel, fn) => engine.listen?.(channel, fn);
export const pgNotify = (channel, payload) => engine.notify?.(channel, payload);
export async function closeDb() { if (engine) { await engine.close(); engine = null; } }

/** UPDATE helper: update('notes', id, { title: 'x' }) — keys are trusted column names from code, values are bound. */
export async function update(table, id, fields, idCol = 'id') {
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  if (!keys.length) return 0;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  return (await q(`UPDATE ${table} SET ${sets} WHERE ${idCol} = $1`, id, ...keys.map((k) => fields[k]))).count;
}
