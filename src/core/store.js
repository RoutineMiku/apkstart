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
    memoryMB: 4096,
    cores: 4,
    idleShutdownMinutes: 15,
    startVisible: true,
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
  },
  sharedDir: path.join(os.homedir(), 'ApkStartShared'),
  deviceSharedDir: '/sdcard/ApkStartShared',
  autoConnect: true,
  createShortcutOnInstall: true,
  shortcutDir: '',           // 空 = 桌面
  freeform: true,            // 独立窗口（Android 7+ freeform）
  hideAfterLaunch: true,
  notifyOnInstall: true,
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
    return deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE, {}));
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
