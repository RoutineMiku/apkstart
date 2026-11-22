'use strict';
/**
 * resources.arsc 资源 ID 解析的生产链路 fixture 测试。
 *
 * 运行：node test/arsc-fixture-test.js
 *
 * 夹具：test/fixtures/arsc-minimal/arsc-minimal.apk（合成，非 SDK 编译产物，
 * 由 test/lib/make-arsc-apk.js 确定性生成；生成命令与 SHA256 见同目录 README.md）。
 *
 * 覆盖：
 *   1) 夹具字节可被 make-arsc-apk.js 逐字节重放，SHA256 固定；
 *   2) parseApk 走真实 ZIP + AXML + ResTable，label/icon 都来自清单里的资源 ID；
 *   3) 直接解析清单，确认 label/icon 是 TYPE_REFERENCE；
 *   4) 直接解析 resources.arsc，确认 package/type/entry 结构；
 *   5) 三组负例（ARSC 值错位、清单 ID 互换、缺失 resources.arsc）必须被
 *      与正例相同的校验器判为失败 —— 负例若“通过”，本测试非零退出。
 *
 * 可用 ARSC_FIXTURE_PATH 指向另一份夹具来验证「缺失/被改坏的夹具必须非零退出」。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { parseApk } = require('../src/core/apk');
const { ResTable } = require('../src/core/arsc');
const { parseAxml, attr } = require('../src/core/axml');
const { ZipFile } = require('../src/core/zip');
const {
  PACKAGE_NAME, VERSION_CODE, VERSION_NAME,
  LABEL_REF, ICON_REF, LABEL_TEXT, ICON_PATH, DECOY_PATH,
  buildArscApkBytes,
} = require('./lib/make-arsc-apk');

const FIXTURE = process.env.ARSC_FIXTURE_PATH
  ? path.resolve(process.env.ARSC_FIXTURE_PATH)
  : path.join(__dirname, 'fixtures', 'arsc-minimal', 'arsc-minimal.apk');

// 改动夹具或生成器时，用 README 里的 --write 命令重新生成并更新这两个常量。
const FIXTURE_SHA256 = 'b5cf42da75a85a30d64fbd5da26474a592136abd0c326a9cfed800a37d16fd06';
const ICON_SHA256 = '0c34ba5629c3745681dd94834b808f8b96e775c81169b00e44d4c72ea6252797';
const DECOY_SHA256 = '744c77e6d9e441ec446e7f72aad692a4d3d64cc6616b83de5c43cade9682146f';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${e && e.message ? e.message : e}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}：期望 ${b}，实际 ${a}`);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 与生产 parseApk 输出绑定的严格校验器。正例要求 violations 为空；
 * 负例要求 violations 明确包含资源 ID 解析相关的失败。
 */
function inspectApk(filePath) {
  const apk = parseApk(filePath);
  const violations = [];
  const push = (code, expected, actual) => violations.push({ code, expected, actual });

  if (apk.package !== PACKAGE_NAME) push('package', PACKAGE_NAME, apk.package);
  if (apk.versionName !== VERSION_NAME) push('versionName', VERSION_NAME, apk.versionName);
  if (apk.versionCode !== VERSION_CODE) push('versionCode', VERSION_CODE, apk.versionCode);
  if (apk.minSdk !== 21) push('minSdk', 21, apk.minSdk);
  if (apk.targetSdk !== 34) push('targetSdk', 34, apk.targetSdk);
  if (apk.launchActivity !== `${PACKAGE_NAME}.Main`) {
    push('launchActivity', `${PACKAGE_NAME}.Main`, apk.launchActivity);
  }
  if (apk.label !== LABEL_TEXT) push('label', LABEL_TEXT, apk.label);
  if (apk.iconFile !== ICON_PATH) push('icon-file', ICON_PATH, apk.iconFile);
  const iconSha = apk.iconPng ? sha256(apk.iconPng) : null;
  if (iconSha !== ICON_SHA256) push('icon-bytes', ICON_SHA256, iconSha);
  return { apk, violations };
}

