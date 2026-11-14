'use strict';
/**
 * ApkStart 主进程
 * 职责：窗口 / 托盘 / 单实例 / 命令行分发（双击 apk、桌面快捷方式启动）/ IPC
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, nativeImage, screen, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');

const store = require('./core/store');
const { Runtime } = require('./core/engine');
const { Installer } = require('./core/installer');
const { Sharer } = require('./core/sharer');
const { parseApk } = require('./core/apk');
const { drawAppIcon } = require('./core/png');

// 品牌 Logo（build/render-logo.js 生成）；缺失时回退到程序化绘制的旧版图标
const LOGO_DIR = path.join(__dirname, 'ui', 'assets');
const LOGO_FILE = path.join(LOGO_DIR, 'logo.png');
const APPICON_FILE = path.join(LOGO_DIR, 'appicon.ico');
function loadBrandIcon(size) {
  try {
    if (fs.existsSync(LOGO_FILE)) {
      const img = nativeImage.createFromPath(LOGO_FILE);
      return size ? img.resize({ width: size, height: size, quality: 'best' }) : img;
    }
  } catch (_) { /* 落到程序化图标 */ }
  return nativeImage.createFromBuffer(drawAppIcon(size || 256));
}
const assoc = require('./core/assoc');
const windowctl = require('./core/windowctl');
const display = require('./core/display');
const { WinAgent } = require('./core/agent');
const pointer = require('./core/pointer');
const { AppWindow, TITLEBAR_H } = require('./core/appwin');
const { NotifyBridge } = require('./core/notify');
const { AndroidSettings } = require('./core/android');

// Windows 下窗口被遮挡时 capturePage 会拿到旧帧，自动化截图需要禁用遮挡计算
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// 应用窗口把模拟器以 SetParent 方式嵌进来当子窗口。Chromium 默认用
// DirectComposition 上半透明图层（Intermediate D3D Window /
// WS_EX_NOREDIRECTIONBITMAP）绘制网页，这层由 DWM 在窗口级别合成，
// 会直接盖住嵌入的子窗口——表现就是"画面全黑但安卓其实在跑"。
// 外壳界面只有一条 38px 标题栏和启动遮罩，走软件合成完全不卡，
// 关掉硬件加速后 Chromium 直接画进 HWND，子窗口层级才真正生效。
// 想对比效果时可以设 APKSTART_HWACCEL=1 启动。
if (process.env.APKSTART_HWACCEL !== '1') app.disableHardwareAcceleration();

const APP_ROOT = path.join(__dirname, '..');
const IS_DEV = process.argv.includes('--dev');

/**
 * 轻量文件日志：打包后没有控制台，出问题时用户可以把 app.log 发过来。
 * 只记关键节点和异常，正常路径几千行也不会撑爆。
 */
function appLog(line) {
  try {
    const dir = path.join(store.DATA_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'app.log'), `${new Date().toISOString()} ${line}\n`);
  } catch (_) { /* 日志失败不能影响主流程 */ }
}
process.on('uncaughtException', (e) => appLog(`UNCAUGHT ${e && (e.stack || e.message)}`));
process.on('unhandledRejection', (e) => appLog(`REJECT ${e && (e.stack || e.message || e)}`));

/**
 * 完整版（内置运行时）自动接管：
 * 发行包里 ApkStart.exe 旁边带有 runtime/（emulator + platform-tools + AEHD + ARM 兼容镜像）。
 * 首次启动（settings.json 尚不存在）时直接把 runtime.dir 指向它并开启兼容模式，
 * 用户无需任何下载与设置，开箱即用。之后用户仍可在设置里改回在线版。
 */
