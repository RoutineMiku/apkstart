'use strict';
/**
 * ApkStart 主进程
 * 职责：窗口 / 托盘 / 单实例 / 命令行分发（双击 apk、桌面快捷方式启动）/ IPC
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const store = require('./core/store');
const { Runtime } = require('./core/engine');
const { Installer } = require('./core/installer');
const { Sharer } = require('./core/sharer');
const { parseApk } = require('./core/apk');
const { drawAppIcon } = require('./core/png');
const { pngToIco } = require('./core/shortcut');
const assoc = require('./core/assoc');

const APP_ROOT = path.join(__dirname, '..');
const IS_DEV = process.argv.includes('--dev');
const ICON_PNG = drawAppIcon(256);

let mainWindow = null;
let tray = null;
let runtime = null;
let installer = null;
let sharer = null;
let quitting = false;

// ---------------- 命令行解析 ----------------

function parseArgs(argv) {
  const args = argv.slice(IS_DEV ? 2 : 1);
  const out = { apk: null, launch: null, silent: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--launch' && args[i + 1]) { out.launch = args[++i]; out.silent = true; }
    else if (a === '--silent') out.silent = true;
    else if (/\.(apk|xapk)$/i.test(a) && !a.startsWith('--')) out.apk = a;
  }
  return out;
}

function launcherInfo() {
  if (app.isPackaged) {
    return { target: process.execPath, args: '', cwd: path.dirname(process.execPath) };
  }
  return { target: process.execPath, args: `"${APP_ROOT}"`, cwd: APP_ROOT };
}

// ---------------- 主窗口 ----------------

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 740,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#f7f8fa',
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f7f8fa', symbolColor: '#2b3138', height: 44 },
    icon: nativeImage.createFromBuffer(ICON_PNG),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (show) mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    notify('ApkStart 仍在后台运行', '点击托盘图标可重新打开；右键托盘可退出。');
  });

  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  return mainWindow;
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notify(title, body) {
  if (store.getSettings().notifyOnInstall === false) return;
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) new Notification({ title, body, icon: nativeImage.createFromBuffer(ICON_PNG) }).show();
  } catch (_) { /* ignore */ }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------------- 托盘 ----------------

