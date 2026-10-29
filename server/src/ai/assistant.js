// "Ask Inkwell": answers from the user's notes (retrieval over search + embeddings), streamed, with cited pages.
import { many } from '../db/index.js';
import { search } from '../search.js';
import { resolve } from './router.js';
import { assistantSystem } from './prompts.js';
import { getSettings } from '../settings.js';
import { needNote } from '../spaces.js';
import { readDoc, recognitionsOf } from '../collab.js';
import { extract } from '../docmodel.js';
import { fail } from '../util/http.js';

async function sourcesFor(userId, question, { spaceId, noteId }) {
  const out = [];
  if (noteId) {
    const n = await needNote(userId, noteId);
    const info = extract(await readDoc(noteId), { recognitions: await recognitionsOf(noteId) });
    out.push({ id: n.id, title: info.title || n.title || 'Untitled', text: info.markdown.slice(0, 12000) });
  }
  const hits = await search(userId, question, { spaceId, limit: 8, any: true });
  const ids = hits.map((h) => h.id).filter((id) => id !== noteId).slice(0, 6);
  if (ids.length) {
    // Best chunks per page when embeddings exist, else the page's beginning.
    const chunks = await many(`SELECT DISTINCT ON (note_id) note_id, body FROM embeddings WHERE note_id = ANY($1::uuid[]) ORDER BY note_id, chunk`, ids);
    const byId = new Map(chunks.map((c) => [c.note_id, c.body]));
    const rows = await many('SELECT id, title, left(text_content, 3000) AS text FROM notes WHERE id = ANY($1::uuid[])', ids);
    const rowById = new Map(rows.map((r) => [r.id, r]));
    for (const h of hits) {
      const r = rowById.get(h.id);
      if (!r) continue;
      out.push({ id: r.id, title: r.title || 'Untitled', text: [h.snippet, byId.get(r.id) || r.text].filter(Boolean).join('\n…\n').slice(0, 3500) });
    }
  }
  return out;
}

export async function ask(userId, { question, history = [], spaceId, noteId }, { onToken, signal }) {
  const settings = await getSettings(userId);
  const r = await resolve(userId, 'chat', { spaceId });
  if (!r) fail(409, 'No AI provider is configured — add one in Settings → AI');
  const sources = await sourcesFor(userId, String(question || ''), { spaceId, noteId });
  const ctx = sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.text}`).join('\n\n---\n\n');
  const user = await many('SELECT name FROM users WHERE id = $1', userId);
  const messages = [
    ...history.slice(-8).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 6000) })),
    { role: 'user', content: `SOURCES (from the user's notes):\n${ctx || '(no matching notes)'}\n\nQUESTION: ${question}` },
  ];
  const out = await r.provider.chat({ model: r.model, system: assistantSystem({ ...settings, userName: user[0]?.name }), messages, onToken, signal, temperature: 0.3, maxTokens: 1800 });
  return { text: out.text, sources: sources.map((s, i) => ({ n: i + 1, id: s.id, title: s.title })), model: r.model };
}
