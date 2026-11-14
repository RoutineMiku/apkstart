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
    // 上次「拉起就崩」的渲染后端（格式 `<emulator版本>|<gpu>`）；auto 模式下下次把它排到最后，
    // 免得每次开机都先白等 20 多秒再退到软件渲染。升级运行时会自动失效。
    badGpu: '',
    forceTcg: false,         // 保留给高级排障；正常路径已由 doctor 自动回退
    audio: true,             // 安卓应用的声音（提示音/视频）。关闭可省一点 CPU
    // ---- 轻量容器（默认全开省资源，用户可逐项关掉）----
    liteMode: true,          // 收敛 vCPU 配额，避免 qemu 占满物理核拖慢 Windows
    // 一句话策略：save（省资源）/ balanced（均衡）/ smooth（流畅，视频·游戏优先）。
    // 界面上只暴露这一个选项，保存时自动翻译成 liteMode / priorityMode / renderSize，
    // 底部仍然保留细项开关给高级用户。
    resourceMode: 'balanced',
    // 数据分区容量（GB）：应用、游戏缓存和它们的更新包都装在这里。
    // 0 = 自动（按磁盘剩余给 6/8GB）。改大后在下次开安卓时**就地扩容**，不丢已装应用。
    dataPartitionGB: 0,
    // 渲染分辨率：越低越流畅、越省电；auto = 按加速状态选 720x1280 / 540x960
    renderSize: 'auto',
    // 网络加速：给模拟器指定国内公共 DNS。安卓默认的 10.0.2.3 要走主机 DNS，
    // VPN / 公司网 / 某些运营商下解析会拖到几百毫秒，视频类应用首屏会明显发卡。
    fastDns: true,
    // 快照：quickboot 内存快照让二次启动只要几秒，代价是磁盘上多一份约 2~3GB 的
    // ram.bin。磁盘紧张时可以关掉（只影响启动速度，不影响应用数据）。
    keepSnapshot: true,
    // 日志上限（KB）：超过就滚动备份一份，避免长期使用把磁盘写满
    logLimitKB: 2048,
    // 鼠标键位：左键由模拟器原生映射为「确认/点击」，无需开关。
    // 右键返回与平滑滚轮需要低级钩子，但只在应用窗口前台时装，失焦即卸载。
    mouseRightBack: true,    // 右键 = 安卓返回（拦下 Qt 默认的「右键也当点击」误触）
    mouseWheelMode: 'smooth', // smooth = 合并后注入一次滑动 | native = 交给 Qt | off = 不处理
    mouseSideButtons: false, // 侧键返回/前进：默认关闭，开启才多装一项映射
    deepTrim: false,         // 深度裁剪系统后台包（Play 商店/向导等），默认不动系统
    priorityMode: 'balanced', // balanced=让出前台 | performance=qemu 用 Normal 优先级
    // 预热：启动 ApkStart 后在后台把安卓环境引导好，第一次点应用几乎不用等。
    // 代价是常驻约 1GB 内存（和 WSA / 应用宝电脑版一样的取舍），可随时关掉。
    prewarm: true,
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
    // 轻量版的运行时整包：默认从本项目 GitHub Release 下载（与「软件更新」同源），
    // 拿不到时自动退回 dl.google.com 分组件下载。可在这里换成自建镜像地址。
    preferGithubRuntime: true,
    runtimePackUrl: '',
    // GitHub 加速镜像前缀（可选）。国内直连 GitHub Releases 经常只有几十 KB/s，
    // 填成 https://ghfast.top/ 之类的镜像前缀即可把 downloads 请求转过去。
    // 留空 = 直连（也会先用 8 线程分块试，能跑满带宽）。
    mirrorPrefix: '',
    // 下载并发数：分块下载的连接数。默认 8，弱网/被限速时可调到 16。
    downloadConnections: 8,
    // 更新/下载的源选择。auto = 同时问 GitHub 与 Gitee、并对每个下载地址实测
    // 128KB 速度，谁快用谁；也可以强制只走某一边（企业网络只放行一个域名时有用）。
    sourcePreference: 'auto',
    // 自动尝试公共 GitHub 加速镜像（ghfast / gh-proxy）。关掉后只用直连 + 自定义前缀。
    // 这两个是第三方服务，只是转发公开的 release 文件，不涉及账号信息。
    autoMirror: true,
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

/**
 * 资源策略 → 具体开关。
 *   save     ：2 vCPU + 低优先级 + 540x960，老笔记本 / 挂机用；
 *   balanced ：vCPU 取物理核的一半（2~4）+ 让出前台 + 720x1280；
 *   smooth   ：不限制 vCPU + 与前台同优先级 + 720x1280，视频与游戏优先。
 * 分辨率先不动 1080p：quickboot 快照指纹与它绑定，改一次就要重冷启动，而 720p
 * 在手机比例的窗口里已经看不出区别，性能却差一档。
 */
function resourcePreset(mode) {
  switch (String(mode || '')) {
    case 'save':
      return { resourceMode: 'save', liteMode: true, priorityMode: 'balanced', renderSize: '540x960' };
    case 'smooth':
      return { resourceMode: 'smooth', liteMode: false, priorityMode: 'performance', renderSize: '720x1280' };
    case 'balanced':
    default:
      return { resourceMode: 'balanced', liteMode: true, priorityMode: 'balanced', renderSize: 'auto' };
  }
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
    // 只改了「资源策略」时，把它翻译成具体的三个开关，避免两套配置各说各话
    if (patch && patch.engine && patch.engine.resourceMode) {
      Object.assign(next.engine, resourcePreset(next.engine.resourceMode));
    }
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
