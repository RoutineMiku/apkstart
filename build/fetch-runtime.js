'use strict';
/**
 * 组装「完整版」内置运行时：
 *   node build/fetch-runtime.js <输出目录>
 * 产出 <输出目录>/runtime/：
 *   emulator/ + platform-tools/ + aehd/ + system-images/android-34/google_apis_playstore/x86_64/
 * 全部通过 Provisioner 的官方通道下载与校验，与在线版完全同源。
 */
const path = require('path');
const fs = require('fs');

const outRoot = path.resolve(process.argv[2] || '');
if (!outRoot) {
  console.error('usage: node build/fetch-runtime.js <output-runtime-dir>');
  process.exit(1);
}
fs.mkdirSync(outRoot, { recursive: true });

// Provisioner 从 settings.runtime.dir 取根目录：
// 把 APPDATA 指到独立目录，避免污染真实用户配置
process.env.APPDATA = path.join(outRoot, '_appdata');
const store = require('../src/core/store');
store.saveSettings({ runtime: { dir: outRoot } });

const { Provisioner } = require('../src/core/provision');
const prov = new Provisioner(path.resolve(__dirname, '..'));

const log = (p) => console.log(`[${p.stage}] ${p.message} ${p.percent != null ? p.percent + '%' : ''}`);

(async () => {
  await prov.installAehd(log);
  await prov.installAdb(log);
  await prov.installEmulator(log);
  await prov.installPlayImage(log);

  const ok =
    fs.existsSync(path.join(outRoot, 'emulator', 'emulator.exe')) &&
    fs.existsSync(path.join(outRoot, 'platform-tools', 'adb.exe')) &&
    fs.existsSync(path.join(outRoot, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'));
  if (!ok) throw new Error('运行时组装后校验失败');

  // 容器式精简：只保留 x86_64 的 QEMU 与无头运行必需的组件。
  // 非 x86_64 的 qemu-system-*.exe（约 400MB）、QtWebEngine、netsim 等对 -no-window 无用。
  const layers = require('../src/core/layers');
  const pruned = layers.prune(outRoot, { apply: true, aggressive: true });
  const before = layers.analyze(outRoot).total + pruned.saved;
  console.log(`slim: ${(pruned.saved / 1048576).toFixed(0)} MB removed, `
    + `${(before / 1073741824).toFixed(2)} GB -> ${(pruned.after / 1073741824).toFixed(2)} GB`);

  fs.rmSync(path.join(outRoot, '_appdata'), { recursive: true, force: true });
  fs.rmSync(path.join(outRoot, '_tmp'), { recursive: true, force: true });
  console.log('runtime-ready:', outRoot);
})().catch((e) => {
  console.error('fetch-runtime failed:', e.message);
  process.exit(1);
});