function writeTemp(dir, name, bytes) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-arsc-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

assert(fs.existsSync(FIXTURE), `夹具缺失：${FIXTURE}（必须失败，不能跳过）`);
const fixtureBytes = fs.readFileSync(FIXTURE);

console.log('\n[arsc-minimal fixture：字节与可重放性]');
test('夹具 SHA256 固定', () => {
  assertEq(sha256(fixtureBytes), FIXTURE_SHA256, 'fixture sha256');
});

test('生成器可逐字节重放夹具', () => {
  const rebuilt = buildArscApkBytes();
  assert(rebuilt.equals(fixtureBytes), `重放字节不一致：生成 ${rebuilt.length}B / 夹具 ${fixtureBytes.length}B`);
});

test('夹具是真实 ZIP，含清单与非空 resources.arsc', () => {
  const zip = new ZipFile(FIXTURE);
  try {
    assert(zip.has('AndroidManifest.xml'), '缺少 AndroidManifest.xml');
    assert(zip.has('resources.arsc'), '缺少 resources.arsc');
    const arsc = zip.read('resources.arsc');
    assert(arsc.length > 100, `resources.arsc 过小：${arsc.length}B`);
    assertEq(arsc.readUInt32LE(8), 1, 'ResTable packageCount');
    assert(zip.has(ICON_PATH), `缺少图标 ${ICON_PATH}`);
    assert(zip.has(DECOY_PATH), `缺少 decoy ${DECOY_PATH}`);
  } finally {
    zip.close();
  }
});

console.log('\n[生产 parseApk：资源 ID -> label / icon]');
test('parseApk 解析 package/version/launcher', () => {
  const { apk, violations } = inspectApk(FIXTURE);
  assertEq(violations, [], 'violations');
  assertEq(apk.package, PACKAGE_NAME, 'package');
  assertEq(apk.versionName, VERSION_NAME, 'versionName');
  assertEq(apk.versionCode, VERSION_CODE, 'versionCode');
  assertEq(apk.launchActivity, `${PACKAGE_NAME}.Main`, 'launchActivity');
});

test('label 来自 ARSC 字符串资源而非包名兜底', () => {
  const { apk } = inspectApk(FIXTURE);
  assertEq(apk.label, LABEL_TEXT, 'label');
  // 兜底路径会得到 "Arscfixture"；命中它说明资源 ID 没解析成功。
  assert(apk.label !== 'Arscfixture', 'label 落到了包名兜底值');
});

test('icon 来自清单引用的资源 ID，而非 ZIP 兜底里更大的 decoy', () => {
  const { apk } = inspectApk(FIXTURE);
  assertEq(apk.iconFile, ICON_PATH, 'iconFile');
  assert(apk.iconPng && apk.iconPng.length > 100, 'iconPng 为空');
  assertEq(sha256(apk.iconPng), ICON_SHA256, 'icon sha256');
  assert(sha256(apk.iconPng) !== DECOY_SHA256, 'icon 取到了 decoy');
  assert(apk.iconFile !== DECOY_PATH, 'iconFile 取到了 decoy');
});

console.log('\n[直接解析 AXML 清单]');
test('label/icon 是 TYPE_REFERENCE，ID 与声明一致', () => {
  const zip = new ZipFile(FIXTURE);
  let manifest;
  try { manifest = parseAxml(zip.read('AndroidManifest.xml')); } finally { zip.close(); }
  const app = manifest.children.find((c) => c.name === 'application');
  assert(app, '清单缺少 application');
  const label = attr(app, 'label');
  const icon = attr(app, 'icon');
  assert(label && icon, '清单缺少 label/icon 属性');
  assertEq(label.dataType, 0x01, 'label dataType');
  assertEq(icon.dataType, 0x01, 'icon dataType');
  assertEq(label.refId >>> 0, LABEL_REF, 'label refId');
  assertEq(icon.refId >>> 0, ICON_REF, 'icon refId');
  assertEq(label.typed, null, 'label typed（引用不应有字面量）');
});

