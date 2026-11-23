'use strict';
/**
 * 本机体检 / 自动配置的纯逻辑测试：不需要 Electron、不需要模拟器、不真的改系统。
 *
 * 守两件事：
 *   1. 结论必须和人话一致（BIOS 没开就说 BIOS，商店版不能自己提权就只给入口）；
 *   2. 自动配置只写「安全」的设置项，生成的驱动必须能过驱动校验。
 *
 * 运行：node test/preflight-test.js
 */
const assert = require('assert/strict');
const path = require('path');

const preflight = require('../src/core/preflight');
const drivers = require('../src/core/drivers');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const hwBase = () => ({
  platform: 'win32',
  arch: 'x64',
  osBuild: 22631,
  cpu: {
    name: 'AMD Ryzen 7 7840HS', cores: 8, threads: 16,
    vtSupported: true, vtFirmware: true, slat: true,
  },
  memory: { totalMB: 32768, freeMB: 8192 },
  gpu: {
    name: 'AMD Radeon 780M', vendor: 'amd', vramMB: 2048,
    driverVersion: '31.0.12027.9001', driverDate: '2024-05-01', status: 'OK',
  },
  virtualization: {
    hypervisorPresent: true,
    hypervisorPlatform: 'enabled',
    vmPlatform: 'enabled',
    hyperV: 'disabled',
    winHvApi: true,
    vmCompute: true,
    aehdInstalled: false,
    accelOk: true,
    accelKind: 'whpx',
  },
});

const clone = (o) => JSON.parse(JSON.stringify(o));

