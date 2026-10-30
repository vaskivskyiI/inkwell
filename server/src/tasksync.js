// To-dos that were sent to Halcyon stay in step both ways: ticking the to-do in the page completes the Halcyon task
// (job after the page is saved) and a task completed in Halcyon ticks the to-do (polled). A to-do and a task belong
// together when the page has a task link with the to-do's text.
import { many, q } from './db/index.js';
import { registerHandler, enqueue } from './ai/queue.js';
import { connection, call } from './integrations/halcyon.js';
import { readDoc, withDoc } from './collab.js';
import { todosOf, setTodoChecked } from './docmodel.js';
import { logger } from './util/log.js';

const log = logger('tasksync');
const norm = (s) => String(s || '').trim().toLowerCase();

const linksOf = (noteId) => many("SELECT id, ref, title, meta_json FROM note_links WHERE note_id = $1 AND kind = 'task' AND ref ~ '^[0-9]+$'", noteId);
const setDone = (id, meta, done) => q('UPDATE note_links SET meta_json = $2::jsonb WHERE id = $1', id, JSON.stringify({ ...meta, done }));

/** Called after a page is saved: only when a linked to-do's tick differs from what Halcyon was last told. */
export async function queueOutgoing(userId, noteId, doc) {
  const links = await linksOf(noteId);
  if (!links.length) return;
  const todos = new Map(todosOf(doc).map((t) => [norm(t.text), t.checked]));
  if (links.some((l) => todos.has(norm(l.title)) && todos.get(norm(l.title)) !== !!l.meta_json?.done)) await enqueue(userId, 'tasksync', noteId, { delay: 2, priority: 4 });
}

registerHandler('tasksync', async (job) => {
  const conn = await connection(job.user_id);
  if (!conn) return;
  const todos = new Map(todosOf(await readDoc(job.ref)).map((t) => [norm(t.text), t.checked]));
  for (const l of await linksOf(job.ref)) {
    const checked = todos.get(norm(l.title));
    if (checked === undefined || checked === !!l.meta_json?.done) continue;
    await call(conn, 'complete_task', { id: Number(l.ref), done: checked });
    await setDone(l.id, l.meta_json, checked);
  }
});

/** Ticks to-dos of tasks completed (or reopened) in Halcyon. */
export async function pullTasks(user) {
  const conn = await connection(user.id);
  if (!conn) return { changed: 0 };
  const links = await many(`SELECT l.id, l.note_id, l.ref, l.title, l.meta_json FROM note_links l JOIN notes n ON n.id = l.note_id
    JOIN space_members m ON m.space_id = n.space_id AND m.user_id = $1 WHERE l.kind = 'task' AND n.deleted_at IS NULL AND l.ref ~ '^[0-9]+$'`, user.id);
  if (!links.length) return { changed: 0 };
  const ids = [...new Set(links.map((l) => Number(l.ref)))];
  const tasks = new Map(((await call(conn, 'list_tasks', { include_done: true, ids }).catch(() => [])) || []).map((t) => [String(t.id), !!t.done]));
  let changed = 0;
  for (const l of links) {
    const done = tasks.get(l.ref);
    if (done === undefined || done === !!l.meta_json?.done) continue;
    await setDone(l.id, l.meta_json, done);
    await withDoc(l.note_id, (doc) => { if (setTodoChecked(doc, l.title, done)) changed++; }, user);
  }
  return { changed };
}

export async function pullAll() {
  const users = await many("SELECT u.id, u.name FROM users u JOIN integrations i ON i.user_id = u.id AND i.kind = 'halcyon' WHERE NOT u.disabled");
  for (const u of users) await pullTasks(u).catch((e) => log.warn(`pull for ${u.id}: ${e.message}`));
}
