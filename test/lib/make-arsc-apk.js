'use strict';
/**
 * 确定性「合成 ARSC fixture」构造器（只给 test/ 用，不进产品代码）。
 *
 * 与 make-apk.js 的区别：make-apk 的清单直接用字符串写 label/icon，因此
 * resources.arsc 解析完全没被覆盖。这里构造一个**自包含的合成 APK**：
 *
 *   <manifest package="com.example.arscfixture" android:versionCode="7"
 *             android:versionName="1.2.3">
 *     <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34"/>
 *     <application android:label="@0x7f010000" android:icon="@0x7f020000">
 *       <activity android:name=".Main"> ... MAIN/LAUNCHER ... </activity>
 *     </application>
 *   </manifest>
 *
 *   resources.arsc:
 *     package id 0x7f, name com.example.arscfixture
 *     type 0x01 "string" entry 0 "app_name"   -> "Arsc Fixture App"
 *     type 0x02 "mipmap" entry 0 "ic_launcher" -> "res/mipmap-hdpi/ic_launcher.png"
 *
 * 清单里的 label/icon 是 TYPE_REFERENCE（0x01），只能通过 ResTable 解析；
 * ZIP 里另放一张更大的 decoy PNG（app_icon_decoy.png），这样「图标走的是
 * 资源 ID 还是 ZIP 兜底启发式」在测试里可区分。全部字节由本文件生成，
 * 不是 aapt2/Android SDK 编译产物，也不代表任何第三方 APK。
 *
 * 用法：
 *   node test/lib/make-arsc-apk.js --write test/fixtures/arsc-minimal/arsc-minimal.apk
 *
 * 输出 ZIP 的字段（时间戳等）全为零，Node 20+ 内置 API 下逐字节确定。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { ANDROID_NS } = require('./make-apk');
const { drawAppIcon } = require('../../src/core/png');

const PACKAGE_NAME = 'com.example.arscfixture';
const VERSION_CODE = 7;
const VERSION_NAME = '1.2.3';

const LABEL_REF = 0x7f010000;       // package 0x7f / type 1 (string) / entry 0
const ICON_REF = 0x7f020000;        // package 0x7f / type 2 (mipmap) / entry 0
const LABEL_TEXT = 'Arsc Fixture App';
const ICON_PATH = 'res/mipmap-hdpi/ic_launcher.png';
const DECOY_PATH = 'res/drawable-xxxhdpi/app_icon_decoy.png';

const ICON_SIZE = 96;
const DECOY_SIZE = 256;

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff, 0); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; }

/** UTF-16 字符串池（RES_STRING_POOL_TYPE），与 make-apk.js 的编码一致 */
function buildStringPool(strings) {
  const data = [];
  const offsets = [];
  let off = 0;
  for (const s of strings) {
    offsets.push(off);
    const chars = Buffer.from(s, 'utf16le');
    data.push(u16(s.length), chars, u16(0));
    off += 2 + chars.length + 2;
  }
  const bodyLen = data.reduce((n, b) => n + b.length, 0);
  const stringsStart = 28 + offsets.length * 4;
  const head = Buffer.concat([
    u16(0x0001), u16(28), u32(stringsStart + bodyLen),
    u32(strings.length), u32(0), u32(0),
    u32(stringsStart), u32(0),
  ]);
  return Buffer.concat([head, ...offsets.map(u32), ...data]);
}

function axmlChunk(type, headerSize, body) {
  return Buffer.concat([u16(type), u16(headerSize), u32(8 + body.length), body]);
}

