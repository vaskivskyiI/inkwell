// Background AI handlers. Each one is idempotent: it reads the current page state, so a job that runs late simply
// works on the newest content.
import { one, many, q, tx, now } from '../db/index.js';
import { registerHandler, enqueue, kick } from './queue.js';
import { resolve, askJson } from './router.js';
import { analyzePrompt, inkPrompt, imagePrompt } from './prompts.js';
import { readDoc, persist, recognitionsOf } from '../collab.js';
import { extract, strokesOf, strokesHash } from '../docmodel.js';
import { strokesToPng } from '../ink/render.js';
import { readAsset } from '../assets.js';
import { getSettings } from '../settings.js';
import { publish } from '../events.js';
import { logger } from '../util/log.js';

const log = logger('ai');
const NO_PROVIDER = { retryIn: 3600 }; // picked up again sooner when a provider is added (resumeWaiting)

async function noteInfo(noteId) {
  return one('SELECT id, space_id, title, kind, deleted_at FROM notes WHERE id = $1', noteId);
}

async function backgroundAllowed(userId) {
  const s = await getSettings(userId);
  return s.ai.enabled && s.ai.background ? s : null;
}

// ---- page analysis: summary, title suggestion, tags, action items
registerHandler('analyze', async (job) => {
  const n = await noteInfo(job.ref);
  if (!n || n.deleted_at) return;
  const settings = await backgroundAllowed(job.user_id);
  if (!settings) return;
  const doc = await readDoc(n.id);
  const info = extract(doc, { recognitions: await recognitionsOf(n.id) });
  const existing = await one('SELECT content_hash FROM ai_insights WHERE note_id = $1', n.id);
  if (existing?.content_hash === info.hash) return;
  const save = (fields) => q(`INSERT INTO ai_insights (note_id, summary, title, tags_json, actions_json, content_hash, error, updated_at)
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8) ON CONFLICT (note_id) DO UPDATE SET summary = EXCLUDED.summary, title = EXCLUDED.title,
    tags_json = EXCLUDED.tags_json, actions_json = EXCLUDED.actions_json, content_hash = EXCLUDED.content_hash, error = EXCLUDED.error, updated_at = EXCLUDED.updated_at`,
  n.id, fields.summary || '', fields.title || '', JSON.stringify(fields.tags || []), JSON.stringify(fields.actions || []), info.hash, fields.error || null, now());
  if (info.markdown.replace(/\s+/g, ' ').trim().length < 40) { await save({}); return; }
  const r = await resolve(job.user_id, 'chat', { spaceId: n.space_id });
  if (!r) return NO_PROVIDER;
  const out = await askJson(r, { system: analyzePrompt(settings), user: `TITLE: ${info.title || '(untitled)'}\n${info.markdown.slice(0, 24000)}` });
  const insight = {
    title: String(out.title || '').slice(0, 120),
    summary: String(out.summary || '').slice(0, 1200),
    tags: (Array.isArray(out.tags) ? out.tags : []).map((t) => String(t).toLowerCase().replace(/^#/, '').trim()).filter(Boolean).slice(0, 6),
    actions: (Array.isArray(out.actions) ? out.actions : []).map((a) => ({ text: String(a?.text || a || '').slice(0, 300), due: /^\d{4}-\d{2}-\d{2}/.test(a?.due || '') ? a.due.slice(0, 10) : null })).filter((a) => a.text).slice(0, 20),
  };
  await save(insight);
  publish(n.space_id, 'ai:insight', { noteId: n.id, insight });
});

registerHandler('analyze:failed', async (job, e, retry) => {
  if (!retry) await q(`INSERT INTO ai_insights (note_id, error, updated_at) VALUES ($1, $2, $3)
    ON CONFLICT (note_id) DO UPDATE SET error = EXCLUDED.error, updated_at = EXCLUDED.updated_at`, job.ref, e.message.slice(0, 300), now()).catch(() => {});
});

// ---- handwriting: render the canvas, read it with the vision model, fold the text back into search and AI context
registerHandler('ink', async (job) => {
  const [noteId, canvasId] = job.ref.split(':');
  const n = await noteInfo(noteId);
  if (!n || n.deleted_at) return;
  const settings = await backgroundAllowed(job.user_id);
  if (!settings) return;
  const doc = await readDoc(noteId);
  const strokes = strokesOf(doc, canvasId);
  const hash = strokesHash(strokes);
  const prev = await one('SELECT strokes_hash FROM ink_recognitions WHERE note_id = $1 AND canvas_id = $2', noteId, canvasId);
  if (prev?.strokes_hash === hash) return;
  if (!strokes.length) {
    await q('DELETE FROM ink_recognitions WHERE note_id = $1 AND canvas_id = $2', noteId, canvasId);
    await persist(noteId, doc, null);
    publish(n.space_id, 'ai:ink', { noteId, canvasId, text: '' });
    return;
  }
  const r = await resolve(job.user_id, 'vision', { spaceId: n.space_id });
  if (!r) return NO_PROVIDER;
  const { png } = await strokesToPng(strokes);
  const context = extract(doc).markdown.slice(0, 1500);
  const out = await askJson(r, {
    system: inkPrompt(settings),
    user: `Page: ${n.title || '(untitled)'}\nstrokes: ${strokes.length}\nNearby typed text (for context only, do not transcribe it):\n${context || '(none)'}`,
    images: [{ mime: 'image/png', data: Buffer.from(png).toString('base64') }],
    maxTokens: 3000,
  });
  const text = String(out.text || '').trim().slice(0, 50000);
  const data = {
    headings: arr(out.headings), todos: arr(out.todos), dates: arr(out.dates).filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d)),
    drawings: String(out.drawings || '').slice(0, 1000), language: String(out.language || '').slice(0, 10),
    confidence: Number(out.confidence) || null, model: r.model,
  };
  await q(`INSERT INTO ink_recognitions (note_id, canvas_id, text, data_json, strokes_hash, error, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, NULL, $6)
    ON CONFLICT (note_id, canvas_id) DO UPDATE SET text = EXCLUDED.text, data_json = EXCLUDED.data_json, strokes_hash = EXCLUDED.strokes_hash, error = NULL, updated_at = EXCLUDED.updated_at`,
  noteId, canvasId, [text, data.drawings && `(drawing: ${data.drawings})`].filter(Boolean).join('\n\n'), JSON.stringify(data), hash, now());
  await persist(noteId, doc, null); // search text, AI summary and embeddings now include the handwriting
  publish(n.space_id, 'ai:ink', { noteId, canvasId, text, data });
});

