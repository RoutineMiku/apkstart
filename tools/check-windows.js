'use strict';
/**
 * 窗口验证：按主进程的方式拉起 emulator，确认「桌面上一个多余窗口都不出现」。
 *
 * 要盯的是两类窗口：
 *   1. "Android Emulator - apkstart5554"（QWindowIcon，模拟器主窗）
 *      —— 正常应该只在 embed 之后作为我们窗口的子窗口出现，桌面上永远看不到；
 *   2. 控制台黑窗（conhost 的 ConsoleWindowClass / CASCADIA_HOSTING_WINDOW_CLASS）
 *      —— qemu、netsimd 各会弹一个，标题是被启动的 exe 路径。
 *
 * 用法: node tools/check-windows.js [runtimeRoot]
 *   runtimeRoot 默认取仓库里的 engine/（本地下载的运行时），也可以传安装目录的
 *   resources/runtime。
 */
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'engine'));
const EMU = path.join(ROOT, 'emulator', 'emulator.exe');
const AVD_HOME = path.join(process.env.APPDATA || '', 'apkstart', 'avd');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

(async () => {
  const agent = new WinAgent();
  await agent.ensure();
  console.log('agent ready, port=', agent.port);

  const windows = async () => {
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    return (r && r.list) || [];
  };

  await agent.bootHide();
  console.log('常驻压制已开启');

  const proc = spawn(EMU, [
    '-avd', 'apkstart', '-port', '5554', '-no-boot-anim', '-no-metrics',
    '-crash-report-mode', 'disabled', '-gpu', 'swangle', '-memory', '3072',
    '-cores', '3', '-no-skin', '-snapshot', 'apkstart', '-no-snapshot-load',
  ], {
    cwd: path.dirname(EMU),
    env: {
      ...process.env,
      ANDROID_SDK_ROOT: ROOT, ANDROID_HOME: ROOT,
      ANDROID_AVD_HOME: AVD_HOME, ANDROID_EMULATOR_HOME: AVD_HOME,
      ANDROID_ADB_SERVER_PORT: '5044',
    },
    windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.unref();
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', () => {});

  let leaked = 0;
  const ticks = Math.max(24, Number(process.env.CHECK_SECONDS || 0) * 2 || 24);
  for (let i = 0; i < ticks; i += 1) {
    await sleep(500);
    const list = await windows();
    const hit = list.filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] 可见的异常窗口:`, JSON.stringify(hit));
    }
  }

  const probe = await agent.probe().catch(() => null);
  console.log('probe（隐藏窗口也应当能被找到）:', JSON.stringify(probe));

  const left = (await windows()).filter(bad);
  console.log('结束时仍在桌面上的异常窗口:', JSON.stringify(left));

  const okProbe = !!(probe && Number(probe.emu) !== 0);
  // 允许「出现过但 400ms 内被压掉」的情况，最终必须为 0
  const ok = left.length === 0 && okProbe;
  console.log('');
  console.log(`结果：${ok ? '通过' : '失败'}（过程中可见异常窗口累计 ${leaked} 次，结束时 ${left.length} 个）`);

  try { proc.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
