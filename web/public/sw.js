// Offline shell: the app loads without a connection; pages themselves are cached by the app in IndexedDB.
// /api is never touched here, so private data is not stored in this cache.
const CACHE = 'inkwell-shell-v2';
// What another app shared with Inkwell (the share sheet on a phone), until the app has taken it.
const SHARE = 'inkwell-share';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add('/')).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const c = await caches.open(SHARE);
    for (const k of await c.keys()) await c.delete(k);
    const files = form.getAll('files').filter((f) => f && typeof f !== 'string' && f.size);
    await Promise.all(files.map((f, i) => c.put(`/shared/${i}`, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || `file-${i + 1}`) } }))));
    const meta = { title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '', files: files.length, at: Date.now() };
    await c.put('/shared/meta', new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
  } catch { /* the share page then says nothing arrived */ }
  return Response.redirect('/#/share', 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method === 'POST' && url.pathname === '/share-target') { e.respondWith(receiveShare(e.request)); return; }
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/assets/')) {
    // Built files have the content hash in their name: never stale.
    e.respondWith(caches.open(CACHE).then(async (c) => (await c.match(e.request)) || fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; })));
    return;
  }
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); } return r; }).catch(() => caches.match('/')));
  }
});