registerHandler('ink:failed', async (job, e, retry) => {
  const [noteId, canvasId] = job.ref.split(':');
  if (!retry) await q(`INSERT INTO ink_recognitions (note_id, canvas_id, error, updated_at) VALUES ($1, $2, $3, $4)
    ON CONFLICT (note_id, canvas_id) DO UPDATE SET error = EXCLUDED.error, updated_at = EXCLUDED.updated_at`, noteId, canvasId, e.message.slice(0, 300), now()).catch(() => {});
});

const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 300)).filter(Boolean).slice(0, 50) : []);

// ---- images: description + visible text, so pasted screenshots/photos are searchable
registerHandler('image', async (job) => {
  const a = await one('SELECT * FROM assets WHERE id = $1', job.ref);
  if (!a || a.ai_text) return;
  if (!(await backgroundAllowed(job.user_id))) return;
  const r = await resolve(job.user_id, 'vision', { spaceId: a.space_id });
  if (!r) return NO_PROVIDER;
  const data = await readAsset(a);
  const out = await askJson(r, { system: imagePrompt(), user: `File name: ${a.name}`, images: [{ mime: a.mime, data: data.toString('base64') }] });
  const text = [out.description, out.text && `Text: ${out.text}`].filter(Boolean).join(' ').slice(0, 4000);
  await q('UPDATE assets SET ai_text = $2 WHERE id = $1', a.id, text || '-');
  if (a.note_id) {
    const n = await noteInfo(a.note_id);
    if (n && !n.deleted_at) await persist(a.note_id, await readDoc(a.note_id), null);
  }
});

