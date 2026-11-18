'use strict';
// 断言里比对的是中文原文：固定界面语言，不随本机系统语言变化
require('../src/i18n').setLang('zh');
/**
 * 开机授权 / 安装校验的纯 Node 测试（不需要真实模拟器、不需要网络）。
 *
 * 覆盖 0.5.3 两个真实故障的根因修复：
 *  1) 快照在「允许 USB 调试」对话框未确认时拍下 → 每次恢复都 device unauthorized →
 *     探测干等 240s×4 还被误诊成显卡问题。修复：识别 unauthorized、作废旧快照冷启动、
 *     健康时才存快照。
 *  2) PackageManager 报 installed=true，但 /data/app 文件已被快照/数据不一致弄丢 →
 *     am start 失败。修复：isInstalled 逐个核对 APK 文件真实存在。
 *
 * 运行：node test/boot-auth-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  AdbClient, parseDeviceState, isUnauthorizedError, parsePmPaths,
} = require('../src/core/adb');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const adbDevices = (line) => `List of devices attached\n${line}\n`;

(async () => {
  console.log('\n[adb 设备状态解析]');
  test('unauthorized 与 authorized 必须能区分（get-state 分不清）', () => {
    assert.equal(parseDeviceState(adbDevices('emulator-5554\tunauthorized'), 'emulator-5554'), 'unauthorized');
    assert.equal(parseDeviceState(adbDevices('emulator-5554\tdevice'), 'emulator-5554'), 'device');
  });
  test('offline / no permissions / 无设备都要如实回报', () => {
    assert.equal(parseDeviceState(adbDevices('emulator-5554\toffline'), 'emulator-5554'), 'offline');
    assert.equal(parseDeviceState(adbDevices('emulator-5554\tno permissions'), 'emulator-5554'), 'unauthorized');
    assert.equal(parseDeviceState(adbDevices(''), 'emulator-5554'), 'no-device');
  });
  test('只认本 serial 的状态行，不被别的设备干扰', () => {
    const out = adbDevices('emulator-5556\tdevice\nemulator-5554\tunauthorized');
    assert.equal(parseDeviceState(out, 'emulator-5554'), 'unauthorized');
  });
  test('报错文本命中 unauthorized（含官方 ADB_VENDOR_KEYS 提示）', () => {
    assert.equal(isUnauthorizedError('error: device unauthorized.'), true);
    assert.equal(isUnauthorizedError("This adb server's $ADB_VENDOR_KEYS is not set. error: device unauthorized"), true);
    assert.equal(isUnauthorizedError('error: device offline'), false);
    assert.equal(isUnauthorizedError('error: no devices/emulators found'), false);
  });

  console.log('\n[pm path 解析 + 文件真实性校验]');
  test('pm path 多分片（split APK）要全部解析出来', () => {
    const out = 'package:/data/app/~~x/com.foo-1/base.apk\npackage:/data/app/~~x/com.foo-1/split_arm64.apk\n';
    assert.deepEqual(parsePmPaths(out), [
      '/data/app/~~x/com.foo-1/base.apk',
      '/data/app/~~x/com.foo-1/split_arm64.apk',
    ]);
  });
  test('pm path 空输出 = 未安装', () => {
    assert.deepEqual(parsePmPaths(''), []);
    assert.deepEqual(parsePmPaths('Error: package not found'), []);
  });

  await atest('PM 说已装但 APK 文件没了 → isInstalled 返回 false', async () => {
    const c = Object.create(AdbClient.prototype);
    c.shell = async (cmd) => {
      if (cmd.startsWith('pm path')) return 'package:/data/app/~~x/com.foo-1/base.apk';
      // 文件校验命令：文件丢了，没有 PRESENT 回显
      return '';
    };
    assert.equal(await c.isInstalled('com.foo'), false);
  });
  await atest('APK 文件真实存在 → isInstalled 返回 true', async () => {
    const c = Object.create(AdbClient.prototype);
    c.shell = async (cmd) => {
      if (cmd.startsWith('pm path')) return 'package:/data/app/~~x/com.foo-1/base.apk';
      return '__APKSTART_PRESENT__';
    };
    assert.equal(await c.isInstalled('com.foo'), true);
  });
  await atest('多分片有一个丢失 → 判定未安装（启动不了）', async () => {
    const c = Object.create(AdbClient.prototype);
    const seen = [];
    c.shell = async (cmd) => {
      if (cmd.startsWith('pm path')) {
        return 'package:/data/app/~~x/com.foo/base.apk\npackage:/data/app/~~x/com.foo/split.apk';
      }
      seen.push(cmd);
      return ''; // 两个 [ -s ] 都失败
    };
    assert.equal(await c.isInstalled('com.foo'), false);
    assert.ok(seen.some((s) => s.includes('/data/app/~~x/com.foo/split.apk')), '校验命令要覆盖每个分片');
  });

  console.log('\n[快照保存守卫]');
  await atest('adb unauthorized → 不存快照', async () => {
    const emu = Object.create(require('../src/core/emulator').EmulatorEngine.prototype);
    emu.port = 5554; // serial 是 getter：emulator-${port}
    emu._log = [];   // log() 会往里 push
    emu._adbGuestHealthy = async () => false;
    const ok = await emu._saveViaAdb('adb');
    assert.equal(ok, false, '不健康时不允许保存');
  });
  await atest('源码级：快照保存路径必须先过健康守卫', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'emulator.js'), 'utf8');
    const fn = src.slice(src.indexOf('async _saveViaAdb('), src.indexOf('async _saveViaAdb(') + 700);
    assert.ok(/_adbGuestHealthy/.test(fn), '_saveViaAdb 必须先判 guest 健康');
    const stopFn = src.slice(src.indexOf('async stop('), src.indexOf('async stop(') + 2400);
    assert.ok(/_adbGuestHealthy/.test(stopFn), 'stop() 关机前也要判断健康');
    assert.ok(/invalidateSnapshot\(\)/.test(stopFn), '不健康关机要作废快照');
  });
  await atest('源码级：开机探测要识别 unauthorized 并冷启动自愈', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'engine.js'), 'utf8');
    const boot = src.slice(src.indexOf('async bootEmulator('), src.indexOf('async bootEmulator(') + 4200);
    assert.ok(/isUnauthorizedError/.test(boot), '探测要按报错文本识别 unauthorized');
    assert.ok(/deviceState\(\)/.test(boot), '探测要按 devices state 列二次确认');
    assert.ok(/invalidateSnapshot\(\)/.test(boot), '命中授权卡住要作废旧快照');
    assert.ok(/_coldBoot = true/.test(boot), '要强制冷启动以重新注入 adb 公钥');
    assert.ok(/ADB_UNAUTHORIZED/.test(boot), '要给出准确诊断，不再误导成显卡问题');
  });
  await atest('adb server 注入 ADB_VENDOR_KEYS 以对齐 host/guest 密钥', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'adb.js'), 'utf8');
    assert.ok(/ADB_VENDOR_KEYS/.test(src), '必须显式指定 adb 公钥目录');
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('  异常：', e.stack || e.message);
  process.exit(1);
});
