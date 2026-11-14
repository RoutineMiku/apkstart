'use strict';
/**
 * 极简 ZIP 读取器（仅依赖 Node 内置 zlib）
 * 只解析中央目录，按需解压单个条目，避免大 APK 全量解压撑爆内存。
 *
 * 注意：本文件只做「读」，不做「写」。两处「大小」相关的不变量：
 *  - 单个 Buffer 有上限（Node 约 2GB），所以 GB 级条目一律走 ZipFile + pipeTo；
 *  - ZIP 的传统 EOCD 用 16/32 位存条目数与偏移，超过就进位成 0xffff/0xffffffff，
 *    真正的值在 Zip64 EOCD（0x06064b50）与 Zip64 扩展字段（id=0x0001）里。
 *    两条路径都必须识别，否则大镜像包会被「静默截断条目」或直接越界。
 */
const zlib = require('zlib');
const fs = require('fs');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOC_SIG = 0x07064b50;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
// read() 单条目上限：超过就要求调用方走 pipeTo（流式），避免整块进内存
const MAX_READ = 256 * 1024 * 1024;

/** 把 BigInt 偏移安全地转成 Number（ZIP 不可能大过 2^53 字节） */
function toNum(v) { return typeof v === 'bigint' ? Number(v) : v; }

/**
 * 解析 Zip64 扩展字段（0x0001），补全中央目录里被置成 0xffffffff 的字段。
 * 字段顺序固定：未压缩大小、压缩大小、本地头偏移、起始磁盘号；只出现「被置位」的那些。
 * @param {Buffer} extra 中央目录项的扩展字段
 * @param {{uncompSize:number, compSize:number, localOffset:number}} fields
 */
function applyZip64Extra(extra, fields) {
  if (!extra || extra.length < 4) return fields;
  let off = 0;
  while (off + 4 <= extra.length) {
    const id = extra.readUInt16LE(off);
    const len = extra.readUInt16LE(off + 2);
    const dataStart = off + 4;
    const dataEnd = dataStart + len;
    if (dataEnd > extra.length) break;
    if (id === 0x0001) {
      let p = dataStart;
      const take64 = () => {
        if (p + 8 > dataEnd) return null;
        const v = toNum(extra.readBigUInt64LE(p));
        p += 8;
        return v;
      };
      if (fields.uncompSize === MAX32) { const v = take64(); if (v !== null) fields.uncompSize = v; }
      if (fields.compSize === MAX32) { const v = take64(); if (v !== null) fields.compSize = v; }
      if (fields.localOffset === MAX32) { const v = take64(); if (v !== null) fields.localOffset = v; }
      break;
    }
    off = dataEnd;
  }
  return fields;
}

/**
 * 从 EOCD 位置解出条目数 / 中央目录大小 / 中央目录偏移，自动跟进 Zip64。
 * @param {Buffer} buf 包含 EOCD 的缓冲区
 * @param {number} eocd EOCD 在 buf 内的下标
 * @param {number} base buf[0] 对应的文件绝对偏移（ZipFile 的尾部窗口用）
 * @returns {{total:number, cdSize:number, cdOffset:number, eocdAbs:number}}
 */
