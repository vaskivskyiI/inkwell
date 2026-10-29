// Runs test files against a PGlite wire-protocol server, so the production `pg` driver path is exercised.
// Usage: node test/pgwire.mjs test/api.test.js test/ai.test.js
// Limitation: the emulator interleaves concurrent connections at the protocol level, so collab.test.js
// (many concurrent queries) fails here with "bind message supplies N parameters" — run it against real Postgres.
import { spawn } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const db = await PGlite.create({ extensions: { vector } });
const server = new PGLiteSocketServer({ db, port: 55432, maxConnections: 40 });
await server.start();
let code = 0;
for (const file of process.argv.slice(2)) {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const status = await new Promise((res) => spawn(process.execPath, ['--no-warnings', '--test', file], { stdio: 'inherit', env: { ...process.env, INKWELL_DATABASE_URL: 'postgres://postgres@127.0.0.1:55432/postgres' } }).on('exit', res));
  code ||= status;
}
await server.stop();
process.exit(code);
