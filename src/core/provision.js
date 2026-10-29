'use strict';
/**
 * 运行时自举（Provisioning）
 *
 * ApkStart 不依赖任何第三方模拟器：adb、QEMU、系统镜像全部由自己下载/校验/管理。
 * 所有运行时文件都放在 %APPDATA%\apkstart\runtime 下，保证在任何安装位置都可写。
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const store = require('./store');
const { download, downloadAny, head } = require('./download');
const { ZipArchive } = require('./zip');

const IS_WIN = process.platform === 'win32';

const SOURCES = {
  adb: [
    'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  ],
  qemuIndex: 'https://qemu.weilnetz.de/w64/',
  qemuFallback: [
    'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe',
  ],
  // Android-x86 9.0-r2（x86_64）：公认最稳的 QEMU 可引导 Android
  iso: [
    'https://master.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso?viasf=1',
    'https://nchc.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://phoenixnap.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://downloads.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
  ],
  isoSizeHint: 900 * 1024 * 1024,
};

const MIN_SIZE = {
  adb: 5 * 1024 * 1024,
  qemu: 60 * 1024 * 1024,
  iso: 400 * 1024 * 1024,
  disk: 1024 * 1024,
};

function run(cmd, args, { timeout = 60000, cwd, windowsHide = true } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, windowsHide, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err });
    });
  });
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

class Provisioner {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this._hypervisor = null;
    this._cache = { adbVersion: '', qemuVersion: '' };
  }

  // ---------------- 路径 ----------------

  get root() {
    const r = store.getSettings().runtime.dir;
    return r && r.trim() ? r : path.join(store.DATA_DIR, 'runtime');
  }

  paths() {
    const root = this.root;
    return {
      root,
      qemuDir: path.join(root, 'qemu'),
      qemuExe: path.join(root, 'qemu', 'qemu-system-x86_64.exe'),
      qemuImg: path.join(root, 'qemu', 'qemu-img.exe'),
      adbDir: path.join(root, 'platform-tools'),
      adbExe: path.join(root, 'platform-tools', 'adb.exe'),
      imagesDir: path.join(root, 'images'),
      iso: path.join(root, 'images', 'android-x86.iso'),
      disk: path.join(root, 'images', 'android.qcow2'),
      tmp: path.join(root, '_tmp'),
    };
  }

  ensureDirs() {
    const p = this.paths();
    for (const d of [p.root, p.qemuDir, p.adbDir, p.imagesDir, p.tmp]) {
      fs.mkdirSync(d, { recursive: true });
    }
    return p;
  }

  // ---------------- 环境检查 ----------------

  async hypervisor() {
    if (this._hypervisor !== null) return this._hypervisor;
    if (!IS_WIN) { this._hypervisor = { whpx: false, note: '非 Windows 平台' }; return this._hypervisor; }
    const dll = fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll');
    const ps = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_ComputerSystem).HypervisorPresent',
    ], { timeout: 15000 });
    const present = /true/i.test(ps.stdout);
    this._hypervisor = {
      whpx: dll && present,
      dll,
      hypervisorPresent: present,
      note: dll && present
        ? '已启用 WHPX 硬件加速'
        : '未检测到 Windows Hypervisor Platform：将以纯软件模拟运行（较慢），可在「启用或关闭 Windows 功能」中勾选「虚拟机平台」后重启提速',
    };
    return this._hypervisor;
  }

  async adbVersion() {
    // 30s 缓存，避免状态轮询频繁拉起外部进程
    if (this._adbCache && Date.now() - this._adbCache.at < 30000) return this._adbCache.value;
    const { adbExe, adbDir } = this.paths();
    const candidates = [adbExe, path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['version'], { timeout: 10000 });
      if (r.ok) {
        const m = /version\s+([\d.]+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : r.stdout.split('\n')[0].trim() };
        this._adbCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._adbCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._adbCache.value;
  }

  async qemuVersion() {
    if (this._qemuCache && Date.now() - this._qemuCache.at < 30000) return this._qemuCache.value;
    const p = this.paths();
    const candidates = [
      p.qemuExe,
      store.getSettings().runtime.qemuPath,
      'C:\\Program Files\\qemu\\qemu-system-x86_64.exe',   // winget 默认安装位置
      path.join(this.appRoot, 'engine', 'qemu', 'qemu-system-x86_64.exe'),
    ].filter(Boolean);
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['--version'], { timeout: 15000 });
      if (r.ok || r.stdout) {
        const m = /QEMU emulator version\s+(\S+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : (r.stdout || '').split('\n')[0].trim() };
        this._qemuCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._qemuCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._qemuCache.value;
  }

  async checkEnv() {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const [adb, qemu, hv] = await Promise.all([this.adbVersion(), this.qemuVersion(), this.hypervisor()]);

    const isoPath = s.runtime.isoPath || p.iso;
    const diskPath = s.runtime.diskPath || p.disk;
    const isoSize = fileSize(isoPath);
    const diskSize = fileSize(diskPath);

    return {
      adb: { ...adb, required: true },
      qemu: { ...qemu, required: true },
      iso: {
        ok: isoSize > MIN_SIZE.iso,
        path: isoPath,
        size: isoSize,
        required: false,
        note: isoSize ? `${(isoSize / 1073741824).toFixed(2)} GB` : '未下载',
      },
      disk: {
        ok: diskSize > MIN_SIZE.disk,
        path: diskPath,
        size: diskSize,
        required: true,
        note: diskSize ? `${(diskSize / 1073741824).toFixed(2)} GB` : '尚未创建',
      },
      hypervisor: hv,
      ready: !!(adb.ok && qemu.ok && diskSize > MIN_SIZE.disk),
      paths: p,
    };
  }

  // ---------------- adb ----------------

  async installAdb(onProgress = () => {}) {
    const p = this.ensureDirs();
    const zipPath = path.join(p.tmp, 'platform-tools.zip');
    onProgress({ stage: 'download', message: '下载 Android platform-tools（约 8MB）…', percent: 2 });

    await downloadAny(SOURCES.adb, zipPath, {
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `下载 adb… ${(pr.got / 1048576).toFixed(1)}MB / ${(pr.total / 1048576).toFixed(1)}MB`,
        percent: pr.percent,
        speed: pr.speed,
      }),
    });

    if (fileSize(zipPath) < MIN_SIZE.adb) throw new Error('adb 安装包下载不完整');

    onProgress({ stage: 'extract', message: '解压 adb…', percent: 92 });
    this.extractZip(zipPath, p.root);

    const v = await this.adbVersion();
    if (!v.ok) throw new Error('adb 解压后无法运行，请检查是否被杀毒软件拦截');

    fs.rmSync(zipPath, { force: true });
    store.saveSettings({ adbPath: v.path });
    this._cache.adbVersion = v.version;
    onProgress({ stage: 'done', message: `adb ${v.version} 就绪`, percent: 100 });
    return v;
  }

  /** 用自带的 ZIP 解析器解压（避免依赖系统解压工具） */
  extractZip(zipPath, destDir) {
    const buf = fs.readFileSync(zipPath);
    const zip = new ZipArchive(buf);
    for (const name of zip.names()) {
      if (name.endsWith('/')) {
        fs.mkdirSync(path.join(destDir, name), { recursive: true });
        continue;
      }
      const target = path.join(destDir, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, zip.read(name));
    }
    return destDir;
  }

  // ---------------- QEMU ----------------

  /** 抓取官方目录里最新的安装包文件名（不写死版本号） */
  async resolveQemuUrl() {
    const configured = store.getSettings().runtime.qemuUrl;
    if (configured && configured.trim()) return configured.trim();
    try {
      const { openStream } = require('./download');
      const res = await openStream(SOURCES.qemuIndex);
      const html = await new Promise((resolve, reject) => {
        let d = '';
        res.on('data', (c) => { d += c; if (d.length > 512 * 1024) res.destroy(); });
        res.on('end', () => resolve(d));
        res.on('error', reject);
      });
      const files = [...html.matchAll(/href="([^"]*qemu-w64-setup-(\d+)\.exe)"/g)]
        .map((m) => ({ file: m[1], ver: Number(m[2]) }))
        .sort((a, b) => b.ver - a.ver);
      if (files.length) {
        const f = files[0].file.replace(/^.*\//, '');
        return new URL(f, SOURCES.qemuIndex).href;
      }
    } catch (_) { /* 落到备用源 */ }
    return SOURCES.qemuFallback[0];
  }

  async installQemu(onProgress = () => {}) {
    const p = this.ensureDirs();
    const setup = path.join(p.tmp, 'qemu-setup.exe');

    onProgress({ stage: 'resolve', message: '查找最新 QEMU 版本…', percent: 1 });
    const url = await this.resolveQemuUrl();
    onProgress({ stage: 'download', message: `下载 QEMU（约 200MB）…`, percent: 2, url });

    await download(url, setup, {
      resume: true,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `下载 QEMU… ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1024).toFixed(0)} KB/s）` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });
    if (fileSize(setup) < MIN_SIZE.qemu) throw new Error('QEMU 安装包下载不完整');

    onProgress({ stage: 'install', message: '正在安装 QEMU（静默）…', percent: 96 });
    // qemu-w64-setup 是 NSIS 安装器：/S 静默，/D 指定目录（必须最后且不加引号）
    const target = p.qemuDir;
    fs.mkdirSync(target, { recursive: true });
    await new Promise((resolve) => {
      const proc = spawn(setup, ['/S', `/D=${target}`], { windowsHide: true, stdio: 'ignore' });
      proc.on('exit', () => resolve());
      proc.on('error', () => resolve());
      setTimeout(() => { try { proc.kill(); } catch (_) {} resolve(); }, 600000);
    });

    const v = await this.qemuVersion();
    if (!v.ok) {
      throw new Error('QEMU 安装后未找到 qemu-system-x86_64.exe：可手动下载 QEMU 并解压到 engine/qemu/');
    }
    fs.rmSync(setup, { force: true });
    this._cache.qemuVersion = v.version;
    onProgress({ stage: 'done', message: `QEMU ${v.version} 就绪`, percent: 100 });
    return v;
  }

  // ---------------- 系统镜像 ----------------

  async downloadIso(onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.isoPath || p.iso;
    const custom = s.runtime.isoUrl && s.runtime.isoUrl.trim();
    const urls = custom ? [custom, ...SOURCES.iso] : SOURCES.iso;

    onProgress({ stage: 'download', message: '下载 Android-x86 9.0-r2（约 900MB）…', percent: 1 });
    const r = await downloadAny(urls, dest, {
      resume: true,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `下载系统镜像… ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1024).toFixed(0)} KB/s）` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });
    if (fileSize(dest) < MIN_SIZE.iso) throw new Error('系统镜像下载不完整，可重试续传');

    store.saveSettings({ runtime: { isoPath: dest } });
    onProgress({ stage: 'done', message: '系统镜像就绪', percent: 100, path: dest });
    return r;
  }

  /** 校验用户导入的镜像/ISO */
  inspectImage(file) {
    const size = fileSize(file);
    if (!size) throw new Error('文件不存在或为空');
    const fd = fs.openSync(file, 'r');
    const head4 = Buffer.alloc(4);
    fs.readSync(fd, head4, 0, 4, 0);
    fs.closeSync(fd);
    const magic = head4.toString('hex');
    let kind = 'unknown';
    if (magic === '514649fb') kind = 'qcow2';
    else if (head4.toString('ascii', 0, 4) === 'KDMV') kind = 'vmdk';
    else if (size > 400 * 1024 * 1024 && magic !== '00000000') kind = 'raw-or-iso';
    return { kind, size, path: file };
  }

  importIso(file) {
    const info = this.inspectImage(file);
    store.saveSettings({ runtime: { isoPath: file } });
    return { ok: true, ...info };
  }

  importDisk(file) {
    const info = this.inspectImage(file);
    store.saveSettings({ runtime: { diskPath: file } });
    return { ok: true, ...info };
  }

  // ---------------- 虚拟磁盘 ----------------

  async createDisk(sizeGB = 24, onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.diskPath || p.disk;
    if (fileSize(dest) > MIN_SIZE.disk) return { ok: true, path: dest, existed: true };

    onProgress({ stage: 'disk', message: `创建 ${sizeGB}GB 虚拟磁盘…`, percent: 40 });
    const qemuImg = fs.existsSync(p.qemuImg)
      ? p.qemuImg
      : path.join(path.dirname(store.getSettings().runtime.qemuPath || ''), 'qemu-img.exe');

    const tool = fs.existsSync(qemuImg) ? qemuImg : null;
    if (tool) {
      const r = await run(tool, ['create', '-f', 'qcow2', dest, `${sizeGB}G`], { timeout: 120000 });
      if (!r.ok) throw new Error(`qemu-img 创建虚拟磁盘失败：${r.stderr || r.stdout}`);
    } else {
      throw new Error('未找到 qemu-img.exe，请先安装 QEMU');
    }
    store.saveSettings({ runtime: { diskPath: dest } });
    onProgress({ stage: 'done', message: '虚拟磁盘已创建', percent: 100, path: dest });
    return { ok: true, path: dest, size: fileSize(dest) };
  }

  // ---------------- 系统镜像可达性预检 ----------------

  async probeSources() {
    const [adb, qemu, iso] = await Promise.all([
      head(SOURCES.adb[0]),
      head(SOURCES.qemuFallback[0]),
      head(SOURCES.iso[0]),
    ]);
    return { adb, qemu, iso };
  }
}

module.exports = { Provisioner, SOURCES, MIN_SIZE };