function bootstrapBundledRuntime() {
  try {
    const exeDir = path.dirname(process.execPath);
    // 便携版把运行时放在 exe 旁边；electron-builder 的 portable 会把资源解到
    // resources/ 下，进程 exe 和 resources 同级，所以几个候选位置都看一下。
    const candidates = [
      path.join(exeDir, 'runtime'),
      path.join(path.dirname(exeDir), 'runtime'),
      path.join(process.resourcesPath || '', 'runtime'),
      path.join(process.resourcesPath || '', 'app', 'runtime'),
    ];
    // 内置运行时只要求「有 emulator + 任意一套完整系统镜像」，不写死 API 版本：
    // 单文件发行版带的可能是更小的 AOSP 镜像，写死 API34 会让它误判成没有运行时。
    const hasImage = (dir) => {
      const root = path.join(dir, 'system-images');
      let apis = [];
      try { apis = fs.readdirSync(root); } catch (_) { return false; }
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) {
            const d = path.join(root, api, tag, abi);
            // 单文件发行版里的镜像是压缩存放的（system.img.xz / .gz），解压在首次启动时做。
            // 这里只认 system.img 会让「包里明明带了镜像」被判成没带，转而去联网下载。
            const hasSys = ['system.img', 'system.img.xz', 'system.img.gz']
              .some((f) => fs.existsSync(path.join(d, f)));
            if (hasSys && fs.existsSync(path.join(d, 'kernel-ranchu'))) return true;
          }
        }
      }
      return false;
    };
    const bundled = candidates.find((dir) =>
      fs.existsSync(path.join(dir, 'emulator', 'emulator.exe')) && hasImage(dir));
    if (!bundled) return;

    const s = store.getSettings();
    // 旧版只在 settings.json 不存在时接管：用户先装过在线版再解压完整版，
    // 就会一直走「缺组件」的部署向导。现在只要当前运行时目录里没有 emulator 就接管。
    const current = s.runtime.dir || path.join(store.DATA_DIR, 'runtime');
    const currentExe = path.join(current, 'emulator', 'emulator.exe');
    // 便携版被移动/升级（解压到新目录）后，settings 里记的还是旧路径：
    // 必须只认「本次 EXE 所在目录下的 runtime」，否则会一直用旧包里的组件
    // （实测踩过：旧包的 emulator 缺 emulator-check → 加速探测失败 → 退回 TCG 软件模拟）。
    const sameTree = path.resolve(current).toLowerCase()
      .startsWith(path.resolve(exeDir).toLowerCase());
    const currentOk = fs.existsSync(currentExe) && sameTree;
    // 已有可用运行时（含在线版）就尊重它：AVD 用户数据就在该目录下，不能悄悄搬走
    if (currentOk) {
      // 但仍把自动参数打开，旧配置里的硬编码 4G/4核/弃用 GPU 模式不能继续用
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // 包里带的是 Google Play 镜像才开兼容模式；AOSP 镜像带的是原生 x86_64 库
    let playBundled = false;
    try {
      const root = path.join(bundled, 'system-images');
      for (const api of fs.readdirSync(root)) {
        for (const tag of fs.readdirSync(path.join(root, api))) {
          if (/playstore|google_apis/i.test(tag)) playBundled = true;
        }
      }
    } catch (_) { /* 忽略 */ }
    store.saveSettings({
      runtime: { dir: bundled, compatImage: playBundled },
      engine: { gpuMode: 'auto', autoMemory: true },
    });
  } catch (_) { /* 接管失败不阻塞启动，走在线引导 */ }
}
bootstrapBundledRuntime();

// 冒烟截图等自动化场景下跳过注册表探测（避免依赖 reg.exe）
const NO_SHELL_PROBE = process.argv.includes('--smoke') || process.env.APKSTART_NO_SHELL_PROBE === '1';
const ICON_PNG = loadBrandIcon().toPNG();

let mainWindow = null;
let tray = null;
let runtime = null;
let installer = null;
let sharer = null;
let quitting = false;
let winAgent = null;
let appWin = null;
let notifier = null;
let androidSet = null;

// ---------------- 命令行解析 ----------------

function parseArgs(argv) {
  const args = argv.slice(IS_DEV ? 2 : 1).filter((a) => !a.startsWith('--allow-file-access'));
  const out = { apk: null, launch: null, silent: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--launch') {
      // Electron 会往 argv 里塞自己的开关和 app 路径，只认形如 com.foo.bar 的包名
      const v = args.slice(i + 1).find((x) => x && /^[a-zA-Z][\w]*(\.[\w]+)+$/.test(x));
      if (v) { out.launch = v; out.silent = true; }
    } else if (a === '--silent' || a === '--autostart') out.silent = true;
    else if (/\.(apk|xapk|apks)$/i.test(a) && !a.startsWith('--')) out.apk = a;
  }
  return out;
}

