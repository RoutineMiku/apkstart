'use strict';
/**
 * adb 客户端封装
 * 只做 apkstart 需要的那部分：安装 / 启动 / 停止 / 卸载 / 文件同步 / 截图
 */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const COMMON_ADB_PATHS = [
  path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  'C:\\Android\\platform-tools\\adb.exe',
  'C:\\adb\\adb.exe',
  'C:\\LDPlayer\\LDPlayer9\\adb.exe',
  'C:\\Program Files\\Netease\\MuMuPlayer-12.0\\shell\\adb.exe',
  'C:\\Program Files\\BlueStacks_nxt\\HD-Adb.exe',
];

/**
 * 把 pm install 的原始失败原因翻译成用户能看懂的中文。
 * 保留原始错误码在末尾，便于搜索排查。
 */
function friendlyInstallError(raw) {
  const code = /INSTALL_[A-Z_]+/.exec(raw);
  const tag = code ? code[0] : '';
  const table = {
    INSTALL_FAILED_NO_MATCHING_ABIS:
      '安装失败：这个应用只提供 ARM 原生库（多数国产应用如此），'
      + '当前系统镜像没有 ARM 转译层。ApkStart 会自动切换到内置新版翻译层的兼容镜像并重试。',
    INSTALL_FAILED_OLDER_SDK:
      '安装失败：应用要求的 Android 版本高于当前运行时（需更高系统镜像）。',
    INSTALL_PARSE_FAILED_NO_CERTIFICATES:
      '安装失败：APK 没有有效签名，无法安装。',
    INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES:
      '安装失败：与已安装版本签名不一致，请先卸载旧版再装。',
    INSTALL_FAILED_VERSION_DOWNGRADE:
      '安装失败：设备上已安装更高版本，不能降级覆盖。',
    INSTALL_FAILED_INSUFFICIENT_STORAGE:
      '安装失败：运行时磁盘空间不足，请清理后重试。',
    INSTALL_FAILED_INVALID_APK:
      '安装失败：APK 文件损坏或不完整（可能下载未完成），请重新获取。',
    INSTALL_FAILED_INVALID_URI: '安装失败：APK 路径含特殊字符，请把文件移到纯英文路径后重试。',
    INSTALL_FAILED_ALREADY_EXISTS: '安装失败：已存在同名应用且签名不同，请先卸载。',
    INSTALL_FAILED_UPDATE_INCOMPATIBLE: '安装失败：与已安装版本签名不一致，请先卸载旧版。',
    INSTALL_FAILED_DEPRECATED_SDK_VERSION:
      '安装失败：这是面向很老 Android 版本的应用（targetSdk 过低），Android 14 默认禁止安装。'
      + 'ApkStart 会自动用官方绕过参数重试。',
    INSTALL_FAILED_TEST_ONLY: '安装失败：这是仅供测试的应用包，已自动加上测试包参数重试。',
    INSTALL_FAILED_MISSING_SHARED_LIBRARY: '安装失败：应用依赖的设备特性（如特定厂商库）在当前运行时不存在。',
    INSTALL_FAILED_USER_RESTRICTION: '安装失败：系统限制了安装，请重启运行时后重试。',
    INSTALL_FAILED_CONFLICTING_PROVIDER: '安装失败：与已有应用的 ContentProvider 冲突，请卸载冲突应用。',
    INSTALL_FAILED_INTERNAL_ERROR: '安装失败：系统内部错误（常见于存储空间不足或开机未完成），请重启运行时后重试。',
  };
  const msg = table[tag];
  return msg ? `${msg}（${tag}）` : `安装失败：${raw}`;
}