// 基线 make-apk.js 的 buildStoredZip 把条目长度写进了本地头的 CRC 槽，
// 中央目录 CRC 恒为 0（Python zipfile 会判 Bad CRC）。夹具要能独立分发，
// 这里自带 CRC-32 的 stored ZIP 写入器，不复用那个基线缺陷。
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 最小 stored ZIP；CRC-32 与长度在本地头/中央目录一致，无时间戳。 */
function buildStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const it of entries) {
    const name = Buffer.from(it.name, 'utf8');
    const crc = crc32(it.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(it.data.length, 18);
    lh.writeUInt32LE(it.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, it.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(it.data.length, 20);
    ch.writeUInt32LE(it.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(off, 42);
    centrals.push(ch, name);
    off += lh.length + name.length + it.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** attrs: [{ ns?, name, type?=0x03, data }]；type 0x01 = TYPE_REFERENCE */
function axmlStartElement(nameIdx, attrs) {
  const attrBufs = attrs.map((a) => Buffer.concat([
    u32(a.ns === undefined ? 0xffffffff : a.ns),
    u32(a.name),
    u32(0xffffffff), // rawValue：引用必须以 typed value 表达
    u16(8), Buffer.from([0]), Buffer.from([a.type === undefined ? 0x03 : a.type]), u32(a.data),
  ]));
  const ext = Buffer.concat([
    u32(0xffffffff), u32(nameIdx),
    u16(20), u16(20), u16(attrs.length), u16(0), u16(0), u16(0),
  ]);
  return axmlChunk(0x0102, 16, Buffer.concat([u32(0), u32(0), ext, ...attrBufs]));
}

function axmlEndElement(nsIdx, nameIdx) {
  return axmlChunk(0x0103, 16, Buffer.concat([u32(0), u32(0), u32(nsIdx), u32(nameIdx)]));
}

/** 二进制 AndroidManifest.xml；label/icon 为可覆盖的资源 ID 引用 */
function buildManifestAxml(opts = {}) {
  const labelRef = opts.labelRef === undefined ? LABEL_REF : opts.labelRef;
  const iconRef = opts.iconRef === undefined ? ICON_REF : opts.iconRef;
  const S = [
    'manifest', 'package', PACKAGE_NAME, 'android', ANDROID_NS,
    'versionCode', 'versionName', VERSION_NAME,
    'uses-sdk', 'minSdkVersion', 'targetSdkVersion',
    'application', 'label', 'icon',
    'activity', 'name', '.Main',
    'intent-filter', 'action', 'android.intent.action.MAIN',
    'category', 'android.intent.category.LAUNCHER',
  ];
  const idx = Object.fromEntries(S.map((s, i) => [s, i]));
  const ns = idx[ANDROID_NS];
  const chunks = [
    axmlChunk(0x0100, 16, Buffer.concat([u32(0), u32(0), u32(idx.android), u32(ns)])),
    axmlStartElement(idx.manifest, [
      { ns: 0xffffffff, name: idx.package, data: idx[PACKAGE_NAME], type: 0x03 },
      { ns, name: idx.versionCode, data: VERSION_CODE, type: 0x10 },
      { ns, name: idx.versionName, data: idx[VERSION_NAME], type: 0x03 },
    ]),
    axmlStartElement(idx['uses-sdk'], [
      { ns, name: idx.minSdkVersion, data: 21, type: 0x10 },
      { ns, name: idx.targetSdkVersion, data: 34, type: 0x10 },
    ]),
    axmlEndElement(0xffffffff, idx['uses-sdk']),
    axmlStartElement(idx.application, [
      { ns, name: idx.label, data: labelRef, type: 0x01 },
      { ns, name: idx.icon, data: iconRef, type: 0x01 },
    ]),
    axmlStartElement(idx.activity, [{ ns, name: idx.name, data: idx['.Main'], type: 0x03 }]),
    axmlStartElement(idx['intent-filter'], []),
    axmlStartElement(idx.action, [{ ns, name: idx.name, data: idx['android.intent.action.MAIN'], type: 0x03 }]),
    axmlEndElement(0xffffffff, idx.action),
    axmlStartElement(idx.category, [{ ns, name: idx.name, data: idx['android.intent.category.LAUNCHER'], type: 0x03 }]),
    axmlEndElement(0xffffffff, idx.category),
    axmlEndElement(0xffffffff, idx['intent-filter']),
    axmlEndElement(0xffffffff, idx.activity),
    axmlEndElement(0xffffffff, idx.application),
    axmlEndElement(0xffffffff, idx.manifest),
    axmlChunk(0x0101, 16, Buffer.concat([u32(0), u32(0), u32(idx.android), u32(ns)])),
  ];
  const all = Buffer.concat([buildStringPool(S), ...chunks]);
  return Buffer.concat([u16(0x0003), u16(8), u32(8 + all.length), all]);
}

/**
 * 一个 ResTable_type chunk（非 sparse、非 offset16）。
 * @param {number} typeId 1-based
 * @param {number} keyIndex 包 keyStrings 下标
 * @param {number} stringIndex 全局字符串池下标（TYPE_STRING）
 */
function buildTypeChunk(typeId, keyIndex, stringIndex) {
  const config = Buffer.alloc(16);
  config.writeUInt32LE(16, 0); // size：其余字段全零 = 默认配置
  const headerSize = 20 + config.length;
  const entryCount = 1;
  const entriesStart = headerSize + entryCount * 4;

  const entry = Buffer.alloc(8 + 8);
  entry.writeUInt16LE(8, 0);          // ResTable_entry.size
  entry.writeUInt16LE(0, 2);          // flags：非复杂资源
  entry.writeUInt32LE(keyIndex, 4);   // key index
  entry.writeUInt16LE(8, 8);          // Res_value.size
  entry.writeUInt8(0, 10);            // res0
  entry.writeUInt8(0x03, 11);         // TYPE_STRING
  entry.writeUInt32LE(stringIndex, 12);

  const size = entriesStart + entry.length;
  return Buffer.concat([
    u16(0x0201), u16(headerSize), u32(size),
    Buffer.from([typeId, 0]), u16(0),
    u32(entryCount), u32(entriesStart),
    config,
    u32(0), // 唯一 entry 的偏移：entriesStart + 0
    entry,
  ]);
}

/**
 * resources.arsc。labelValueIndex / iconValueIndex 指向全局字符串池，
 * 用于构造「ID 合法但值错位」的负例。
 */
function buildResTable(opts = {}) {
  const labelValueIndex = opts.labelValueIndex === undefined ? 0 : opts.labelValueIndex;
  const iconValueIndex = opts.iconValueIndex === undefined ? 1 : opts.iconValueIndex;

  const globalPool = buildStringPool([LABEL_TEXT, ICON_PATH]);
  const typePool = buildStringPool(['string', 'mipmap']);
  const keyPool = buildStringPool(['app_name', 'ic_launcher']);
  const typeString = buildTypeChunk(1, 0, labelValueIndex);
  const typeIcon = buildTypeChunk(2, 1, iconValueIndex);

  const headerSize = 288; // ResTable_package + typeStrings/keyStrings/typeIdOffset
  const typeStringsOff = headerSize;
  const keyStringsOff = headerSize + typePool.length;
  const size = headerSize + typePool.length + keyPool.length + typeString.length + typeIcon.length;

  const pkg = Buffer.alloc(headerSize);
  pkg.writeUInt16LE(0x0200, 0);
  pkg.writeUInt16LE(headerSize, 2);
  pkg.writeUInt32LE(size, 4);
  pkg.writeUInt32LE(0x7f, 8);
  Buffer.from(PACKAGE_NAME, 'utf16le').copy(pkg, 12); // char16_t name[128]，其余补零
  pkg.writeUInt32LE(typeStringsOff, 268);
  pkg.writeUInt32LE(2, 272); // lastPublicType
  pkg.writeUInt32LE(keyStringsOff, 276);
  pkg.writeUInt32LE(2, 280); // lastPublicKey
  pkg.writeUInt32LE(0, 284); // typeIdOffset

  const tableSize = 12 + globalPool.length + size;
  const tableHead = Buffer.concat([u16(0x0002), u16(12), u32(tableSize), u32(1)]);
  return Buffer.concat([tableHead, globalPool, pkg, typePool, keyPool, typeString, typeIcon]);
}

/**
 * 合成 APK 字节。
 * @param {object} [opts]
 * @param {number} [opts.labelRef] 清单 label 引用（默认 0x7f010000）
 * @param {number} [opts.iconRef] 清单 icon 引用（默认 0x7f020000）
 * @param {number} [opts.labelValueIndex] ARSC 里 label 实际指向的全局字符串
 * @param {number} [opts.iconValueIndex] ARSC 里 icon 实际指向的全局字符串
 * @param {boolean} [opts.includeArsc=true] false = 故意缺失 resources.arsc
 */
function buildArscApkBytes(opts = {}) {
  const includeArsc = opts.includeArsc !== false;
  const entries = [
    { name: 'AndroidManifest.xml', data: buildManifestAxml(opts) },
  ];
  if (includeArsc) entries.push({ name: 'resources.arsc', data: buildResTable(opts) });
  entries.push(
    { name: ICON_PATH, data: drawAppIcon(ICON_SIZE) },
    { name: DECOY_PATH, data: drawAppIcon(DECOY_SIZE) },
    { name: 'classes.dex', data: Buffer.from('dex\n035\0') },
  );
  return buildStoredZip(entries);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

module.exports = {
  PACKAGE_NAME,
  VERSION_CODE,
  VERSION_NAME,
  LABEL_REF,
  ICON_REF,
  LABEL_TEXT,
  ICON_PATH,
  DECOY_PATH,
  ICON_SIZE,
  DECOY_SIZE,
  buildManifestAxml,
  buildResTable,
  buildArscApkBytes,
  sha256,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const wi = args.indexOf('--write');
  if (wi < 0 || !args[wi + 1]) {
    console.error('用法: node test/lib/make-arsc-apk.js --write <output.apk>');
    process.exit(2);
  }
  const out = path.resolve(args[wi + 1]);
  const bytes = buildArscApkBytes();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  console.log(`wrote ${out}`);
  console.log(`bytes ${bytes.length}`);
  console.log(`sha256 ${sha256(bytes)}`);
}
