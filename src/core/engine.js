'use strict';
/**
 * 运行时引擎：ApkStart 自带的 QEMU + Android-x86 虚拟机
 *
 * 设计原则：
 *  - 默认完全自持（builtin）：adb / QEMU / 系统镜像都由 ApkStart 自己管理，不依赖任何第三方模拟器
 *  - 所有对安卓的操作统一走 adb，因此引擎可替换
 *  - 虚拟机按需启动，空闲自动回收；启动后常驻复用，装/开应用几乎零等待
 */
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { AdbClient } = require('./adb');
const store = require('./store');
const { Provisioner } = require('./provision');

const LOG_DIR = path.join(store.DATA_DIR, 'logs');
const MONITOR_PORT = 5556;

const ATTACH_ENDPOINTS = [
  { name: 'Windows Subsystem for Android', serial: '127.0.0.1:58526' },
  { name: 'LDPlayer', serial: '127.0.0.1:5555' },
  { name: 'MuMu 模拟器', serial: '127.0.0.1:7555' },
  { name: 'Nox 夜神', serial: '127.0.0.1:62001' },
  { name: 'MEmu 逍遥', serial: '127.0.0.1:21503' },
];

class Runtime {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.vmProc = null;
    this.vmStarting = false;
    this.installing = false;
    this.lastActivity = Date.now();
    this._watchdog = null;
    this._freeformReady = false;
    this._client = null;
    this._bootLog = [];
    store.ensureDirs();
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  get settings() { return store.getSettings(); }

  // ---------------- 基础 ----------------

  adbPath() {
    const s = this.settings;
    const p = this.provisioner.paths();
    if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    if (fs.existsSync(p.adbExe)) return p.adbExe;
    const local = path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe');
    if (fs.existsSync(local)) return local;
    return AdbClient.resolveAdb('', this.appRoot);
  }

  client(serial) {
    const useSerial = serial || (this.settings.engine.mode === 'attach' ? this.settings.device : '127.0.0.1:5555');
    const adbPath = this.adbPath();
    if (!this._client || this._client.serial !== useSerial || this._client.adbPath !== adbPath) {
      this._client = new AdbClient({ adbPath, serial: useSerial });
    }
    return this._client;
  }

  touch() { this.lastActivity = Date.now(); }

  log(line) {
    this._bootLog.push({ t: Date.now(), line });
    if (this._bootLog.length > 300) this._bootLog.shift();
  }

  // ---------------- 状态 ----------------

  async status() {
    const env = await this.provisioner.checkEnv();
    const s = this.settings;
    const client = this.client();
    const result = {
      mode: s.engine.mode,
      installed: !!s.runtime.installed,
      env,
      vmRunning: !!(this.vmProc && !this.vmProc.killed),
      vmStarting: this.vmStarting,
      installing: this.installing,
      adbOk: env.adb.ok,
      adbVersion: env.adb.version,
      qemuOk: env.qemu.ok,
      qemuVersion: env.qemu.version,
      deviceOnline: false,
      android: '',
      sdk: 0,
      freeform: false,
      ready: false,
      needsSetup: null,
      error: '',
    };

    if (!env.adb.ok) {
      result.needsSetup = 'adb';
      result.error = '缺少 adb：点击「一键部署」自动下载';
      return result;
    }

    try {
      result.deviceOnline = await client.isOnline();
      if (result.deviceOnline) {
        const [android, sdk, ff] = await Promise.all([
          client.androidVersion().catch(() => ''),
          client.sdkInt().catch(() => 0),
          client.shell('settings get global enable_freeform_support').catch(() => '0'),
        ]);
        result.android = android;
        result.sdk = sdk;
        result.freeform = String(ff).trim() === '1' || this._freeformReady;
      }
    } catch (e) {
      result.error = e.message;
    }

    if (result.deviceOnline) result.ready = true;
    else if (!env.qemu.ok) result.needsSetup = 'qemu';
    else if (!result.installed) result.needsSetup = 'install';

    return result;
  }

  /** 高级模式：探测本机已有运行时（非默认路径） */
  async probe() {
    const adbPath = this.adbPath();
    const one = (ep) => new Promise((resolve) => {
      const c = new AdbClient({ adbPath, serial: ep.serial });
      const timer = setTimeout(() => resolve(null), 4000);
      c.isOnline().then((online) => {
        clearTimeout(timer);
        if (!online && ep.serial.includes(':')) return c.connect().then((ok) => (ok ? ep : null));
        return online ? ep : null;
      }).then(resolve).catch(() => { clearTimeout(timer); resolve(null); });
    });
    const found = await Promise.all(ATTACH_ENDPOINTS.map(one));
    return found.filter(Boolean);
  }

