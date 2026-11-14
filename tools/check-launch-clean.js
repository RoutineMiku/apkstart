'use strict';
/**
 * 端到端验证「安卓应用打开只有安卓应用窗口」：
 *   1) 用沙盒 APPDATA 起真实 ApkStart，`--apk` 安装一个测试 APK（会拉起模拟器）；
 *   2) 再 `--launch <包名>` 打开应用；
 *   3) 全程枚举可见顶层窗口：模拟器主窗（Android Emulator - …）与 qemu / netsimd
 *      的控制台窗口都不允许出现；应用窗口必须出现（说明 embed 成功、画面在窗口里）。
 *
 * 用法: node tools/check-launch-clean.js [apkPath]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

const ROOT = path.join(__dirname, '..');
// 与另两个窗口测试一样支持外部指定运行时/数据目录（用户的运行时常常在 D 盘）
const ENGINE = path.resolve(process.env.APKSTART_RUNTIME || path.join(ROOT, 'engine'));
const AVD_DIR = process.env.APKSTART_AVD_HOME || '';
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const APK = process.argv[2] || path.join(os.tmpdir(), 'fdroid.apk');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

function launch(args, sandbox) {
  const env = { ...process.env, APPDATA: sandbox };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(ELECTRON, ['.', ...args], {
    cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  return p;
}

(async () => {
  if (!fs.existsSync(APK)) throw new Error(`找不到测试 APK: ${APK}`);
  const sandbox = path.join(os.tmpdir(), `apk-launch-${Date.now()}`);
  const appData = path.join(sandbox, 'apkstart');
  fs.mkdirSync(appData, { recursive: true });
  fs.writeFileSync(path.join(appData, 'settings.json'), JSON.stringify({
    runtime: { dir: ENGINE, avdDir: AVD_DIR }, engine: { prewarm: true },
  }));

  const agent = new WinAgent();
  await agent.ensure();
  await agent.scope([ENGINE]);

  let pass = true;
  const check = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) pass = false; };

  // ---- 1) 安装 ----
  console.log('— 安装 APK（首次要冷启动模拟器，约 40~90 秒）…');
  let p = launch(['--apk', APK], sandbox);
  let pkg = '';
  for (let i = 0; i < 240; i += 1) {
    await sleep(1000);
    try {
      const apps = JSON.parse(fs.readFileSync(path.join(appData, 'apps.json'), 'utf8')).apps || [];
      if (apps.length && apps[0].package) { pkg = apps[0].package; break; }
    } catch (_) { /* 还没写出来 */ }
    if (p.exitCode !== null) break;
  }
  check(!!pkg, `安装完成：${pkg || '（超时）'}`);
  // 必须等第一个实例**真正退出**再起第二个：单实例锁还在的话，第二个会立刻退出，
  // 表现为「窗口一直不出现」，而不是启动失败（实测踩过，排查了很久）。
  try { p.kill(); } catch (_) { /* ignore */ }
  for (let i = 0; i < 30 && p.exitCode === null; i += 1) await sleep(500);
  await sleep(2000);

  if (!pkg) {
    agent.dispose();
    console.log('\n结果：失败（没有装出应用，后续跳过）');
    process.exit(1);
  }

  // ---- 2) 打开应用 ----
  console.log('— 打开应用…');
  p = launch(['--launch', pkg], sandbox);
  let leaked = 0;
  let sawAppWin = false;
  const titles = new Set();
  // 冷启动 23s + 应用拉起 ~17s，留足 120 秒；之前 60 秒在慢机器上会假失败
  for (let i = 0; i < 240; i += 1) {
    await sleep(500);
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    const list = ((r && r.list) || []);
    for (const w of list) if (w.title) titles.add(w.title);
    const hit = list.filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] 可见的异常窗口:`, JSON.stringify(hit));
    }
    // 应用窗口 = 一个有标题、不是模拟器/控制台的普通窗口
    if (!sawAppWin) {
      sawAppWin = list.some((w) => {
        const t = String(w.title || '');
        return t && !bad(w) && !/ApkStart|WorkBuddy|Microsoft|Program Manager|设置|Edge|输入体验/.test(t);
      });
      if (sawAppWin) console.log(`[${((i + 1) * 0.5).toFixed(1)}s] 应用窗口已出现`);
    }
    if (sawAppWin && i > 40) break;
  }

  check(leaked === 0, `模拟器/控制台窗口始终不可见（累计 ${leaked} 次）`);
  check(sawAppWin, `应用窗口已出现（说明画面被嵌进窗口，而不是独立的模拟器窗口）`);
  console.log('  可见窗口标题：', JSON.stringify([...titles].slice(0, 12)));
  if (!pass) {
    console.log('--- app.log 末尾 ---');
    try {
      const log = fs.readFileSync(path.join(appData, 'logs', 'app.log'), 'utf8').trim().split('\n');
      console.log(log.slice(-12).join('\n'));
    } catch (_) { console.log('（没有 app.log）'); }
  }

  try { p.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  await sleep(1500);
  if (pass) {
    try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* ignore */ }
  } else {
    console.log(`  沙盒保留在：${sandbox}`);
  }
  console.log('');
  console.log(`结果：${pass ? '通过' : '失败'}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
