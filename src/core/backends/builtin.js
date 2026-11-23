'use strict';
/**
 * 底座：自带的 Google Android Emulator（QEMU 全系统虚拟化）
 *
 * 这是 ApkStart 的默认底座，也是唯一「完全自持」的底座：
 * adb / emulator / 系统镜像都由 ApkStart 自己下载和管理，不依赖用户机器上
 * 已经装了什么模拟器。
 *
 * 真正的实现在 core/engine.js（Runtime）与 core/emulator.js（EmulatorEngine）里，
 * 本文件只做一层薄适配，把它们的接口翻译成本层约定，这样上层不需要知道
 * 自研底座内部有多复杂。
 *
 * 注意：这个后端依赖 Runtime 实例，构造时通过 deps.runtime 注入。
 */
const fs = require('fs');
const path = require('path');
const { Backend, CAPS } = require('./base');
const { freeDiskMB } = require('../doctor');
const { diskRequiredMB, diskVerdict, hostProfile, memoryLimits, memVerdict, diskLimits } = require('../resources');

class BuiltinBackend extends Backend {
  static get id() { return 'builtin'; }

  static get label() { return 'Built-in Runtime (Android Emulator + QEMU)'; }

  static get summary() {
    return 'Zero third-party dependencies: ApkStart downloads and manages the Android 14 image, with built-in ARM translation. '
      + 'First boot takes ~25s, then quickboot snapshots resume in seconds.';
  }

  static get embedCapable() { return true; }

  constructor(appRoot, deps = {}) {
    super(appRoot, deps);
    this.rt = deps.runtime || null;
  }

  get caps() {
    return new Set([
      CAPS.provision, CAPS.snapshot, CAPS.resizeData,
      CAPS.resetData, CAPS.rotatePanel, CAPS.priority, CAPS.shutdown,
    ]);
  }

  // serial 用可写字段而不是 getter：基类构造函数里会 `this.serial = ''`，
  // 若在这里定义 getter，赋值会直接抛 TypeError（原型上的 getter 不可写）。
  // 需要实时值时由 ensure() 主动从 Runtime 取一次写进来。
  syncSerial() {
    if (this.rt) this.serial = this.rt.emuSerial || '';
    return this.serial;
  }

  running() { return !!(this.rt && this.rt.emuRunning); }

  async probe() {
    if (!this.rt) return { ok: false, found: false, detail: 'Runtime not initialized' };
    const p = this.rt.provisioner.paths();
    const found = fs.existsSync(p.emulatorExe) || fs.existsSync(p.adbExe);
    return { ok: true, found, path: p.emulatorExe, detail: p.root };
  }

  async check() {
    if (!this.rt) return { ok: false, reason: 'Runtime not initialized' };
    const env = await this.rt.provisioner.checkEnv().catch(() => null);
    if (!env) return { ok: false, reason: 'Runtime probe failed' };
    if (!env.adb.ok) return { ok: false, reason: 'Missing adb', needs: 'adb' };
    if (!env.emulator.ok) return { ok: false, reason: 'Missing Android Emulator', needs: 'emulator' };
    if (!env.sysimg.ok) return { ok: false, reason: 'Missing system image', needs: 'sysimg' };
    return { ok: true, env };
  }

  async resolveAdb() { return this.rt ? this.rt.adbPath() : ''; }

