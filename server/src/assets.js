// Uploaded files (images, attachments). Content-addressed on disk (<assets>/<ab>/<sha256>), so identical files are
// stored once; within a space the same upload also reuses its record (and what AI read from it). asset_refs says which
// pages use a file: members of those pages' spaces may read it, and a file no page uses is removed after a grace
// period, which keeps undo, offline devices and just-uploaded files safe.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { one, many, q, now } from './db/index.js';
import { config } from './config.js';
import { fail, str, isUuid, uuidOr404 } from './util/http.js';
import { needSpace, needNote, userSpaceIds } from './spaces.js';
import { docFrom, extract } from './docmodel.js';
import { syncAssetRefs } from './collab.js';
import { getServerSetting, setServerSetting } from './settings.js';
import { logger } from './util/log.js';
import { enqueue } from './ai/queue.js';

// Shown inline; everything else downloads (an uploaded HTML/SVG must never run as a page of this origin).
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm)|audio\/(mpeg|ogg|wav|webm|mp4)|application\/pdf)$/;

const log = logger('assets');
const fileOf = (sha) => path.join(config.assetsDir, sha.slice(0, 2), sha);

/** Writes a stream to a temporary file next to the stored files, hashing on the way: uploads of any size never sit in memory. */
export async function saveStream(stream) {
  const dir = path.join(config.assetsDir, 'tmp');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, crypto.randomUUID());
  const hash = crypto.createHash('sha256');
  let size = 0;
  stream.on('data', (c) => { hash.update(c); size += c.length; });
  try { await pipeline(stream, fs.createWriteStream(file)); } catch (e) { await fsp.unlink(file).catch(() => {}); throw e; }
  return { file, sha: hash.digest('hex'), size };
}

export const tempFile = async () => {
  const dir = path.join(config.assetsDir, 'tmp');
  await fsp.mkdir(dir, { recursive: true });
  return path.join(dir, crypto.randomUUID());
};

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** Stores bytes (`data`) or a temporary file (`file`, moved into place, so the caller must not use it again). */
export async function storeAsset({ spaceId, noteId, userId, name, mime, data, file: tmp, sha: known }) {
  const sha = known || (tmp ? await hashFile(tmp) : crypto.createHash('sha256').update(data).digest('hex'));
  const size = tmp ? (await fsp.stat(tmp)).size : data.length;
  const file = fileOf(sha);
  if (!fs.existsSync(file)) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    if (tmp) await fsp.rename(tmp, file);
    else {
      await fsp.writeFile(`${file}.tmp`, data);
      await fsp.rename(`${file}.tmp`, file);
    }
  } else if (tmp) await fsp.unlink(tmp).catch(() => {});
  const same = await one('SELECT * FROM assets WHERE space_id = $1 AND sha256 = $2 ORDER BY created_at LIMIT 1', spaceId, sha);
  if (same) return { ...same, name: str(name, 200) || same.name };
  const a = await one('INSERT INTO assets (space_id, note_id, user_id, name, mime, size, sha256, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
    spaceId, noteId || null, userId, str(name, 200), str(mime, 100).split(';')[0] || 'application/octet-stream', size, sha, now());
  if (/^image\/(png|jpeg|gif|webp)$/.test(a.mime) && size < 15e6) await enqueue(userId, 'image', a.id, { delay: 2, priority: 6 });
  if (/^audio\//.test(a.mime)) await enqueue(userId, 'transcribe', a.id, { delay: 1, priority: 3 });
  return a;
}

export const readAsset = (a) => fsp.readFile(fileOf(a.sha256));

async function canRead(userId, a) {
  const spaces = await userSpaceIds(userId);
  if (spaces.includes(a.space_id)) return true;
  // A page that moved to another space takes its files along for that space's members.
  return !!(await one('SELECT 1 FROM asset_refs r JOIN notes n ON n.id = r.note_id WHERE r.asset_id = $1 AND n.space_id = ANY($2::uuid[]) LIMIT 1', a.id, spaces));
}