/** 把启动后的崩溃日志翻译成能看懂的原因 */
function friendlyLaunchError(raw, pkg) {
  const t = String(raw || '');
  if (/DoBadTrampoline|libndk_translation|houdini|SIGABRT.*arm/i.test(t)) {
    return `${pkg || '应用'} 启动后崩溃：ARM 翻译层与该应用的信号处理不兼容。`
      + 'ApkStart 会自动切换到 Android 14 兼容镜像后重试。';
  }
  if (/UnsatisfiedLinkError|dlopen failed|couldn't find "lib|\.so.*not found/i.test(t)) {
    return `${pkg || '应用'} 启动后崩溃：缺少设备原生库（应用可能只提供 ARM 版本）。`
      + '会自动切换到带 ARM 翻译层的兼容镜像后重试。';
  }
  if (/ClassNotFoundException|NoClassDefFoundError|AndroidRuntime/i.test(t)) {
    return `${pkg || '应用'} 启动即崩溃（应用内部异常，可能与模拟器环境或缺少 Google 服务有关）。`;
  }
  if (/java\.lang\.SecurityException|Permission Denial/i.test(t)) {
    return `${pkg || '应用'} 启动失败：系统拒绝了启动请求（权限或签名问题）。`;
  }
  return `${pkg || '应用'} 未能启动${t ? `：${t.slice(0, 240)}` : '（进程未存活）'}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Windows 版 adb 对非 ASCII 路径处理不稳定（中文用户名/中文下载目录很常见）。
 * 安装前把 APK 复制到纯 ASCII 的临时目录，装完即删。
 */
function stageApk(apkPath) {
  const p = String(apkPath || '');
  if (/^[\x20-\x7e]*$/.test(p) && p.length < 200) return { path: p, staged: false };
  const dir = path.join(os.tmpdir(), 'apkstart-install');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.createHash('sha1').update(p).digest('hex').slice(0, 12)}.apk`;
  const target = path.join(dir, name);
  fs.copyFileSync(p, target);
  return { path: target, staged: true };
}

function unstage(staged) {
  if (!staged) return;
  try { fs.rmSync(staged, { force: true }); } catch (_) { /* ignore */ }
}

class AdbError extends Error {
  constructor(message, stderr, code) {
    super(message);
    this.stderr = stderr;
    this.code = code;
  }
}

/**
 * 解析 `find -exec stat -c '%Y|%s|%n'` 的输出。
 * 返回 null 表示输出不像 stat 结果（设备不支持）。
 */
