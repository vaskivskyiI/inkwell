// Uploaded files (images, attachments). Content-addressed on disk (<assets>/<ab>/<sha256>), so duplicates are stored
// once; access follows the space the file belongs to.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { one, q, now } from './db/index.js';
import { config } from './config.js';
import { fail, str, isUuid, uuidOr404 } from './util/http.js';
import { needSpace, needNote } from './spaces.js';
import { enqueue } from './ai/queue.js';

// Shown inline; everything else downloads (an uploaded HTML/SVG must never run as a page of this origin).
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm)|audio\/(mpeg|ogg|wav|webm|mp4)|application\/pdf)$/;

const fileOf = (sha) => path.join(config.assetsDir, sha.slice(0, 2), sha);

export async function storeAsset({ spaceId, noteId, userId, name, mime, data }) {
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  const file = fileOf(sha);
  if (!fs.existsSync(file)) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(`${file}.tmp`, data);
    await fsp.rename(`${file}.tmp`, file);
  }
  const a = await one('INSERT INTO assets (space_id, note_id, user_id, name, mime, size, sha256, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
    spaceId, noteId || null, userId, str(name, 200), str(mime, 100).split(';')[0] || 'application/octet-stream', data.length, sha, now());
  if (/^image\/(png|jpeg|gif|webp)$/.test(a.mime) && data.length < 15e6) await enqueue(userId, 'image', a.id, { delay: 2, priority: 6 });
  if (/^audio\//.test(a.mime)) await enqueue(userId, 'transcribe', a.id, { delay: 1, priority: 3 });
  return a;
}

export const readAsset = (a) => fsp.readFile(fileOf(a.sha256));

function send(reply, a) {
  reply.header('content-type', a.mime);
  reply.header('cache-control', 'private, max-age=31536000, immutable');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('content-security-policy', "default-src 'none'; sandbox");
  reply.header('content-disposition', `${INLINE.test(a.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name || 'file')}`);
  return reply.send(fs.createReadStream(fileOf(a.sha256)));
}

export default async function assetRoutes(app) {
  app.post('/api/assets', async (req) => {
    const part = await req.file({ limits: { fileSize: config.maxUpload } });
    if (!part) fail(400, 'No file');
    const fields = Object.fromEntries(Object.entries(part.fields).map(([k, v]) => [k, v?.value]));
    let spaceId = fields.spaceId;
    const noteId = isUuid(fields.noteId) ? fields.noteId : null;
    if (noteId) spaceId = (await needNote(req.user.id, noteId, 'editor')).space_id;
    else await needSpace(req.user.id, spaceId, 'editor');
    const data = await part.toBuffer();
    if (part.file.truncated) fail(413, `Files can be at most ${Math.round(config.maxUpload / 1048576)} MB`);
    const a = await storeAsset({ spaceId, noteId, userId: req.user.id, name: part.filename, mime: part.mimetype, data });
    return { id: a.id, url: `/api/assets/${a.id}`, name: a.name, mime: a.mime, size: a.size };
  });

  // What a client already knows about a file (the text of a PDF page, the transcript shown for a recording).
  app.get('/api/assets/:id/text', async (req) => {
    const a = await one('SELECT space_id, ai_text FROM assets WHERE id = $1', uuidOr404(req.params.id)) || fail(404, 'Not found');
    await needSpace(req.user.id, a.space_id);
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
    if (!a) fail(404, 'Not found');
    await needSpace(req.user.id, a.space_id);
    return send(reply, a);
  });

  // Images of a page shared by public link.
  app.get('/api/public/:slug/assets/:id', async (req, reply) => {
    const a = await one(`SELECT a.* FROM assets a JOIN notes n ON n.id = a.note_id
      WHERE a.id = $1 AND n.public_slug = $2 AND n.deleted_at IS NULL`, uuidOr404(req.params.id), str(req.params.slug, 40));
    if (!a) fail(404, 'Not found');
    return send(reply, a);
  });
}

export async function deleteOrphanFiles() {
  // Files whose last asset row is gone (space deleted). Runs rarely; cheap enough to list the directory.
  const dirs = fs.existsSync(config.assetsDir) ? await fsp.readdir(config.assetsDir) : [];
  for (const d of dirs) {
    for (const f of await fsp.readdir(path.join(config.assetsDir, d))) {
      if (f.endsWith('.tmp')) continue;
      if (!(await one('SELECT 1 FROM assets WHERE sha256 = $1 LIMIT 1', f))) await fsp.unlink(path.join(config.assetsDir, d, f)).catch(() => {});
    }
  }
}
