'use strict';
/**
 * 真实引导测试（默认可跳过，`npm run test:boot` 手动跑）
 *
 * 用 61MB 的 Alpine virt ISO 走一遍产品的真实启动参数：
 *   创建 qcow2 虚拟磁盘 → 以光驱引导 → 从串口确认进入用户态 → 优雅关机
 *
 * 目的：引擎层最容易出错的是「参数看起来对，但真机起不来」（machine 类型、accel、
 * 启动顺序、virtio 磁盘、ACPI 关机）。这里用真实 QEMU + 真实 guest 把它钉死。
 * 不需要 Android 镜像，也不需要硬件加速。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// 隔离数据目录：绝不能把测试用的镜像/磁盘路径写进真实用户设置
process.env.APPDATA = path.join(os.tmpdir(), `apkstart-boot-test-${Date.now()}`);
fs.mkdirSync(path.join(process.env.APPDATA, 'apkstart'), { recursive: true });

const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');
const { downloadParallel } = require('../src/core/download');

const ISO_URL = 'https://mirrors.tuna.tsinghua.edu.cn/alpine/v3.20/releases/x86_64/alpine-virt-3.20.3-x86_64.iso';
const WORK = path.join(os.tmpdir(), 'apkstart-boot');
const ISO = path.join(WORK, 'alpine-virt.iso');
const DISK = path.join(WORK, 'boot-test.qcow2');
const SERIAL = path.join(WORK, 'serial.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`  ${m}`);

async function ensureIso() {
  if (fs.existsSync(ISO) && fs.statSync(ISO).size > 50 * 1024 * 1024) return;
  fs.mkdirSync(WORK, { recursive: true });
  log('下载 Alpine virt ISO（约 61MB）…');
  await downloadParallel(ISO_URL, ISO, { connections: 8, minChunk: 4 * 1024 * 1024 });
}

(async () => {
  console.log('\n[真实引导测试]');
  const runtime = new Runtime(path.join(__dirname, '..'));
  const env = await runtime.provisioner.checkEnv();
  if (!env.qemu.ok) {
    console.error('  跳过：未安装 QEMU');
    process.exit(0);
  }
  log(`QEMU ${env.qemu.version} · ${env.qemu.path}`);

  await ensureIso();
  log(`ISO ${(fs.statSync(ISO).size / 1048576).toFixed(0)}MB`);

  // 1) qemu-img 建盘（同时验证产品的 createDisk 工具链）
  const img = path.join(path.dirname(env.qemu.path), 'qemu-img.exe');
  try { fs.rmSync(DISK, { force: true }); } catch (_) { /* ignore */ }
  const { execFileSync } = require('child_process');
  execFileSync(img, ['create', '-f', 'qcow2', DISK, '2G'], { windowsHide: true });
  log(`虚拟磁盘 ${(fs.statSync(DISK).size / 1024).toFixed(0)}KB（稀疏）`);

  // 2) 用产品真实的启动参数
  runtime._hv = env.hypervisor;
  store.saveSettings({
    runtime: { isoPath: ISO, diskPath: DISK },
    engine: { memoryMB: 1024, cores: 2 },
  });
  const args = runtime.buildArgs({ install: true, headless: true });
  args.push('-serial', `file:${SERIAL}`, '-no-reboot');
  try { fs.rmSync(SERIAL, { force: true }); } catch (_) { /* ignore */ }

  log(`启动：${args.filter((a) => !a.includes('=')).slice(0, 8).join(' ')} …`);
  const proc = spawn(env.qemu.path, args, { stdio: 'ignore', windowsHide: true });
  let exited = false;
  proc.on('exit', () => { exited = true; });

  // 3) 等 guest 进入用户态（串口出现登录提示即为引导成功）
  const start = Date.now();
  let booted = false;
  while (Date.now() - start < 180000) {
    if (exited) break;
    if (fs.existsSync(SERIAL)) {
      const txt = fs.readFileSync(SERIAL, 'latin1');
      if (/login:/i.test(txt)) { booted = true; break; }
    }
    await sleep(2000);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  if (!booted) {
    const tail = fs.existsSync(SERIAL) ? fs.readFileSync(SERIAL, 'latin1').slice(-600) : '(无串口输出)';
    console.error(`  ✗ 引导失败（${elapsed}s）：\n${tail}`);
    try { proc.kill(); } catch (_) { /* ignore */ }
    process.exit(1);
  }
  log(`✓ guest 已进入用户态（${elapsed}s）`);

  // 4) 优雅关机：先 system_powerdown，超时再 quit（正是产品 stop() 的行为）
  let graceful = false;
  try {
    await runtime.monitorCmd('system_powerdown');
    for (let i = 0; i < 20; i++) {
      if (exited) { graceful = true; break; }
      await sleep(500);
    }
    if (!exited) {
      log('guest 未响应 ACPI 关机，改用 quit（产品同样会这样兜底）…');
      await runtime.monitorCmd('quit');
      for (let i = 0; i < 10; i++) {
        if (exited) break;
        await sleep(300);
      }
    }
  } catch (e) {
    log(`monitor 异常：${e.message}`);
  }
  if (!exited) { try { proc.kill(); } catch (_) { /* ignore */ } }
  log(exited ? `✓ 虚拟机关闭（${graceful ? 'ACPI 优雅关机' : 'quit 兜底'}）` : '✗ 虚拟机关闭失败');

  try { fs.rmSync(DISK, { force: true }); } catch (_) { /* ignore */ }
  console.log(`\n结果：${exited ? '通过' : '失败'}\n`);
  process.exit(exited ? 0 : 1);
})().catch((e) => {
  console.error('  异常：', e.message);
  process.exit(1);
});
