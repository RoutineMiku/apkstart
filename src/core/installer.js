'use strict';
/**
 * 安装 / 启动 / 卸载 编排层
 * 把「解析 APK → 安装进运行时 → 落本地元数据 → 生成桌面快捷方式」串成一条流水线。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { parseApk } = require('./apk');
const { ZipFile } = require('./zip');
const { iconToIco, writeShortcut, removeShortcut, safeFileName } = require('./shortcut');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** APK 只有 ARM 原生库（国产 App 绝大多数如此） */
function isArmOnly(meta) {
  return !!(meta && meta.abis && meta.abis.length && !meta.abis.some((a) => /x86/i.test(a)));
}

/**
 * 拆分安装包（.apks / .xapk）：解出里面的分片 APK 到纯 ASCII 临时目录。
 * 用文件版 ZIP 读取器 + 流式落盘：拆分包动辄 2GB+，整包读内存会失败。
 * 返回 { meta, files, cleanup }；meta 来自带 AndroidManifest 的 base APK。
 */
async function parseBundle(filePath) {
  const zip = new ZipFile(filePath);
  const dir = path.join(os.tmpdir(), 'apkstart-bundle', crypto.createHash('sha1')
    .update(filePath).digest('hex').slice(0, 12));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } };
  try {
    const apkNames = zip.names().filter((n) => /\.apk$/i.test(n));
    if (!apkNames.length) throw new Error('这个安装包里没有找到 APK 分片（可能不是 .apks/.xapk）');
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (let i = 0; i < apkNames.length; i++) {
      const target = path.join(dir, `split-${i}.apk`);
      // 单个分片也可能是几百 MB：流式解压，不经过 Buffer
      // eslint-disable-next-line no-await-in-loop
      await zip.pipeTo(apkNames[i], fs.createWriteStream(target));
      files.push(target);
    }
    let meta = null;
    for (const f of files) {
      try { meta = parseApk(f); break; } catch (_) { /* 分片里没有清单 */ }
    }
    if (!meta) throw new Error('拆分包的 base APK 解析失败');
    return { meta, files, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    zip.close();
  }
}

