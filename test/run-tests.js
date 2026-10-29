'use strict';
/**
 * 纯 Node 单元测试（不依赖 Electron / adb / 网络）
 * 运行：npm test
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

console.log('\n[zip.js]');
const { ZipArchive } = require('../src/core/zip');
test('能解析自身所在项目的 package.json 压缩包结构', () => {
  // 用一个内存里构造的最小 zip（stored 模式）验证解析
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8); // stored
  const name = Buffer.from('hello.txt');
  const data = Buffer.from('hello apkstart');
  header.writeUInt16LE(name.length, 26);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 14);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(0, 8);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(0, 42); // local offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12); // 中央目录总大小
  eocd.writeUInt32LE(30 + name.length + data.length, 16); // 中央目录偏移

  const zip = new ZipArchive(Buffer.concat([header, name, data, cen, name, eocd]));
  assert(zip.has('hello.txt'), '应能找到 hello.txt');
  assert(zip.read('hello.txt').toString() === 'hello apkstart', '内容应一致');
});

console.log('\n[png.js]');
const { encodePng, drawAppIcon } = require('../src/core/png');
test('PNG 编码器输出合法签名与 IHDR', () => {
  const rgba = new Uint8Array(16 * 16 * 4).fill(128);
  const png = encodePng(16, 16, rgba);
  assert(png[0] === 0x89 && png[1] === 0x50, 'PNG 签名');
  assert(png.toString('ascii', 12, 16) === 'IHDR', 'IHDR chunk');
  assert(png.length > 50, '长度合理');
});
test('应用图标可按任意尺寸绘制', () => {
  for (const s of [16, 32, 64, 256]) {
    const png = drawAppIcon(s);
    const w = png.readUInt32BE(16);
    assert(w === s, `宽度应为 ${s}，实际 ${w}`);
  }
});

console.log('\n[axml.js + arsc.js + apk.js]');
const { parseAxml } = require('../src/core/axml');
const { ResTable } = require('../src/core/arsc');
const { parseApk, quickCheck } = require('../src/core/apk');

// 测试夹具：优先用环境变量 APKSTART_TEST_APK 指定，
// 否则尝试常见的本机 APK 位置（只读，不复制）
function findFixture() {
  const candidates = [
    process.env.APKSTART_TEST_APK,
    path.join(__dirname, 'fixtures', 'sample.apk'),
  ];
  try {
    const dl = path.join(process.env.USERPROFILE || '', 'Documents');
    for (const f of fs.readdirSync(dl)) {
      if (/\.apk$/i.test(f)) candidates.push(path.join(dl, f));
    }
  } catch (_) { /* ignore */ }
  return candidates.find((c) => c && fs.existsSync(c));
}

const fixture = findFixture();
if (fixture) {
  console.log(`  （夹具：${fixture}）`);
  test('quickCheck 识别 PK 头', () => {
    assert(quickCheck(fixture) === true);
  });
  const meta = parseApk(fixture);
  test('解析出包名 / 版本 / 启动 Activity', () => {
    assert(/^[\w.]+$/.test(meta.package), `包名异常: ${meta.package}`);
    assert(meta.versionName, '缺少 versionName');
    assert(meta.launchActivity && /\./.test(meta.launchActivity),
      `启动 Activity 异常: ${meta.launchActivity}`);
  });
  test('解析出可用图标', () => {
    assert(meta.iconPng && meta.iconPng.length > 100, '图标为空或过小');
    assert(meta.label, '应用名为空');
    console.log(`    ↳ ${meta.label} (${meta.package}) v${meta.versionName}`);
  });
  test('AXML 根节点是 manifest', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    const root = parseAxml(zip.read('AndroidManifest.xml'));
    assert(root.name === 'manifest');
  });
  test('resources.arsc 可解析', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    if (zip.has('resources.arsc')) {
      const res = new ResTable(zip.read('resources.arsc'));
      assert(res.packages.length > 0, '应至少有一个 package');
    }
  });
} else {
  console.log('  （跳过：未找到 APK 夹具，可设置 APKSTART_TEST_APK）');
}

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
