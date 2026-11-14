'use strict';
/**
 * 运行时自举（Provisioning）
 *
 * ApkStart 不依赖任何第三方模拟器：adb、QEMU、系统镜像全部由自己下载/校验/管理。
 * 所有运行时文件都放在 %APPDATA%\apkstart\runtime 下，保证在任何安装位置都可写。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');
const store = require('./store');
const doctor = require('./doctor');
const { download, downloadAny, downloadAnyParallel, head } = require('./download');
const { ZipArchive, ZipFile } = require('./zip');

const IS_WIN = process.platform === 'win32';

const SOURCES = {
  adb: [
    'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  ],
  qemuIndex: 'https://qemu.weilnetz.de/w64/',
  qemuFallback: [
    'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe',
  ],
  // Google 官方 SDK 索引：emulator 与系统镜像的真实地址从这里动态解析，不写死版本号
  sdkIndex: 'https://dl.google.com/android/repository/repository2-3.xml',
  sysImgIndexes: [
    'https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml',
    'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml',
  ],
  aehdFallback: 'https://dl.google.com/android/repository/aehd-windows_v2.2.zip',
  // 兜底：索引不可用时直接用的已知版本
  emulatorFallback: 'https://dl.google.com/android/repository/emulator-windows_x64-16847572.zip',
  sysimgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // ARM 兼容镜像（Google Play 版，内置 native bridge）
  playImgIndex: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-3.xml',
  playImgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // Android-x86 9.0-r2（x86_64）：仅在用户已自备 ISO 时使用
  iso: [
    'https://master.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso?viasf=1',
    'https://nchc.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://phoenixnap.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://downloads.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
  ],
  isoSizeHint: 900 * 1024 * 1024,
  // 轻量版（不带运行时）从这里拿「运行时整包」：本项目自己的 GitHub Release。
  // 以前轻量版要从 dl.google.com 分别下 emulator / 系统镜像，国内网络经常
  // 卡在几十 KB/s 甚至直接 404；改成整包 + 本项目 GitHub 之后，下载源和更新源
  // 是同一个地方，出了问题也只需要在一个地方修。
  ghReleaseApi: 'https://api.github.com/repos/RoutineMiku/apkstart/releases',
  ghReleasePage: 'https://github.com/RoutineMiku/apkstart/releases',
};

/**
 * SDK 索引里的 <url> 是相对路径，基准目录各不相同：
 *   repository2-3.xml      → https://dl.google.com/android/repository/
 *   sys-img/android/*.xml  → https://dl.google.com/android/repository/sys-img/android/
 * 所以基准目录一律取「索引文件自身所在目录」。此前直接拿文件名当 URL 会抛 Invalid URL。
 */
const REPO_BASE = 'https://dl.google.com/android/repository/';

function baseOf(indexUrl) {
  const s = String(indexUrl || '');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i + 1) : REPO_BASE;
}

function absUrl(u, base = REPO_BASE) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  return base + s.replace(/^\/+/, '');
}

/**
 * 只保留一份「通用基础镜像」。
 * 旧版默认 AOSP API30 + 可选 API34 Play 兼容镜像，导致：
 *   - 用户装国产 ARM 应用时必然失败，还要手动切镜像（实用门槛）；
 *   - 两份镜像各 0.6~3GB，运行时目录动辄十几 GB；
 *   - 切换镜像要 wipe-data，已装应用全丢。
 * 现在统一为 Android 14 Google Play x86_64：x86 应用、ARM 应用、GMS 都能跑，
 * 全机只存一份只读基础层（容器式共享），按需下载一次即可。
 */
const PLAY_SYSIMG = { api: '34', tag: 'google_apis_playstore', abi: 'x86_64' };
const DEFAULT_SYSIMG = PLAY_SYSIMG;

