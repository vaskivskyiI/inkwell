// Reads a zip file on disk entry by entry, so an import of any size never has to fit in memory. Handles zip64
// (archives or entries over 4 GB) and the two methods real exports use: stored and deflate.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const big = (buf, at) => Number(buf.readBigUInt64LE(at));

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (!n) break;
    got += n;
  }
  return buf.subarray(0, got);
}

export function isZipFile(file) {
  const fd = fs.openSync(file, 'r');
  try { const b = readAt(fd, 0, 4); return b.length === 4 && b.readUInt32LE(0) === 0x04034b50; } finally { fs.closeSync(fd); }
}

/** [{ name, size, read() → Buffer, extract(dest) → Promise }]; close() when done. */
export function openZip(file) {
  const fd = fs.openSync(file, 'r');
  const total = fs.fstatSync(fd).size;
  const tailLen = Math.min(total, 65557);
  const tail = readAt(fd, total - tailLen, tailLen);
  let e = tail.length - 22;
  while (e >= 0 && tail.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) { fs.closeSync(fd); throw new Error('not a zip file (no central directory)'); }
  let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOffset = tail.readUInt32LE(e + 16);
  if ((count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) && e >= 20 && tail.readUInt32LE(e - 20) === 0x07064b50) {
    const z = readAt(fd, big(tail, e - 20 + 8), 56);
    if (z.readUInt32LE(0) === 0x06064b50) { count = big(z, 32); cdSize = big(z, 40); cdOffset = big(z, 48); }
  }
  const cd = readAt(fd, cdOffset, cdSize);
  const entries = [];
  for (let p = 0, i = 0; i < count && p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; i++) {
    const method = cd.readUInt16LE(p + 10), nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    let comp = cd.readUInt32LE(p + 20), size = cd.readUInt32LE(p + 24), local = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    // zip64 extra field: only the values that overflowed are there, in this order.
    for (let x = p + 46 + nameLen, end = x + extraLen; x + 4 <= end;) {
      const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
      if (id === 1) {
        let v = x + 4;
        if (size === 0xffffffff) { size = big(cd, v); v += 8; }
        if (comp === 0xffffffff) { comp = big(cd, v); v += 8; }
        if (local === 0xffffffff) local = big(cd, v);
      }
      x += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    entries.push(entry(fd, { name, method, comp, size, local }));
  }
  return { entries, close: () => fs.closeSync(fd) };
}

function entry(fd, { name, method, comp, size, local }) {
  if (method !== 0 && method !== 8) throw new Error(`${name}: unsupported compression method ${method}`);
  const start = () => {
    const h = readAt(fd, local, 30);
    if (h.readUInt32LE(0) !== 0x04034b50) throw new Error(`${name}: damaged entry`);
    return local + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  };
  return {
    name, size,
    read() {
      const raw = comp ? readAt(fd, start(), comp) : Buffer.alloc(0);
      return method === 8 ? zlib.inflateRawSync(raw) : raw;
    },
    async extract(dest) {
      const from = start();
      const src = fs.createReadStream(null, { fd, autoClose: false, start: from, end: from + comp - 1 });
      if (!comp) return fs.promises.writeFile(dest, '');
      await (method === 8 ? pipeline(src, zlib.createInflateRaw(), fs.createWriteStream(dest)) : pipeline(src, fs.createWriteStream(dest)));
    },
  };
}
