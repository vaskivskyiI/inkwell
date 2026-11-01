// Which provider and model does a task use? tasks: chat (text), vision (handwriting, images), embed, audio (speech to text).
// Sources, in order: the user's own providers, server-wide providers (admin), the operator's INKWELL_AI_* env.
// A space's owner may fix the models for the space's pages (settings_json.ai); everyone's work there then uses them.
// A space with `localAiOnly` only ever reaches providers on this machine / the private network.
import { one, many } from '../db/index.js';
import { config } from '../config.js';
import { decrypt } from '../util/crypto.js';
import { getSettings } from '../settings.js';
import { makeProvider, PROVIDER_TYPES, isLocalEndpoint } from './providers/index.js';

const ENV_ID = 'server-env';
const cache = new Map();

const listed = (rows) => {
  const list = rows.map((r) => ({ id: r.id, name: r.name, type: r.type, baseUrl: r.base_url, apiKeyEnc: r.api_key_enc, shared: !r.user_id }));
  if (config.ai.type && PROVIDER_TYPES[config.ai.type]) {
    list.push({ id: ENV_ID, name: 'Server AI', type: config.ai.type, baseUrl: config.ai.baseUrl, apiKey: config.ai.apiKey, shared: true, env: true,
      models: { chat: config.ai.chatModel, vision: config.ai.visionModel, embed: config.ai.embedModel } });
  }
  return list;
};

export const availableProviders = async (userId) => listed(await many('SELECT * FROM ai_providers WHERE user_id = $1 OR user_id IS NULL ORDER BY (user_id IS NULL), created_at', userId));

/** What a space's own choice may use: server-wide providers and its owners' own. */
export const spaceProviders = async (spaceId) => listed(await many(`SELECT * FROM ai_providers WHERE user_id IS NULL OR user_id IN (
  SELECT owner_id FROM spaces WHERE id = $1 UNION SELECT user_id FROM space_members WHERE space_id = $1 AND role = 'owner') ORDER BY (user_id IS NULL), created_at`, spaceId));

const defaultModel = (p, task) => {
  const t = PROVIDER_TYPES[p.type] || {};
  if (p.models?.[task]) return p.models[task];
  if (task === 'embed') return t.defaultEmbed;
  if (task === 'audio') return t.defaultAudio;
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
  let localOnly = false, fixed = null;
  if (spaceId) {
    const s = await one('SELECT settings_json FROM spaces WHERE id = $1', spaceId);
    if (s?.settings_json?.aiEnabled === false) return null;
    localOnly = !!s?.settings_json?.localAiOnly;
    fixed = s?.settings_json?.ai?.[task];
  }
  const usable = (l) => l.filter((p) => (config.demo || p.type !== 'mock') && (!localOnly || isLocalEndpoint(p.type, p.baseUrl)));
  // The space's choice first; when its provider is gone (or not local enough), each person's own routing.
  if (fixed?.providerId) {
    const p = usable(await spaceProviders(spaceId)).find((x) => x.id === fixed.providerId);
    const model = p && (fixed.model || defaultModel(p, task));
    if (model) return out(p, model);
  }
  const list = usable(await availableProviders(userId));
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
  return out(p, model);
}
const out = (p, model) => ({ provider: instance(p), model, name: p.name, type: p.type, local: isLocalEndpoint(p.type, p.baseUrl) });

// What models send instead of JSON: thinking first, fences, prose around it, LaTeX backslashes and raw line breaks in
// strings, or an answer cut off at the token limit. Each is mended before giving up.
export function parseJson(text) {
  const s = String(text || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim();
  const tries = [s];
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0) tries.push(b > a ? s.slice(a, b + 1) : s.slice(a), s.slice(a));
  for (const t of tries) {
    for (const x of [t, mendJson(t)]) {
      try { const v = JSON.parse(x); if (v && typeof v === 'object') return Array.isArray(v) ? { items: v } : v; } catch { /* next */ }
    }
  }
  throw new Error('The model did not return valid JSON');
}

/** Escapes what is not allowed inside strings and closes what a cut-off answer left open. */
function mendJson(t) {
  let out = '', inStr = false;
  const open = [];
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (c === '\\') {
        const n = t[i + 1];
        if (n && '"\\/bfnrt'.includes(n)) { out += c + n; i++; }
        else if (n === 'u' && /^[0-9a-f]{4}$/i.test(t.slice(i + 2, i + 6))) { out += t.slice(i, i + 6); i += 5; }
        else out += '\\\\'; // \alpha, \sum, \( …: a literal backslash
      } else if (c === '"') { inStr = false; out += c; }
      else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else if (c < ' ') out += ' ';
      else out += c;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') open.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') open.pop();
    out += c;
  }
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '').replace(/,(\s*[}\]])/g, '$1').replace(/:\s*$/, ': null');
  return out + open.reverse().join('');
}

/**
 * One JSON answer from the chat (or vision) model. A model that still answers otherwise is asked once more, with room
 * for a longer answer; `fallback` turns a plain-text answer into a usable one (a transcription is useful as text too).
 */
export async function askJson(r, { system, user, images, maxTokens = 1500, fallback }) {
  const ask = (sys, max) => r.provider.chat({ model: r.model, system: sys, messages: [{ role: 'user', content: user, images }], json: true, temperature: 0.1, maxTokens: max });
  const first = await ask(system, maxTokens);
  try { return parseJson(first.text); } catch { /* ask again */ }
  const again = await ask(`${system}\n\nAnswer with one JSON object only: no text before or after it, no code fences. Write a backslash inside a string as \\\\.`, maxTokens * 2);
  try { return parseJson(again.text); } catch (e) {
    const prose = String(again.text || first.text || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
    if (fallback && prose) return fallback(prose);
    throw e;
  }
}