const MIN_SIZE = {
  adb: 5 * 1024 * 1024,
  qemu: 60 * 1024 * 1024,
  iso: 400 * 1024 * 1024,
  disk: 1024 * 1024,
  emulator: 200 * 1024 * 1024,
  sysimg: 300 * 1024 * 1024,
  aeHD: 64 * 1024,
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

/**
 * 环境探测结果的落盘缓存。
 *
 * `emulator -version` 与 `emulator -accel-check` 每次都要新起一个 emulator 进程，
 * 在 Windows 上实测 1~3 秒；而这两项在「引擎/驱动没变」时结果恒定。
 * 以前只在内存里缓存 30 秒，等于每次冷启动都要重付一遍，而且这几秒正好卡在
 * 用户点开应用的那一刻。这里按「exe 大小+修改时间 + AEHD 驱动时间 + WHPX 组件」
 * 做指纹落到 %APPDATA%，软硬件一换自动失效。
 */
const ENV_CACHE_TTL = 6 * 60 * 60 * 1000;
const ENV_CACHE_NEG_TTL = 10 * 60 * 1000; // 加速「不可用」只信 10 分钟：用户可能刚去开了虚拟化

function envCacheFile() {
  return path.join(store.DATA_DIR, 'cache', 'env.json');
}

function statKey(p) {
  try {
    const s = fs.statSync(p);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch (_) { return ''; }
}

class Provisioner {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this._hypervisor = null;
    this._cache = { adbVersion: '', qemuVersion: '' };
  }

  /** 缓存指纹：引擎文件与加速驱动任一变化就换 key */
  _envKey(exe) {
    const aehd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    return [
      String(exe || '').replace(/\\/g, '/').toLowerCase(),
      statKey(exe),
      statKey(aehd),
      fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll') ? '1' : '0',
    ].join('|');
  }

  envCacheGet(exe) {
    try {
      const j = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8'));
      if (!j || j.key !== this._envKey(exe)) return null;
      return j;
    } catch (_) { return null; }
  }

  envCacheSet(exe, patch) {
    try {
      const key = this._envKey(exe);
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8')) || {}; } catch (_) { /* 首次 */ }
      const base = cur.key === key ? cur : { key, version: null, accel: null, accelAt: 0 };
      const next = { ...base, ...patch, key, at: Date.now() };
      fs.mkdirSync(path.dirname(envCacheFile()), { recursive: true });
      fs.writeFileSync(envCacheFile(), JSON.stringify(next));
    } catch (_) { /* 缓存写不进去不影响主流程 */ }
  }

  /** 开机失败（加速/镜像类问题）时调用：下次启动重新探测，避免一直用错的结论 */
  invalidateEnvCache() {
    this._cache = { adbVersion: '', qemuVersion: '' };
    try { fs.rmSync(envCacheFile(), { force: true }); } catch (_) { /* ignore */ }
  }

  // ---------------- 路径 ----------------

  get root() {
    const r = store.getSettings().runtime.dir;
    return r && r.trim() ? r : path.join(store.DATA_DIR, 'runtime');
  }

  paths() {
    const root = this.root;
    const sysTag = DEFAULT_SYSIMG.tag;
    const sysApi = DEFAULT_SYSIMG.api;
    const sysAbi = DEFAULT_SYSIMG.abi;
    // AVD（含用户数据、已装应用、quickboot 快照）必须落在可写且不会被清理的地方。
    // 单文件发行版的运行时是随包解压到临时目录的，把 AVD 放进去等于每次退出都丢应用。
    // 只要运行时目录不在 %APPDATA% 里，就把 AVD 固定指到用户数据目录。
    // 另外：允许在设置里单独指定「安卓数据目录」——它才是真正吃盘的地方
    // （6~24GB 数据分区 + 2~3GB 快照），只挪运行时、不挪它，C 盘一样会满。
    const explicitAvd = String(store.getSettings().runtime.avdDir || '').trim();
    const writable = explicitAvd || path.join(store.DATA_DIR, 'avd');
    const insideData = root.toLowerCase().startsWith(store.DATA_DIR.toLowerCase());
    // 单文件发行版的镜像会展开到用户目录（见 materializeImages），那里有就用那里的
    const dataImg = path.join(store.DATA_DIR, 'system-images');
    const sysRoot = fs.existsSync(dataImg) ? dataImg : path.join(root, 'system-images');
    return {
      root,
      qemuDir: path.join(root, 'qemu'),
      qemuExe: path.join(root, 'qemu', 'qemu-system-x86_64.exe'),
      qemuImg: path.join(root, 'qemu', 'qemu-img.exe'),
      adbDir: path.join(root, 'platform-tools'),
      adbExe: path.join(root, 'platform-tools', 'adb.exe'),
      // emulator 运行时（Google 官方）：root 同时充当 ANDROID_SDK_ROOT
      emulatorDir: path.join(root, 'emulator'),
      emulatorExe: path.join(root, 'emulator', 'emulator.exe'),
      sysImgRoot: sysRoot,
      sysImgDir: path.join(sysRoot, `android-${sysApi}`, sysTag, sysAbi),
      avdHome: insideData ? path.join(root, 'avd') : writable,
      aehdDir: path.join(root, 'aehd'),
      imagesDir: path.join(root, 'images'),
      iso: path.join(root, 'images', 'android-x86.iso'),
      disk: path.join(root, 'images', 'android.qcow2'),
      tmp: path.join(root, '_tmp'),
      sysTag, sysApi, sysAbi,
    };
  }

  ensureDirs() {
    const p = this.paths();
    for (const d of [p.root, p.qemuDir, p.adbDir, p.imagesDir, p.tmp, p.avdHome]) {
      fs.mkdirSync(d, { recursive: true });
    }
    return p;
  }

  /**
   * 磁盘守卫：在下载 / 解压一份大体积组件之前，先确认目标盘有足够可用空间。
   * 否则会下到一半把系统盘撑爆，或解压阶段直接失败（且残留半截文件）。
   * 预留 1GB 缓冲：模拟器/镜像解压后还有快照、用户数据分区会持续膨胀。
   * @param {string} component 组件名（决定所需空间估算）
   * @param {string} targetDir 写入目录（据此定位所在盘）
   */
  async guardDisk(component, targetDir) {
    const need = {
      adb: 64, emulator: 600, sysimg: 1800, playimg: 1800, qemu: 320, iso: 1100, aehd: 64,
    }[component] || 512; // MB
    const buf = 1024; // 额外预留 1GB（快照 / 数据分区 / 解压中间文件）
    const dir = targetDir || this.root;
    const free = doctor.freeDiskMB(dir);
    if (free && free < need + buf) {
      throw new Error(
        `目标磁盘空间不足：该组件约需 ${need + buf} MB，但「${dir}」所在盘仅剩 ${free} MB。\n`
        + '建议：把「运行时数据目录」改到空间更大的盘（设置 → 系统集成 → 运行时数据目录 → 浏览），'
        + '或先清理磁盘 / 卸载不用的应用后再试。',
      );
    }
    return free;
  }

  // ---------------- 环境检查 ----------------

  async hypervisor() {
    if (this._hypervisor !== null) return this._hypervisor;
    if (!IS_WIN) { this._hypervisor = { whpx: false, note: '非 Windows 平台' }; return this._hypervisor; }
    // 只做毫秒级的文件检查。真正"WHPX 是否可用"由 emulator -accel-check 给出权威答案，
    // 避免在这里拉起 PowerShell（冷启动 1-2 秒）拖慢每次状态轮询。
    const dll = fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll');
    this._hypervisor = {
      whpx: false,          // 由 emulatorAccel() 覆盖为真实值
      dll,
      hypervisorPresent: false,
      note: dll
        ? '虚拟机平台组件存在（可用性由运行时引擎检测）'
        : '未检测到 Windows Hypervisor Platform 组件：可在「启用或关闭 Windows 功能」中勾选「虚拟机平台」后重启',
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

  /** 校验 ISO9660 主卷描述符（偏移 0x8001 处的 "CD001"），防止把错误页/半截文件当镜像 */
  inspectIso(file) {
    const size = fileSize(file);
    if (!size) return { ok: false, iso9660: false, size: 0, reason: '未下载' };
    let magic = '';
    try {
      const fd = fs.openSync(file, 'r');
      const b = Buffer.alloc(5);
      fs.readSync(fd, b, 0, 5, 0x8001);
      fs.closeSync(fd);
      magic = b.toString('latin1');
    } catch (_) { /* ignore */ }

    const iso9660 = magic === 'CD001';
    // 用户导入的 raw/已装磁盘镜像不含 ISO 引导区，按尺寸放行
    const rawImage = !iso9660 && /\.(img|raw|qcow2)$/i.test(file) && size > MIN_SIZE.iso;
    const ok = size > MIN_SIZE.iso && (iso9660 || rawImage);

    let reason = '';
    if (!ok) {
      reason = size <= MIN_SIZE.iso
        ? `文件只有 ${(size / 1048576).toFixed(1)}MB，下载未完成`
        : '文件不是有效的 ISO9660 镜像（可能是下载到错误页或文件已损坏）';
    }
    return { ok, iso9660, rawImage, size, reason, magic };
  }

  async checkEnv() {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const [adb, qemu, hv, emulator, accel] = await Promise.all([
      this.adbVersion(), this.qemuVersion(), this.hypervisor(),
      this.emulatorVersion(), this.emulatorAccel(),
    ]);

    const isoPath = s.runtime.isoPath || p.iso;
    const diskPath = s.runtime.diskPath || p.disk;
    const iso = this.inspectIso(isoPath);
    const diskSize = fileSize(diskPath);
    const sysimg = this.systemImageInfo();

    // 完整版（内置运行时）只带一份 API 34 Google Play 镜像，它同时是主镜像与兼容镜像；
    // 不再依赖 compatImage 开关，避免「镜像明明在，却因为没勾开关而判定未部署」
    const compatReady = this.playImageInfo().ok;
    const emulatorReady = emulator.ok && (sysimg.ok || compatReady);
    const qemuReady = qemu.ok && diskSize > MIN_SIZE.disk;

    return {
      adb: { ...adb, required: true },
      emulator: { ...emulator, required: true, note: emulator.ok ? emulator.version : '未安装' },
      sysimg: {
        ok: sysimg.ok || compatReady,
        dir: sysimg.dir,
        size: sysimg.ok ? sysimg.size : (compatReady ? this.playImageInfo().size : 0),
        api: sysimg.ok ? sysimg.api : (compatReady ? PLAY_SYSIMG.api : sysimg.api),
        required: false,
        note: sysimg.ok
          ? `Android ${sysimg.api}（${(sysimg.size / 1073741824).toFixed(2)} GB）`
          : (compatReady ? `Android ${PLAY_SYSIMG.api}（ARM 兼容镜像）` : (sysimg.note || '未下载')),
      },
      playImage: this.playImageInfo(),
      accel,
      qemu: { ...qemu, required: false },
      iso: {
        ok: iso.ok,
        path: isoPath,
        size: iso.size,
        iso9660: iso.iso9660,
        required: false,
        note: iso.size ? `${(iso.size / 1073741824).toFixed(2)} GB` : '未下载',
        reason: iso.reason,
      },
      disk: {
        ok: diskSize > MIN_SIZE.disk,
        path: diskPath,
        size: diskSize,
        required: false,
        note: diskSize ? `${(diskSize / 1073741824).toFixed(2)} GB` : '尚未创建',
      },
      hypervisor: hv,
      ready: !!(adb.ok && (emulatorReady || qemuReady)),
      engine: emulatorReady ? 'emulator' : (qemuReady ? 'qemu' : 'none'),
      paths: p,
    };
  }

  // ---------------- adb ----------------

  async installAdb(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('adb', p.root);
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
    await this.extractZip(zipPath, p.root);

    const v = await this.adbVersion();
    if (!v.ok) throw new Error('adb 解压后无法运行，请检查是否被杀毒软件拦截');

    fs.rmSync(zipPath, { force: true });
    store.saveSettings({ adbPath: v.path });
    this._cache.adbVersion = v.version;
    onProgress({ stage: 'done', message: `adb ${v.version} 就绪`, percent: 100 });
    return v;
  }

  /**
   * 用自带的 ZIP 解析器解压（避免依赖系统解压工具）
   * 大条目（GB 级 system.img）走流式，小条目整块读，避免撞 Node 的单 Buffer 上限。
   */
  // ---------------- 本项目 GitHub 的运行时整包（轻量版） ----------------

  async _fetchJson(url) {
    const text = await this._fetchText(url).catch(() => '');
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  /**
   * 解析「运行时整包」的下载地址。
   * 资产名约定：ApkStart-runtime-<tag>.zip（由 .github/workflows/release.yml 产出，
   * 内容就是 build/runtime 的那一套：emulator/ + platform-tools/ + aehd/ + system-images/）。
   * 找最新的、且带这个资产的 release；找不到就抛错，让上层退回 Google 官方分组件下载。
   */
  async resolveRuntimePack() {
    const custom = String(store.getSettings().runtime.runtimePackUrl || '').trim();
    if (custom) return { url: absUrl(custom), name: path.basename(custom.split('?')[0]), size: 0, tag: 'custom' };
    if (this._cache.pack) return this._cache.pack;

    const list = await this._fetchJson(`${SOURCES.ghReleaseApi}?per_page=15`);
    if (!Array.isArray(list)) throw new Error('无法读取 GitHub 发布列表（网络或限流）');
    for (const rel of list) {
      if (!rel || rel.draft) continue;
      const hit = (rel.assets || []).find((a) => /^ApkStart-runtime-.*\.zip$/i.test(a.name || ''));
      if (!hit) continue;
      this._cache.pack = {
        url: hit.browser_download_url,
        name: hit.name,
        size: hit.size || 0,
        tag: String(rel.tag_name || '').replace(/^v/i, ''),
        page: rel.html_url || SOURCES.ghReleasePage,
      };
      return this._cache.pack;
    }
    throw new Error('GitHub 上还没有运行时整包');
  }

  /**
   * 轻量版一键部署：从本项目 GitHub 下载运行时整包并解压。
   * 系统镜像在包里是 .xz，首次开机时由 materializeImages() 展开（只做一次）。
   */
  async installRuntimePack(onProgress = () => {}) {
    const p = this.ensureDirs();
    const pack = await this.resolveRuntimePack();
    await this.guardDisk('runtime', p.root);
    const zip = path.join(p.tmp, 'runtime-pack.zip');
    const total = pack.size || 0;

    onProgress({ stage: 'download', message: '从 GitHub 下载运行时（约 1.5 GB，只需一次）…', percent: 1 });
    await download(pack.url, zip, {
      onProgress: (pr) => {
        const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
        onProgress({
          stage: 'download',
          message: `下载运行时 ${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`,
          percent: Math.max(1, Math.min(90, Math.round(pct * 0.9))),
          speed: pr.speed,
        });
      },
    });
    if (fileSize(zip) < 200 * 1024 * 1024) throw new Error('运行时整包下载不完整，可重试续传');

    onProgress({ stage: 'extract', message: '解压运行时（约 1 分钟）…', percent: 91 });
    await this.extractZip(zip, p.root, {
      onEntry: (name, done, all) => {
        if (done % 50 === 0) {
          onProgress({ stage: 'extract', percent: Math.min(99, 91 + Math.round((done / all) * 8)), message: `解压 ${done}/${all}` });
        }
      },
    });
    try {
      fs.writeFileSync(path.join(p.root, '.runtime-pack.json'), JSON.stringify({
        name: pack.name, tag: pack.tag, at: new Date().toISOString(), from: pack.url,
      }));
      fs.rmSync(zip, { force: true });
    } catch (_) { /* 标记写不进去不影响使用 */ }

    // 整包里的 system.img 是 .xz 压缩的（和完整版安装包一致）。这里立刻展开，
    // 否则紧接着 checkEnv() 会认为「没装系统镜像」，又去 Google 下一套 1.4 GB。
    onProgress({ stage: 'extract', message: '展开系统镜像（约 1 分钟，只需一次）…', percent: 99 });
    await this.materializeImages((m) => onProgress({ stage: 'extract', message: m, percent: 99 })).catch(() => 0);

    onProgress({ stage: 'done', message: '运行时已就绪', percent: 100 });
    return { ok: true, name: pack.name, tag: pack.tag };
  }

  async extractZip(zipPath, destDir, opts = {}) {
    // 大包（emulator / 系统镜像）走文件版：不把 1.5GB zip 整包读进内存，
    // 低内存机器也能稳定解压；小包沿用内存版，速度更快。
    const big = fileSize(zipPath) > 64 * 1024 * 1024;
    const zip = big ? new ZipFile(zipPath) : new ZipArchive(fs.readFileSync(zipPath));
    const STREAM_THRESHOLD = 64 * 1024 * 1024;
    const total = zip.names().length;
    let done = 0;

    try {
      for (const name of zip.names()) {
        if (name.endsWith('/')) {
          fs.mkdirSync(path.join(destDir, name), { recursive: true });
          continue;
        }
        const target = path.join(destDir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const e = zip.entries.get(name);
        if (e.uncompSize > STREAM_THRESHOLD) {
          // eslint-disable-next-line no-await-in-loop
          await zip.pipeTo(name, fs.createWriteStream(target));
        } else {
          fs.writeFileSync(target, zip.read(name));
        }
        done += 1;
        if (opts.onEntry) opts.onEntry(name, done, total);
      }
    } finally {
      if (zip.close) zip.close();
    }
    return destDir;
  }

  // ---------------- Emulator（Google 官方运行时） ----------------

  /** 抓取一段 XML 文本（带大小上限，索引文件约 400KB） */
  async _fetchText(url, limit = 2 * 1024 * 1024) {
    const { openStream } = require('./download');
    const res = await openStream(url);
    return new Promise((resolve, reject) => {
      let d = '';
      res.on('data', (c) => { d += c; if (d.length > limit) res.destroy(); });
      res.on('end', () => resolve(d));
      res.on('error', () => resolve(d));
    });
  }

  /** 从 SDK 索引里动态解析最新的 Windows emulator 包地址 */
  async resolveEmulatorUrl() {
    const cached = store.getSettings().runtime.emulatorUrl;
    if (cached && cached.trim()) return absUrl(cached);
    if (this._cache.emulatorUrl) return this._cache.emulatorUrl;
    try {
      const xml = await this._fetchText(SOURCES.sdkIndex);
      const block = /<remotePackage path="emulator"[\s\S]*?<\/remotePackage>/.exec(xml);
      if (block) {
        const base = baseOf(SOURCES.sdkIndex);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base));
        const win = urls.find((u) => /windows_x64.*\.zip$/i.test(u));
        if (win) {
          this._cache.emulatorUrl = win;
          return win;
        }
      }
    } catch (_) { /* 落兜底 */ }
    this._cache.emulatorUrl = SOURCES.emulatorFallback;
    return SOURCES.emulatorFallback;
  }

  /** 从 sys-img 索引里解析默认 AOSP 系统镜像地址 */
  async resolveSysimgUrl() {
    const cached = store.getSettings().runtime.sysimgUrl;
    if (cached && cached.trim()) return absUrl(cached, baseOf(SOURCES.sysImgIndexes[0]));
    if (this._cache.sysimgUrl) return this._cache.sysimgUrl;
    const want = `system-images;android-${DEFAULT_SYSIMG.api};${DEFAULT_SYSIMG.tag};${DEFAULT_SYSIMG.abi}`;
    for (const idx of [SOURCES.playImgIndex, ...SOURCES.sysImgIndexes]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const xml = await this._fetchText(idx);
        const re = new RegExp(`<remotePackage path="${want.replace(/[;]/g, ';')}"[\\s\\S]*?</remotePackage>`);
        const block = re.exec(xml);
        if (block) {
          const base = baseOf(idx);
          const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
            .filter((u) => /x86_64.*\.zip$/i.test(u));
          if (urls.length) {
            this._cache.sysimgUrl = urls[urls.length - 1];
            return this._cache.sysimgUrl;
          }
        }
      } catch (_) { /* 换下一个索引 */ }
    }
    this._cache.sysimgUrl = SOURCES.sysimgFallback;
    return SOURCES.sysimgFallback;
  }

  async emulatorVersion() {
    if (this._cache.emulatorVersion && this._cache.emulatorVerAt && Date.now() - this._cache.emulatorVerAt < 30000) {
      return this._cache.emulatorVersion;
    }
    const p = this.paths();
    const candidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      // 上一次会话探测过、且引擎文件没变：直接用落盘结果（省掉一次 1s+ 的进程拉起）
      const cached = this.envCacheGet(c);
      if (cached && cached.version && cached.version.ok && Date.now() - (cached.at || 0) < ENV_CACHE_TTL) {
        this._cache.emulatorVersion = cached.version;
        this._cache.emulatorVerAt = Date.now();
        return cached.version;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await run(c, ['-version'], { timeout: 20000 });
      const text = `${r.stdout}${r.stderr}`;
      const m = /Android emulator version\s+([\d.]+)/i.exec(text);
      if (m) {
        this._cache.emulatorVersion = { ok: true, path: c, version: m[1] };
        this._cache.emulatorVerAt = Date.now();
        this.envCacheSet(c, { version: this._cache.emulatorVersion });
        return this._cache.emulatorVersion;
      }
    }
    return { ok: false, path: '', version: '' };
  }

  /**
   * 首次启动把随包带来的压缩镜像展开到用户目录（只做一次）。
   * 单文件发行版里 system.img 是 .gz（3.1GB→580MB 左右），不展开模拟器没法用。
   * 展开到 %APPDATA% 而不是包里：便携版的运行时目录每次启动都是新的临时目录，
   * 放进去等于每次开机都重解压一遍。
   */
  async materializeImages(onLog = () => {}) {
    const srcRoot = path.join(this.root, 'system-images');
    const destRoot = path.join(store.DATA_DIR, 'system-images');
    const jobs = [];
    const copies = []; // 压缩镜像之外的文件（kernel-ranchu / ramdisk / 未压缩 .img 等）必须一并落到展开目录
    const found = new Map(); // dest -> job（同镜像 .xz/.gz 并存时优先 .xz）
    const walk = (dir, rel = '') => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p, path.join(rel, e.name)); continue; }
        // 支持 .img.xz（LZMA2，体积比 .gz 小 ~25%）和旧的 .img.gz
        if (/\.img\.(xz|gz)$/i.test(e.name)) {
          const dest = path.join(destRoot, rel, e.name.replace(/\.img\.(xz|gz)$/i, '.img'));
          const job = { src: p, dest, xz: /\.xz$/i.test(e.name) };
          const prev = found.get(dest);
          if (!prev || (job.xz && !prev.xz)) found.set(dest, job);
        } else {
          copies.push({ src: p, dest: path.join(destRoot, rel, e.name) });
        }
      }
    };
    walk(srcRoot);
    jobs.push(...found.values());
    if (!jobs.length && !copies.length) return 0;

    // 先补齐非镜像文件（模拟器靠 kernel-ranchu 等定位/引导，缺了会报"还差系统镜像"）
    for (const c of copies) {
      try {
        const have = fileSize(c.dest);
        if (have > 0 && have === fileSize(c.src)) continue;
        fs.mkdirSync(path.dirname(c.dest), { recursive: true });
        fs.copyFileSync(c.src, c.dest);
      } catch (e) { onLog(`复制镜像组件失败：${e.message}`); }
    }

    let done = 0;
    for (const j of jobs) {
      const have = fileSize(j.dest);
      if (have > 32 * 1024 * 1024) continue; // 已经展开过
      fs.mkdirSync(path.dirname(j.dest), { recursive: true });
      onLog(`首次启动：正在展开系统镜像 ${path.basename(j.dest)}（约 1 分钟，只需一次）`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve, reject) => {
        const { pipeline, Readable } = require('stream');
        if (j.xz) {
          // LZMA2 解压：必须直接引原生绑定 index.js。
          // 包默认入口 main.js / xz.js 内部会 require('stream-polyfill.mjs')，
          // Electron 的 Node 20 不支持 require(ESM) 会抛错；而 exports 又不允许
          // 直接写 '@napi-rs/lzma/index.js'，所以用 require.resolve 定位目录后按文件路径引。
          const path0 = require('path');
          const lzmaDir = path0.dirname(require.resolve('@napi-rs/lzma'));
          const { xz } = require(path0.join(lzmaDir, 'index.js'));
          const webIn = Readable.toWeb(fs.createReadStream(j.src));
          const webOut = xz.decompressStream(webIn);
          pipeline(Readable.fromWeb(webOut), fs.createWriteStream(j.dest), (err) => (err ? reject(err) : resolve()));
        } else {
          pipeline(
            fs.createReadStream(j.src),
            zlib.createGunzip(),
            fs.createWriteStream(j.dest),
            (err) => (err ? reject(err) : resolve()),
          );
        }
      }).catch((e) => onLog(`展开镜像失败：${e.message}`));
      done += 1;
    }
    return done;
  }

  /** 系统镜像是否完整（system.img 是硬指标，缺失或过小都视为没下完） */
  systemImageInfo() {
    const p = this.paths();
    const roots = [p.sysImgRoot, path.join(this.root, 'system-images'), path.join(this.appRoot, 'engine', 'system-images')];
    // 先在默认位置（API34 Play）找，再退到「随便哪套镜像」。
    // 单文件发行版可能只带一套更小的 AOSP 镜像，写死 API34 会导致
    // 镜像明明在包里却报"未下载"，用户被迫联网下载一套新的。
    const preferred = [p.sysImgDir,
      path.join(this.appRoot, 'engine', 'system-images',
        `android-${DEFAULT_SYSIMG.api}`, DEFAULT_SYSIMG.tag, DEFAULT_SYSIMG.abi)];
    const candidates = [...preferred];
    for (const root of roots) {
      let apis = [];
      try { apis = fs.readdirSync(root).filter((d) => /^android-\d+$/.test(d)); } catch (_) { continue; }
      apis.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) candidates.push(path.join(root, api, tag, abi));
        }
      }
    }
    let missing = null;
    for (const dir of candidates) {
      const system = path.join(dir, 'system.img');
      const kernel = path.join(dir, 'kernel-ranchu');
      const size = fileSize(system);
      const m = /system-images[\\/]android-(\d+)[\\/]([^\\/]+)[\\/]([^\\/]+)$/.exec(dir);
      const api = m ? Number(m[1]) : DEFAULT_SYSIMG.api;
      const tag = m ? m[2] : DEFAULT_SYSIMG.tag;
      const abi = m ? m[3] : DEFAULT_SYSIMG.abi;
      if (size > MIN_SIZE.sysimg && fs.existsSync(kernel)) {
        return { ok: true, dir, size, api, tag, abi };
      }
      if (!missing && fs.existsSync(dir)) {
        missing = { ok: false, dir, size, api, tag, abi, note: size ? '镜像不完整' : '缺少 system.img' };
      }
    }
    if (missing) return missing;
    return { ok: false, dir: p.sysImgDir, size: 0, api: DEFAULT_SYSIMG.api, tag: DEFAULT_SYSIMG.tag, note: '未下载' };
  }

  /**
   * 硬件加速状态。
   * emulator 在 Windows 上支持两种加速：WHPX（系统功能，需重启）与 AEHD（Google 自家驱动，装完即用）。
   */
  async emulatorAccel() {
    // 状态轮询每几秒一次，而 -accel-check 要拉起一个 emulator 进程，必须缓存
    if (this._cache.accel && this._cache.accelAt && Date.now() - this._cache.accelAt < 30000) {
      return this._cache.accel;
    }
    const p = this.paths();
    const exe = fs.existsSync(p.emulatorExe) ? p.emulatorExe
      : path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe');
    if (!fs.existsSync(exe)) return { ok: false, kind: 'none', note: '未安装 emulator' };

    // 落盘缓存：冷启动时不再为这一项拉起 emulator 进程。
    // 「不可用」结论只信 10 分钟 —— 用户可能刚去开了虚拟化/装了 AEHD，要能立刻反映。
    const cached = this.envCacheGet(exe);
    if (cached && cached.accel) {
      const ttl = cached.accel.ok ? ENV_CACHE_TTL : ENV_CACHE_NEG_TTL;
      if (Date.now() - (cached.accelAt || 0) < ttl) {
        this._cache.accel = cached.accel;
        this._cache.accelAt = Date.now();
        return cached.accel;
      }
    }

    const aehdSys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    const hasAehdFile = fs.existsSync(aehdSys) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    const hv = await this.hypervisor();

    const r = await run(exe, ['-accel-check'], { timeout: 30000 });
    const text = `${r.stdout}${r.stderr}`;
    const usable = /accel:\s*\n?0\b/.test(text) && !/ERROR_ACCESS_DENIED|not installed/i.test(text);

    let result;
    if (usable) {
      const kind = hasAehdFile && /aehd/i.test(text) ? 'aehd' : 'whpx';
      result = { ok: true, kind, note: kind === 'whpx' ? 'WHPX 硬件加速已启用' : 'AEHD 硬件加速已启用' };
    } else if (/can't find the emulator-check|corrupted tools installation/i.test(text) && hasAehdFile) {
      // 部分精简运行时包会漏掉 emulator-check.exe，导致 -accel-check 无法给出结论。
      // 此时只要 AEHD 驱动已安装，就按「可用」处理：启动时 emulator 自己会挂载驱动，
      // 避免被误判成无加速而强行 -accel off（软件模拟在部分机器上会直接崩溃）。
      result = { ok: true, kind: 'aehd', note: 'AEHD 硬件加速已启用（emulator-check 缺失，按驱动判定）' };
    } else if (hasAehdFile && /aehd/i.test(text) && !/ERROR_ACCESS_DENIED/i.test(text)) {
      result = { ok: true, kind: 'aehd', note: 'AEHD 硬件加速已启用' };
    } else if (hv.dll && /whpx/i.test(text) && !/error|denied/i.test(text)) {
      result = { ok: true, kind: 'whpx', note: 'WHPX 硬件加速已启用' };
    } else {
      result = {
        ok: false,
        kind: 'none',
        whpx: hv.whpx,
        aehdInstalled: hasAehdFile,
        viaTcg: true,
        note: '未启用硬件加速：将回退软件模拟（能跑但很慢）。建议安装 AEHD 驱动或开启「虚拟机平台」',
      };
    }
    this._cache.accel = result;
    this._cache.accelAt = Date.now();
    this.envCacheSet(exe, { accel: result, accelAt: Date.now() });
    return result;
  }

  /** 下载并安装 emulator（zip 顶层就是 emulator/，直接解到 SDK root） */
  async installEmulator(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('emulator', p.root);
    const url = await this.resolveEmulatorUrl();
    const zip = path.join(p.tmp, 'emulator.zip');
    onProgress({ stage: 'download', message: '下载运行时引擎（约 440MB，走 Google 官方源）…', percent: 1 });

    await downloadAnyParallel([url], zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `下载运行时引擎 ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1048576).toFixed(1)} MB/s）` : ''),
        percent: Math.round(pr.percent * 0.85),
        canResume: true,
      }),
    });
    if (fileSize(zip) < MIN_SIZE.emulator) throw new Error('运行时引擎下载不完整，可重试续传');

    onProgress({ stage: 'extract', message: '解压运行时引擎…', percent: 88 });
    await this.extractZip(zip, p.root);
    fs.rmSync(zip, { force: true });

    // SDK root 必须同时具备 platform-tools，否则 emulator 拒绝启动
    this.ensurePlatformTools();

    const v = await this.emulatorVersion();
    if (!v.ok) throw new Error('emulator 解压后无法运行，请检查是否被杀毒软件拦截');
    this._cache.emulatorVersion = v.version;
    onProgress({ stage: 'done', message: `运行时引擎 ${v.version} 就绪`, percent: 100 });
    return v;
  }

  /** emulator 要求 SDK root 下有 platform-tools 目录，否则直接 FATAL */
  ensurePlatformTools() {
    const p = this.paths();
    fs.mkdirSync(p.adbDir, { recursive: true });
    if (fs.existsSync(p.adbExe)) return true;
    const src = [
      path.join(this.appRoot, 'engine', 'platform-tools'),
      path.join(this.appRoot, 'tools', 'platform-tools'),
      path.dirname(this.adbVersionPath() || ''),
    ].find((d) => d && fs.existsSync(path.join(d, 'adb.exe')));
    if (!src) return false;
    for (const f of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
      const from = path.join(src, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(p.adbDir, f));
    }
    return fs.existsSync(p.adbExe);
  }

  adbVersionPath() {
    try {
      const s = store.getSettings();
      if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    } catch (_) { /* ignore */ }
    return '';
  }

  /** 只下载一份通用基础镜像（Android 14 Play x86_64），不再有「普通/兼容」两套 */
  async installSystemImage(onProgress = () => {}) {
    if (this.playImageInfo().ok) return this.playImageInfo();
    return this.installPlayImage(onProgress);
  }

  /** ARM 兼容镜像（Google Play 版）是否已就位 */
  playImageInfo() {
    const p = this.paths();
    const dir = path.join(p.sysImgRoot, `android-${PLAY_SYSIMG.api}`, PLAY_SYSIMG.tag, PLAY_SYSIMG.abi);
    const size = fileSize(path.join(dir, 'system.img'));
    if (size > MIN_SIZE.sysimg && fs.existsSync(path.join(dir, 'kernel-ranchu'))) {
      return { ok: true, dir, size, api: PLAY_SYSIMG.api, tag: PLAY_SYSIMG.tag };
    }
    return { ok: false, dir, size, note: size ? '镜像不完整' : '未下载' };
  }

  /** 解析 Google Play 版镜像地址（<url> 相对索引文件所在目录） */
  async resolvePlayUrl() {
    if (this._cache.playUrl) return this._cache.playUrl;
    try {
      const xml = await this._fetchText(SOURCES.playImgIndex);
      const want = `system-images;android-${PLAY_SYSIMG.api};${PLAY_SYSIMG.tag};${PLAY_SYSIMG.abi}`;
      const block = new RegExp(`<remotePackage path="${want}"[\\s\\S]*?</remotePackage>`).exec(xml);
      if (block) {
        const base = baseOf(SOURCES.playImgIndex);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
          .filter((u) => /x86_64.*\.zip$/i.test(u));
        if (urls.length) {
          this._cache.playUrl = urls[urls.length - 1];
          return this._cache.playUrl;
        }
      }
    } catch (_) { /* 落兜底 */ }
    this._cache.playUrl = SOURCES.playImgFallback;
    return this._cache.playUrl;
  }

  /** 下载并安装 ARM 兼容镜像（Google Play 版，约 1.5GB） */
  async installPlayImage(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('playimg', p.sysImgRoot);
    const url = await this.resolvePlayUrl();
    const zip = path.join(p.tmp, 'play-sysimg.zip');
    onProgress({ stage: 'download', message: '下载 ARM 兼容镜像（Android 14，约 1.5GB）…', percent: 1 });
    await downloadAnyParallel([url], zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `下载兼容镜像 ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1048576).toFixed(1)} MB/s）` : ''),
        percent: Math.round(pr.percent * 0.8),
        canResume: true,
      }),
    });
    if (fileSize(zip) < MIN_SIZE.sysimg) throw new Error('兼容镜像下载不完整，可重试续传');

    const dest = path.join(p.sysImgRoot, `android-${PLAY_SYSIMG.api}`, PLAY_SYSIMG.tag);
    fs.mkdirSync(dest, { recursive: true });
    onProgress({ stage: 'extract', message: '解压兼容镜像（3GB，需十余秒）…', percent: 82 });
    await this.extractZip(zip, dest, {
      onEntry: (_n, i, total) => onProgress({
        stage: 'extract',
        message: `解压兼容镜像 ${i}/${total}`,
        percent: 82 + Math.round((i / Math.max(1, total)) * 15),
      }),
    });
    fs.rmSync(zip, { force: true });

    const info = this.playImageInfo();
    if (!info.ok) throw new Error('兼容镜像解压后校验失败');
    // 旧版（API 30）兼容镜像不再使用，成功装好后清理腾空间
    for (const old of ['android-30']) {
      const legacy = path.join(p.sysImgRoot, old, 'google_apis_playstore');
      if (fs.existsSync(legacy)) fs.rmSync(legacy, { recursive: true, force: true });
    }
    onProgress({ stage: 'done', message: 'ARM 兼容镜像就绪，重新启动运行时即可生效', percent: 100 });
    return info;
  }

  /** 下载 AEHD 驱动（小文件）；安装需要管理员权限，交给引导流程 */
  async installAehd(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('aehd', p.aehdDir);
    const zip = path.join(p.tmp, 'aehd.zip');
    onProgress({ stage: 'download', message: '下载 AEHD 驱动…', percent: 10 });
    await downloadAnyParallel([SOURCES.aehdFallback], zip, { connections: 2 });
    fs.mkdirSync(p.aehdDir, { recursive: true });
    await this.extractZip(zip, p.aehdDir);
    fs.rmSync(zip, { force: true });
    const has = fs.existsSync(path.join(p.aehdDir, 'aehd.Sys')) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    if (!has) throw new Error('AEHD 驱动包解压异常');
    this._cache.accel = null;
    this._cache.accelAt = 0;
    onProgress({ stage: 'done', message: 'AEHD 驱动已就绪，需管理员权限安装', percent: 100 });
    return { ok: true, dir: p.aehdDir, installer: path.join(p.aehdDir, 'silent_install.bat') };
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
    await this.guardDisk('qemu', p.root);
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
    await this.guardDisk('iso', path.dirname(dest));
    const custom = s.runtime.isoUrl && s.runtime.isoUrl.trim();
    const urls = custom ? [custom, ...SOURCES.iso] : SOURCES.iso;

    onProgress({ stage: 'download', message: '下载 Android-x86 9.0-r2（约 900MB，8 线程分块）…', percent: 1 });
    const r = await downloadAnyParallel(urls, dest, {
      connections: 8,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `下载系统镜像… ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1024).toFixed(0)} KB/s）` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });

    const info = this.inspectIso(dest);
    if (!info.ok) {
      throw new Error(`系统镜像不可用：${info.reason}${info.size && info.size < MIN_SIZE.iso ? '，可再次点击继续断点续传' : ''}`);
    }

    store.saveSettings({ runtime: { isoPath: dest } });
    onProgress({ stage: 'done', message: `系统镜像就绪（${(info.size / 1073741824).toFixed(2)} GB）`, percent: 100, path: dest });
    return { ...r, ...info };
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
    const info = this.inspectIso(file);
    if (!info.ok) {
      const e = new Error(info.reason || '镜像文件不可用');
      e.invalidIso = true;
      throw e;
    }
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

module.exports = { Provisioner, SOURCES, MIN_SIZE, absUrl, baseOf };