/** Chromium 能解 WebP，nativeImage 不能；用隐藏窗口把 APK 图标转成 PNG */
let decodeWindow = null;
async function decodeIcon(raw) {
  if (!decodeWindow || decodeWindow.isDestroyed()) {
    decodeWindow = new BrowserWindow({ show: false, width: 2, height: 2, skipTaskbar: true });
    await decodeWindow.loadURL('about:blank');
  }
  const mime = /^RIFF/.test(raw.toString('ascii', 0, 4)) ? 'image/webp' : 'image/png';
  const js = `(async () => {
    const img = new Image();
    img.src = 'data:${mime};base64,${raw.toString('base64')}';
    await img.decode();
    const s = Math.min(256, Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = s; c.height = s;
    c.getContext('2d').drawImage(img, 0, 0, s, s);
    return c.toDataURL('image/png');
  })()`;
  const url = await decodeWindow.webContents.executeJavaScript(js);
  return Buffer.from(String(url).split(',')[1] || '', 'base64');
}

/** 开机自启：默认开启，不需要用户去设置里勾 */
function applyAutoStart() {
  if (!app.isPackaged) return; // 开发时不写注册表
  const on = !!store.getSettings().autoStart;
  try {
    // 必须显式给 name，否则注册表里的启动项会叫 "electron.app.Electron"
    app.setLoginItemSettings({
      openAtLogin: on,
      name: 'ApkStart',
      path: process.execPath,
      args: ['--autostart'],
    });
    // 清掉旧版本（没传 name）留下的那条，避免重复启动
    app.setLoginItemSettings({ openAtLogin: false, name: 'electron.app.Electron' });
  } catch (_) { /* 组策略禁止时忽略 */ }
}

// ---------------- 显示模式：全屏自适应 / 竖屏窗口可调 ----------------

function displaySettings() { return store.getSettings().display || {}; }

function screenRect() {
  const d = screen.getPrimaryDisplay();
  const a = d.workArea || d.bounds;
  return { x: a.x || 0, y: a.y || 0, w: a.width || 1920, h: a.height || 1080 };
}

let currentAppPkg = null;
let wheelRouter = null;
const deviceSize = { value: null };

/** 滚轮注入需要知道 Android 侧分辨率；缓存一次，转屏/重启运行时后失效 */
async function getDeviceSize() {
  if (deviceSize.value) return deviceSize.value;
  try { deviceSize.value = await runtime.client().wmSize(); } catch (_) { /* 运行时还没起来 */ }
  if (!deviceSize.value || !deviceSize.value.width || !deviceSize.value.height) {
    const p = portraitSize();
    deviceSize.value = { width: p.w, height: p.h };
  }
  return deviceSize.value;
}

function portraitSize() {
  const d = displaySettings();
  return display.portraitSize(d.portrait || '540x960');
}

/** 设置页改动鼠标键位后，立刻按当前窗口焦点同步一次钩子配置 */
function refreshPointerMapping() {
  if (appWin && appWin.isOpen) appWin.refreshPointer();
  else if (winAgent && winAgent.hooked) winAgent.setHook(false).catch(() => {});
}

/** 打开（或复用）那个「一个应用一个干净窗口」 */
function openAppWindow(pkg, tip) {
  const rec = store.getApp(pkg);
  appWin.open({
    pkg,
    label: (rec && rec.label) || pkg,
    iconPath: rec && rec.icoPath,
    portrait: portraitSize(),
    fullscreen: displaySettings().mode === 'fullscreen',
  });
  appWin.setIcon(rec && rec.icoPath);
  appWin.setState({ tip: tip || '正在启动安卓运行时…', ready: false, landscape: false });
  currentAppPkg = pkg;
}

async function toggleDisplayMode() {
  const next = store.saveSettings({
    display: { mode: displaySettings().mode === 'fullscreen' ? 'window' : 'fullscreen' },
  });
  if (appWin && appWin.isOpen) {
    if (next.display.mode === 'fullscreen') appWin.win.maximize();
    else appWin.win.unmaximize();
    appWin.scheduleFit();
  }
  return next.display.mode;
}

