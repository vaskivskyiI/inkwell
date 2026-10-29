import { one, q } from './db/index.js';

// Per-user preferences. `ai` routes tasks to providers: { chat: {providerId, model}, vision: {...}, embed: {...} }.
export const DEFAULT_SETTINGS = {
  theme: 'system',
  language: '',            // AI output language; empty = the language of the page
  ai: { enabled: true, background: true, chat: null, vision: null, embed: null },
  paper: 'ruled',          // default journal paper: ruled | grid | dotted | plain
  penOnly: 'auto',         // auto | on | off — when on, touch scrolls and only a pen draws
  journalSpace: '',        // space for daily journal pages (default: the first space the user owns)
};

const merge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
  return out;
};

export async function getSettings(userId) {
  const r = await one('SELECT settings_json FROM user_settings WHERE user_id = $1', userId);
  return merge(DEFAULT_SETTINGS, r?.settings_json);
}

export async function saveSettings(userId, patch) {
  const next = merge(await getSettings(userId), patch);
  await q(`INSERT INTO user_settings (user_id, settings_json) VALUES ($1, $2::jsonb)
    ON CONFLICT (user_id) DO UPDATE SET settings_json = EXCLUDED.settings_json`, userId, JSON.stringify(next));
  return next;
}

export async function getServerSetting(key, fallback) {
  const r = await one('SELECT value_json FROM server_settings WHERE key = $1', key);
  return r ? r.value_json : fallback;
}

export async function setServerSetting(key, value) {
  await q(`INSERT INTO server_settings (key, value_json) VALUES ($1, $2::jsonb)
    ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json`, key, JSON.stringify(value));
}