(() => {
  console.log('\n[体检 · 资源推荐]');

  test('32GB / 16 线程：给 8GB + 4 核', () => {
    const r = preflight.recommendResources({ totalMB: 32768, cores: 16, accelOk: true, vramMB: 2048 });
    assert.equal(r.memoryMB, 8192);
    assert.equal(r.cores, 4);
    assert.equal(r.renderSize, 'auto');
  });

  test('8GB / 4 线程：给 3GB + 2 核，且不超过宿主一半', () => {
    const r = preflight.recommendResources({ totalMB: 8192, cores: 4, accelOk: true, vramMB: 1024 });
    assert.equal(r.memoryMB, 3072);
    assert.equal(r.cores, 2);
    assert.ok(r.memoryMB <= 8192 / 2);
  });

  test('4GB 内存也只给 2GB，不会把 Windows 挤爆', () => {
    const r = preflight.recommendResources({ totalMB: 4096, cores: 4, accelOk: false, vramMB: 256 });
    assert.equal(r.memoryMB, 2048);
    assert.equal(r.renderSize, '540x960', '没有加速时应该降分辨率');
  });

  test('没有加速 → 540p；小显存也 → 540p', () => {
    assert.equal(preflight.recommendResources({ totalMB: 16384, cores: 8, accelOk: false, vramMB: 4096 }).renderSize, '540x960');
    assert.equal(preflight.recommendResources({ totalMB: 16384, cores: 8, accelOk: true, vramMB: 256 }).renderSize, '540x960');
  });

  console.log('\n[体检 · 渲染后端建议]');

  test('没有加速一律 software（先保证能出画面）', () => {
    assert.equal(preflight.recommendGpu({ vendor: 'nvidia', accelOk: false, vramMB: 8192 }).gpuMode, 'software');
  });

  test('NVIDIA/AMD/Intel + 加速 → host（独显/核显都用上硬件渲染）', () => {
    assert.equal(preflight.recommendGpu({ vendor: 'nvidia', accelOk: true, vramMB: 8192 }).gpuMode, 'host');
    assert.equal(preflight.recommendGpu({ vendor: 'amd', accelOk: true, vramMB: 2048 }).gpuMode, 'host');
    assert.equal(preflight.recommendGpu({ vendor: 'intel', accelOk: true, vramMB: 2048 }).gpuMode, 'host');
  });

  test('核显共享内存报显存 0，不该被误判成弱显卡降到 swangle', () => {
    assert.equal(preflight.recommendGpu({ vendor: 'intel', accelOk: true, vramMB: 0 }).gpuMode, 'host');
  });

  test('显存真的小（<512MB）才降到 swangle', () => {
    assert.equal(preflight.recommendGpu({ vendor: 'amd', accelOk: true, vramMB: 256 }).gpuMode, 'swangle');
  });

  test('显卡型号读不到时不乱猜，交回 auto', () => {
    assert.equal(preflight.recommendGpu({ vendor: 'unknown', accelOk: true, vramMB: 0 }).gpuMode, 'auto');
  });

  console.log('\n[体检 · 场景判断]');

  test('一切正常：level=good，建议 host（用上独显/核显），不强制 TCG', () => {
    const r = preflight.evaluate({ hw: hwBase(), settings: {} });
    assert.equal(r.level, 'good', r.summary);
    assert.equal(r.patch.engine.forceTcg, false);
    assert.equal(r.patch.engine.gpuMode, 'auto');
    assert.equal(r.recommended.gpuMode, 'host');
  });

  test('BIOS 虚拟化没开：判 bad，只给「进 BIOS」的手动指引，不假装能一键', () => {
    const hw = hwBase();
    hw.cpu.vtFirmware = false;
    hw.virtualization.accelOk = false;
    hw.virtualization.accelKind = 'none';
    const r = preflight.evaluate({ hw });
    assert.equal(r.level, 'bad');
    const item = r.items.find((i) => i.key === 'vt-bios-off');
    assert.ok(item, '缺少 BIOS 提示');
    assert.equal(item.action.kind, 'manual');
    assert.equal(r.patch.engine.forceTcg, true, 'BIOS 没开时应该锁软件模拟');
  });

  test('CPU 不支持虚拟化：说明只能软件模拟，不给开 BIOS 的指引', () => {
    const hw = hwBase();
    hw.cpu.vtSupported = false;
    hw.virtualization.accelOk = false;
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'vt-unsupported'));
    assert.ok(!r.items.some((i) => i.key === 'vt-bios-off'));
  });

  test('Windows 功能没开 + 安装版：给「一键开启（需管理员）」', () => {
    const hw = hwBase();
    hw.virtualization.hypervisorPlatform = 'disabled';
    hw.virtualization.accelOk = false;
    const r = preflight.evaluate({ hw, edition: 'installer' });
    const item = r.items.find((i) => i.key === 'whpx-off');
    assert.ok(item);
    assert.equal(item.action.kind, 'elevate');
    assert.equal(item.action.id, 'virtualization');
    assert.ok(/Enable Now/.test(item.action.label));
  });

  test('商店版不能自行提权：同一个问题只打开「Windows 功能」窗口', () => {
    const hw = hwBase();
    hw.virtualization.hypervisorPlatform = 'disabled';
    hw.virtualization.accelOk = false;
    const r = preflight.evaluate({ hw, edition: 'store' });
    const item = r.items.find((i) => i.key === 'whpx-off');
    assert.equal(item.action.kind, 'elevate');
    assert.ok(/Windows Features/.test(item.action.label), item.action.label);
    assert.ok(!/Enable Now/.test(item.action.label));
  });

  test('没有加速 + 安装版：额外提供「安装 AEHD」入口', () => {
    const hw = hwBase();
    hw.virtualization.accelOk = false;
    hw.virtualization.hypervisorPlatform = 'disabled';
    const r = preflight.evaluate({ hw, edition: 'installer' });
    const accel = r.items.find((i) => i.key === 'accel-off');
    assert.equal(accel.action.id, 'accel');
  });

  test('Hyper-V 接管 VT 时 WMI 报 false 也不能误判「不支持」', () => {
    const hw = hwBase();
    hw.cpu.vtSupported = 'unknown';
    hw.cpu.vtFirmware = true;
    hw.cpu.slat = 'unknown';
    hw.virtualization.accelOk = true;
    const r = preflight.evaluate({ hw });
    assert.equal(r.level, 'good', r.summary);
    assert.ok(!r.items.some((i) => i.key === 'vt-unsupported'));
  });

  test('显存读不到 / 显卡未知：给 warn 但不出致命结论', () => {
    const hw = hwBase();
    hw.gpu = { name: '', vendor: 'unknown', vramMB: 0, driverVersion: '', driverDate: '', status: '' };
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'gpu-unknown'));
    assert.equal(r.level, 'warn');
  });

  test('驱动太旧会提醒更新（黑屏常见原因）', () => {
    const hw = hwBase();
    hw.gpu.driverDate = '2019-03-01';
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'gpu-driver-old'));
  });

  test('内存小 / 系统太旧都会单独提示', () => {
    const hw = hwBase();
    hw.memory.totalMB = 4096;
    hw.osBuild = 18363;
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'mem-low'));
    assert.ok(r.items.some((i) => i.key === 'os-old'));
  });

  console.log('\n[体检 · 自动配置的边界]');

  test('自动配置只写安全设置项（不会碰数据分区 / 分辨率模式等）', () => {
    const r = preflight.evaluate({ hw: hwBase() });
    assert.deepEqual(Object.keys(r.patch.engine).sort(),
      ['autoMemory', 'cores', 'forceTcg', 'gpuMode', 'memoryMB', 'renderSize'].sort());
  });

  test('自动生成的驱动能通过校验，且 match 绑定这台机器', () => {
    const r = preflight.evaluate({ hw: hwBase() });
    const v = drivers.validateDriver(r.driver);
    assert.equal(v.ok, true, v.errors.join('；'));
    assert.deepEqual(v.driver.match.gpuVendor, ['amd']);
    assert.equal(v.driver.effect.gpuMode, 'host', '生成的驱动应锁定 host 用上显卡，不再强制软件渲染');
    assert.equal(v.driver.effect.forceTcg, null, '有加速时不该写 forceTcg');
  });

  test('没有加速时生成的驱动会锁软件模拟', () => {
    const hw = hwBase();
    hw.virtualization.accelOk = false;
    hw.virtualization.accelKind = 'none';
    const r = preflight.evaluate({ hw });
    const v = drivers.validateDriver(r.driver);
    assert.equal(v.ok, true, v.errors.join('；'));
    assert.equal(v.driver.effect.forceTcg, true);
    assert.equal(v.driver.effect.gpuMode, 'software');
  });

  test('探测失败也要能给结论（未知 ≠ 崩溃）', () => {
    const r = preflight.evaluate({ hw: { platform: 'win32' } });
    assert.ok(['warn', 'bad'].includes(r.level));
    assert.ok(r.items.length >= 3);
    assert.equal(typeof r.summary, 'string');
  });

  test('collect() 是异步的（不阻塞界面）', () => {
    assert.equal(preflight.collect.constructor.name, 'AsyncFunction');
  });

  test('评估是纯函数：同样的输入必须得到同样的配置', () => {
    const a = preflight.evaluate({ hw: {}, settings: {} });
    const b = preflight.evaluate({ hw: {}, settings: {} });
    assert.deepEqual(a.patch, b.patch);
    assert.deepEqual(a.driver, b.driver);
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();