function send(reply, a) {
  reply.header('content-type', a.mime);
  reply.header('cache-control', 'private, max-age=31536000, immutable');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('content-security-policy', "default-src 'none'; sandbox");
  reply.header('content-disposition', `${INLINE.test(a.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name || 'file')}`);
  return reply.send(fs.createReadStream(fileOf(a.sha256)));
}

// Large files arrive in pieces (PUT /api/uploads/:id?offset=n): a proxy in front may cap the size of one request
// (nginx's default is 1 MB), and a dropped connection only costs the current piece. The finished upload is then
// named by its id in a JSON request to /api/assets or /api/import instead of a multipart body.
const uploads = new Map(); // id → { userId, file, at }

const uploadOf = (userId, id) => {
  const u = uploads.get(id);
  if (!u || u.userId !== userId) fail(404, 'Upload not found (it may have expired)');
  return u;
};
const sizeOf = (file) => fsp.stat(file).then((s) => s.size, () => 0);

/** The finished upload's temporary file, now the caller's to move or delete. */
export async function takeUpload(userId, id, limit = Infinity) {
  const u = uploadOf(userId, id);
  uploads.delete(id);
  const size = await sizeOf(u.file);
  if (size > limit) { await fsp.unlink(u.file).catch(() => {}); fail(413, `Files can be at most ${Math.round(limit / 1048576)} MB`); }
  return { file: u.file, size };
}

export default async function assetRoutes(app) {
  // Raw pieces stream straight to disk (no body limit: they never sit in memory).
  app.addContentTypeParser('application/octet-stream', (req, payload, done) => done(null, payload));

  app.post('/api/uploads', async (req) => {
    for (const [id, u] of uploads) if (now() - u.at > 864e5) { uploads.delete(id); fsp.unlink(u.file).catch(() => {}); }
    const id = crypto.randomUUID(), file = await tempFile();
    await fsp.writeFile(file, '');
    uploads.set(id, { userId: req.user.id, file, at: now() });
    return { id };
  });
  app.get('/api/uploads/:id', async (req) => ({ size: await sizeOf(uploadOf(req.user.id, req.params.id).file) }));
  app.put('/api/uploads/:id', async (req, reply) => {
    const u = uploadOf(req.user.id, req.params.id);
    const size = await sizeOf(u.file);
    // A piece that is not the next one (a retry after a lost answer, or a lost piece): say where to continue.
    if (Number(req.query.offset) !== size) { req.body?.resume?.(); return reply.code(409).send({ error: 'Wrong offset', size }); }
    u.at = now();
    await pipeline(req.body, fs.createWriteStream(u.file, { flags: 'a' }));
    return { size: await sizeOf(u.file) };
  });

  app.post('/api/assets', async (req) => {
    let fields, upload;
    if (req.isMultipart()) {
      const part = await req.file({ limits: { fileSize: config.maxUpload } });
      if (!part) fail(400, 'No file');
      fields = { ...Object.fromEntries(Object.entries(part.fields).map(([k, v]) => [k, v?.value])), name: part.filename, mime: part.mimetype };
      upload = { stream: part.file };
    } else {
      fields = req.body || {};
      upload = uploadOf(req.user.id, fields.uploadId);
    }
    let spaceId = fields.spaceId;
    const noteId = isUuid(fields.noteId) ? fields.noteId : null;
    if (noteId) spaceId = (await needNote(req.user.id, noteId, 'editor')).space_id;
    else await needSpace(req.user.id, spaceId, 'editor');
    let saved;
    if (upload.stream) {
      saved = await saveStream(upload.stream);
      if (upload.stream.truncated) { await fsp.unlink(saved.file).catch(() => {}); fail(413, `Files can be at most ${Math.round(config.maxUpload / 1048576)} MB`); }
    } else saved = await takeUpload(req.user.id, fields.uploadId, config.maxUpload);
    const a = await storeAsset({ spaceId, noteId, userId: req.user.id, name: fields.name, mime: fields.mime, file: saved.file, sha: saved.sha });
    return { id: a.id, url: `/api/assets/${a.id}`, name: a.name, mime: a.mime, size: a.size };
  });

  // What a client already knows about a file (the text of a PDF page, the transcript shown for a recording).
  app.get('/api/assets/:id/text', async (req) => {
    const a = await one('SELECT id, space_id, ai_text FROM assets WHERE id = $1', uuidOr404(req.params.id)) || fail(404, 'Not found');
    if (!(await canRead(req.user.id, a))) fail(404, 'Not found');
    return { text: a.ai_text || '' };
  });
  app.put('/api/assets/:id/text', async (req) => {
    const a = await one('SELECT id, space_id FROM assets WHERE id = $1', uuidOr404(req.params.id)) || fail(404, 'Not found');
    await needSpace(req.user.id, a.space_id, 'editor');
    await q('UPDATE assets SET ai_text = $2 WHERE id = $1', a.id, str(req.body?.text, 200000));
    return { ok: true };
  });

  app.get('/api/assets/:id', async (req, reply) => {
    const a = await one('SELECT * FROM assets WHERE id = $1', uuidOr404(req.params.id));
    if (!a || !(await canRead(req.user.id, a))) fail(404, 'Not found');
    return send(reply, a);
  });

  // Images of a page shared by public link.
  app.get('/api/public/:slug/assets/:id', async (req, reply) => {
    const a = await one(`SELECT a.* FROM assets a JOIN asset_refs r ON r.asset_id = a.id JOIN notes n ON n.id = r.note_id
      WHERE a.id = $1 AND n.public_slug = $2 AND n.deleted_at IS NULL`, uuidOr404(req.params.id), str(req.params.slug, 40));
    if (!a) fail(404, 'Not found');
    return send(reply, a);
  });
}