function readEndOfCentralDirectory(buf, eocd, base) {
  let total = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const eocdAbs = base + eocd;

  const needsZip64 = total === MAX16 || cdSize === MAX32 || cdOffset === MAX32;
  if (!needsZip64) return { total, cdSize, cdOffset, eocdAbs };

  // Zip64 EOCD locator 固定紧挨在 EOCD 前面 20 字节
  const loc = eocd - 20;
  if (loc < 0) return { total, cdSize, cdOffset, eocdAbs };
  if (buf.readUInt32LE(loc) !== ZIP64_LOC_SIG) return { total, cdSize, cdOffset, eocdAbs };
  const z64Abs = toNum(buf.readBigUInt64LE(loc + 8));
  const z64 = z64Abs - base;
  if (z64 < 0 || z64 + 56 > buf.length) return { total, cdSize, cdOffset, eocdAbs };
  if (buf.readUInt32LE(z64) !== ZIP64_EOCD_SIG) return { total, cdSize, cdOffset, eocdAbs };

  total = toNum(buf.readBigUInt64LE(z64 + 32));
  cdSize = toNum(buf.readBigUInt64LE(z64 + 40));
  cdOffset = toNum(buf.readBigUInt64LE(z64 + 48));
  return { total, cdSize, cdOffset, eocdAbs };
}

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

    const { total, cdOffset } = readEndOfCentralDirectory(buf, eocd, 0);
    let offset = cdOffset;

    for (let i = 0; i < total; i++) {
      if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CEN_SIG) break;
      const flags = buf.readUInt16LE(offset + 8);
      const method = buf.readUInt16LE(offset + 10);
      const nameLen = buf.readUInt16LE(offset + 28);
      const extraLen = buf.readUInt16LE(offset + 30);
      const commentLen = buf.readUInt16LE(offset + 32);
      const nameEnd = offset + 46 + nameLen;
      if (nameEnd > buf.length) break;
      const fields = applyZip64Extra(
        buf.subarray(nameEnd, nameEnd + extraLen),
        {
          uncompSize: buf.readUInt32LE(offset + 24),
          compSize: buf.readUInt32LE(offset + 20),
          localOffset: buf.readUInt32LE(offset + 42),
        },
      );
      const name = buf.toString('utf8', offset + 46, nameEnd);
      this.entries.set(name, {
        name, flags, method,
        compSize: fields.compSize,
        uncompSize: fields.uncompSize,
        localOffset: fields.localOffset,
      });
      offset = nameEnd + extraLen + commentLen;
    }
  }

  has(name) { return this.entries.has(name); }

  names() { return [...this.entries.keys()]; }

  read(name) {
    const e = this.entries.get(name);
    if (!e) return null;
    const buf = this.buf;
    if (e.localOffset + 30 > buf.length) throw new Error(`本地文件头越界: ${name}`);
    if (buf.readUInt32LE(e.localOffset) !== LOC_SIG) {
      throw new Error(`本地文件头损坏: ${name}`);
    }
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    if (start + e.compSize > buf.length) throw new Error(`条目数据越界: ${name}`);
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
    const n = Math.max(0, Math.min(len, this.size - pos));
    const b = Buffer.alloc(n);
    if (n > 0) {
      let got = 0;
      while (got < n) {
        // readSync 可能短读（尤其大块），必须循环到读满
        const r = fs.readSync(this.fd, b, got, n - got, pos + got);
        if (r <= 0) break;
        got += r;
      }
    }
    return b;
  }

  _parse() {
    if (this.size < 22) throw new Error('不是有效的 ZIP/APK 文件（文件过小）');
    const tailLen = Math.min(this.size, 22 + 65557 + 4096);
    const tailBase = this.size - tailLen;
    const tail = this._readAt(tailBase, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP/APK 文件（未找到 EOCD）');

    const { total, cdSize, cdOffset, eocdAbs } = readEndOfCentralDirectory(tail, eocd, tailBase);
    if (cdOffset + cdSize > this.size) {
      throw new Error('ZIP 中央目录偏移异常');
    }

    let cd = tail;
    let cdBase = tailBase;
    if (cdOffset < tailBase || cdOffset + cdSize > eocdAbs) {
      // 中央目录不在尾部缓冲里（超大注释 / 多分卷），按声明大小精确读一段
      const len = Math.min(cdSize, 256 * 1024 * 1024);
      if (len <= 0) throw new Error('ZIP 中央目录偏移异常');
      cd = this._readAt(cdOffset, len);
      cdBase = cdOffset;
    }

    let off = cdOffset - cdBase;
    for (let i = 0; i < total; i += 1) {
      if (off + 46 > cd.length || cd.readUInt32LE(off) !== CEN_SIG) break;
      const flags = cd.readUInt16LE(off + 8);
      const method = cd.readUInt16LE(off + 10);
      const nameLen = cd.readUInt16LE(off + 28);
      const extraLen = cd.readUInt16LE(off + 30);
      const commentLen = cd.readUInt16LE(off + 32);
      const nameEnd = off + 46 + nameLen;
      if (nameEnd > cd.length) break;
      const fields = applyZip64Extra(
        cd.subarray(nameEnd, nameEnd + extraLen),
        {
          uncompSize: cd.readUInt32LE(off + 24),
          compSize: cd.readUInt32LE(off + 20),
          localOffset: cd.readUInt32LE(off + 42),
        },
      );
      const name = cd.toString('utf8', off + 46, nameEnd);
      this.entries.set(name, {
        name, flags, method,
        compSize: fields.compSize,
        uncompSize: fields.uncompSize,
        localOffset: fields.localOffset,
      });
      off = nameEnd + extraLen + commentLen;
    }
  }

  has(name) { return this.entries.has(name); }
  names() { return [...this.entries.keys()]; }
  find(re) { return this.names().filter((n) => re.test(n)); }

  _range(name) {
    const e = this.entries.get(name);
    if (!e) throw new Error(`条目不存在: ${name}`);
    const head = this._readAt(e.localOffset, 30);
    if (head.length < 30 || head.readUInt32LE(0) !== LOC_SIG) throw new Error(`本地文件头损坏: ${name}`);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    return { e, start, end: start + e.compSize - 1 };
  }

  read(name) {
    const { e, start } = this._range(name);
    // read() 会把整个条目解到内存：给一个明确上限，避免未来某个调用点顺手
    // 拿来读 GB 级镜像（那正是 issue #21 里「大包必炸」的形态）。
    if (e.compSize > MAX_READ) {
      throw new Error(`条目过大（${(e.compSize / 1048576).toFixed(0)}MB），请改用 pipeTo: ${name}`);
    }
    const raw = this._readAt(start, e.compSize);
    if (raw.length < e.compSize) throw new Error(`条目数据被截断: ${name}`);
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
