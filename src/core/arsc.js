'use strict';
/**
 * resources.arsc 解析器（精简版）
 * 用途：把 AndroidManifest 里的 @0x7f... 资源引用还原成
 *       应用名（字符串）和图标文件路径（res/... 下的 png）。
 *
 * 只解析 ResTable / ResTable_package / ResTable_type 三层结构，
 * 足以覆盖 99% 的应用名与图标场景。
 */

const RES_TABLE_TYPE = 0x0002;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;
const RES_TABLE_TYPE_SPEC_TYPE = 0x0202;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;

function readStringPool(buf, start) {
  const headerSize = buf.readUInt16LE(start + 2);
  const count = buf.readUInt32LE(start + 8);
  const flags = buf.readUInt32LE(start + 16);
  const stringsStart = buf.readUInt32LE(start + 20);
  const isUtf8 = (flags & 0x100) !== 0;
  const base = start + stringsStart;
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    let p = base + buf.readUInt32LE(start + headerSize + i * 4);
    if (isUtf8) {
      let len = buf[p++];
      if (len & 0x80) { len = ((len & 0x7f) << 8) | buf[p++]; }
      let byteLen = buf[p++];
      if (byteLen & 0x80) { byteLen = ((byteLen & 0x7f) << 8) | buf[p++]; }
      out[i] = buf.toString('utf8', p, p + byteLen);
    } else {
      let len = buf.readUInt16LE(p); p += 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p); p += 2; }
      out[i] = buf.toString('utf16le', p, p + len * 2);
    }
  }
  return out;
}

function parseConfig(buf, off) {
  const size = buf.readUInt32LE(off);
  const cfg = { size, density: 0, language: '', country: '', sdkVersion: 0, isDefault: true };
  if (size >= 16) {
    const lang = buf.toString('latin1', off + 8, off + 10).replace(/\0/g, '').trim();
    const country = buf.toString('latin1', off + 10, off + 12).replace(/\0/g, '').trim();
    cfg.language = lang;
    cfg.country = country;
  }
  if (size >= 16) cfg.density = buf.readUInt16LE(off + 14);
  if (size >= 28) cfg.sdkVersion = buf.readUInt16LE(off + 24);
  if (size >= 29) cfg.uiMode = buf.readUInt8(off + 29);
  cfg.isDefault = !cfg.language && !cfg.country && cfg.density === 0 && !cfg.sdkVersion;
  return cfg;
}

/** 为不同用途的取值打分：字符串偏好默认配置，图片偏好高密度 */
function score(cfg, prefer) {
  let s = 0;
  if (prefer === 'file') {
    s += cfg.density === 0 ? 0 : cfg.density;          // 高密度优先
    if (cfg.density === 0xfffe) s -= 500;               // anydpi 可能是 xml，扣分
  } else {
    s -= cfg.density === 0 ? 0 : 10;                    // 字符串：无密度优先
    if (cfg.language) s -= 40;
    if (cfg.sdkVersion) s -= cfg.sdkVersion / 1000;
    if (cfg.uiMode) s -= 20;
  }
  return s;
}

class ResTable {
  constructor(buffer) {
    this.buf = buffer;
    this.globalStrings = [];
    this.packages = [];
    this._parse();
  }

  _parse() {
    const buf = this.buf;
    if (buf.readUInt16LE(0) !== RES_TABLE_TYPE) throw new Error('resources.arsc 格式错误');
    const headerSize = buf.readUInt16LE(2);
    const total = buf.readUInt32LE(4);
    const pkgCount = buf.readUInt32LE(8);

    let pos = headerSize;
    while (pos < total && pos < buf.length) {
      const type = buf.readUInt16LE(pos);
      const chunkSize = buf.readUInt32LE(pos + 4);
      if (chunkSize <= 0) break;
      if (type === RES_STRING_POOL_TYPE && this.globalStrings.length === 0) {
        this.globalStrings = readStringPool(buf, pos);
      } else if (type === RES_TABLE_PACKAGE_TYPE) {
        this.packages.push(this._parsePackage(pos, chunkSize));
      }
      pos += chunkSize;
    }
  }

