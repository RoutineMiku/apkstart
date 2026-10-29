'use strict';
/**
 * adb 客户端封装
 * 只做 apkstart 需要的那部分：安装 / 启动 / 停止 / 卸载 / 文件同步 / 截图
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const COMMON_ADB_PATHS = [
  path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  'C:\\Android\\platform-tools\\adb.exe',
  'C:\\adb\\adb.exe',
  'C:\\LDPlayer\\LDPlayer9\\adb.exe',
  'C:\\Program Files\\Netease\\MuMuPlayer-12.0\\shell\\adb.exe',
  'C:\\Program Files\\BlueStacks_nxt\\HD-Adb.exe',
];

class AdbError extends Error {
  constructor(message, stderr, code) {
    super(message);
    this.stderr = stderr;
    this.code = code;
  }
}

class AdbClient {
  constructor({ adbPath, serial }) {
    this.adbPath = adbPath || 'adb';
    this.serial = serial || '';
  }

  static resolveAdb(explicit, appRoot) {
    const candidates = [
      explicit,
      appRoot && path.join(appRoot, 'tools', 'platform-tools', 'adb.exe'),
      ...COMMON_ADB_PATHS,
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
    }
    return 'adb'; // 交给 PATH
  }

  _args(args, withSerial = true) {
    const a = [];
    if (withSerial && this.serial) a.push('-s', this.serial);
    return a.concat(args);
  }

  exec(args, { timeout = 30000, withSerial = true, binary = false } = {}) {
    return new Promise((resolve, reject) => {
      const finalArgs = this._args(args, withSerial);
      execFile(this.adbPath, finalArgs, {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        encoding: binary ? 'buffer' : 'utf8',
        windowsHide: true,
      }, (err, stdout, stderr) => {
        if (err) {
          return reject(new AdbError(
            `adb ${finalArgs.join(' ')} 失败: ${String(stderr || err.message).trim()}`,
            stderr, err.code,
          ));
        }
        resolve({ stdout, stderr });
      });
    });
  }

  async shell(cmd, opts = {}) {
    const { stdout } = await this.exec(['shell', cmd], opts);
    return typeof stdout === 'string' ? stdout.trim() : stdout;
  }

  async version() {
    const { stdout } = await this.exec(['version'], { withSerial: false });
    const m = /version\s+([\d.]+)/i.exec(stdout);
    return m ? m[1] : stdout.trim();
  }

  async connect() {
    if (!this.serial.includes(':')) return true;
    try {
      await this.exec(['connect', this.serial], { withSerial: false, timeout: 15000 });
    } catch (_) { /* 可能已连接 */ }
    return this.isOnline();
  }

  async isOnline() {
    try {
      const { stdout } = await this.exec(['get-state'], { timeout: 8000 });
      return stdout.trim() === 'device';
    } catch (_) {
      // get-state 在未指定 serial 时不可用，退化用 devices 列表
      try {
        const { stdout } = await this.exec(['devices'], { withSerial: false, timeout: 8000 });
        return stdout.split('\n').some((l) => l.startsWith(this.serial) && l.includes('device'));
      } catch (_) {
        return false;
      }
    }
  }

  async devices() {
    const { stdout } = await this.exec(['devices', '-l'], { withSerial: false });
    return stdout.split('\n').slice(1)
      .map((l) => l.trim())
      .filter((l) => l && l.includes('device') && !l.startsWith('*'))
      .map((l) => {
        const parts = l.split(/\s+/);
        return { serial: parts[0], state: parts[1], model: (l.match(/model:(\S+)/) || [])[1] || '' };
      })
      .filter((d) => d.state === 'device');
  }

  async install(apkPath) {
    if (!fs.existsSync(apkPath)) throw new Error(`APK 不存在: ${apkPath}`);
    const { stdout } = await this.exec(['install', '-r', '-g', '-t', apkPath], { timeout: 180000 });
    if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) {
      throw new Error(stdout.trim());
    }
    return stdout.trim();
  }

  async uninstall(pkg) {
    try {
      await this.exec(['uninstall', pkg], { timeout: 60000 });
    } catch (e) {
      // 部分设备需要指定 user
      await this.exec(['shell', 'pm', 'uninstall', '--user', '0', pkg], { timeout: 60000 });
    }
  }

  async isInstalled(pkg) {
    const out = await this.shell(`pm path ${pkg}`);
    return /package:/.test(out);
  }

  async listPackages() {
    const out = await this.shell('pm list packages -3');
    return out.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
  }

  /** 启动应用；freeform=true 时以独立窗口模式启动 */
  async startApp(pkg, activity, { freeform = true, bounds = null, forceStop = false } = {}) {
    if (forceStop) await this.forceStop(pkg);
    const parts = ['am', 'start'];
    if (freeform) parts.push('--windowingMode', '5');
    parts.push('--activity-clear-top');
    if (activity) parts.push('-n', `${pkg}/${activity}`);
    else parts.push('-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', pkg);
    const out = await this.shell(parts.join(' '));
    if (/Error|Exception/i.test(out)) throw new Error(out);
    if (bounds) {
      // 尽力而为：把新任务挪到上次的位置
      this.resizeTaskOfPackage(pkg, bounds).catch(() => {});
    }
    return out;
  }

  async forceStop(pkg) {
    try { await this.shell(`am force-stop ${pkg}`); } catch (_) { /* ignore */ }
  }

  async runningPackages() {
    try {
      const out = await this.shell('dumpsys activity activities | grep -E "mResumedActivity|ResumedActivity"');
      const pkgs = [...out.matchAll(/([a-zA-Z][\w.]+\/[.\w$]+)/g)].map((m) => m[1].split('/')[0]);
      return [...new Set(pkgs)];
    } catch (_) {
      return [];
    }
  }

  async taskIdOfPackage(pkg) {
    try {
      const out = await this.shell('dumpsys activity recents');
      const blocks = out.split('Recent #');
      for (const b of blocks) {
        if (!b.includes(pkg)) continue;
        const m = /taskId=(\d+)/.exec(b) || /^\d+/.exec(b);
        if (m) return Number(m[1] || m[0]);
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  async resizeTaskOfPackage(pkg, bounds) {
    const id = await this.taskIdOfPackage(pkg);
    if (!id) return false;
    await this.shell(`am task resize ${id} ${bounds.left} ${bounds.top} ${bounds.right} ${bounds.bottom}`);
    return true;
  }

  /** 开启 freeform（独立窗口）支持，失败不影响主流程 */
  async ensureFreeform() {
    const cmds = [
      'settings put global enable_freeform_support 1',
      'settings put global force_resizable_activities 1',
      'settings put global development_settings_enabled 1',
    ];
    for (const c of cmds) {
      try { await this.shell(c); } catch (_) { /* ignore */ }
    }
    const v = await this.shell('settings get global enable_freeform_support').catch(() => '0');
    return v.trim() === '1';
  }

  async wmSize() {
    const out = await this.shell('wm size');
    const m = /(\d+)x(\d+)/.exec(out.split('\n').pop() || out);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  }

  async androidVersion() {
    return (await this.shell('getprop ro.build.version.release').catch(() => '')).trim();
  }

  async sdkInt() {
    const v = await this.shell('getprop ro.build.version.sdk').catch(() => '0');
    return Number(v.trim()) || 0;
  }

  async screenshot() {
    const { stdout } = await this.exec(['exec-out', 'screencap', '-p'], { binary: true, timeout: 20000 });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  }

  async push(local, remote) {
    await this.exec(['push', local, remote], { timeout: 180000 });
  }

  async pull(remote, local) {
    await this.exec(['pull', remote, local], { timeout: 180000 });
  }

  async shellMkdir(remote) {
    await this.shell(`mkdir -p "${remote}"`);
  }

  async listRemote(remote) {
    const out = await this.shell(`ls -l "${remote}" 2>/dev/null`);
    return out.split('\n').map((l) => {
      const m = /^([\-dl])\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\d+\s+[\d:]+)\s+(.+)$/.exec(l.trim());
      return m ? { isDir: m[1] === 'd', size: Number(m[2]), name: m[4] } : null;
    }).filter(Boolean);
  }

  /** 清除应用数据 */
  async clearData(pkg) {
    await this.shell(`pm clear ${pkg}`);
  }

  /** 导出应用数据（Windows/调试版可用 run-as；否则走 adb backup 兜底） */
  async exportAppData(pkg, localTarPath) {
    const remote = `/sdcard/apkstart-tmp-${pkg}.tar`;
    const cmd = `run-as ${pkg} tar -cf ${remote} . 2>/dev/null || (cd /data/data/${pkg} && tar -cf ${remote} .)`;
    await this.shell(cmd);
    await this.pull(remote, localTarPath);
    await this.shell(`rm -f ${remote}`).catch(() => {});
    return localTarPath;
  }

  async batteryOptimizeOff(pkg) {
    try { await this.shell(`dumpsys deviceidle whitelist +${pkg}`); } catch (_) { /* ignore */ }
  }
}

module.exports = { AdbClient, AdbError };
