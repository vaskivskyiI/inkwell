// Search: Postgres full-text (title, text, handwriting and image text) with prefix matching, merged with semantic
// matches from embeddings by reciprocal rank fusion. Operators: tag:x, kind:journal|page, in:<space name>.
import { many, one } from './db/index.js';
import { userSpaceIds } from './spaces.js';
import { resolve } from './ai/router.js';
import { isUuid } from './util/http.js';
import { logger } from './util/log.js';

const log = logger('search');

export function parseQuery(raw) {
  const out = { words: [], tags: [], kind: null, space: null };
  for (const m of String(raw || '').matchAll(/(\w+):("[^"]*"|\S+)|"([^"]+)"|(\S+)/g)) {
    const val = (m[2] || '').replace(/^"|"$/g, '');
    if (m[1] === 'tag') out.tags.push(val.toLowerCase().replace(/^#/, ''));
    else if (m[1] === 'kind') out.kind = val === 'journal' ? 'journal' : 'page';
    else if (m[1] === 'in') out.space = val.toLowerCase();
    else if (m[4]?.startsWith('#') && m[4].length > 2) out.tags.push(m[4].slice(1).toLowerCase());
    else out.words.push(...String(m[3] || m[4] || m[0]).split(/\s+/));
  }
  out.words = out.words.map((w) => w.replace(/[^\p{L}\p{N}_-]+/gu, '')).filter(Boolean);
  return out;
}

const tsquery = (words, any) => words.map((w) => `${w.replace(/-/g, ' & ')}:*`).join(any ? ' | ' : ' & ');

/** any: match pages containing any of the words (the assistant's retrieval for questions), ranked by how many. */
export async function search(userId, raw, { spaceId, limit = 30, semantic = true, any = false } = {}) {
  const pq = parseQuery(raw);
  if (any) pq.words = pq.words.filter((w) => w.length > 2);
  let spaces = isUuid(spaceId) ? [spaceId] : await userSpaceIds(userId);
  if (spaceId && !(await userSpaceIds(userId)).includes(spaceId)) return [];
  if (pq.space) {
    const named = await many('SELECT s.id FROM spaces s JOIN space_members m ON m.space_id = s.id AND m.user_id = $1 WHERE lower(s.name) = $2', userId, pq.space);
    if (named.length) spaces = named.map((r) => r.id);
  }
  const filters = ['n.space_id = ANY($1::uuid[])', 'n.deleted_at IS NULL'];
  const params = [spaces];
  if (pq.tags.length) { params.push(pq.tags); filters.push(`(n.tags && $${params.length}::text[] OR EXISTS (SELECT 1 FROM ai_insights i WHERE i.note_id = n.id AND i.tags_json ?| $${params.length}::text[]))`); }
  if (pq.kind) { params.push(pq.kind); filters.push(`n.kind = $${params.length}`); }

  let fts = [];
  if (pq.words.length) {
    params.push(tsquery(pq.words, any));
    const qi = params.length;
    fts = await many(`SELECT n.id, n.space_id, n.title, n.icon, n.kind, n.updated_at, ts_rank(n.search, to_tsquery('simple', $${qi})) AS rank,
      ts_headline('simple', left(n.text_content, 20000), to_tsquery('simple', $${qi}), 'MaxFragments=1, MaxWords=24, MinWords=10, StartSel=«, StopSel=»') AS snippet
      FROM notes n WHERE ${filters.join(' AND ')} AND n.search @@ to_tsquery('simple', $${qi}) ORDER BY rank DESC, n.updated_at DESC LIMIT ${Number(limit) * 2}`, ...params).catch((e) => {
      log.warn('fts failed', e.message); return [];
    });
    params.pop();
  } else if (pq.tags.length || pq.kind) {
    fts = await many(`SELECT n.id, n.space_id, n.title, n.icon, n.kind, n.updated_at, left(n.text_content, 160) AS snippet
      FROM notes n WHERE ${filters.join(' AND ')} ORDER BY n.updated_at DESC LIMIT ${Number(limit)}`, ...params);
  }

  let sem = [];
  const text = pq.words.join(' ');
  if (semantic && text.length >= 3) {
    try {
      const r = await resolve(userId, 'embed', { spaceId: isUuid(spaceId) ? spaceId : undefined });
      if (r) {
        const [vec] = await r.provider.embed({ model: r.model, input: [text] });
        params.push(`[${vec.join(',')}]`, r.model, vec.length);
        const v = params.length - 2;
        sem = await many(`SELECT DISTINCT ON (n.id) n.id, n.space_id, n.title, n.icon, n.kind, n.updated_at, e.body AS snippet, e.vec <=> $${v}::vector AS dist
          FROM embeddings e JOIN notes n ON n.id = e.note_id WHERE ${filters.join(' AND ')} AND e.model = $${v + 1} AND vector_dims(e.vec) = $${v + 2}
          ORDER BY n.id, dist`, ...params);
        sem = sem.filter((x) => x.dist < 0.75).sort((a, b) => a.dist - b.dist).slice(0, limit);
      }
    } catch (e) { log.warn('semantic search skipped:', e.message); }
  }

  // Reciprocal rank fusion: a page found by both lists ranks highest.
  const scores = new Map();
  const add = (list, weight) => list.forEach((r, i) => {
    const s = scores.get(r.id) || { row: r, score: 0, via: [] };
    s.score += weight / (60 + i);
    s.via.push(weight === 1 ? 'text' : 'meaning');
    if (weight === 1 || !s.row.snippet) s.row = { ...r, snippet: s.row.snippet && weight !== 1 ? s.row.snippet : r.snippet };
    scores.set(r.id, s);
  });
  add(fts, 1);
  add(sem, 0.8);
  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(({ row, via }) => ({
    id: row.id, spaceId: row.space_id, title: row.title, icon: row.icon, kind: row.kind, updatedAt: row.updated_at,
    snippet: String(row.snippet || '').replace(/\s+/g, ' ').slice(0, 300), via,
  }));
}

/** Pages closest in meaning to this one (average of its chunk embeddings). */
export async function related(userId, noteId, limit = 6) {
  const spaces = await userSpaceIds(userId);
  const own = await one('SELECT model, vector_dims(vec) AS dims FROM embeddings WHERE note_id = $1 LIMIT 1', noteId);
  if (!own) return [];
  return (await many(`WITH me AS (SELECT avg(vec) AS v FROM embeddings WHERE note_id = $1)
    SELECT n.id, n.title, n.icon, n.kind, n.space_id, min(e.vec <=> (SELECT v FROM me)) AS dist
    FROM embeddings e JOIN notes n ON n.id = e.note_id
    WHERE e.note_id <> $1 AND e.model = $2 AND vector_dims(e.vec) = $3 AND n.deleted_at IS NULL AND n.space_id = ANY($4::uuid[])
    GROUP BY n.id ORDER BY dist LIMIT $5`, noteId, own.model, own.dims, spaces, limit))
    .filter((r) => r.dist < 0.6).map((r) => ({ id: r.id, title: r.title, icon: r.icon, kind: r.kind, spaceId: r.space_id, score: 1 - r.dist }));
}

export default async function searchRoutes(app) {
  app.get('/api/search', async (req) => search(req.user.id, req.query.q, { spaceId: req.query.space, limit: Math.min(Number(req.query.limit) || 30, 100), semantic: req.query.semantic !== '0' }));
}