function parseStatList(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const rows = [];
  for (const l of lines) {
    const m = /^(\d{9,})\|(\d+)\|(.+)$/.exec(l);
    if (!m) continue;
    const rel = m[3].replace(/^\.\//, '');
    if (!rel || rel.endsWith('/')) continue;
    rows.push({ rel, size: Number(m[2]), mtime: Number(m[1]) * 1000 });
  }
  // 有输出但一行都解析不出来 → 说明不是 stat 格式
  if (!rows.length) return null;
  return rows;
}

class AdbClient {
  constructor({ adbPath, serial }) {
    this.adbPath = adbPath || 'adb';
    this.serial = serial || '';
    this._input = null;        // 常驻 `adb shell` 进程
    this._inputSeq = 0;
    this._waiters = new Map(); // id -> { resolve, reject, timer, token }
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

  _adbEnv() {
    return { ...process.env, ANDROID_ADB_SERVER_PORT: process.env.ANDROID_ADB_SERVER_PORT || '5044' };
  }

  exec(args, { timeout = 30000, withSerial = true, binary = false } = {}) {
    return new Promise((resolve, reject) => {
      const finalArgs = this._args(args, withSerial);
      execFile(this.adbPath, finalArgs, {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        encoding: binary ? 'buffer' : 'utf8',
        windowsHide: true,
        // 与运行时模拟器共用专用 adb server 端口（默认 5044），与 5037 上的
        // WSA / 第三方模拟器 adb 隔离，避免注册被反复踢掉导致设备 offline
        env: this._adbEnv(),
      }, (err, stdout, stderr) => {
        if (err) {
          // adb install 的失败原因写在 stdout 且退出码非 0；
          // 旧版只看 stderr，导致用户永远只看到一句空泛的「失败」。
          const text = [stdout, stderr, err.message].filter(Boolean).join('\n').trim();
          const e = new AdbError(`adb ${finalArgs.join(' ')} 失败: ${text}`, stderr, err.code);
          e.stdout = stdout;
          e.raw = text;
          return reject(e);
        }
        resolve({ stdout, stderr });
      });
    });
  }

  async shell(cmd, opts = {}) {
    const { stdout } = await this.exec(['shell', cmd], opts);
    return typeof stdout === 'string' ? stdout.trim() : stdout;
  }

  /**
   * 常驻输入通道。
   * 滚轮/返回是高频输入：每格滚轮都 execFile 一个 adb 会起一堆进程，
   * 桌面会明显发顿。这里复用一条 `adb shell`，每行一条命令，并在末尾
   * echo 一个结束标记 —— 既知道命令何时真正跑完，也天然形成背压，
   * 不会让滑动命令在 shell 里排成一长队。
   */
  _inputSession() {
    const old = this._input;
    if (old && old.exitCode === null && !old.killed && old.stdin && old.stdin.writable) return old;
    if (old) this.disposeInput();

    const p = spawn(this.adbPath, this._args(['shell'], true), {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this._adbEnv(),
    });
    this._input = p;
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        for (const [id, w] of this._waiters) {
          // 必须整行等于标记：某些 shell 会把整条命令行回显出来，
          // 用 contains 会把「刚写进去」误判成「已执行完」，滑动就会堆积。
          if (line === w.token) {
            this._waiters.delete(id);
            clearTimeout(w.timer);
            w.resolve(true);
            break;
          }
        }
      }
    });
    p.stderr.on('data', () => { /* 忽略：设备离线等信息由调用方兜底 */ });
    p.stdin.on('error', () => { /* 断开时由 exit 统一清理 */ });
    p.on('error', () => { this._failWaiters(new Error('adb shell 启动失败')); });
    p.on('exit', () => {
      if (this._input === p) this._input = null;
      this._failWaiters(new Error('adb shell 已退出'));
    });
    return p;
  }

  _failWaiters(err) {
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this._waiters.clear();
  }

  /** 执行一条白名单内的 input 命令；失败会回收会话，调用方可回退到一次性 adb */
  async input(cmd, { timeout = 4000 } = {}) {
    const { isInputCommand } = require('./pointer');
    if (!isInputCommand(cmd)) throw new Error('非法的输入命令');
    const p = this._inputSession();
    const id = ++this._inputSeq;
    const token = `__APKSTART_${id}__`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(id);
        this.disposeInput();
        reject(new Error('input 命令超时'));
      }, timeout);
      this._waiters.set(id, { resolve, reject, timer, token });
      try {
        p.stdin.write(`${cmd}; echo ${token}\n`);
      } catch (e) {
        this._waiters.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  disposeInput() {
    const p = this._input;
    this._input = null;
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('输入通道已关闭'));
    }
    this._waiters.clear();
    if (p) {
      try { p.stdin.end(); } catch (_) { /* ignore */ }
      try { p.kill(); } catch (_) { /* ignore */ }
    }
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

  /**
   * 安装单个 APK，带自动降级：
   *  - 默认去掉 -g（自动授予全部权限在部分镜像上会让 PermissionController 崩掉）；
   *  - 带 --bypass-low-target-sdk-block，解决 Android 14 拒绝安装老 targetSdk 应用；
   *  - adb 版本不认该参数 / 中文路径 / 传输错误时自动换写法重试；
   *  - NO_MATCHING_ABIS 抛带 code 的错误，交给上层自动切换兼容镜像。
   */
  async install(apkPath) {
    if (!fs.existsSync(apkPath)) throw new Error(`APK 不存在: ${apkPath}`);
    const staged = stageApk(apkPath);
    const file = staged.path;
    const variants = [
      // -g 自动授予运行时权限，省掉应用里的授权弹窗；部分镜像不支持则自动降级去掉
      ['install', '-r', '-t', '-g', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', file],
      ['install', '-r', file],
    ];
    let last = '';
    try {
      for (const args of variants) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(args, { timeout: 240000 });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) {
            throw new Error(String(stdout).trim());
          }
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          last = raw;
          const tag = (/INSTALL_[A-Z_]+/.exec(raw) || [])[0] || '';

          if (tag === 'INSTALL_FAILED_NO_MATCHING_ABIS') {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            err.raw = raw;
            throw err;
          }
          // 老 adb 不认新参数 / 测试包标记 → 换一种写法
          if (/Unknown option|unrecognized option|Unknown command/i.test(raw)) continue;
          if (tag === 'INSTALL_FAILED_TEST_ONLY' || tag === 'INSTALL_FAILED_DEPRECATED_SDK_VERSION') continue;
          // 传输类错误（设备掉线、adb server 重启）重试一次
          if (/device (not found|offline)|closed|protocol fault|no devices/i.test(raw)) {
            // eslint-disable-next-line no-await-in-loop
            await sleep(1500);
            continue;
          }
          if (tag) {
            const err = new Error(friendlyInstallError(raw));
            err.code = tag;
            err.raw = raw;
            throw err;
          }
          // 没拿到明确错误码：最后一种写法再试
        }
      }
      const err = new Error(friendlyInstallError(last || '安装失败，未获得明确原因'));
      err.code = (/INSTALL_[A-Z_]+/.exec(last) || [])[0] || 'INSTALL_UNKNOWN';
      err.raw = last;
      throw err;
    } finally {
      unstage(staged.staged ? file : null);
    }
  }

  /** 拆分 APK（.apks / .xapk 解出来的多个分片）走 install-multiple */
  async installMultiple(apkPaths) {
    if (!apkPaths || !apkPaths.length) throw new Error('没有可安装的分片 APK');
    const staged = apkPaths.map((p) => stageApk(p));
    const files = staged.map((s) => s.path);
    try {
      for (const extra of [['-r', '-t', '--bypass-low-target-sdk-block'], ['-r', '-t']]) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(['install-multiple', ...extra, ...files], { timeout: 300000 });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) throw new Error(stdout);
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          if (/Unknown option|unrecognized option/i.test(raw)) continue;
          if (/INSTALL_FAILED_NO_MATCHING_ABIS/.test(raw)) {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            throw err;
          }
          throw new Error(friendlyInstallError(raw));
        }
      }
      throw new Error('拆分 APK 安装失败');
    } finally {
      staged.forEach((s) => unstage(s.staged ? s.path : null));
    }
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

  /** 从系统解析真正的启动 Activity（清单里解析不出来时的兜底） */
  async resolveLauncher(pkg) {
    try {
      const out = await this.shell(
        `cmd package resolve-activity --brief ${pkg}`, { timeout: 10000 },
      );
      const m = /([\w.]+\/[.\w$]+)/.exec(String(out).split('\n').pop() || out);
      if (m && m[1].startsWith(`${pkg}/`)) return m[1];
    } catch (_) { /* 落到 monkey */ }
    return null;
  }

  /** 应用是否真的活着：am start 返回成功 ≠ 进程没崩 */
  async waitAppAlive(pkg, timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      const pid = await this.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
      if (String(pid).trim()) return { ok: true };
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    let crash = '';
    try {
      crash = await this.shell(
        `logcat -d -t 250 -v brief AndroidRuntime:E DEBUG:E libc:E 2>/dev/null | `
        + `grep -i -E '${pkg}|FATAL|ndk_translation|SIGABRT|SIGSEGV|UnsatisfiedLink' | tail -n 30`,
        { timeout: 12000 },
      );
    } catch (_) { /* ignore */ }
    const text = String(crash || '').trim();
    // 没有崩溃日志时不能断言失败：部分大型应用首次启动要 20-40 秒
    return { ok: false, crash: text, uncertain: !text };
  }

  /**
   * 启动应用，带三级降级：
   *   freeform 独立窗口 → 普通全屏 → monkey 兜底；
   * 每次都验证进程是否存活，崩溃时抓 logcat 并抛带 code 的错误供上层自动切镜像。
   */
  async startApp(pkg, activity, { freeform = true, bounds = null, forceStop = false } = {}) {
    if (forceStop) await this.forceStop(pkg);
    // 必须用系统解析出来的 LAUNCHER 入口，不能只用 APK 里解析到的主 Activity：
    // 很多应用（红果短剧等）的启动页才做真正的初始化，直接进主 Activity 会
    // 抛 "had you called RpcService.init"，表现为点开闪一下就没了。
    const resolved = (await this.resolveLauncher(pkg).catch(() => '')) || activity;
    const intent = resolved
      ? ['-n', `${pkg}/${resolved}`]
      : ['-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', pkg];
    const modes = freeform
      ? [['--windowingMode', '5'], []]
      : [[]];
    let lastError = '';

    for (const mode of modes) {
      const parts = ['am', 'start', ...mode, '--activity-clear-top', ...intent];
      let out = '';
      try {
        // eslint-disable-next-line no-await-in-loop
        out = await this.shell(parts.join(' '), { timeout: 20000 });
      } catch (e) {
        lastError = String(e.message || e);
        continue;
      }
      if (/Error|Exception/i.test(out)) { lastError = out; continue; }

      if (bounds) this.resizeTaskOfPackage(pkg, bounds).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      const alive = await this.waitAppAlive(pkg, 6000);
      if (alive.ok) return out;
      if (alive.uncertain) return `${out}\n（应用仍在加载中）`;
      lastError = alive.crash || lastError;
      // 崩溃日志明确指向 ARM 翻译层时不再重试，直接交给上层切换兼容镜像
      if (/DoBadTrampoline|libndk_translation|UnsatisfiedLinkError|dlopen failed/i.test(alive.crash || '')) {
        const err = new Error(friendlyLaunchError(alive.crash, pkg));
        err.code = 'APP_CRASHED';
        err.crash = alive.crash;
        throw err;
      }
    }

    // monkey 兜底：部分镜像的 am start -a/-c/-p 解析不到 launcher
    try {
      const out = await this.shell(
        `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { timeout: 20000 },
      );
      const alive = await this.waitAppAlive(pkg, 12000);
      if (alive.ok || alive.uncertain) return out;
      lastError = alive.crash || lastError;
    } catch (e) {
      // 有明确崩溃信息时优先用它，否则保留原始启动错误
      if (!lastError) lastError = String(e.message || e);
    }

    if (!lastError) return 'started';
    const err = new Error(friendlyLaunchError(lastError, pkg));
    err.code = 'APP_CRASHED';
    err.crash = lastError;
    throw err;
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
    return String(out).split('\n').map((line) => {
      const l = line.trim();
      if (!l || l.startsWith('total ')) return null;
      // Android 的 ls -l 有「含 group」和「不含 group」两种格式，日期可能是
      // "2026-11-12 18:52" 或 "Nov 12 18:52"，用固定正则会全解析不出来。
      // 权限位之后的第 2 个数字即文件大小，最后一段即文件名。
      const parts = l.split(/\s+/);
      if (parts.length < 6 || !/^[\-dl]/.test(parts[0])) return null;
      const sizeIdx = parts.findIndex((p, i) => i >= 2 && /^\d+$/.test(p)
        && /(\d{4}-\d{2}-\d{2}|^[A-Za-z]{3}$)/.test(parts[i + 1] || ''));
      if (sizeIdx < 0) return null;
      const size = Number(parts[sizeIdx]);
      // 文件名在「时:分」token 之后（日期段 2-3 个 token，不固定）
      const timeIdx = parts.findIndex((p, i) => i > sizeIdx && /^\d{1,2}:\d{2}(:\d{2})?$/.test(p));
      const name = parts.slice((timeIdx >= 0 ? timeIdx : sizeIdx + 2) + 1).join(' ');
      return name ? { isDir: parts[0][0] === 'd', size, name } : null;
    }).filter(Boolean);
  }

  /**
   * 带真实 mtime 的远端列表（toybox stat）。
   * ls -l 的日期是「月 日 时:分」，无法可靠换算，会导致同步误判为「每次都变了」。
   * 返回 null 表示设备不支持 stat，调用方应退回 listRemote。
   */
  async listRemoteStat(remote) {
    let out = '';
    try {
      out = await this.shell(`cd "${remote}" 2>/dev/null && find . -type f -exec stat -c '%Y|%s|%n' {} + 2>/dev/null`);
    } catch (_) {
      return null;
    }
    const rows = parseStatList(out);
    if (!rows) return null;
    return rows;
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

  /**
   * 把应用申请的运行时权限一次性授掉。
   * 不授会有两个后果：① 首次启动弹系统授权框，用户看到的是「应用没打开」；
   * ② 清过数据（pm clear）之后权限会掉，应用起来就卡在授权页。
   */
  async grantRuntimePermissions(pkg) {
    let dump = '';
    try {
      dump = await this.shell(`dumpsys package ${pkg}`, { timeout: 20000 });
    } catch (_) {
      return [];
    }
    const lines = String(dump).split(/\r?\n/);
    let inRuntime = false;
    const denied = [];
    for (const line of lines) {
      if (/^\s*runtime permissions:/.test(line)) { inRuntime = true; continue; }
      if (!inRuntime) continue;
      if (/^\s{0,6}\S/.test(line)) break; // 离开 runtime permissions 段
      const m = /^\s+([A-Za-z0-9_.]+):\s*granted=(\w+)/.exec(line);
      if (m && m[2] === 'false') denied.push(m[1]);
    }
    const granted = [];
    for (const p of denied) {
      // eslint-disable-next-line no-await-in-loop
      const r = await this.shell(`pm grant ${pkg} ${p}`, { timeout: 8000 }).catch(() => null);
      if (r !== null) granted.push(p);
    }
    // 特殊权限走 appops，否则仍然会弹窗
    const ops = ['MANAGE_EXTERNAL_STORAGE', 'SYSTEM_ALERT_WINDOW', 'REQUEST_INSTALL_PACKAGES', 'WRITE_SETTINGS'];
    for (const op of ops) {
      // eslint-disable-next-line no-await-in-loop
      await this.shell(`cmd appops set ${pkg} ${op} allow`, { timeout: 8000 }).catch(() => {});
    }
    return granted;
  }

  /**
   * 进入「就是这个应用」的状态：
   *  - 收起锁屏，避免开机后停在锁屏挡住应用；
   *  - 隐藏状态栏（保留底部导航键，鼠标不在手边时还能点返回/主页）；
   *  - 关掉系统动画，低配机器上体感差别非常大。
   * 全部是 settings 级命令，一次几百毫秒，重复调用无害。
   */
  async prepareForeground() {
    const cmds = [
      'wm dismiss-keyguard',
      'settings put global policy_control immersive.status=*',
      'settings put secure immersive_mode_confirmations confirmed',
      'settings put global window_animation_scale 0',
      'settings put global transition_animation_scale 0',
      'settings put global animator_duration_scale 0',
      'settings put system screen_off_timeout 2147483647',
    ];
    for (const c of cmds) {
      // eslint-disable-next-line no-await-in-loop
      await this.shell(c, { timeout: 8000 }).catch(() => {});
    }
    return true;
  }

  /** 鼠标右键 / 侧键 / 快捷键映射：走常驻输入通道，右键返回不再有 100ms 级延迟 */
  async _key(code) {
    try {
      await this.input(`input keyevent ${code}`);
    } catch (_) {
      // 运行时刚重启、常驻 shell 还没连上时，退回一次性 adb，不能把这次点击丢掉
      await this.shell(`input keyevent ${code}`, { timeout: 6000 }).catch(() => {});
    }
  }

  async keyBack() { return this._key(4); }
  async keyForward() { return this._key(125); }

  /**
   * 横竖屏切换。
   * 不用 Ctrl+←（那是模拟器窗口的 Qt 快捷键，需要键盘焦点落在模拟器上，
   * 而用户点的是 ApkStart 标题栏上的旋转按钮，焦点在网页层，按键根本传不过去），
   * 直接走模拟器控制台命令，模拟器会自己把 LCD 转过来并调整窗口比例。
   */
  /**
   * 横竖屏切换。
   * 这里不用模拟器的 Ctrl+←：那条路只把**画面**转 90°，Android 里还是竖屏，
   * 用户看到的就是整屏横躺的文字（试过 emu rotate、user_rotation、聚焦后发按键，
   * 都是这个结果）。真正可行的是把 Android 的逻辑分辨率换成目标方向，
   * 系统会按新方向重新排版，界面始终是正的；模拟器随后跟着换成同样的比例。
   */
  async setOrientation(landscape) {
    try {
      if (!landscape) {
        await this.shell('wm size reset; wm density reset', { timeout: 15000 });
        return true;
      }
      const sizeOut = await this.shell('wm size', { timeout: 10000 });
      const m = /Physical size:\s*(\d+)x(\d+)/.exec(sizeOut);
      const w = m ? Math.max(Number(m[1]), Number(m[2])) : 1280;
      const h = m ? Math.min(Number(m[1]), Number(m[2])) : 720;
      const denOut = await this.shell('wm density', { timeout: 10000 });
      const dm = /Physical density:\s*(\d+)/.exec(denOut);
      const dpi = dm ? Number(dm[1]) : 0;
      const cmds = [`wm size ${w}x${h}`];
      if (dpi) cmds.push(`wm density ${dpi}`);
      await this.shell(cmds.join('; '), { timeout: 15000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 授权框还挂在最前面时（用户不在电脑前也能自愈），按返回键收掉 */
  async dismissPermissionDialog() {    try {
      const top = await this.shell('dumpsys activity activities', { timeout: 12000 });
      if (/GrantPermissionsActivity|permissioncontroller/i.test(String(top))) {
        await this.shell('input keyevent 4', { timeout: 6000 }).catch(() => {});
        return true;
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  /**
   * 显示适配：全屏时把 Android 分辨率改成显示器尺寸（内容自动铺满），
   * 窗口模式时恢复竖屏预设。wm 命令是运行时生效的，不需要重启 Android。
   */
  async setDisplaySize(width, height, density) {
    const w = Math.max(320, Math.round(Number(width) || 0));
    const h = Math.max(480, Math.round(Number(height) || 0));
    await this.shell(`wm size ${w}x${h}`);
    if (density) await this.shell(`wm density ${Math.max(120, Math.min(640, Math.round(density)))}`);
    return { w, h };
  }

  async resetDisplaySize() {
    await this.shell('wm size reset').catch(() => {});
    await this.shell('wm density reset').catch(() => {});
  }
}

module.exports = { AdbClient, AdbError, parseStatList, friendlyInstallError, friendlyLaunchError };