console.log('\n[直接解析 resources.arsc]');
test('package/type/entry 结构与解析结果', () => {
  const zip = new ZipFile(FIXTURE);
  let table;
  try { table = new ResTable(zip.read('resources.arsc')); } finally { zip.close(); }

  assertEq(table.packages.length, 1, 'package 数');
  const pkg = table.packages[0];
  assertEq(pkg.id, 0x7f, 'package id');
  assertEq(pkg.typeStrings, ['string', 'mipmap'], 'typeStrings');
  assertEq(pkg.keyStrings, ['app_name', 'ic_launcher'], 'keyStrings');

  const labelChunks = pkg.types.get(1);
  const iconChunks = pkg.types.get(2);
  assert(labelChunks && iconChunks, '缺少 type 1/2 的 chunk');
  assertEq(labelChunks.length, 1, 'type 1 chunk 数');
  assertEq(iconChunks.length, 1, 'type 2 chunk 数');
  assertEq([...labelChunks[0].entries.keys()], [0], 'type 1 entry 下标');
  assertEq([...iconChunks[0].entries.keys()], [0], 'type 2 entry 下标');
  assertEq(labelChunks[0].entries.get(0), { dataType: 0x03, data: 0 }, 'type 1 entry 值');
  assertEq(iconChunks[0].entries.get(0), { dataType: 0x03, data: 1 }, 'type 2 entry 值');

  assertEq(table.resolve(LABEL_REF, 'string'), LABEL_TEXT, 'resolve label');
  assertEq(table.resolve(ICON_REF, 'file'), ICON_PATH, 'resolve icon');
});

console.log('\n[负例：资源 ID 解析错误必须被判失败]');
test('负例 A：ARSC 内 label 值错位到 icon 字符串', () => {
  withTempDir((dir) => {
    const p = writeTemp(dir, 'bad-label-value.apk', buildArscApkBytes({ labelValueIndex: 1 }));
    const { apk, violations } = inspectApk(p);
    const codes = violations.map((v) => v.code);
    assert(codes.includes('label'), `未识别 label 错位：${JSON.stringify(violations)}`);
    assertEq(apk.label, ICON_PATH, '错位后 label 实际值');
  });
});

test('负例 B：清单 label/icon 资源 ID 互换', () => {
  withTempDir((dir) => {
    const p = writeTemp(dir, 'swapped-refs.apk', buildArscApkBytes({ labelRef: ICON_REF, iconRef: LABEL_REF }));
    const { apk, violations } = inspectApk(p);
    const codes = violations.map((v) => v.code);
    assert(codes.includes('label'), `未识别 label 引用错误：${JSON.stringify(violations)}`);
    assert(codes.includes('icon-file'), `未识别 icon 引用错误：${JSON.stringify(violations)}`);
    assertEq(apk.label, ICON_PATH, '互换后 label 实际值');
    assertEq(apk.iconFile, DECOY_PATH, '互换后 icon 落到 ZIP 兜底 decoy');
  });
});

test('负例 C：缺失 resources.arsc（必须失败而非跳过）', () => {
  withTempDir((dir) => {
    const p = writeTemp(dir, 'no-arsc.apk', buildArscApkBytes({ includeArsc: false }));
    const { apk, violations } = inspectApk(p);
    const codes = violations.map((v) => v.code);
    assert(codes.includes('label'), `未识别缺失 ARSC 的 label 兜底：${JSON.stringify(violations)}`);
    assert(codes.includes('icon-file'), `未识别缺失 ARSC 的 icon 兜底：${JSON.stringify(violations)}`);
    assertEq(apk.label, 'Arscfixture', '缺失 ARSC 时 label 兜底值');
    assertEq(apk.iconFile, DECOY_PATH, '缺失 ARSC 时 icon 走 ZIP 兜底');
  });
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exitCode = failed ? 1 : 0;