/** 首次运行把 adb / emulator / 系统镜像一次装完，不再分 1~5 步 */
let deploying = false;
async function autoDeploy() {
  if (deploying || !store.getSettings().autoDeploy) return { ok: false, error: 'skipped' };
  deploying = true;
  const progress = (p) => send('provision:progress', { ...p, component: p.component || 'all' });
  try {
    const env = await runtime.provisioner.checkEnv();
    if (!env.adb.ok) {
      progress({ message: '正在准备 adb…' });
      await runtime.provisioner.installAdb(progress);
    }
    if (!env.emulator.ok) {
      progress({ message: '正在准备 Android 运行时…' });
      await runtime.provisioner.installEmulator(progress);
    }
    if (!env.sysimg.ok) {
      progress({ message: '正在准备 Android 系统镜像…' });
      await runtime.provisioner.installSystemImage(progress);
    }
    const after = await runtime.provisioner.checkEnv();
    return { ok: !!(after.adb.ok && after.emulator.ok && after.sysimg.ok) };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    deploying = false;
  }
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

  // 外链一律交给系统浏览器（公众号/GitHub 等），绝不把应用窗口导航走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

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
  const icon = loadBrandIcon(16);
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
      {
        label: displaySettings().mode === 'fullscreen' ? '切回竖屏窗口' : '全屏（自适应屏幕）',
        click: () => { toggleDisplayMode(); },
      },
      { label: '重建桌面/开始菜单快捷方式', click: () => { installer.ensureShortcuts().catch(() => {}); } },
      { label: '同步共享目录', click: () => sharer.sync() },
      { label: '设置', click: () => { showWindow(); send('ui:navigate', 'settings'); } },
      { type: 'separator' },
      {
        label: '退出',
        click: async () => {
          try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
          quitting = true;
          app.quit();
        },
      },
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
    // 新建的桌面图标要让资源管理器立刻刷新，否则用户会以为「没创建快捷方式」
    windowctl.refreshShell().catch(() => {});
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
  const t0 = Date.now();
  const mark = (s) => appLog(`launch ${pkg} ${s} +${Date.now() - t0}ms`);
  appLog(`launch start ${pkg}`);
  try {
    // 1) 先把「应用窗口」打开显示启动动画：整个过程看不到安卓桌面，也看不到模拟器窗口
    openAppWindow(pkg, '正在启动安卓运行时…');
    if (mainWindow && mainWindow.isVisible() && !IS_DEV) mainWindow.hide();

    const r = await installer.launch(pkg, {
      onLog: (m) => { send('runtime:log', m); appLog(`  rt ${m}`); },
      onMark: mark,
      beforeStart: async (rt) => {
        mark('engine ready');
        appWin.setState({ tip: '正在打开应用…' });
        // 沉浸式 + 关动画 + 收起锁屏：只做一次，之后每次启动都秒进
        await rt.client.prepareForeground().catch(() => {});
        mark('foreground ready');
      },
    });
    mark('app started');

    // 2) 应用真的活下来了，才把画面嵌进窗口（否则用户会看到闪一下的桌面/崩溃页）
    const embedded = await appWin.embed();
    mark('embedded');
    appWin.setState({ ready: true, tip: '' });
    // 容器会话：环境已经就绪，这里只做「按应用裁剪 + 打开后台轮询」，
    // 不再为这个 App 重新引导一遍 Android。鼠标键位钩子由窗口 focus 事件
    // 按设置决定，失焦即卸载。
    deviceSize.value = null;
    appWin.refreshPointer();
    await runtime.beginApp(pkg, { onActive: onContainerActive }).catch(() => {});
    send('app:launched', { package: pkg, engine: r.engine });
    appLog(`launch ok ${pkg} embedded=${embedded}`);
    return { ok: true, embedded };
  } catch (e) {
    appLog(`launch failed ${pkg}: ${e && (e.stack || e.message)}`);
    try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
    showWindow();
    send('toast', { type: 'error', message: `启动失败：${e.message}` });
    return { ok: false, error: e.message };
  }
}

/**
 * 容器有/无应用窗口时的后台任务开关。
 * 文件同步每 8 秒要遍历共享目录并走一次 adb find/stat，通知桥也在轮询；
 * 以前从 ApkStart 一启动就无条件开跑，哪怕一个 Android 应用都没打开。
 * 现在只在容器里真的有应用时才开，关掉最后一个窗口立刻停。
 */
function onContainerActive(on) {
  if (on) {
    sharer?.start(8000);
    startNotifier();
  } else {
    sharer?.stop();
    notifier?.stop();
  }
}

