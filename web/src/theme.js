import { localGet, localSet } from './store.js';

const media = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;

export function applyTheme(pref = localGet('theme') || 'system') {
  const dark = pref === 'dark' || (pref === 'system' && media?.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#16171d' : '#ffffff');
}

export function setTheme(pref) { localSet('theme', pref); applyTheme(pref); }
media?.addEventListener?.('change', () => applyTheme());
