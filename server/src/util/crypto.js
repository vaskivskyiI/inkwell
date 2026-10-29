// Secrets at rest (provider API keys, integration tokens) are AES-256-GCM encrypted with the master key:
// INKWELL_SECRET, or <dataDir>/secret.key created on first start. Losing it makes stored secrets unreadable.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

let key = null;
function masterKey() {
  if (key) return key;
  let secret = config.secret;
  if (!secret) {
    const file = path.join(config.dataDir, 'secret.key');
    if (fs.existsSync(file)) secret = fs.readFileSync(file, 'utf8').trim();
    else if (config.memoryDb) secret = crypto.randomBytes(32).toString('base64');
    else {
      fs.mkdirSync(config.dataDir, { recursive: true });
      secret = crypto.randomBytes(32).toString('base64');
      fs.writeFileSync(file, secret, { mode: 0o600 });
    }
  }
  key = crypto.createHash('sha256').update(secret).digest();
  return key;
}

export function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}

export function decrypt(blob) {
  if (!blob) return '';
  const raw = Buffer.from(String(blob).replace(/^v1:/, ''), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const h = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hash, 'base64');
  return expected.length === h.length && crypto.timingSafeEqual(expected, h);
}
