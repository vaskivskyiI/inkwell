// To-dos that were sent to Halcyon stay in step both ways: ticking the to-do in the page completes the Halcyon task
// (job after the page is saved) and a task completed in Halcyon ticks the to-do (polled). A to-do and a task belong
// together when the page has a task link with the to-do's text.
//
// Repeating tasks stay open in Halcyon and move to their next date when ticked, so "done" never shows on them: a tick
// there is seen as a moved due date, and a tick here is sent once only (each send would complete one more occurrence).
import { many, q } from './db/index.js';
import { registerHandler, enqueue } from './ai/queue.js';
import { connection, call } from './integrations/halcyon.js';
import { readDoc, withDoc } from './collab.js';
import { todosOf, setTodoChecked } from './docmodel.js';
import { logger } from './util/log.js';

const log = logger('tasksync');
const norm = (s) => String(s || '').trim().toLowerCase();

const linksOf = (noteId) => many("SELECT id, ref, title, meta_json FROM note_links WHERE note_id = $1 AND kind = 'task' AND ref ~ '^[0-9]+$'", noteId);
const setMeta = (l, patch) => q('UPDATE note_links SET meta_json = $2::jsonb WHERE id = $1', l.id, JSON.stringify({ ...l.meta_json, ...patch }));

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
    // Unticking cannot take back a completed occurrence.
    if (l.meta_json?.repeats && !checked) { await setMeta(l, { done: false }); continue; }
    const out = await call(conn, 'complete_task', { id: Number(l.ref), done: checked });
    await setMeta(l, { done: checked, ...(out?.completed_id ? { repeats: true, seenDue: out.next_due ?? null } : {}) });
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
  const tasks = new Map(((await call(conn, 'list_tasks', { include_done: true, ids }).catch(() => [])) || []).map((t) => [String(t.id), t]));
  let changed = 0;
  for (const l of links) {
    const t = tasks.get(l.ref); // missing: deleted or out of the token's space
    if (!t) continue;
    const m = l.meta_json || {};
    let done = !!t.done;
    // A repeating task's last occurrence ends as plain done.
    if ((t.repeats || m.repeats) && !t.done) {
      const moved = m.seenDue !== undefined && (t.due ?? null) !== m.seenDue;
      if (moved || m.seenDue === undefined || !m.repeats) await setMeta(l, { repeats: true, seenDue: t.due ?? null, ...(moved ? { done: true } : {}) });
      if (!moved || m.done) continue;
      done = true;
    } else {
      if (done === !!m.done) continue;
      await setMeta(l, { done });
    }
    await withDoc(l.note_id, (doc) => { if (setTodoChecked(doc, l.title, done)) changed++; }, user);
  }
  return { changed };
}

export async function pullAll() {
  const users = await many("SELECT u.id, u.name FROM users u JOIN integrations i ON i.user_id = u.id AND i.kind = 'halcyon' WHERE NOT u.disabled");
  for (const u of users) await pullTasks(u).catch((e) => log.warn(`pull for ${u.id}: ${e.message}`));
}
