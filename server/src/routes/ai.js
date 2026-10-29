import { one, many, q, now } from '../db/index.js';
import { fail, str, streamNdjson, isUuid } from '../util/http.js';
import { encrypt } from '../util/crypto.js';
import { needNote } from '../spaces.js';
import { getSettings, saveSettings, getServerSetting, setServerSetting } from '../settings.js';
import { PROVIDER_TYPES, makeProvider } from '../ai/providers/index.js';
import { availableProviders, resolve, forgetProvider } from '../ai/router.js';
import { INLINE_ACTIONS, inlineSystem } from '../ai/prompts.js';
import { enqueue } from '../ai/queue.js';
import { resumeWaiting, reanalyseAll } from '../ai/tasks.js';
import { ask } from '../ai/assistant.js';
import { related } from '../search.js';
import { readDoc, recognitionsOf } from '../collab.js';
import { extract } from '../docmodel.js';
import { config } from '../config.js';

const providerOut = (p) => ({ id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, hasKey: !!(p.apiKeyEnc || p.apiKey), shared: p.shared, env: !!p.env });

export default async function aiRoutes(app) {
  app.get('/api/ai/types', async () => Object.entries(PROVIDER_TYPES).filter(([k]) => k !== 'mock' || config.demo).map(([id, t]) => ({ id, ...t })));

  app.get('/api/ai/providers', async (req) => (await availableProviders(req.user.id)).map(providerOut));

  app.post('/api/ai/providers', async (req) => {
    const b = req.body || {};
    if (!PROVIDER_TYPES[b.type] || (b.type === 'mock' && !config.demo)) fail(400, 'Unknown provider type');
    if (b.shared && !req.user.is_admin) fail(403, 'Only administrators add server-wide providers');
    const p = await one('INSERT INTO ai_providers (user_id, name, type, base_url, api_key_enc, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      b.shared ? null : req.user.id, str(b.name, 60) || PROVIDER_TYPES[b.type].label, b.type, str(b.baseUrl, 300), encrypt(str(b.apiKey, 500)), now());
    await resumeWaiting(req.user.id);
    return { id: p.id };
  });

  const ownProvider = async (req) => {
    const p = await one('SELECT * FROM ai_providers WHERE id = $1', isUuid(req.params.id) ? req.params.id : null);
    if (!p || (p.user_id && p.user_id !== req.user.id)) fail(404, 'Provider not found');
    if (!p.user_id && !req.user.is_admin) fail(403, 'Only administrators change server-wide providers');
    return p;
  };

  app.patch('/api/ai/providers/:id', async (req) => {
    const p = await ownProvider(req);
    const b = req.body || {};
    await q('UPDATE ai_providers SET name = coalesce($2, name), base_url = coalesce($3, base_url), api_key_enc = coalesce($4, api_key_enc) WHERE id = $1',
      p.id, b.name !== undefined ? str(b.name, 60) : null, b.baseUrl !== undefined ? str(b.baseUrl, 300) : null, b.apiKey ? encrypt(str(b.apiKey, 500)) : null);
    forgetProvider();
    await resumeWaiting(req.user.id);
    return { ok: true };
  });

  app.delete('/api/ai/providers/:id', async (req) => {
    const p = await ownProvider(req);
    await q('DELETE FROM ai_providers WHERE id = $1', p.id);
    forgetProvider();
    return { ok: true };
  });

  // Unsaved settings can be tested too (wizard): pass type/baseUrl/apiKey instead of an id.
  const providerFrom = async (req) => {
    const b = req.body || {};
    if (b.id) {
      const p = (await availableProviders(req.user.id)).find((x) => x.id === b.id) || fail(404, 'Provider not found');
      const { decrypt } = await import('../util/crypto.js');
      return { inst: makeProvider({ type: p.type, baseUrl: p.baseUrl || PROVIDER_TYPES[p.type].defaultBaseUrl, apiKey: p.apiKey ?? decrypt(p.apiKeyEnc) }), type: p.type };
    }
    if (!PROVIDER_TYPES[b.type]) fail(400, 'Unknown provider type');
    return { inst: makeProvider({ type: b.type, baseUrl: str(b.baseUrl, 300) || PROVIDER_TYPES[b.type].defaultBaseUrl, apiKey: str(b.apiKey, 500) }), type: b.type };
  };

  app.post('/api/ai/models', async (req) => {
    const { inst } = await providerFrom(req);
    try { return await inst.listModels(); } catch (e) { fail(502, e.message); }
  });

  app.post('/api/ai/test', async (req) => {
    const { inst, type } = await providerFrom(req);
    const model = str(req.body?.model, 200) || PROVIDER_TYPES[type].defaultModel;
    const t0 = Date.now();
    try {
      const out = await inst.chat({ model, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], maxTokens: 20 });
      return { ok: true, reply: out.text.slice(0, 100), ms: Date.now() - t0, model };
    } catch (e) { return { ok: false, error: e.message, model }; }
  });

  app.get('/api/ai/status', async (req) => {
    const [chat, vision, embed] = await Promise.all(['chat', 'vision', 'embed'].map((t) => resolve(req.user.id, t)));
    const out = (r) => r && { provider: r.name, model: r.model, local: r.local };
    const jobs = await one(`SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued, count(*) FILTER (WHERE status = 'running')::int AS running,
      count(*) FILTER (WHERE status = 'failed')::int AS failed FROM jobs WHERE user_id = $1`, req.user.id);
    return { chat: out(chat), vision: out(vision), embed: out(embed), jobs };
  });

  // ---- settings (also used for non-AI preferences)
  app.get('/api/settings', async (req) => getSettings(req.user.id));
  app.put('/api/settings', async (req) => {
    const b = req.body || {};
    const allowed = {};
    for (const k of ['theme', 'language', 'paper', 'penOnly', 'journalSpace']) if (b[k] !== undefined) allowed[k] = str(b[k], 60);
    if (b.ai && typeof b.ai === 'object') {
      allowed.ai = {};
      for (const k of ['enabled', 'background']) if (b.ai[k] !== undefined) allowed.ai[k] = !!b.ai[k];
      for (const k of ['chat', 'vision', 'embed']) {
        if (b.ai[k] === null) allowed.ai[k] = null;
        else if (b.ai[k]?.providerId) allowed.ai[k] = { providerId: str(b.ai[k].providerId, 60), model: str(b.ai[k].model, 200) };
      }
    }
    const s = await saveSettings(req.user.id, allowed);
    if (allowed.ai) await resumeWaiting(req.user.id);
    return s;
  });

  app.get('/api/admin/settings', async (req) => {
    if (!req.user.is_admin) fail(403, 'Administrators only');
    return { allowSignup: await getServerSetting('allowSignup', config.allowSignup) };
  });
  app.put('/api/admin/settings', async (req) => {
    if (!req.user.is_admin) fail(403, 'Administrators only');
    if (req.body?.allowSignup !== undefined) await setServerSetting('allowSignup', !!req.body.allowSignup);
    return { ok: true };
  });

  // ---- on-demand AI
  app.get('/api/ai/actions', async () => Object.keys(INLINE_ACTIONS));

  app.post('/api/ai/inline', async (req, reply) => {
    const b = req.body || {};
    const action = INLINE_ACTIONS[b.action] ? b.action : fail(400, 'Unknown action');
    let spaceId, context = '';
    if (b.noteId) {
      const n = await needNote(req.user.id, b.noteId);
      spaceId = n.space_id;
      context = extract(await readDoc(n.id), { recognitions: await recognitionsOf(n.id) }).markdown.slice(0, 6000);
    }
    const settings = await getSettings(req.user.id);
    const r = await resolve(req.user.id, 'chat', { spaceId });
    if (!r) fail(409, 'No AI provider is configured — add one in Settings → AI');
    const instruction = INLINE_ACTIONS[action].replace('{target}', str(b.target, 40) || 'English').replace('{instruction}', str(b.instruction, 2000));
    const text = str(b.text, 30000) || context;
    const user = [
      context && b.text ? `Page context (for reference, do not repeat it):\n${context}\n` : '',
      `${instruction}\n\n<text>\n${text}\n</text>`,
    ].filter(Boolean).join('\n');
    return streamNdjson(reply, async ({ onToken, signal }) => {
      const out = await r.provider.chat({ model: r.model, system: inlineSystem(settings), messages: [{ role: 'user', content: user }], onToken, signal, temperature: action === 'continue' ? 0.7 : 0.3, maxTokens: 2500 });
      return { text: out.text.trim(), model: r.model };
    });
  });

  app.post('/api/ai/ask', async (req, reply) => {
    const b = req.body || {};
    return streamNdjson(reply, ({ onToken, signal }) => ask(req.user.id, {
      question: str(b.question, 4000), history: Array.isArray(b.history) ? b.history : [],
      spaceId: isUuid(b.spaceId) ? b.spaceId : undefined, noteId: isUuid(b.noteId) ? b.noteId : undefined,
    }, { onToken, signal }));
  });

  app.post('/api/notes/:id/ai/refresh', async (req) => {
    const n = await needNote(req.user.id, req.params.id);
    await q('DELETE FROM ai_insights WHERE note_id = $1', n.id);
    await q('UPDATE ink_recognitions SET strokes_hash = $2 WHERE note_id = $1', n.id, '');
    await enqueue(req.user.id, 'analyze', n.id, { priority: 1 });
    await enqueue(req.user.id, 'embed', n.id, { priority: 4 });
    for (const c of extract(await readDoc(n.id)).canvases) await enqueue(req.user.id, 'ink', `${n.id}:${c.id}`, { priority: 1 });
    return { ok: true };
  });

  // Handwriting of one canvas, read now (the editor asks when the user presses "Transcribe").
  app.post('/api/notes/:id/ink/:canvasId/recognize', async (req) => {
    const n = await needNote(req.user.id, req.params.id);
    await q('UPDATE ink_recognitions SET strokes_hash = $3 WHERE note_id = $1 AND canvas_id = $2', n.id, str(req.params.canvasId, 80), '');
    await enqueue(req.user.id, 'ink', `${n.id}:${str(req.params.canvasId, 80)}`, { priority: 0 });
    return { ok: true };
  });

  app.get('/api/notes/:id/related', async (req) => {
    await needNote(req.user.id, req.params.id);
    return related(req.user.id, req.params.id);
  });

  app.post('/api/ai/reanalyse', async (req) => ({ queued: await reanalyseAll(req.user.id) }));

  app.get('/api/ai/failed', async (req) => (await many("SELECT type, ref, error, updated_at FROM jobs WHERE user_id = $1 AND status = 'failed' ORDER BY updated_at DESC LIMIT 50", req.user.id)));
  app.post('/api/ai/failed/retry', async (req) => {
    await q("UPDATE jobs SET status = 'queued', attempts = 0, run_after = $2 WHERE user_id = $1 AND status = 'failed' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type = jobs.type AND j.ref = jobs.ref AND j.status = 'queued')", req.user.id, now());
    await q("DELETE FROM jobs WHERE user_id = $1 AND status = 'failed'", req.user.id);
    return { ok: true };
  });
}
