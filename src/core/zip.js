'use strict';
/**
 * 极简 ZIP 读取器（仅依赖 Node 内置 zlib）
 * 只解析中央目录，按需解压单个条目，避免大 APK 全量解压撑爆内存。
 */
const zlib = require('zlib');
const fs = require('fs');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

class ZipArchive {
  constructor(buffer) {
    this.buf = buffer;
    this.entries = new Map();
    this._parse();
  }

  _parse() {
    const buf = this.buf;
    let eocd = -1;
    const maxScan = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= maxScan; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP/APK 文件（未找到 EOCD）');

    const total = buf.readUInt16LE(eocd + 10);
    let offset = buf.readUInt32LE(eocd + 16);

    for (let i = 0; i < total; i++) {
      if (buf.readUInt32LE(offset) !== CEN_SIG) break;
      const flags = buf.readUInt16LE(offset + 8);
      const method = buf.readUInt16LE(offset + 10);
      const compSize = buf.readUInt32LE(offset + 20);
      const uncompSize = buf.readUInt32LE(offset + 24);
      const nameLen = buf.readUInt16LE(offset + 28);
      const extraLen = buf.readUInt16LE(offset + 30);
      const commentLen = buf.readUInt16LE(offset + 32);
      const localOffset = buf.readUInt32LE(offset + 42);
      const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
      this.entries.set(name, {
        name, flags, method, compSize, uncompSize, localOffset,
      });
      offset += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(name) { return this.entries.has(name); }

  names() { return [...this.entries.keys()]; }

  read(name) {
    const e = this.entries.get(name);
    if (!e) return null;
    const buf = this.buf;
    if (buf.readUInt32LE(e.localOffset) !== LOC_SIG) {
      throw new Error(`本地文件头损坏: ${name}`);
    }
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return Buffer.from(raw);
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`不支持的压缩方式 ${e.method}: ${name}`);
  }

  /** 列出匹配某个前缀/正则的条目名 */
  find(re) {
    return [...this.entries.keys()].filter((n) => re.test(n));
  }

  /**
   * 流式解压单个条目到可写流。
   * system.img 这类 GB 级条目无法整块 inflate 进内存（会撞上 Node 的 2GB 单 Buffer 上限），
   * 必须边解压边落盘。
   */
  pipeTo(name, dest) {
    const e = this.entries.get(name);
    if (!e) return Promise.reject(new Error(`条目不存在: ${name}`));
    const buf = this.buf;
    if (buf.readUInt32LE(e.localOffset) !== LOC_SIG) {
      return Promise.reject(new Error(`本地文件头损坏: ${name}`));
    }
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.compSize);

    return new Promise((resolve, reject) => {
      const done = (err) => { if (err) reject(err); else resolve(e.uncompSize); };
      dest.on('error', done);
      dest.on('finish', () => done(null));

      if (e.method === 0) {
        dest.end(raw);
        return;
      }
      if (e.method !== 8) return done(new Error(`不支持的压缩方式 ${e.method}: ${name}`));

      const inflater = zlib.createInflateRaw();
      // 分片喂入，避免一次性把 GB 数据塞进 zlib 缓冲区
      const SLICE = 1 << 20;
      let pos = 0;
      const pump = () => {
        while (pos < raw.length) {
          const end = Math.min(pos + SLICE, raw.length);
          const chunk = raw.subarray(pos, end);
          pos = end;
          if (!inflater.write(chunk)) {
            inflater.once('drain', pump);
            return;
          }
        }
        inflater.end();
      };
      inflater.on('error', done);
      inflater.pipe(dest);
      pump();
    });
  }
}

/**
 * 文件版 ZIP 读取器：只把尾部中央目录读进内存，条目按需从 fd 流式读。
 * 用于 emulator / 系统镜像这类 GB 级安装包——旧版 fs.readFileSync 整包读会
 * 在低内存机器上直接 OOM，表现为「下载完了却装不上」。
 */