  // ---------------- 启动 / 停止虚拟机 ----------------

  buildArgs({ install = false, headless = false } = {}) {
    const s = this.settings;
    const p = this.provisioner.paths();
    const hv = this._hv || { whpx: false };
    const disk = s.runtime.diskPath || p.disk;
    const iso = s.runtime.isoPath || p.iso;
    const accel = hv.whpx ? 'whpx' : 'tcg';

    const args = [
      '-name', 'ApkStart Runtime',
      '-machine', `q35,accel=${accel}`,
      '-cpu', hv.whpx ? 'host' : 'max',
      '-smp', String(Math.max(2, s.engine.cores || 4)),
      '-m', String(s.engine.memoryMB || 4096),
      '-rtc', 'base=localtime',
      '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:5555-:5555',
      '-device', 'virtio-net-pci,netdev=net0',
      '-vga', 'std',
      '-usb', '-device', 'usb-tablet',
      '-monitor', `tcp:127.0.0.1:${MONITOR_PORT},server,nowait`,
    ];

    if (headless || s.runtime.headless) args.push('-display', 'none');

    if (install) {
      args.push('-boot', 'order=d');
      args.push('-cdrom', iso);
    } else {
      args.push('-boot', 'order=c');
    }
    args.push('-drive', `file=${disk},if=virtio,format=qcow2,cache=writeback`);
    return args;
  }

  async boot({ install = false, onLog = () => {} } = {}) {
    if (this.vmProc && !this.vmProc.killed) return { ok: true, reused: true };
    if (this.vmStarting) {
      const started = Date.now();
      while (this.vmStarting && Date.now() - started < 180000) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
      }
      return { ok: !!(this.vmProc && !this.vmProc.killed), reused: true };
    }

    const env = await this.provisioner.checkEnv();
    this._hv = env.hypervisor;
    if (!env.qemu.ok) throw new Error('未安装 QEMU，请先完成运行时部署');
    if (install && !env.iso.ok) throw new Error('系统镜像（ISO）未就绪');

    const p = this.provisioner.paths();
    const disk = this.settings.runtime.diskPath || p.disk;
    if (!install && !fs.existsSync(disk)) throw new Error('尚未安装 Android 系统到虚拟磁盘');

    this.vmStarting = true;
    const args = this.buildArgs({ install });
    const logFile = path.join(LOG_DIR, install ? 'qemu-install.log' : 'qemu.log');
    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n\n=== ${new Date().toISOString()} ${install ? 'INSTALL' : 'BOOT'} ===\n${env.qemu.path} ${args.join(' ')}\n`);

    onLog(`启动运行时（${env.hypervisor.whpx ? 'WHPX 硬件加速' : '纯软件模拟'}）…`);
    if (!env.hypervisor.whpx) onLog(env.hypervisor.note);

    const proc = spawn(env.qemu.path, args, {
      cwd: path.dirname(env.qemu.path),
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    this.vmProc = proc;
    this.installing = install;
    this.lastActivity = Date.now();

    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      onLog(`启动失败：${e.message}`);
      this.vmProc = null;
      this.vmStarting = false;
    });
    proc.on('exit', (code) => {
      this.log(`qemu exit ${code}`);
      onLog(`运行时已退出（code=${code}）`);
      this.vmProc = null;
      this.vmStarting = false;
      this.installing = false;
    });

    await new Promise((r) => setTimeout(r, 1500));
    this.vmStarting = false;
    if (!this.vmProc) throw new Error(`QEMU 启动失败，详见日志：${logFile}`);

    const client = this.client('127.0.0.1:5555');
    const timeout = env.hypervisor.whpx ? 180000 : 900000;
    const ok = await this.waitAdb(client, timeout, onLog);
    if (!ok) {
      return {
        ok: false,
        error: '虚拟机已启动，但 adb 未连接：请在虚拟机窗口里完成安装/开启网络调试后重试',
      };
    }
    await this.prepare(client);
    return { ok: true, client };
  }

  async waitAdb(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let lastNotice = 0;
    while (Date.now() - start < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      await client.connect().catch(() => false);
      // eslint-disable-next-line no-await-in-loop
      if (await client.isOnline()) return true;
      if (Date.now() - lastNotice > 20000) {
        lastNotice = Date.now();
        onLog(`等待 Android 启动… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async prepare(client) {
    if (!this._freeformReady) {
      try { this._freeformReady = await client.ensureFreeform(); } catch (_) { /* ignore */ }
    }
    this.startWatchdog();
  }

