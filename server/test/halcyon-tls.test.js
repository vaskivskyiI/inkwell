// Halcyon behind a private CA (fixtures/tls: a test CA and a server certificate for 127.0.0.1): refused until its CA
// is added or checking is switched off; the choice is kept with the connection.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import { startServer, signup } from './helpers.js';

const fx = (f) => fs.readFileSync(new URL(`./fixtures/tls/${f}`, import.meta.url), 'utf8');
let app, ann, fake, base;
before(async () => {
  ({ app } = await startServer());
  ann = await signup(app, 'tls@test.local', 'Tess');
  fake = https.createServer({ key: fx('server.key'), cert: fx('server.pem') }, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer hmcp_good') { res.writeHead(401).end('{}'); return; }
      const { id } = JSON.parse(body);
      const items = [{ id: 7, title: 'Existing task', due: null, done: false }];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(items) }], structuredContent: { items } } }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  base = `https://127.0.0.1:${fake.address().port}`;
});
after(async () => { fake?.close(); await app.close(); });

test('Halcyon with a private CA: its certificate authority, or no check', async () => {
  const put = (body) => ann.status('PUT', '/api/integrations/halcyon', { baseUrl: base, token: 'hmcp_good', ...body });
  assert.equal(await put({}), 502, 'not trusted by default');
  assert.equal(await put({ tls: { ca: 'not a certificate' } }), 400);
  await ann.put('/api/integrations/halcyon', { baseUrl: base, token: 'hmcp_good', tls: { ca: fx('ca.pem') } });
  const c = await ann.get('/api/integrations/halcyon');
  assert.equal(c.connected, true);
  assert.match(c.settings.tls.ca, /^-----BEGIN CERTIFICATE-----/);
  assert.equal((await ann.get('/api/halcyon/search?kind=task&q=existing'))[0].title, 'Existing task', 'later calls use the CA too');

  await ann.put('/api/integrations/halcyon', { baseUrl: base, token: 'hmcp_good', tls: { insecure: true } });
  assert.deepEqual((await ann.get('/api/integrations/halcyon')).settings.tls, { insecure: true });
  assert.equal(await put({}), 502, 'reconnecting without either checks again');
});