class ZipFile {
  constructor(filePath) {
    this.path = filePath;
    this.fd = fs.openSync(filePath, 'r');
    this.size = fs.statSync(filePath).size;
    this.entries = new Map();
    try { this._parse(); } catch (e) { this.close(); throw e; }
  }

  close() {
    if (this.fd != null) { try { fs.closeSync(this.fd); } catch (_) { /* ignore */ } }
    this.fd = null;
  }

  _readAt(pos, len) {
    const b = Buffer.alloc(Math.max(0, len));
    if (len > 0) fs.readSync(this.fd, b, 0, len, pos);
    return b;
  }

  _parse() {
    const tailLen = Math.min(this.size, 22 + 65557 + 4096);
    const tailBase = this.size - tailLen;
    const tail = this._readAt(tailBase, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP/APK 文件（未找到 EOCD）');

    const total = tail.readUInt16LE(eocd + 10);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const eocdAbs = tailBase + eocd;
    let cd = tail;
    let cdBase = tailBase;
    if (cdOffset < tailBase || cdOffset > eocdAbs) {
      // 中央目录不在尾部缓冲里（超大注释等），单独读一段
      const len = Math.min(eocdAbs - cdOffset, 64 * 1024 * 1024);
      if (len <= 0) throw new Error('ZIP 中央目录偏移异常');
      cd = this._readAt(cdOffset, len);
      cdBase = cdOffset;
    }

    let off = cdOffset - cdBase;
    for (let i = 0; i < total; i += 1) {
      if (off + 46 > cd.length || cd.readUInt32LE(off) !== CEN_SIG) break;
      const flags = cd.readUInt16LE(off + 8);
      const method = cd.readUInt16LE(off + 10);
      const compSize = cd.readUInt32LE(off + 20);
      const uncompSize = cd.readUInt32LE(off + 24);
      const nameLen = cd.readUInt16LE(off + 28);
      const extraLen = cd.readUInt16LE(off + 30);
      const commentLen = cd.readUInt16LE(off + 32);
      const localOffset = cd.readUInt32LE(off + 42);
      const name = cd.toString('utf8', off + 46, off + 46 + nameLen);
      this.entries.set(name, { name, flags, method, compSize, uncompSize, localOffset });
      off += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(name) { return this.entries.has(name); }
  names() { return [...this.entries.keys()]; }
  find(re) { return this.names().filter((n) => re.test(n)); }

  _range(name) {
    const e = this.entries.get(name);
    if (!e) throw new Error(`条目不存在: ${name}`);
    const head = this._readAt(e.localOffset, 30);
    if (head.readUInt32LE(0) !== LOC_SIG) throw new Error(`本地文件头损坏: ${name}`);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    return { e, start, end: start + e.compSize - 1 };
  }

  read(name) {
    const { e, start } = this._range(name);
    const raw = this._readAt(start, e.compSize);
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`不支持的压缩方式 ${e.method}: ${name}`);
  }

  pipeTo(name, dest) {
    let r;
    try { r = this._range(name); } catch (e) { return Promise.reject(e); }
    const { e, start, end } = r;
    return new Promise((resolve, reject) => {
      const done = (err) => (err ? reject(err) : resolve(e.uncompSize));
      dest.on('error', done);
      dest.on('finish', () => done(null));
      if (e.compSize === 0) { dest.end(); return undefined; }
      if (e.method !== 0 && e.method !== 8) return done(new Error(`不支持的压缩方式 ${e.method}: ${name}`));
      const src = fs.createReadStream(null, {
        fd: this.fd, autoClose: false, start, end: Math.max(start, end),
      });
      src.on('error', done);
      if (e.method === 0) return src.pipe(dest);
      const inflater = zlib.createInflateRaw();
      inflater.on('error', done);
      return src.pipe(inflater).pipe(dest);
    });
  }
}

module.exports = { ZipArchive, ZipFile };
