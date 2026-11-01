// To-dos that were sent to Halcyon stay in step both ways: ticking the to-do in the page completes the Halcyon task
// (job after the page is saved) and a task completed in Halcyon ticks the to-do (polled). A to-do and a task belong
// together when the page has a task link with the to-do's text.
//
// Repeating tasks stay open in Halcyon and move to their next date when ticked, so "done" never shows on them: a tick
// there is seen as a moved due date, and a tick here is sent once only (each send would complete one more occurrence).
import { many, q } from './db/index.js';
import { registerHandler, enqueue } from './ai/queue.js';
import { connections, tryEach, call, byConn, suiteEnabled } from './integrations/halcyon.js';
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
  const conns = await connections(job.user_id);
  if (!conns.length) return;
  const todos = new Map(todosOf(await readDoc(job.ref)).map((t) => [norm(t.text), t.checked]));
  for (const l of await linksOf(job.ref)) {
    const checked = todos.get(norm(l.title));
    if (checked === undefined || checked === !!l.meta_json?.done) continue;
    // Unticking cannot take back a completed occurrence.
    if (l.meta_json?.repeats && !checked) { await setMeta(l, { done: false }); continue; }
    const { conn, out } = await tryEach(conns, l.meta_json?.conn, (c) => call(c, 'complete_task', { id: Number(l.ref), done: checked }));
    await setMeta(l, { done: checked, conn: l.meta_json?.conn ?? conn.key, ...(out?.completed_id ? { repeats: true, seenDue: out.next_due ?? null } : {}) });
  }
});

/** Ticks to-dos of tasks completed (or reopened) in Halcyon. */
export async function pullTasks(user) {
  const conns = await connections(user.id);
  if (!conns.length) return { changed: 0 };
  const links = await many(`SELECT l.id, l.note_id, l.ref, l.title, l.meta_json FROM note_links l JOIN notes n ON n.id = l.note_id
    JOIN space_members m ON m.space_id = n.space_id AND m.user_id = $1 WHERE l.kind = 'task' AND n.deleted_at IS NULL AND l.ref ~ '^[0-9]+$'`, user.id);
  if (!links.length) return { changed: 0 };
  const known = (l) => byConn(conns, l.meta_json?.conn);
  const found = new Map(); // link → its task, from the link's connection, or the first that has it
  for (const c of conns) {
    const mine = links.filter((l) => (known(l) ? known(l) === c : !found.has(l)));
    if (!mine.length) continue;
    const ids = [...new Set(mine.map((l) => Number(l.ref)))];
    const tasks = new Map(((await call(c, 'list_tasks', { include_done: true, ids }).catch(() => [])) || []).map((t) => [String(t.id), t]));
    for (const l of mine) if (tasks.has(l.ref)) found.set(l, tasks.get(l.ref)); // missing: deleted or out of the token's space
  }
  let changed = 0;
  for (const [l, t] of found) {
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
  // Users signed in with Halcyon have suite connections without any setup of their own.
  const users = await many(`SELECT u.id, u.name FROM users u WHERE NOT u.disabled AND (($1 AND u.halcyon_sub IS NOT NULL)
    OR EXISTS (SELECT 1 FROM integrations i WHERE i.user_id = u.id AND i.kind = 'halcyon'))`, suiteEnabled());
  for (const u of users) await pullTasks(u).catch((e) => log.warn(`pull for ${u.id}: ${e.message}`));
}