  async ensure({ onLog = () => {} } = {}) {
    if (!this.rt) return { ok: false, error: 'Runtime not initialized' };
    const r = await this.rt.ensure({ onLog });
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'Android runtime failed to start' };
    // serial 用可写字段（见 syncSerial 的说明），ensure 成功后同步一次
    this.syncSerial();
    this.adbPath = this.rt.adbPath();
    return {
      ok: true, serial: this.serial, adbPath: this.adbPath, reused: !!r.reused, client: r.client, engine: 'emulator',
    };
  }

  /**
   * 自带 emulator 的画面窗口不给候选句柄：它按进程目录作用域由 WinAgent 的
   * FindEmulator() 找（见 core/win/agent.ps1），这样即使窗口标题变了也不会认错。
   */
  async windowTargets() { return []; }

  /**
   * 画面窗口是否已经嵌进宿主。
   * isEmbedded 由 WinAgent 注入（问 agent.ps1 当前 _emu 的父窗口是不是宿主），
   * 没注入时保守返回 true：自带底座一直走老路径，不需要这块门禁。
   */
  async windowReady({ isEmbedded } = {}) {
    if (typeof isEmbedded !== 'function') return { ok: true };
    return { ok: !!isEmbedded };
  }

  async stop({ graceful = true } = {}) {
    if (!this.rt) return { ok: false, error: 'Runtime not initialized' };
    const ok = await this.rt.stop({ graceful }).catch((e) => ({ error: e.message }));
    return { ok: ok !== false };
  }

  async install(component, onProgress = () => {}) {
    if (!this.rt) return { ok: false, error: 'Runtime not initialized' };
    const prov = this.rt.provisioner;
    switch (component) {
      case 'runtime': return prov.installRuntimePack(onProgress);
      case 'adb': return prov.installAdb(onProgress);
      case 'emulator': return prov.installEmulator(onProgress);
      case 'sysimg': return prov.installSystemImage(onProgress);
      case 'playimg': return prov.installPlayImage(onProgress);
      case 'aehd': return prov.installAehd(onProgress);
      case 'qemu': return prov.installQemu(onProgress);
      default: return { ok: false, error: `Unknown component ${component}` };
    }
  }

  usage() { return this.rt ? this.rt.usage() : { total: 0, items: [] }; }

  dataInfo() { return this.rt ? this.rt.emulator.dataInfo() : { ok: false }; }

  /**
   * 设置页展示用：宿主上限 + 当前分配。
   * 自带运行时的内存/CPU 是写进 qemu 命令行的，改完下次开安卓生效；
   * 数据分区可以就地扩容（resizeData），不丢已装应用。
   */
  resources() {
    const info = this.dataInfo() || {};
    const host = hostProfile();
    const eng = (this.rt && this.rt.settings && this.rt.settings.engine) || {};
    const freeMB = info.avdDir ? freeDiskMB(info.avdDir) : 0;
    const memMB = Number(eng.memoryMB) || 0;
    return {
      backend: 'builtin',
      host,
      limits: { ...memoryLimits(host.totalMB), ...diskLimits(freeMB) },
      wanted: { memoryGB: memMB ? Math.round((memMB / 1024) * 2) / 2 : 0, cores: Number(eng.cores) || 0 },
      current: {
        memoryGB: memMB ? Math.round((memMB / 1024) * 2) / 2 : 0,
        cores: Number(eng.cores) || 0,
        dataGB: Number(info.configuredGB) || 0,
        imageGB: Number(info.imageGB) || 0,
      },
      freeMB,
      pending: false,
      verdict: memVerdict(memMB, host.totalMB),
      note: 'Built-in runtime RAM/CPU changes take effect on next Android boot; after increasing Data Partition, click "Expand Now" — '
        + 'resizes in-place when possible, or prompts to rebuild if using a Quickboot differential disk.',
    };
  }

  /**
   * 大包预检：除了物理磁盘，还要看 /data 分区本身够不够。
   * 50GB 级游戏装不下的最常见原因不是下载失败，而是 userdata 镜像还是
   * 默认的 6/8GB —— 装到 dexopt 阶段才报 INSTALL_INSUFFICIENT_STORAGE。
   */
  checkDiskFor(bytes) {
    const info = this.dataInfo() || {};
    const need = diskRequiredMB(bytes);
    const phys = diskVerdict(info.avdDir ? freeDiskMB(info.avdDir) : 0, need);
    if (!phys.ok) return phys;
    const capGB = Number(info.configuredGB) || 0;
    if (capGB && capGB * 1024 < need) {
      return {
        ok: false,
        message: `Insufficient Android data partition: currently ${capGB} GB, this game recommends at least ${Math.ceil(need / 1024)} GB. `
          + 'Please increase "Data partition size" in Settings → Engine and restart Android (expands in place without losing installed apps).',
      };
    }
    return { ok: true, requiredMB: need };
  }

  async resizeData(mb) { return this.rt ? this.rt.emulator.resizeDataPartition(mb) : { ok: false }; }

  async resetData() { return this.rt ? this.rt.resetAndroidData() : { ok: false }; }

  dispose() {
    // 交给 Runtime.dispose()：它会保留 qemu 进程，下次启动可以直接接管
  }

  diagnose() {
    const p = this.rt ? this.rt.provisioner.paths() : {};
    return {
      backend: 'builtin',
      serial: this.serial,
      root: p.root || '',
      emulator: p.emulatorExe || '',
      running: this.running(),
    };
  }
}

module.exports = { BuiltinBackend, BACKEND_ROOT: path.dirname(__dirname) };