  _parsePackage(start, size) {
    const buf = this.buf;
    const id = buf.readUInt32LE(start + 8);
    const typeStringsOff = buf.readUInt32LE(start + 268);
    const keyStringsOff = buf.readUInt32LE(start + 276);
    const headerSize = buf.readUInt16LE(start + 2);

    let typeStrings = [];
    let keyStrings = [];
    try {
      if (typeStringsOff) typeStrings = readStringPool(buf, start + typeStringsOff);
      if (keyStringsOff) keyStrings = readStringPool(buf, start + keyStringsOff);
    } catch (_) { /* 容错：缺字符串池不影响主流程 */ }

    const types = new Map(); // typeId -> [{ config, entries: Map }]
    let pos = start + headerSize;
    const end = start + size;
    while (pos + 8 <= end) {
      const type = buf.readUInt16LE(pos);
      const chunkSize = buf.readUInt32LE(pos + 4);
      if (chunkSize <= 0) break;
      if (type === RES_TABLE_TYPE_TYPE) {
        const t = this._parseType(pos);
        if (t) {
          if (!types.has(t.id)) types.set(t.id, []);
          types.get(t.id).push(t);
        }
      }
      pos += chunkSize;
    }
    return { id, typeStrings, keyStrings, types };
  }

  _parseType(start) {
    const buf = this.buf;
    const headerSize = buf.readUInt16LE(start + 2);
    const id = buf.readUInt8(start + 8);
    const flags = buf.readUInt8(start + 9);
    const entryCount = buf.readUInt32LE(start + 12);
    const entriesStart = buf.readUInt32LE(start + 16);
    const cfg = parseConfig(buf, start + 20);

    const entries = new Map();
    const offsetsBase = start + headerSize;
    const entriesBase = start + entriesStart;

    if (flags & 0x01) {
      // FLAG_SPARSE：entryCount 个 (idx:u16, offset:u16)
      for (let i = 0; i < entryCount; i++) {
        const idx = buf.readUInt16LE(offsetsBase + i * 4);
        const off = buf.readUInt16LE(offsetsBase + i * 4 + 2) * 4;
        const v = this._readValue(entriesBase + off);
        if (v) entries.set(idx, v);
      }
    } else if (flags & 0x02) {
      // FLAG_OFFSET16
      for (let i = 0; i < entryCount; i++) {
        const off = buf.readUInt16LE(offsetsBase + i * 2);
        if (off === 0xffff) continue;
        const v = this._readValue(entriesBase + off * 4);
        if (v) entries.set(i, v);
      }
    } else {
      for (let i = 0; i < entryCount; i++) {
        const off = buf.readUInt32LE(offsetsBase + i * 4);
        if (off === 0xffffffff) continue;
        const v = this._readValue(entriesBase + off);
        if (v) entries.set(i, v);
      }
    }
    return { id, config: cfg, entries };
  }

  _readValue(at) {
    const buf = this.buf;
    if (at + 8 > buf.length) return null;
    const entrySize = buf.readUInt16LE(at);
    const flags = buf.readUInt16LE(at + 2);
    if (flags & 0x0001) return null; // 复杂资源（bag/map），此处不处理
    const valueAt = at + entrySize;
    return {
      dataType: buf.readUInt8(valueAt + 3),
      data: buf.readUInt32LE(valueAt + 4),
    };
  }

  /**
   * 解析资源引用
   * @param {number} ref 0xPPTTEEEE
   * @param {'string'|'file'|'any'} prefer
   * @param {number} depth
   */
  resolve(ref, prefer = 'any', depth = 0) {
    if (depth > 6 || !ref) return null;
    const pkgId = (ref >>> 24) & 0xff;
    const typeId = (ref >>> 16) & 0xff;
    const entryIdx = ref & 0xffff;

    const pkg = this.packages.find((p) => p.id === pkgId) || this.packages[0];
    if (!pkg) return null;
    const chunks = pkg.types.get(typeId);
    if (!chunks) return null;

    let best = null;
    let bestScore = -Infinity;
    for (const c of chunks) {
      if (!c.entries.has(entryIdx)) continue;
      const s = score(c.config, prefer);
      if (s > bestScore) { bestScore = s; best = c.entries.get(entryIdx); }
    }
    if (!best) return null;

    if (best.dataType === TYPE_STRING) {
      const s = this.globalStrings[best.data];
      return s === undefined ? null : s;
    }
    if (best.dataType === TYPE_REFERENCE) {
      return this.resolve(best.data >>> 0, prefer, depth + 1);
    }
    if (best.dataType === TYPE_INT_BOOLEAN) return best.data !== 0;
    if (best.dataType === TYPE_INT_DEC || best.dataType === TYPE_INT_HEX) return best.data | 0;
    return null;
  }
}

module.exports = { ResTable, TYPE_REFERENCE };