/** 通知桥：只在有应用窗口时轮询，关掉窗口就停，避免空转 */
function startNotifier() {
  if (!notifier) {
    notifier = new NotifyBridge({
      getClient: () => runtime.client(),
      getAppLabel: (pkg) => (store.getApp(pkg) || {}).label || pkg,
      getAppIcon: (pkg) => (store.getApp(pkg) || {}).icoPath || '',
      onOpen: (pkg) => {
        if (appWin && appWin.isOpen && appWin.pkg === pkg) {
          appWin.win.show();
          appWin.win.focus();
        } else {
          runLaunch(pkg).catch(() => {});
        }
      },
    });
  }
  notifier.start();
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    isDev: IS_DEV,
    dataDir: store.DATA_DIR,
    runtimeDir: runtime.provisioner.paths().root,
    exe: process.execPath,
    packaged: app.isPackaged,
  }));

  // 选文件夹（用于把运行时/镜像/已装应用挪到非系统盘）
  ipcMain.handle('dialog:openDir', async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择数据存放目录',
      defaultPath: defaultPath || store.DATA_DIR,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

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
      filters: [{ name: 'Android 应用', extensions: ['apk', 'apks', 'xapk'] }],
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
  ipcMain.handle('settings:set', (_e, patch) => {
    const next = store.saveSettings(patch);
    if (patch && patch.autoStart !== undefined) applyAutoStart();
    if (patch && patch.display && appWin && appWin.isOpen) {
      // 竖屏基准尺寸变了：只影响后续打开的窗口大小，不打断正在跑的应用
      appWin.portrait = portraitSize();
    }
    // 打开「开始菜单快捷方式」时立刻补齐，不用等下次安装
    if (patch && (patch.createStartMenuShortcut === true || patch.createShortcutOnInstall === true)) {
      installer.ensureShortcuts().catch(() => {});
    }
    // 鼠标键位变了：立刻按当前焦点重装/卸载钩子，不用等下次切窗口
    if (patch && patch.engine && (
      'mouseRightBack' in patch.engine || 'mouseWheelMode' in patch.engine || 'mouseSideButtons' in patch.engine
    )) {
      refreshPointerMapping();
    }
    return next;
  });

  // ---------------- 显示模式 / 快捷方式 / 一键部署 ----------------

  ipcMain.handle('display:state', () => ({
    ...displaySettings(),
    screen: screenRect(),
    current: currentAppPkg,
  }));

  ipcMain.handle('display:set', async (_e, patch) => {
    const next = store.saveSettings({ display: patch || {} });
    if (appWin && appWin.isOpen) {
      appWin.portrait = portraitSize();
      if (next.display.mode === 'fullscreen' && !appWin.win.isMaximized()) appWin.win.maximize();
      if (next.display.mode !== 'fullscreen' && appWin.win.isMaximized()) appWin.win.unmaximize();
      appWin.scheduleFit();
    }
    return next.display;
  });

  ipcMain.handle('display:toggle', () => toggleDisplayMode());

  ipcMain.handle('shortcut:rebuild', async () => ({ ok: true, fixed: await installer.ensureShortcuts() }));
  ipcMain.handle('runtime:autoDeploy', () => autoDeploy());
  // 关闭「深度裁剪」时把被 pm disable-user 的系统包恢复回来
  ipcMain.handle('settings:restoreSystem', async () => runtime.restoreSystemApps());
  // 鼠标键位改变：只同步配置，不再无条件卸载（右键返回/滚轮可能仍需要钩子）
  ipcMain.handle('settings:refreshPointer', async () => { refreshPointerMapping(); return true; });
  // 兼容旧界面：语义已改为「按设置重新同步」
  ipcMain.handle('settings:unhook', async () => { refreshPointerMapping(); return true; });

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

  // ---------------- 诊断 / 瘦身 ----------------

  ipcMain.handle('doctor:profile', async () => {
    const doctor = require('./core/doctor');
    // 已经开机就用实跑参数；没开机也要按「真实引擎版本 + 真实加速状态」推导，
    // 否则设置页会显示已弃用的 swiftshader_indirect / 软件模拟，和实跑不一致。
    let p = runtime.emulator.profile;
    if (!p) {
      const env = await runtime.provisioner.checkEnv();
      p = doctor.autoProfile({
        settings: store.getSettings(),
        accel: env.accel,
        emulatorVersion: env.emulator.version || '',
        diskMB: doctor.freeDiskMB(store.DATA_DIR),
      });
    }
    return { profile: p, text: doctor.describeProfile(p) };
  });

  ipcMain.handle('doctor:report', async () => {
    const r = await runtime.diagnostics();
    shell.showItemInFolder(r.file);
    return r;
  });

  // 微软 VC++ 2015-2022 x64 运行库：安卓模拟器（Qt6）与 qemu 都依赖它。
  // 缺了在「其他电脑」上会直接起不来（0xc0000135 / MSVCP140 缺失）。
  function vcRedistInstaller() {
    const p = runtime.provisioner.paths();
    const cands = [
      path.join(p.root, 'vc_redist.x64.exe'),
      path.join(process.resourcesPath || '', 'runtime', 'vc_redist.x64.exe'),
    ];
    return cands.find((c) => c && fs.existsSync(c)) || null;
  }
  ipcMain.handle('runtime:vcRedist', () => {
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk(), path: vcRedistInstaller() };
  });
  ipcMain.handle('runtime:installVcRedist', async () => {
    const file = vcRedistInstaller();
    if (!file) return { ok: false, reason: 'no-installer' };
    const { spawn } = require('child_process');
    await new Promise((resolve) => {
      // 用 RunAs 提权安装（VC++ 是系统级组件，需要管理员）；/quiet 静默 /norestart 不重启
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
        `Start-Process -FilePath "${file}" -ArgumentList '/quiet','/norestart' -Verb RunAs -Wait`],
      { windowsHide: true, stdio: 'ignore' });
      ps.on('exit', () => resolve());
      ps.on('error', () => resolve());
    });
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk() };
  });

  ipcMain.handle('runtime:usage', () => runtime.usage());

  ipcMain.handle('runtime:cleanup', async (_e, opts = {}) => {
    // 明确两次确认：先给清单，用户确认后才真正删；且只清理 ApkStart 自己的运行时目录
    if (!opts.apply) return runtime.cleanup({ apply: false, aggressive: !!opts.aggressive });
    const preview = runtime.cleanup({ apply: false, aggressive: !!opts.aggressive });
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['取消', `清理 ${preview.candidates.length} 项`],
      defaultId: 0,
      cancelId: 0,
      title: '确认清理运行时缓存',
      message: `将释放约 ${(preview.candidates.reduce((n, c) => n + c.size, 0) / 1048576).toFixed(0)} MB`,
      detail: '只删除旧镜像、旧快照、锁文件和非活动 AVD 的缓存，已安装的应用会保留。'
        + '此操作不可撤销，建议先导出诊断报告。',
    });
    if (response !== 1) return { ...preview, cancelled: true };
    return runtime.cleanup({ apply: true, aggressive: !!opts.aggressive });
  });

  // ---------------- 运行时自举 ----------------

  ipcMain.handle('provision:installEmulator', async () => {
    try {
      const r = await runtime.provisioner.installEmulator(
        (p) => send('provision:progress', { ...p, component: 'emulator' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installSysimg', async () => {
    try {
      const r = await runtime.provisioner.installSystemImage(
        (p) => send('provision:progress', { ...p, component: 'sysimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installPlayImage', async () => {
    try {
      const r = await runtime.provisioner.installPlayImage(
        (p) => send('provision:progress', { ...p, component: 'playimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAehd', async () => {
    try {
      const r = await runtime.provisioner.installAehd(
        (p) => send('provision:progress', { ...p, component: 'aehd' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** 提权安装 AEHD 驱动：弹出 UAC，用户确认后静默安装 */
  ipcMain.handle('provision:enableAccel', async () => {
    try {
      const p = runtime.provisioner.paths();
      const bat = path.join(p.aehdDir, 'silent_install.bat');
      if (!fs.existsSync(bat)) {
        const r = await runtime.provisioner.installAehd(
          (x) => send('provision:progress', { ...x, component: 'aehd' }),
        );
        if (!fs.existsSync(bat)) throw new Error(r.error || 'AEHD 驱动包未就绪');
      }

      await new Promise((resolve, reject) => {
        const { spawn: sp } = require('child_process');
        const esc = bat.replace(/'/g, "''");
        const ps = `try { $p = Start-Process -FilePath '${esc}' -WorkingDirectory '${path.dirname(bat).replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 2 }`;
        const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
          windowsHide: true,
        });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(
          code === 2 ? '已取消管理员授权（需要点「是」才能安装驱动）' : `驱动安装失败（退出码 ${code}）`,
        ))));
        proc.on('error', (e) => reject(e));
      });

      const accel = await runtime.provisioner.emulatorAccel();
      return { ok: accel.ok, accel, error: accel.ok ? '' : accel.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

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
    // 冒烟/无 shell 环境：不探测注册表（reg.exe 可能被策略拦截）
    if (NO_SHELL_PROBE) return { registered: false, skipped: true };
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
      // 优先用随包分发的多尺寸品牌 ICO，缺失时从 Logo PNG 现算
      if (fs.existsSync(APPICON_FILE)) fs.copyFileSync(APPICON_FILE, icoPath);
      else {
        const { pngToIco } = require('./core/shortcut');
        const ico = pngToIco(ICON_PNG);
        if (ico) fs.writeFileSync(icoPath, ico);
      }
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

  // ---------------- 应用窗口（只有 旋转 / 最小化 / 最大化 / 关闭） ----------------

  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.handle('shell:state', () => ({ ...appWin.state, iconUrl: appWin.iconUrl || '' }));
  ipcMain.handle('shell:minimize', (e) => winOf(e)?.minimize());
  ipcMain.handle('shell:maximize', (e) => {
    const w = winOf(e);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    appWin.scheduleFit();
  });
  ipcMain.handle('shell:close', (e) => { winOf(e)?.close(); });
  ipcMain.handle('shell:rotate', () => appWin.rotate());
  ipcMain.handle('shell:back', async () => { await runtime.client().keyBack(); });
  ipcMain.handle('shell:forward', async () => { await runtime.client().keyForward(); });

  // ---------------- 安卓系统设置（不用进安卓桌面） ----------------

  ipcMain.handle('android:status', async () => {
    try { return { ok: true, ...(await androidSet.status()) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:set', async (_e, { key, value }) => {
    try {
      switch (key) {
        case 'wifi': return { ok: true, ...(await androidSet.setWifi(!!value)) };
        case 'airplane': return { ok: true, ...(await androidSet.setAirplane(!!value)) };
        case 'volume': return { ok: true, ...(await androidSet.setVolume(value)) };
        case 'animations': return { ok: true, ...(await androidSet.setAnimations(!!value)) };
        case 'fontScale': return { ok: true, ...(await androidSet.setFontScale(value)) };
        case 'density': return { ok: true, ...(await androidSet.setDensity(value)) };
        default: return { ok: false, error: `未知设置项 ${key}` };
      }
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:open', async (_e, action) => {
    try { return { ok: true, ...(await androidSet.open(action)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:tune', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.tune({ pkg })) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:permissions', async (_e, pkg) => {
    try { return { ok: true, rows: await androidSet.permissions(pkg) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:grantAll', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.grantAll(pkg)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('app:foreground', () => {
    if (appWin && appWin.isOpen) { appWin.win.show(); appWin.win.focus(); return true; }
    return false;
  });
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
      // Windows 搜索索引的是开始菜单里的 .lnk，只放桌面会「搜不到应用」
      startMenuDir: path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      decodeIcon,
    });
    sharer = new Sharer(runtime);
    androidSet = new AndroidSettings(runtime);

    // 滚轮合并器：一个时间窗内的滚动只注入一条 input swipe，走常驻 adb shell。
    wheelRouter = new pointer.WheelRouter({
      getSize: getDeviceSize,
      inject: (cmd) => runtime.client().input(cmd),
    });

    // 窗口代理：只负责内嵌模拟器窗口。全局鼠标钩子只在应用窗口前台时按配置安装。
    winAgent = new WinAgent();
    appWin = new AppWindow({
      agent: winAgent,
      // 旋转要改 Android 的逻辑分辨率，交给 adb 客户端做
      setOrientation: async (landscape) => {
        deviceSize.value = null;
        return runtime.client().setOrientation(landscape);
      },
      // 传 getter：设置页改了键位，下一次窗口 focus / 刷新就生效，不用重启
      pointerConfig: () => pointer.pointerOptions(store.getSettings()),
    });
    appWin.onCloseApp((pkg) => {
      // 关窗口 = 停这个应用；最后一个窗口关掉时容器停放（降优先级、停轮询），
      // 但 Android 环境留着，下次点开是秒进而非重新冷启动。
      runtime?.endApp(pkg, { onIdle: onContainerActive }).catch(() => {});
    });

    // 代理进程意外退出后会重建，事件监听必须一起重新挂上（旧版会在这里丢掉
    // 右键返回与滚轮，表现是「用一会儿就没反应了」）。
    const attachAgentEvents = (agent) => {
      agent.on('back', () => { runtime.client().keyBack().catch(() => {}); });
      agent.on('forward', () => { runtime.client().keyForward().catch(() => {}); });
      agent.on('wheel', (m) => {
        if (pointer.pointerOptions(store.getSettings()).wheel === 'smooth') wheelRouter.push(m);
      });
      agent.on('exit', () => {
        const next = new WinAgent();
        winAgent = next;
        appWin.agent = next;
        attachAgentEvents(next);
      });
    };
    attachAgentEvents(winAgent);

    registerIpc();
    createWindow({ show: !parseArgs(process.argv).silent });
    buildTray();
    applyAutoStart();

    // 老版本只建过桌面快捷方式 / 图标是 null：启动即自动补齐，不用用户操作
    installer.ensureShortcuts().then((fixed) => {
      if (fixed && fixed.length) {
        windowctl.refreshShell().catch(() => {});
        notify('快捷方式已补齐', fixed.join('、'));
      }
    }).catch(() => {});

    // F11 全屏 / 窗口切换；全局快捷键只在 ApkStart 活着时有效
    try {
      globalShortcut.register('F11', () => { toggleDisplayMode(); });
    } catch (_) { /* ignore */ }

    const args = parseArgs(process.argv);
    if (args.apk) runInstall(args.apk).catch(() => {});
    else if (args.launch) await runLaunch(args.launch);

    // 首次运行的组件部署延后 20 秒：冷启动那段时间磁盘/CPU 已经打满，
    // 再并发下载解压只会让桌面更卡。真有应用要打开时 ensure() 自会准备。
    setTimeout(() => {
      autoDeploy().then((r) => {
        if (r && r.ok) send('toast', { type: 'ok', message: '运行时已自动准备完成' });
      }).catch(() => {});
    }, 20000).unref?.();

    // 文件同步 / 通知轮询不再无条件常驻：只在容器里真的有应用窗口时才跑
    // （见 onContainerActive）。

    // 冒烟测试：截图后退出，用于自动化验证界面是否正常渲染
    if (process.argv.includes('--smoke') && mainWindow) {
      const out = process.argv[process.argv.indexOf('--smoke') + 1] || 'smoke.png';
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            if (process.argv.includes('--setup')) {
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('btnRuntime').click(); true;",
              );
              await new Promise((r) => setTimeout(r, 2500));
            }
            if (process.argv.includes('--settings')) {
              const opened = await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  document.getElementById('btnSettings').click();
                  for (let i = 0; i < 50; i++) {
                    await new Promise((r) => setTimeout(r, 100));
                    if (document.getElementById('settingsMask').classList.contains('on')) return true;
                  }
                  return false;
                })()
              `);
              console.log('[smoke] settings opened =', opened);
              await new Promise((r) => setTimeout(r, 600));
              const dbg = await mainWindow.webContents.executeJavaScript(
                "JSON.stringify({ on: document.getElementById('settingsMask').classList.contains('on'), qr: !!document.querySelector('#aboutGroup img'), qrH: (document.querySelector('#aboutGroup img')||{}).naturalHeight, ver: (document.getElementById('aboutVer')||{}).textContent })",
              );
              console.log('[smoke] dom =', dbg);
            }
            // 窗口可能被遮挡导致拿到旧帧：强制重绘 + 连拍两帧取后一帧
            const snap = async (file) => {
              mainWindow.webContents.invalidate();
              await mainWindow.webContents.capturePage().catch(() => null);
              await new Promise((r) => setTimeout(r, 400));
              const im = await mainWindow.webContents.capturePage();
              fs.writeFileSync(file, im.toPNG());
              console.log('[smoke] saved', file);
            };
            await snap(out);
            if (process.argv.includes('--settings')) {
              // 再拍一张「关于」区（二维码 / GitHub / Powered by）
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('aboutGroup').scrollIntoView({ block: 'center' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-about.png'));
            }
          } catch (e) {
            console.error('[smoke] 截图失败', e);
          }
          quitting = true;
          app.quit();
        }, 6500);
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
    notifier?.stop();
    try { appWin?.close({ keepApp: false }); } catch (_) { /* ignore */ }
    try { winAgent?.dispose(); } catch (_) { /* ignore */ }
    try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
    runtime?.dispose();
    // 隐藏的图标解码窗口也算一个窗口，不关掉会让 window-all-closed 永远不触发
    try { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); } catch (_) { /* ignore */ }
  });
}