function buildTray() {
  const icon = nativeImage.createFromBuffer(drawAppIcon(64)).resize({ width: 16, height: 16 });
  try {
    tray = new Tray(icon);
  } catch (_) {
    return;
  }
  const refresh = () => {
    const apps = store.getApps().slice(0, 8);
    const menu = Menu.buildFromTemplate([
      { label: '打开 ApkStart', click: () => showWindow() },
      { type: 'separator' },
      ...(apps.length
        ? apps.map((a) => ({ label: a.label, click: () => runLaunch(a.package) }))
        : [{ label: '还没有安装应用', enabled: false }]),
      { type: 'separator' },
      { label: '同步共享目录', click: () => sharer.sync() },
      { label: '设置', click: () => { showWindow(); send('ui:navigate', 'settings'); } },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
  };
  tray.setToolTip('ApkStart — 安卓应用运行器');
  tray.on('double-click', () => showWindow());
  refresh();
  setInterval(refresh, 5000).unref?.();
}

// ---------------- 核心动作 ----------------

async function runInstall(filePath) {
  showWindow();
  send('install:start', { file: filePath });
  try {
    const result = await installer.install(filePath, (p) => send('install:progress', p));
    send('install:done', result);
    notify('安装完成', `${result.app.label} 已安装${result.app.shortcutPath ? '，桌面快捷方式已创建' : ''}`);
    return result;
  } catch (e) {
    send('install:error', { message: e.message });
    if (e.needsSetup) send('ui:navigate', 'setup');
    notify('安装失败', e.message.slice(0, 120));
    throw e;
  }
}

async function runLaunch(pkg) {
  try {
    const settings = store.getSettings();
    const r = await installer.launch(pkg, { onLog: (m) => send('runtime:log', m) });
    send('app:launched', { package: pkg, engine: r.engine });
    if (settings.hideAfterLaunch && !IS_DEV && !mainWindow?.isVisible()) {
      // 静默启动：不打扰用户
    }
    return { ok: true };
  } catch (e) {
    showWindow();
    send('toast', { type: 'error', message: `启动失败：${e.message}` });
    return { ok: false, error: e.message };
  }
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    isDev: IS_DEV,
    dataDir: store.DATA_DIR,
    exe: process.execPath,
    packaged: app.isPackaged,
  }));

  ipcMain.handle('apps:list', async () => {
    const apps = store.getApps();
    const settings = store.getSettings();
    let running = [];
    try {
      const c = runtime.client();
      if (await c.isOnline()) running = await c.runningPackages();
    } catch (_) { /* 运行时未启动时忽略 */ }
    return apps
      .map((a) => ({
        ...a,
        running: running.includes(a.package),
        iconUrl: a.iconPath && fs.existsSync(a.iconPath)
          ? `file:///${a.iconPath.replace(/\\/g, '/').replace(/ /g, '%20')}`
          : null,
        shortcutExists: a.shortcutPath ? fs.existsSync(a.shortcutPath) : false,
      }))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastLaunchAt || 0) - (a.lastLaunchAt || 0) || a.label.localeCompare(b.label, 'zh'));
  });

  ipcMain.handle('apk:pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择要安装的 APK',
      filters: [{ name: 'Android 应用', extensions: ['apk'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled) return [];
    return r.filePaths;
  });

  ipcMain.handle('apk:parse', async (_e, filePath) => parseApk(filePath));

  ipcMain.handle('apk:install', async (_e, filePath) => {
    const r = await runInstall(filePath);
    return { ok: true, app: r.app, warnings: r.warnings };
  });

  ipcMain.handle('app:launch', async (_e, pkg) => runLaunch(pkg));

  ipcMain.handle('app:uninstall', async (_e, pkg) => {
    await installer.uninstall(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:shortcut', async (_e, pkg) => {
    const appRecord = store.getApp(pkg);
    if (!appRecord) throw new Error('应用不存在');
    const p = installer.createShortcut(appRecord);
    store.upsertApp({ package: pkg, shortcutPath: p });
    return { ok: true, path: p };
  });

  ipcMain.handle('app:clearData', async (_e, pkg) => {
    const rt = await runtime.ensure();
    if (!rt.ok) throw new Error(rt.error);
    await rt.client.clearData(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:pin', async (_e, { pkg, pinned }) => {
    store.upsertApp({ package: pkg, pinned: !!pinned });
    return { ok: true };
  });

  ipcMain.handle('app:revealApk', async (_e, pkg) => {
    const a = store.getApp(pkg);
    if (a?.apkPath && fs.existsSync(a.apkPath)) shell.showItemInFolder(a.apkPath);
  });

  ipcMain.handle('apk:reveal', async () => {
    fs.mkdirSync(store.APK_DIR, { recursive: true });
    shell.openPath(store.APK_DIR);
  });

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, patch) => store.saveSettings(patch));

  ipcMain.handle('runtime:status', async () => runtime.status());
  ipcMain.handle('runtime:probe', async () => runtime.probe());
  ipcMain.handle('runtime:start', async () => {
    const r = await runtime.ensure({ onLog: (m) => send('runtime:log', m) });
    return r.ok ? { ok: true, engine: r.engine } : { ok: false, error: r.error, needsSetup: r.needsSetup };
  });
  ipcMain.handle('runtime:stop', async () => {
    await runtime.stop();
    return { ok: true };
  });
  ipcMain.handle('runtime:log', () => runtime.bootLog);

  // ---------------- 运行时自举 ----------------

  ipcMain.handle('provision:installAdb', async () => {
    try {
      const r = await runtime.provisioner.installAdb((p) => send('provision:progress', { ...p, component: 'adb' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installQemu', async () => {
    try {
      const r = await runtime.provisioner.installQemu((p) => send('provision:progress', { ...p, component: 'qemu' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:downloadIso', async () => {
    try {
      const r = await runtime.provisioner.downloadIso((p) => send('provision:progress', { ...p, component: 'iso' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:createDisk', async (_e, sizeGB) => {
    try {
      const r = await runtime.provisioner.createDisk(sizeGB || store.getSettings().runtime.diskSizeGB || 24,
        (p) => send('provision:progress', { ...p, component: 'disk' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importIso', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Android-x86 / Bliss OS 系统镜像',
      filters: [{ name: '系统镜像', extensions: ['iso', 'img'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      return { ok: true, ...runtime.provisioner.importIso(r.filePaths[0]) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importDisk', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择已安装 Android 的虚拟磁盘',
      filters: [{ name: '虚拟磁盘', extensions: ['qcow2', 'img', 'vmdk', 'raw'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      const info = runtime.provisioner.importDisk(r.filePaths[0]);
      store.saveSettings({ runtime: { installed: true } });
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:check', async () => runtime.provisioner.checkEnv());
  ipcMain.handle('provision:probeSources', async () => runtime.provisioner.probeSources());

  ipcMain.handle('runtime:startInstaller', async () => {
    try {
      await runtime.startInstaller({ onLog: (m) => send('runtime:log', m) });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:markInstalled', async () => {
    await runtime.markInstalled();
    return { ok: true };
  });

  ipcMain.handle('runtime:resetInstall', async () => {
    store.saveSettings({ runtime: { installed: false } });
    return { ok: true };
  });

  ipcMain.handle('assoc:status', () => {
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\.apk', '/ve'], { windowsHide: true, encoding: 'utf8' });
      return { registered: out.includes(assoc.PROGID) };
    } catch (_) {
      return { registered: false };
    }
  });

  ipcMain.handle('assoc:register', () => {
    const l = launcherInfo();
    const icoPath = path.join(store.ICON_DIR, 'apkstart.ico');
    if (!fs.existsSync(icoPath)) {
      const ico = pngToIco(ICON_PNG);
      if (ico) fs.writeFileSync(icoPath, ico);
    }
    return assoc.registerAssociation(l.target, icoPath, l.args);
  });

  ipcMain.handle('assoc:unregister', () => assoc.unregisterAssociation());

  ipcMain.handle('share:sync', async () => sharer.sync({ onLog: (m) => send('runtime:log', m) }));
  ipcMain.handle('share:open', async () => {
    const dir = store.getSettings().sharedDir;
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });

  ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:hide', () => mainWindow?.hide());
}

// ---------------- 生命周期 ----------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_evt, argv) => {
    const args = parseArgs(argv);
    if (args.launch) { runLaunch(args.launch); return; }
    if (args.apk) { runInstall(args.apk).catch(() => {}); return; }
    showWindow();
  });

  app.whenReady().then(async () => {
    store.ensureDirs();
    runtime = new Runtime(APP_ROOT);
    const l = launcherInfo();
    installer = new Installer(runtime, {
      launcherTarget: l.target,
      launcherArgs: l.args,
      cwd: l.cwd,
      isDev: IS_DEV,
      desktopDir: app.getPath('desktop'),
    });
    sharer = new Sharer(runtime);

    registerIpc();
    createWindow({ show: !parseArgs(process.argv).silent });
    buildTray();

    const args = parseArgs(process.argv);
    if (args.apk) runInstall(args.apk).catch(() => {});
    else if (args.launch) {
      const r = await runLaunch(args.launch);
      if (r.ok) {
        // 纯原生体验：从桌面图标启动时，不留下壳层界面
        setTimeout(() => { if (store.getSettings().hideAfterLaunch) { quitting = true; app.quit(); } }, 800);
      }
    }

    sharer.start(8000);

    // 冒烟测试：截图后退出，用于自动化验证界面是否正常渲染
    if (process.argv.includes('--smoke') && mainWindow) {
      const out = process.argv[process.argv.indexOf('--smoke') + 1] || 'smoke.png';
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            const img = await mainWindow.webContents.capturePage();
            fs.writeFileSync(out, img.toPNG());
          } catch (e) {
            console.error('[smoke] 截图失败', e);
          }
          quitting = true;
          app.quit();
        }, 3500);
      });
    }

    app.on('activate', () => showWindow());
  });

  app.on('window-all-closed', () => {
    // 正常关闭窗口时只隐藏到托盘（close 事件已拦截），
    // 走到这里说明是真正要退出，必须放行，否则进程会残留并占住单实例锁。
    if (quitting) app.exit(0);
  });

  app.on('before-quit', () => {
    quitting = true;
    sharer?.stop();
    runtime?.dispose();
  });
}