  /** 用 QEMU monitor 优雅退出（避免直接杀进程损坏磁盘） */
  async stop({ graceful = true } = {}) {
    if (!this.vmProc) return false;
    if (graceful) {
      try { await this.monitorCmd('system_powerdown'); } catch (_) { /* ignore */ }
      for (let i = 0; i < 16; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
        if (!this.vmProc) return true;
      }
      try { await this.monitorCmd('quit'); } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
    return true;
  }

  // ---------------- QEMU monitor ----------------

  monitorCmd(cmd, { timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: MONITOR_PORT });
      let buf = '';
      let sent = false;
      const done = (err, data) => {
        try { sock.destroy(); } catch (_) { /* ignore */ }
        if (err) reject(err); else resolve(data);
      };
      sock.setTimeout(timeout, () => done(new Error('monitor 超时')));
      sock.on('error', (e) => {
        // QEMU 执行 quit 等命令后会主动断开连接（ECONNRESET/EPIPE），属于正常现象
        if (sent && /ECONNRESET|EPIPE/i.test(e.code || String(e))) done(null, buf);
        else done(e);
      });
      sock.on('data', (c) => {
        buf += c.toString();
        if (!sent && buf.includes('(qemu)')) {
          sent = true;
          sock.write(`${cmd}\n`);
          setTimeout(() => done(null, buf), 300);
        }
      });
      sock.on('connect', () => {
        if (!cmd) setTimeout(() => done(null, buf), 250);
      });
    });
  }

  async sendKey(keys, delay = 140) {
    for (const k of keys) {
      // eslint-disable-next-line no-await-in-loop
      await this.monitorCmd(`sendkey ${k}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // ---------------- 安装系统到虚拟磁盘 ----------------

  async startInstaller({ onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    if (!env.iso.ok) throw new Error('请先下载/导入 Android 系统镜像（ISO）');
    if (!env.disk.ok) await this.provisioner.createDisk(this.settings.runtime.diskSizeGB || 24, () => {});
    this.installing = true;
    const r = await this.boot({ install: true, onLog });
    if (!r.ok) throw new Error(r.error || '安装环境启动失败');
    return r;
  }

  /** 安装完成后：写标记 → 之后直接从磁盘启动 */
  async markInstalled() {
    store.saveSettings({ runtime: { installed: true } });
    this.installing = false;
    return true;
  }

  // ---------------- ensure ----------------

  async ensure({ onLog = () => {} } = {}) {
    const client = this.client();
    if (await client.isOnline()) {
      await this.prepare(client);
      return { ok: true, client, engine: 'builtin', reused: true };
    }

    const s = this.settings;

    // 高级模式：连接已有运行时
    if (s.engine.mode === 'attach') {
      onLog('正在探测已有运行时…');
      const found = await this.probe();
      if (found.length) {
        store.saveSettings({ device: found[0].serial });
        const c2 = this.client(found[0].serial);
        if (await c2.isOnline()) {
          await this.prepare(c2);
          return { ok: true, client: c2, engine: found[0].name };
        }
      }
      return { ok: false, needsSetup: 'attach', error: '未发现可用的已有运行时' };
    }

    // 默认：自带运行时
    if (!s.runtime.installed) {
      const env = await this.provisioner.checkEnv();
      return {
        ok: false,
        needsSetup: env.qemu.ok ? 'install' : 'provision',
        error: env.qemu.ok ? '运行时已就绪，但还没有安装 Android 系统' : '运行时组件尚未部署完成',
        env,
      };
    }

    try {
      const r = await this.boot({ onLog });
      if (r.ok) return { ok: true, client: r.client, engine: 'builtin' };
      return { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------------- 空闲回收 ----------------

  startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(async () => {
      const s = this.settings;
      const limit = (s.engine.idleShutdownMinutes || 0) * 60000;
      if (!limit || !this.vmProc || this.installing) return;
      if (Date.now() - this.lastActivity < limit) return;
      try {
        const running = await this.client().runningPackages();
        const alive = running.filter((p) => !/launcher|systemui|settings|inputmethod|android\.systemui/i.test(p));
        if (alive.length === 0) await this.stop();
        else this.lastActivity = Date.now();
      } catch (_) { /* ignore */ }
    }, 60000);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  dispose() {
    if (this._watchdog) clearInterval(this._watchdog);
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
  }

  get bootLog() { return this._bootLog.slice(-60); }
}

module.exports = { Runtime, MONITOR_PORT };
