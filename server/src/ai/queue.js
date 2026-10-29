// Durable background jobs (AI analysis, handwriting, embeddings…). A job is unique per (type, ref) while queued, so
// a burst of edits keeps pushing one job's start time back instead of piling up work. Workers claim jobs with
// FOR UPDATE SKIP LOCKED, so several server instances share the queue safely.
import { one, q, now, outsideTx } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../util/log.js';

const log = logger('queue');
const handlers = new Map();
let timer = null, running = 0, stopped = false;
const wakeups = new Set();

export const registerHandler = (type, fn) => handlers.set(type, fn);

/** delay in seconds; an already queued job of the same type/ref moves to the later start time and keeps the higher priority. */
export async function enqueue(userId, type, ref, { priority = 5, delay = 0 } = {}) {
  const t = now();
  await q(`INSERT INTO jobs (user_id, type, ref, priority, run_after, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)
    ON CONFLICT (type, ref) WHERE status = 'queued' DO UPDATE SET run_after = GREATEST(jobs.run_after, EXCLUDED.run_after),
      priority = LEAST(jobs.priority, EXCLUDED.priority), user_id = EXCLUDED.user_id, updated_at = EXCLUDED.updated_at`,
  userId, type, String(ref), priority, t + delay * 1000, t);
  kick(delay * 1000 + 50);
}

async function claim() {
  return one(`UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = $1 WHERE id = (
    SELECT id FROM jobs WHERE status = 'queued' AND run_after <= $1 ORDER BY priority, run_after LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`, now());
}

async function work() {
  if (stopped || running >= config.workers) return;
  running++;
  try {
    for (;;) {
      if (stopped) break;
      const job = await claim();
      if (!job) break;
      const fn = handlers.get(job.type);
      try {
        if (!fn) throw new Error(`No handler for ${job.type}`);
        const out = await fn(job);
        // A handler may ask to try later (e.g. no AI provider configured yet) without counting as failure.
        if (out?.retryIn) await q("UPDATE jobs SET status = 'queued', run_after = $2, attempts = attempts - 1, updated_at = $3 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type = $4 AND j.ref = $5 AND j.status = 'queued')", job.id, now() + out.retryIn * 1000, now(), job.type, job.ref);
        await q("DELETE FROM jobs WHERE id = $1 AND status = 'running'", job.id);
      } catch (e) {
        log.warn(`${job.type} ${job.ref} failed (attempt ${job.attempts}): ${e.message}`);
        const retry = job.attempts < 4 && e.status !== 400 && e.status !== 401 && e.status !== 403;
        if (retry) {
          // Back off 30 s, 2 min, 8 min — unless a newer job for the same thing is already queued.
          await q(`UPDATE jobs SET status = 'queued', run_after = $2, error = $3, updated_at = $4 WHERE id = $1
            AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type = $5 AND j.ref = $6 AND j.status = 'queued')`, job.id, now() + 30e3 * 4 ** (job.attempts - 1), e.message.slice(0, 500), now(), job.type, job.ref);
          await q("DELETE FROM jobs WHERE id = $1 AND status = 'running'", job.id);
        } else {
          await q("UPDATE jobs SET status = 'failed', error = $2, updated_at = $3 WHERE id = $1", job.id, e.message.slice(0, 500), now());
        }
        await handlers.get(`${job.type}:failed`)?.(job, e, retry).catch(() => {});
      }
    }
  } catch (e) {
    log.error('worker error', e);
  } finally { running--; }
}

export function kick(ms = 0) {
  const h = outsideTx(() => setTimeout(() => { wakeups.delete(h); work(); }, Math.max(0, ms)));
  h.unref?.();
  wakeups.add(h);
}

export function startQueue() {
  stopped = false;
  // Jobs left 'running' by a crashed instance go back to the queue after 10 minutes.
  q("UPDATE jobs SET status = 'queued', updated_at = $1 WHERE status = 'running' AND updated_at < $2", now(), now() - 600e3).catch(() => {});
  timer = setInterval(() => { for (let i = 0; i < config.workers; i++) work(); }, 5000);
  timer.unref?.();
  kick();
}

export function stopQueue() {
  stopped = true;
  clearInterval(timer);
  for (const h of wakeups) clearTimeout(h);
  wakeups.clear();
}

/** Tests: run until nothing is due. */
export async function drain() {
  for (let i = 0; i < 50; i++) {
    await work();
    while (running) await new Promise((r) => setTimeout(r, 10));
    const due = await one("SELECT count(*)::int AS n FROM jobs WHERE status IN ('queued', 'running') AND run_after <= $1", now());
    if (!due.n) return;
  }
}
