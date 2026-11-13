'use strict';
/**
 * 本地持久化：应用清单 + 设置
 * 数据目录：%APPDATA%\apkstart
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'apkstart');
const ICON_DIR = path.join(DATA_DIR, 'icons');
const APK_DIR = path.join(DATA_DIR, 'apks');
const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  adbPath: '',
  device: '127.0.0.1:5555',
  engine: {
    mode: 'builtin',         // builtin（自带运行时，默认） | attach（连接已有运行时，高级）
    qemuPath: '',
    systemImage: '',
    memoryMB: 0,             // 0 = 由 doctor 按机器内存自动决定
    cores: 0,                // 0 = 自动
    autoMemory: true,        // 零配置：自动推导内存/核心/磁盘/渲染参数
    idleShutdownMinutes: 15,
    startVisible: true,
    // 必须带窗口：无头模式 SurfaceFlinger 不出 VSYNC，应用进程活着但屏幕上什么都没有。
    // 带窗口的模拟器是原生 60fps + 原生鼠标键盘，ApkStart 只负责把它打扮成应用窗口。
    headless: false,
    gpuMode: 'auto',         // auto = 按 emulator 版本自动挑后端并逐级降级
    forceTcg: false,         // 保留给高级排障；正常路径已由 doctor 自动回退
    // ---- 轻量容器（默认全开省资源，用户可逐项关掉）----
    liteMode: true,          // 收敛 vCPU 配额，避免 qemu 占满物理核拖慢 Windows
    // 鼠标键位：左键由模拟器原生映射为「确认/点击」，无需开关。
    // 右键返回与平滑滚轮需要低级钩子，但只在应用窗口前台时装，失焦即卸载。
    mouseRightBack: true,    // 右键 = 安卓返回（拦下 Qt 默认的「右键也当点击」误触）
    mouseWheelMode: 'smooth', // smooth = 合并后注入一次滑动 | native = 交给 Qt | off = 不处理
    mouseSideButtons: false, // 侧键返回/前进：默认关闭，开启才多装一项映射
    deepTrim: false,         // 深度裁剪系统后台包（Play 商店/向导等），默认不动系统
    priorityMode: 'balanced', // balanced=让出前台 | performance=qemu 用 Normal 优先级
  },
  runtime: {
    dir: '',                 // 空 = %APPDATA%\apkstart\runtime
    qemuUrl: '',             // 手动指定 QEMU 安装包地址
    isoUrl: '',              // 手动指定系统镜像地址
    isoPath: '',             // 系统镜像（ISO）路径
    diskPath: '',            // 安装系统的虚拟磁盘
    diskSizeGB: 24,
    headless: false,         // 不显示虚拟机窗口（仅调试）
    installMode: 'guided',   // guided（引导手动安装） | auto（实验性自动安装）
    emulatorUrl: '',         // 手动指定 emulator 包地址（空 = 自动从 SDK 索引解析最新版）
    sysimgUrl: '',           // 手动指定系统镜像包地址
    compatImage: false,      // ARM 兼容模式：改用 Google Play 镜像（内置 native bridge，可装 ARM-only 应用）
  },
  sharedDir: path.join(os.homedir(), 'ApkStartShared'),
  deviceSharedDir: '/sdcard/ApkStartShared',
  autoConnect: true,
  createShortcutOnInstall: true,
  createStartMenuShortcut: true, // 开始菜单快捷方式 = 让 Windows 搜索能搜到应用
  shortcutDir: '',           // 空 = 桌面
  freeform: false,           // 共享一个运行时窗口，不再用 Android freeform 小窗
  hideAfterLaunch: false,    // 主进程必须常驻，否则一退出就把 Android 运行时杀掉了
  notifyOnInstall: true,
  autoStart: true,           // 开机自启，默认开启，用户无需设置
  autoDeploy: true,          // 首次运行自动完成全部部署，不再分 1~5 步
  display: {
    mode: 'window',          // window（竖屏窗口，可自由拉伸） | fullscreen（自动适配屏幕）
    portrait: '900x1600',    // 窗口模式的竖屏分辨率，可在设置里调大小
    density: 0,              // 0 = 按分辨率自动推导
    rememberBounds: true,    // 记住每个应用的窗口位置/大小
    autoFullscreenOnLaunch: false,
  },
};

function ensureDirs() {
  for (const d of [DATA_DIR, ICON_DIR, APK_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDirs();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const store = {
  DATA_DIR, ICON_DIR, APK_DIR,

  getSettings() {
    const s = deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE, {}));
    // 旧版本默认无头运行：应用进程能起来但屏幕上没有窗口，等效于「打不开」。
    // 无条件迁移到带窗口模式，且不再允许通过旧配置把它关掉。
    s.engine.headless = false;
    // 旧版本退出壳层时会杀掉整个 Android 运行时，导致桌面图标点开闪一下就没了。
    s.hideAfterLaunch = false;
    // 旧版本用 Android freeform 小窗，现在整个模拟器窗口就是应用窗口，
    // 应用必须铺满这块屏幕，否则会出现「窗口里再套一个小窗」。
    s.freeform = false;
    return s;
  },

  saveSettings(patch) {
    const next = deepMerge(this.getSettings(), patch);
    writeJson(SETTINGS_FILE, next);
    return next;
  },

  getApps() {
    const data = readJson(APPS_FILE, { apps: [] });
    return Array.isArray(data.apps) ? data.apps : [];
  },

  saveApps(apps) {
    writeJson(APPS_FILE, { apps });
  },

  upsertApp(app) {
    const apps = this.getApps();
    const i = apps.findIndex((a) => a.package === app.package);
    if (i >= 0) apps[i] = { ...apps[i], ...app };
    else apps.push(app);
    this.saveApps(apps);
    return app;
  },

  removeApp(pkg) {
    const apps = this.getApps().filter((a) => a.package !== pkg);
    this.saveApps(apps);
  },

  getApp(pkg) {
    return this.getApps().find((a) => a.package === pkg) || null;
  },

  iconPath(pkg) {
    return path.join(ICON_DIR, `${pkg}.png`);
  },

  apkPath(pkg, version = 'cur') {
    return path.join(APK_DIR, `${pkg}-${version}.apk`);
  },

  ensureDirs,
  DEFAULT_SETTINGS,
};

module.exports = store;
