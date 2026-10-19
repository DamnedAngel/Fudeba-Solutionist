'use strict';
// Read-only ZIP access (stored + deflate), enough for Visual Studio template archives.
const fs = require('fs');
const zlib = require('zlib');

class ZipArchive {
  constructor(file) {
    this.file = file;
    this.buf = fs.readFileSync(file);
    /** @type {{name:string, method:number, csize:number, size:number, offset:number, dir:boolean}[]} */
    this.entries = [];
    this._readDirectory();
  }

  _readDirectory() {
    const b = this.buf;
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
      if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error(`${this.file}: not a zip archive`);
    const count = b.readUInt16LE(eocd + 10);
    let p = b.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
      if (b.readUInt32LE(p) !== 0x02014b50) throw new Error(`${this.file}: corrupt central directory`);
      const flags = b.readUInt16LE(p + 8);
      const method = b.readUInt16LE(p + 10);
      const csize = b.readUInt32LE(p + 20);
      const size = b.readUInt32LE(p + 24);
      const nlen = b.readUInt16LE(p + 28), elen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32);
      const offset = b.readUInt32LE(p + 42);
      // bit 11 = UTF-8 names; otherwise CP437, which only differs from UTF-8 for non-ASCII names
      const name = b.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen).replace(/\\/g, '/');
      this.entries.push({ name, method, csize, size, offset, dir: name.endsWith('/') });
      p += 46 + nlen + elen + clen;
    }
  }

  find(name) {
    const l = name.replace(/\\/g, '/').toLowerCase();
    return this.entries.find((e) => e.name.toLowerCase() === l);
  }

  read(entry) {
    const e = typeof entry === 'string' ? this.find(entry) : entry;
    if (!e) throw new Error(`${this.file}: no such entry ${entry}`);
    const b = this.buf;
    if (b.readUInt32LE(e.offset) !== 0x04034b50) throw new Error(`${this.file}: corrupt entry ${e.name}`);
    const start = e.offset + 30 + b.readUInt16LE(e.offset + 26) + b.readUInt16LE(e.offset + 28);
    const data = b.subarray(start, start + e.csize);
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`${this.file}: unsupported compression method ${e.method} for ${e.name}`);
  }
}

module.exports = { ZipArchive };
