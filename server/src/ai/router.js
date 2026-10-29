// Which provider and model does a task use? tasks: chat (text), vision (handwriting, images), embed.
// Sources, in order: the user's own providers, server-wide providers (admin), the operator's INKWELL_AI_* env.
// A space with `localAiOnly` only ever reaches providers on this machine / the private network.
import { one, many } from '../db/index.js';
import { config } from '../config.js';
import { decrypt } from '../util/crypto.js';
import { getSettings } from '../settings.js';
import { makeProvider, PROVIDER_TYPES, isLocalEndpoint } from './providers/index.js';

const ENV_ID = 'server-env';
const cache = new Map();

export async function availableProviders(userId) {
  const rows = await many('SELECT * FROM ai_providers WHERE user_id = $1 OR user_id IS NULL ORDER BY (user_id IS NULL), created_at', userId);
  const list = rows.map((r) => ({ id: r.id, name: r.name, type: r.type, baseUrl: r.base_url, apiKeyEnc: r.api_key_enc, shared: !r.user_id }));
  if (config.ai.type && PROVIDER_TYPES[config.ai.type]) {
    list.push({ id: ENV_ID, name: 'Server AI', type: config.ai.type, baseUrl: config.ai.baseUrl, apiKey: config.ai.apiKey, shared: true, env: true,
      models: { chat: config.ai.chatModel, vision: config.ai.visionModel, embed: config.ai.embedModel } });
  }
  return list;
}

const defaultModel = (p, task) => {
  const t = PROVIDER_TYPES[p.type] || {};
  if (p.models?.[task]) return p.models[task];
  if (task === 'embed') return t.defaultEmbed;
  if (task === 'vision') return t.defaultVision || t.defaultModel;
  return t.defaultModel;
};

function instance(p) {
  const key = `${p.id}|${p.type}|${p.baseUrl}`;
  if (!cache.has(key)) cache.set(key, makeProvider({ type: p.type, baseUrl: p.baseUrl || PROVIDER_TYPES[p.type]?.defaultBaseUrl, apiKey: p.apiKey ?? decrypt(p.apiKeyEnc) }));
  return cache.get(key);
}
export const forgetProvider = () => cache.clear();

/** { provider, model, name, local } or null when nothing suitable is configured (or AI is off for the user/space). */
export async function resolve(userId, task, { spaceId } = {}) {
  const settings = await getSettings(userId);
  if (!settings.ai.enabled) return null;
  let localOnly = false;
  if (spaceId) {
    const s = await one('SELECT settings_json FROM spaces WHERE id = $1', spaceId);
    if (s?.settings_json?.aiEnabled === false) return null;
    localOnly = !!s?.settings_json?.localAiOnly;
  }
  let list = await availableProviders(userId);
  if (!config.demo) list = list.filter((p) => p.type !== 'mock');
  if (localOnly) list = list.filter((p) => isLocalEndpoint(p.type, p.baseUrl));
  const chosen = settings.ai[task];
  let p = chosen?.providerId && list.find((x) => x.id === chosen.providerId);
  let model = p && (chosen.model || defaultModel(p, task));
  if (!p) {
    // Vision falls back to the chat provider's vision model; embeddings to the first provider that has them.
    const chat = task === 'vision' && settings.ai.chat?.providerId && list.find((x) => x.id === settings.ai.chat.providerId);
    p = chat || list.find((x) => defaultModel(x, task));
    model = p && defaultModel(p, task);
  }
  if (!p || !model) return null;
  return { provider: instance(p), model, name: p.name, type: p.type, local: isLocalEndpoint(p.type, p.baseUrl) };
}

export function parseJson(text) {
  const s = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fall through */ } }
  throw new Error('The model did not return valid JSON');
}

/** One JSON answer from the chat (or vision) model. */
export async function askJson(r, { system, user, images, maxTokens = 1500 }) {
  const out = await r.provider.chat({ model: r.model, system, messages: [{ role: 'user', content: user, images }], json: true, temperature: 0.1, maxTokens });
  return parseJson(out.text);
}
