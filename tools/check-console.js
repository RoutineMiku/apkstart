'use strict';
/**
 * 黑窗验证：按主进程的方式拉起 emulator，检查「命令栏黑窗」是否被窗口代理压住。
 *
 * 只靠代码推断不可靠 —— 控制台窗口属于 conhost.exe，pid 和 emulator 完全对不上，
 * 必须真的枚举一次可见窗口才算数。
 *
 * 用法: node tools/check-console.js [appRoot]
 */
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

const INSTALL = process.argv[2] || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'apkstart');
const EMU = path.join(INSTALL, 'resources', 'runtime', 'emulator', 'emulator.exe');
const AVD_HOME = path.join(process.env.APPDATA || '', 'apkstart', 'avd');
const ROOT = path.join(INSTALL, 'resources', 'runtime');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const agent = new WinAgent();
  await agent.ensure();
  await agent.scope([ROOT]);
  console.log('agent ready, port=', agent.port);

  const list = async () => {
    const r = await agent.call({ cmd: 'consoles' }, 4000);
    return (r && r.list) || [];
  };

  const before = await list();
  console.log('启动前可见控制台窗口:', JSON.stringify(before));

  // 与主进程完全一致：detached + windowsHide + pipe
  const proc = spawn(EMU, [
    '-avd', 'apkstart', '-port', '5554', '-no-boot-anim', '-no-metrics',
    '-crash-report-mode', 'disabled', '-gpu', 'swangle', '-memory', '3072',
    '-cores', '3', '-no-skin', '-snapshot', 'apkstart',
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

  let sawConsole = 0;
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    const l = await list();
    const ours = l.filter((w) => w.ours);
    if (ours.length > sawConsole) {
      sawConsole = ours.length;
      console.log(`[${(i + 1) * 0.5}s] 出现黑窗:`, JSON.stringify(ours));
    }
  }
  const afterSpawn = (await list()).filter((w) => w.ours);
  console.log('未压制时仍在画面上的黑窗:', JSON.stringify(afterSpawn));

  console.log('--- 打开 bootHide ---');
  const r = await agent.bootHide();
  console.log('bootHide:', JSON.stringify(r));
  await sleep(1500);
  const afterHide = (await list()).filter((w) => w.ours);
  console.log('压制后剩余黑窗:', JSON.stringify(afterHide));

  console.log('');
  console.log(afterHide.length === 0
    ? `结果：通过（启动过程中出现过 ${sawConsole} 个黑窗，压制后全部不可见）`
    : '结果：失败（仍有可见黑窗）');

  try { proc.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  process.exit(afterHide.length === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