function accentOf(pkg) {
  let h = 0;
  for (let i = 0; i < pkg.length; i++) h = (h * 31 + pkg.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 62% 52%)`;
}

class Installer {
  constructor(runtime, ctx) {
    this.runtime = runtime;
    this.ctx = ctx; // { launcherTarget, launcherArgs, cwd, isDev, desktopDir }
  }

  shortcutTarget() {
    const { launcherTarget, launcherArgs } = this.ctx;
    return { target: launcherTarget, baseArgs: launcherArgs || '' };
  }

  iconFile(pkg) { return store.iconPath(pkg); }

  icoFile(pkg) { return path.join(store.ICON_DIR, `${pkg}.ico`); }

  shortcutPath(app) {
    const s = store.getSettings();
    const dir = s.shortcutDir && s.shortcutDir.trim() ? s.shortcutDir : this.ctx.desktopDir;
    return path.join(dir, `${safeFileName(app.label)}.lnk`);
  }

  /**
   * 桌面 + 开始菜单两份。
   * Windows 搜索索引的是「开始菜单 \ 程序」里的 .lnk，只放桌面会搜不到；
   * 有些机器的桌面被 OneDrive 重定向，开始菜单这份也保证入口不丢。
   */
  shortcutPaths(app) {
    const out = [this.shortcutPath(app)];
    if (this.ctx.startMenuDir && store.getSettings().createStartMenuShortcut !== false) {
      // 放在独立子目录：既能被 Windows 搜索索引到，又不会覆盖同名第三方应用的快捷方式
      // （实测「红果免费短剧」在开始菜单里已被另一个桌面助手占用）
      out.push(path.join(this.ctx.startMenuDir, 'ApkStart', `${safeFileName(app.label)}.lnk`));
    }
    return [...new Set(out)];
  }

  /** 兼容镜像按「首次遇到 ARM 应用」按需下载，作为共享只读基础层只下一次 */
  async ensureCompatImage(onProgress) {
    const prov = this.runtime.provisioner;
    if (prov.playImageInfo().ok) return true;
    onProgress({ stage: 'runtime', message: '首次安装 ARM 应用：正在下载兼容镜像（约 1.5GB，只需一次）…' });
    await prov.installPlayImage((p) => onProgress({ stage: 'runtime', message: p.message, percent: p.percent }));
    if (!prov.playImageInfo().ok) throw new Error('兼容镜像下载失败，请检查网络后重试');
    return true;
  }

  /** 切换镜像必须重启运行时；重启后把已装应用从本地 APK 备份重新灌回去 */
  async switchToCompat(onProgress) {
    const apps = store.getApps();
    store.saveSettings({ runtime: { compatImage: true } });
    onProgress({ stage: 'runtime', message: '正在切换到兼容镜像并重启运行时…' });
    try { await this.runtime.stop(); } catch (_) { /* ignore */ }
    // 等旧设备从 adb 列表里消失，避免被 ensure() 当成可复用实例
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ds = await this.runtime.client().devices().catch(() => []);
      if (!ds.some((d) => /^emulator-\d+$/.test(d.serial))) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
    if (!rt.ok) {
      const err = new Error(rt.error || '切换兼容镜像后运行时不可用');
      err.needsSetup = rt.needsSetup || 'provision';
      throw err;
    }
    for (const app of apps) {
      if (!app.apkPath || !fs.existsSync(app.apkPath)) continue;
      try {
        if (app.bundle) {
          // eslint-disable-next-line no-await-in-loop
          const b = await parseBundle(app.apkPath);
          // eslint-disable-next-line no-await-in-loop
          await rt.client.installMultiple(b.files);
          b.cleanup();
        } else {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.install(app.apkPath);
        }
        onProgress({ stage: 'runtime', message: `正在恢复已装应用 ${app.label}…` });
      } catch (_) { /* 单个应用恢复失败不阻塞 */ }
    }
    return rt;
  }

  async install(filePath, onProgress = () => {}) {
    onProgress({ stage: 'parse', message: '正在解析 APK…' });
    let meta;
    let bundle = null;
    if (/\.(apks|xapk)$/i.test(filePath)) {
      bundle = await parseBundle(filePath);
      meta = bundle.meta;
    } else {
      meta = parseApk(filePath);
    }
    onProgress({
      stage: 'parse-done',
      message: `已识别 ${meta.label}（${meta.package}）`,
      meta: { label: meta.label, package: meta.package, versionName: meta.versionName },
    });

    try {
      // 零配置：仅含 ARM 库的应用自动补齐带 ARM 翻译层的镜像，用户不用开任何开关
      if (isArmOnly(meta) && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const switched = await this.switchToCompat(onProgress);
        return this.finishInstall(switched, meta, filePath, bundle, onProgress);
      }

      onProgress({ stage: 'runtime', message: '正在准备安卓运行时…' });
      const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
      if (!rt.ok) {
        const err = new Error(rt.error || '运行时不可用');
        err.needsSetup = rt.needsSetup || 'provision';
        throw err;
      }
      return await this.finishInstall(rt, meta, filePath, bundle, onProgress);
    } finally {
      if (bundle) bundle.cleanup();
    }
  }

  /** 安装本体 + 落盘元数据 + 快捷方式；失败时带一次自动修复重试 */
  async finishInstall(rt, meta, filePath, bundle, onProgress) {
    const client = rt.client;
    const existing = store.getApp(meta.package);
    // 装完之后旧 quickboot 快照里的磁盘状态就过期了，留着会导致「装好的应用重启后又不见了」
    try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
    onProgress({ stage: 'install', message: existing ? '正在更新应用…' : '正在安装应用…' });
    try {
      if (bundle) await client.installMultiple(bundle.files);
      else await client.install(filePath);
    } catch (e) {
      // 到了这一步还报 ABI 不匹配：说明当前运行时是 AOSP 镜像，自动切兼容镜像再装一次
      if (e.code === 'NO_MATCHING_ABIS' && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const rt2 = await this.switchToCompat(onProgress);
        onProgress({ stage: 'install', message: '已切换兼容镜像，正在重新安装…' });
        if (bundle) await rt2.client.installMultiple(bundle.files);
        else await rt2.client.install(filePath);
      } else {
        throw e;
      }
    }
    this.runtime.touch();

    // 图标落盘。APK 图标大量是 WebP，nativeImage 解不了，交给渲染进程解码 +
    // 品牌占位图兜底，保证 .lnk 一定带图标（之前 icoPath 一直是 null）。
    // iconFallback 记录「真实图标解不出来、用了占位图」——这种要作为软警告告诉用户，
    // 否则桌面上只有一片绿色三角，用户会以为是 ApkStart 弄错了图标。
    let iconPath = null;
    let icoPath = null;
    let iconFallback = '';
    if (meta.iconPng) {
      try {
        iconPath = store.iconPath(meta.package);
        fs.writeFileSync(iconPath, meta.iconPng);
      } catch (_) { /* ignore */ }
      try {
        const ico = await iconToIco(meta.iconPng, {
          decode: this.ctx.decodeIcon,
          onFallback: (why) => { iconFallback = why; },
        });
        if (ico) {
          icoPath = this.icoFile(meta.package);
          fs.writeFileSync(icoPath, ico);
        }
      } catch (_) { /* 图标失败不影响安装 */ }
    }

    // 备份 APK，便于日后重装/找回
    let apkCopy = null;
    try {
      apkCopy = store.apkPath(meta.package, meta.versionCode.toString(36));
      fs.copyFileSync(filePath, apkCopy);
    } catch (_) { /* ignore */ }

    // 启动入口以系统解析结果为准：APK 里解析到的「主 Activity」经常不是
    // 真正的 LAUNCHER 入口，直接用它启动会跳过应用的初始化页导致闪退。
    let launchActivity = meta.launchActivity;
    try {
      client.clearLauncherCache?.(meta.package);
      const resolved = await client.resolveLauncher(meta.package);
      if (resolved) launchActivity = resolved;
    } catch (_) { /* 保留 APK 解析结果 */ }

    const app = {
      package: meta.package,
      label: meta.label,
      versionName: meta.versionName,
      versionCode: meta.versionCode,
      activity: launchActivity,
      abis: meta.abis,
      minSdk: meta.minSdk,
      sizeBytes: meta.sizeBytes,
      iconPath,
      icoPath,
      apkPath: apkCopy,
      bundle: !!bundle,
      accent: existing ? existing.accent : accentOf(meta.package),
      installedAt: existing ? existing.installedAt : Date.now(),
      updatedAt: Date.now(),
      launchCount: existing ? existing.launchCount || 0 : 0,
      lastLaunchAt: existing ? existing.lastLaunchAt || 0 : 0,
      shortcutPath: existing ? existing.shortcutPath || null : null,
      bounds: existing ? existing.bounds || null : null,
      pinned: existing ? !!existing.pinned : false,
    };

    store.upsertApp(app);

    const settings = store.getSettings();
    if (settings.createShortcutOnInstall) {
      onProgress({ stage: 'shortcut', message: '正在创建桌面快捷方式…' });
      try {
        app.shortcutPath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: app.shortcutPath });
      } catch (e) {
        onProgress({ stage: 'shortcut-warn', message: `快捷方式创建失败：${e.message}` });
      }
    }

    // 兼容性提示：只有 ARM 原生库时，x86 运行时需要转译层
    const warnings = [];
    if (meta.minSdk && meta.minSdk > 34) {
      warnings.push(`此应用要求 Android ${meta.minSdk}+，高于当前运行时，可能无法正常运行。`);
    }
    if (iconFallback === 'placeholder') {
      warnings.push('应用图标无法解析（可能是特殊格式的自适应图标），快捷方式暂时使用占位图标。');
    } else if (iconFallback === 'webp-decode-failed') {
      warnings.push('应用图标（WebP）解码失败，快捷方式暂时使用占位图标。');
    }
    client.batteryOptimizeOff(meta.package).catch(() => {});
    // 装应用时作废了旧快照，这里补排一次：空闲时把「已装好新应用」的状态存下来，
    // 否则下次开机要重新冷启动（20 多秒）。
    try { this.runtime.scheduleSnapshotSave?.(12000); } catch (_) { /* ignore */ }

    onProgress({ stage: 'done', message: `${app.label} 安装完成`, app });
    return { app, warnings, engine: rt.engine };
  }

  createShortcut(app) {
    const { target, baseArgs } = this.shortcutTarget();
    const args = `${baseArgs ? baseArgs + ' ' : ''}--launch "${app.package}"`.trim();
    const ico = app.icoPath && fs.existsSync(app.icoPath) ? app.icoPath : undefined;
    const paths = this.shortcutPaths(app);

    const write = (shortcutPath) => writeShortcut({
      shortcutPath,
      target,
      args,
      iconIcoPath: ico,
      description: `${app.label} — 由 ApkStart 运行`,
      cwd: this.ctx.cwd,
      // 每个应用一个 AUMID：任务栏上按应用分组，不会全挤到 ApkStart 里
      appUserModelId: `RoutineMiku.ApkStart.${app.package}`.slice(0, 128),
    });

    let first = null;
    let startMenuPath = null;
    const errors = [];
    paths.forEach((p, i) => {
      try {
        write(p);
        if (!first) first = p;
        if (i === 1) startMenuPath = p;
      } catch (e) {
        errors.push(`${p}: ${e.message}`);
      }
    });

    // 主路径全失败（自定义快捷方式目录不可写 / 被安全软件拦截）：
    // 退回桌面再试一次——桌面上有图标，用户才找得到应用。
    if (!first) {
      const fallback = path.join(this.ctx.desktopDir, `${safeFileName(app.label)}.lnk`);
      try {
        write(fallback);
        first = fallback;
      } catch (e) {
        errors.push(`${fallback}: ${e.message}`);
      }
    }
    if (!first) throw new Error(errors.join('; ') || '创建快捷方式失败');
    // 开始菜单那份的路径也存下来，卸载时一起删
    if (startMenuPath || first) {
      store.upsertApp({ package: app.package, startMenuPath });
    }
    return first;
  }

  /** 补全缺失的快捷方式与图标：老版本只建了桌面那份，且 WebP 图标当时没转成功 */
  async ensureShortcuts() {
    const made = [];
    // 用户明确关掉「安装后自动创建」、且这个应用本来就没有任何入口时不要擅自补，
    // 否则开关关掉了也挡不住启动时被重建。
    const auto = store.getSettings().createShortcutOnInstall !== false;
    for (const app of store.getApps()) {
      if (!auto && !app.shortcutPath && !app.startMenuPath) continue;
      let dirty = false;
      if ((!app.icoPath || !fs.existsSync(app.icoPath)) && app.iconPath && fs.existsSync(app.iconPath)) {
        try {
          const ico = await iconToIco(fs.readFileSync(app.iconPath), { decode: this.ctx.decodeIcon });
          if (ico) {
            const p = this.icoFile(app.package);
            fs.writeFileSync(p, ico);
            store.upsertApp({ package: app.package, icoPath: p });
            app.icoPath = p;
            dirty = true;
          }
        } catch (_) { /* 图标补建失败不影响入口 */ }
      }
      const missing = this.shortcutPaths(app).filter((p) => !fs.existsSync(p));
      if (!missing.length && !dirty) continue;
      try {
        // 图标刚补出来时，即使 .lnk 存在也要重建，让快捷方式换上真实应用图标
        const madePath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: madePath });
        made.push(app.label);
      } catch (_) { /* 单个失败不阻塞启动 */ }
    }
    return made;
  }

  async uninstall(pkg, { removeShortcut: rm = true } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure();
    if (rt.ok) await rt.client.uninstall(pkg).catch(() => {});
    if (app && rm) {
      removeShortcut(app.shortcutPath);
      removeShortcut(app.startMenuPath);
    }
    if (app) {
      try { if (app.iconPath && fs.existsSync(app.iconPath)) fs.unlinkSync(app.iconPath); } catch (_) {}
      try { if (app.icoPath && fs.existsSync(app.icoPath)) fs.unlinkSync(app.icoPath); } catch (_) {}
      try { if (app.apkPath && fs.existsSync(app.apkPath)) fs.unlinkSync(app.apkPath); } catch (_) {}
    }
    store.removeApp(pkg);
    return true;
  }

  async launch(pkg, { onLog = () => {}, beforeStart = null, onMark = () => {} } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure({ onLog });
    onMark('ensure done');
    if (!rt.ok) {
      const err = new Error(rt.error || '运行时不可用');
      err.needsSetup = rt.needsSetup;
      throw err;
    }
    // 分辨率要在拉起应用之前改，避免 wm size 触发配置变更把刚启动的 Activity 重建
    if (beforeStart) await beforeStart(rt).catch((e) => onLog(`显示适配跳过：${e.message}`));
    // 冷启动时顺手做过网络体检：没网就直接说清楚。否则用户只会看到「这个应用一直黑屏」，
    // 完全想不到是虚拟机没网（联网页面拿不到数据就是一块黑底）。
    // 关键修复：Wi-Fi 关联往往比 sys.boot_completed 晚几十秒，红果一进去就拉首页数据，
    // 没网时首页渲染成整块黑底 —— 这就是「点同意并继续后一直黑屏」的真正原因。
    // 所以拉起应用前先等网络就绪（最多 90 秒），宁可多等几秒也不要给用户一块黑屏。
    if (rt.engine === 'emulator' || rt.engine === 'builtin') {
      const net = await this.runtime.ensureNetwork({ onLog }).catch(() => null);
      if (net && net.ok) {
        onLog(`虚拟机网络就绪（${net.ip || ''}）`);
      } else {
        onLog('⚠ 虚拟机联网超时：需要联网的页面可能暂时黑屏，可在「设置 → 修复网络」重试。');
      }
    }
    const settings = store.getSettings();
    const start = () => rt.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
      freeform: settings.freeform,
      bounds: app ? app.bounds : null,
    });
    // 应用可能还没装进当前运行时（镜像重建 / 清过数据 / 首次），直接拉起会报
    // "Invalid packageName"。先在本地缓存里把它装上再启动，这样「点开应用」永远能进，
    // 不用先手动装一遍——这正是「点击已安装应用直接进入系统」想要的体验。
    if (app && app.apkPath && fs.existsSync(app.apkPath)) {
      const pkgs = await rt.client.shell(`pm list packages ${pkg}`, { timeout: 8000 }).catch(() => '');
      if (!new RegExp(`package:${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(pkgs)) {
        onLog('应用尚未安装，正在自动安装…');
        await rt.client.install(app.apkPath).catch((e) => onLog(`自动安装失败：${e.message}`));
      }
    }
    // 观察 25 秒并要求「连续存活 5 秒」才算启动成功。
    // 关键：进程"还没起来"和"起来过又没了"必须分开看。以前一看到 pidof 为空就判失败，
    // 结果大型应用（红果这种首启要十几秒的）在加载途中就被 force-stop 重启，
    // 反复三轮才勉强起来，用户感知就是"点了要等一分钟"。
    const staysAlive = async () => {
      const t0 = Date.now();
      let aliveSince = 0;
      let seen = false;
      while (Date.now() - t0 < 25000) {
        // 先查再睡：常驻容器里热启动往往 1 秒内就能看到进程，
        // 先 sleep 1 秒等于把最快的那条路径硬生生拖慢一秒。
        // eslint-disable-next-line no-await-in-loop
        const pid = await rt.client.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
        if (!String(pid).trim()) {
          if (seen) return false; // 起来过又消失 = 真的崩了
        } else {
          seen = true;
          if (!aliveSince) aliveSince = Date.now();
          if (Date.now() - aliveSince >= 4000) return true;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(700);
      }
      return seen; // 一直没见过进程才算失败
    };
    try {
      // 先确保运行时权限齐备：安装时的 -g 在清过数据后可能失效，
      // 缺权限时应用会被系统授权框挡住，用户看到的就是「点了没反应/打不开」。
      await rt.client.grantRuntimePermissions(pkg).catch(() => {});
      onMark('permissions granted');
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
        if (attempt > 1) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.forceStop(pkg).catch(() => {});
          // 授权框挡在最前面时，应用看起来就是「打不开」；先补授权再收掉弹窗
          // eslint-disable-next-line no-await-in-loop
          await rt.client.grantRuntimePermissions(pkg).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await rt.client.dismissPermissionDialog().catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await sleep(600 * attempt);
        }
        let started = true;
        try {
          // eslint-disable-next-line no-await-in-loop
          await start();
        } catch (e) {
          // 有明确崩溃日志才交给外层（可能要切兼容镜像）；没有证据多半只是启动慢，重试即可
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
          started = false;
        }
        onMark(`am start #${attempt} ${started ? 'ok' : 'fail'}`);
        // eslint-disable-next-line no-await-in-loop
        ok = started ? await staysAlive() : false;
        onMark(`alive #${attempt} ${ok}`);
        if (!ok && attempt < 3) onLog(`应用启动后退出（第 ${attempt} 次），正在自动重试…`);
      }
      if (!ok) {
        // 兜底：异常退出会留下「半初始化」的数据，导致之后每次都崩。
        // 清一次应用数据再拉起来，成功率最高（用户不必自己去设置里清缓存）。
        onLog('应用连续退出，正在重置应用数据后重试…');
        await rt.client.shell(`pm clear ${pkg}`, { timeout: 20000 }).catch(() => '');
        await sleep(800);
        // pm clear 会把运行时权限一并清掉，必须重新授，否则会卡在系统授权框
        await rt.client.grantRuntimePermissions(pkg).catch(() => {});
        await start().catch((e) => {
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
        });
        ok = await staysAlive();
        if (!ok) await rt.client.dismissPermissionDialog().catch(() => {});
      }
      if (!ok) {
        const err = new Error('应用启动后立即退出，已自动重试并重置应用数据仍未成功');
        err.code = 'APP_UNSTABLE';
        throw err;
      }
    } catch (e) {
      if (e.code === 'APP_CRASHED' && !this.runtime.provisioner.playImageInfo().ok) {
        // 崩溃来自 ARM 翻译层：自动切镜像、重装备份 APK、再启动一次
        onLog('检测到 ARM 翻译层崩溃，正在自动切换兼容镜像…');
        await this.ensureCompatImage(onLog ? (m) => onLog(m.message || '') : () => {});
        const rt2 = await this.switchToCompat((m) => onLog(m.message || ''));
        if (app && app.apkPath && fs.existsSync(app.apkPath)) {
          try { await rt2.client.install(app.apkPath); } catch (_) { /* 保留原包 */ }
        }
        await rt2.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
          freeform: settings.freeform,
          bounds: app ? app.bounds : null,
        });
      } else {
        throw e;
      }
    }
    this.runtime.touch();
    if (app) {
      store.upsertApp({
        package: app.package,
        launchCount: (app.launchCount || 0) + 1,
        lastLaunchAt: Date.now(),
      });
    }
    return { ok: true, engine: rt.engine };
  }
}

module.exports = { Installer, accentOf, parseBundle };