// ---- recordings: speech to text; the transcript joins the page's text like handwriting does
registerHandler('transcribe', async (job) => {
  const a = await one('SELECT * FROM assets WHERE id = $1', job.ref);
  if (!a || a.ai_text) return;
  if (!(await backgroundAllowed(job.user_id))) return;
  const r = await resolve(job.user_id, 'audio', { spaceId: a.space_id });
  if (!r?.provider.transcribe) return NO_PROVIDER;
  const text = String(await r.provider.transcribe({ model: r.model, data: await readAsset(a), mime: a.mime, name: a.name })).trim().slice(0, 200000);
  await q('UPDATE assets SET ai_text = $2 WHERE id = $1', a.id, text || '-');
  if (a.note_id) {
    const n = await noteInfo(a.note_id);
    if (n && !n.deleted_at) { await persist(a.note_id, await readDoc(a.note_id), null); publish(n.space_id, 'ai:audio', { noteId: n.id, assetId: a.id }); }
  }
});

// ---- embeddings for semantic search, related pages and the assistant
export function chunk(md, size = 1200) {
  const paras = md.split(/\n{2,}/);
  const out = [];
  let cur = '';
  for (const p of paras) {
    if (cur && (cur.length + p.length) > size) { out.push(cur); cur = ''; }
    if (p.length > size * 1.5) { for (let i = 0; i < p.length; i += size) out.push(p.slice(i, i + size)); continue; }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur.trim()) out.push(cur);
  return out.slice(0, 200);
}

registerHandler('embed', async (job) => {
  const n = await noteInfo(job.ref);
  if (!n || n.deleted_at) { await q('DELETE FROM embeddings WHERE note_id = $1', job.ref); return; }
  if (!(await backgroundAllowed(job.user_id))) return;
  const r = await resolve(job.user_id, 'embed', { spaceId: n.space_id });
  if (!r) return NO_PROVIDER;
  const doc = await readDoc(n.id);
  const info = extract(doc, { recognitions: await recognitionsOf(n.id) });
  const parts = chunk(`${info.title}\n\n${info.markdown}`.trim());
  if (!parts.length || info.markdown.trim().length < 10) { await q('DELETE FROM embeddings WHERE note_id = $1', n.id); return; }
  const vecs = [];
  for (let i = 0; i < parts.length; i += 32) vecs.push(...await r.provider.embed({ model: r.model, input: parts.slice(i, i + 32) }));
  await tx(async () => {
    await q('DELETE FROM embeddings WHERE note_id = $1', n.id);
    for (let i = 0; i < parts.length; i++) {
      await q('INSERT INTO embeddings (note_id, chunk, body, model, vec) VALUES ($1, $2, $3, $4, $5::vector)', n.id, i, parts[i], r.model, `[${vecs[i].join(',')}]`);
    }
  });
  log.debug(`embedded ${n.id} (${parts.length} chunks)`);
});

/** A provider was added or settings changed: jobs that waited for one run now. */
export async function resumeWaiting(userId) {
  await q("UPDATE jobs SET run_after = $2 WHERE status = 'queued' AND (user_id = $1 OR $1 IS NULL) AND run_after > $2", userId, now());
  kick();
}

/** Re-analyse everything of a user (e.g. after choosing a better model). */
export async function reanalyseAll(userId) {
  const notes = await many(`SELECT n.id FROM notes n JOIN space_members m ON m.space_id = n.space_id AND m.user_id = $1
    WHERE n.deleted_at IS NULL ORDER BY n.updated_at DESC LIMIT 2000`, userId);
  for (const n of notes) { await enqueue(userId, 'analyze', n.id, { priority: 8 }); await enqueue(userId, 'embed', n.id, { priority: 9 }); }
  return notes.length;
}
