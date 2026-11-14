'use strict';
/**
 * 测试用「合成 APK」构造器（只给 test/ 用，不进产品代码）。
 *
 * 为什么需要它：真实 APK 夹具体积大、不便随仓库分发，缺失时 axml.js / apk.js
 * 在 CI 上等于零覆盖。这里用几十行字节拼出一个**合法的**二进制 AXML 清单 +
 * 最小 ZIP，让解析栈永远有可跑的用例。
 *
 * 生成的内容：
 *   <manifest package="com.example.test" android:versionCode="7" android:versionName="1.2.3">
 *     <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34"/>
 *     <application android:label="TestApp" android:icon="res/mipmap-hdpi/ic_launcher.png">
 *       <activity android:name=".Main">
 *         <intent-filter><action android:name="android.intent.action.MAIN"/>
 *           <category android:name="android.intent.category.LAUNCHER"/></intent-filter>
 *       </activity>
 *     </application>
 *   </manifest>
 */
const { drawAppIcon } = require('../../src/core/png');

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; }

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
  const chunkSize = stringsStart + bodyLen;
  const head = Buffer.concat([
    u16(0x0001), u16(28), u32(chunkSize),
    u32(strings.length), u32(0), u32(0),
    u32(stringsStart), u32(0),
  ]);
  return Buffer.concat([head, ...offsets.map(u32), ...data]);
}

function axmlChunk(type, headerSize, body) {
  return Buffer.concat([u16(type), u16(headerSize), u32(8 + body.length), body]);
}

/** attrs: [{ ns?, name, type?=0x03, data }] */
function axmlStartElement(nameIdx, attrs) {
  const attrBufs = attrs.map((a) => Buffer.concat([
    u32(a.ns === undefined ? 0xffffffff : a.ns),
    u32(a.name),
    u32(0xffffffff),
    // typedValue: size(2) res0(1) dataType(1) data(4)
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

/** 生成 AndroidManifest.xml 的二进制 AXML */
function buildManifestAxml() {
  const S = [
    'manifest', 'package', 'com.example.test', 'android', ANDROID_NS,
    'versionCode', 'versionName', '1.2.3',
    'uses-sdk', 'minSdkVersion', 'targetSdkVersion',
    'application', 'label', 'TestApp', 'icon', 'res/mipmap-hdpi/ic_launcher.png',
    'activity', 'name', '.Main',
    'intent-filter', 'action', 'android.intent.action.MAIN',
    'category', 'android.intent.category.LAUNCHER',
  ];
  const idx = Object.fromEntries(S.map((s, i) => [s, i]));
  const ns = idx[ANDROID_NS];
  const pool = buildStringPool(S);
  const chunks = [
    axmlChunk(0x0100, 16, Buffer.concat([u32(0), u32(0), u32(idx.android), u32(ns)])),
    axmlStartElement(idx.manifest, [
      { ns: 0xffffffff, name: idx.package, data: idx['com.example.test'], type: 0x03 },
      { ns, name: idx.versionCode, data: 7, type: 0x10 },
      { ns, name: idx.versionName, data: idx['1.2.3'], type: 0x03 },
    ]),
    axmlStartElement(idx['uses-sdk'], [
      { ns, name: idx.minSdkVersion, data: 21, type: 0x10 },
      { ns, name: idx.targetSdkVersion, data: 34, type: 0x10 },
    ]),
    axmlEndElement(0xffffffff, idx['uses-sdk']),
    axmlStartElement(idx.application, [
      { ns, name: idx.label, data: idx.TestApp, type: 0x03 },
      { ns, name: idx.icon, data: idx['res/mipmap-hdpi/ic_launcher.png'], type: 0x03 },
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
  const all = Buffer.concat([pool, ...chunks]);
  return Buffer.concat([u16(0x0003), u16(8), u32(8 + all.length), all]);
}

/** 最小 ZIP（stored，无压缩） */
function buildStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const it of entries) {
    const name = Buffer.from(it.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(it.data.length, 14);
    lh.writeUInt32LE(it.data.length, 18);
    lh.writeUInt32LE(it.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, it.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(it.data.length, 20);
    ch.writeUInt32LE(it.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
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

/** 一个可直接被 parseApk 解析的最小 APK 的字节 */
function buildApkBytes() {
  const png = drawAppIcon(96);
  return buildStoredZip([
    { name: 'AndroidManifest.xml', data: buildManifestAxml() },
    { name: 'res/mipmap-hdpi/ic_launcher.png', data: png },
    { name: 'lib/arm64-v8a/libtest.so', data: Buffer.from('ELF-fake') },
    { name: 'classes.dex', data: Buffer.from('dex\n035\0') },
  ]);
}

module.exports = {
  ANDROID_NS,
  buildManifestAxml,
  buildStoredZip,
  buildApkBytes,
};