// Pages saved before references existed.
async function backfillRefs() {
  if (await getServerSetting('assetRefsDone', false)) return;
  let last = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const rows = await many('SELECT id, ydoc FROM notes WHERE id > $1 AND ydoc IS NOT NULL ORDER BY id LIMIT 200', last);
    if (!rows.length) break;
    for (const n of rows) await syncAssetRefs(n.id, extract(docFrom(n.ydoc)).assets);
    last = rows.at(-1).id;
  }
  await setServerSetting('assetRefsDone', true);
}

/** Removes files no page has used for the grace period; a page in the trash still counts as using them. */
export async function collectAssets({ graceMs = config.assetGraceDays * 864e5 } = {}) {
  await backfillRefs();
  const t = now();
  await q('UPDATE assets a SET orphaned_at = NULL WHERE orphaned_at IS NOT NULL AND EXISTS (SELECT 1 FROM asset_refs r WHERE r.asset_id = a.id)');
  await q('UPDATE assets a SET orphaned_at = $1 WHERE orphaned_at IS NULL AND NOT EXISTS (SELECT 1 FROM asset_refs r WHERE r.asset_id = a.id)', t);
  const gone = (await q('DELETE FROM assets WHERE orphaned_at IS NOT NULL AND orphaned_at <= $1 RETURNING sha256', t - graceMs)).rows;
  for (const sha of new Set(gone.map((r) => r.sha256))) {
    if (!(await one('SELECT 1 FROM assets WHERE sha256 = $1 LIMIT 1', sha))) await fsp.unlink(fileOf(sha)).catch(() => {});
  }
  if (gone.length) log.info(`removed ${gone.length} unused file(s)`);
  return { removed: gone.length };
}

export async function deleteOrphanFiles() {
  // Files whose last record is gone (a deleted space). Recent ones may be an upload in progress.
  const dirs = fs.existsSync(config.assetsDir) ? await fsp.readdir(config.assetsDir) : [];
  for (const d of dirs) {
    for (const f of await fsp.readdir(path.join(config.assetsDir, d))) {
      const file = path.join(config.assetsDir, d, f);
      if (f.endsWith('.tmp') || now() - (await fsp.stat(file)).mtimeMs < 36e5) continue;
      if (!(await one('SELECT 1 FROM assets WHERE sha256 = $1 LIMIT 1', f))) await fsp.unlink(file).catch(() => {});
    }
  }
}
