'use strict';
/**
 * 安装 / 启动 / 卸载 编排层
 * 把「解析 APK → 安装进运行时 → 落本地元数据 → 生成桌面快捷方式」串成一条流水线。
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { parseApk } = require('./apk');
const { pngToIco, writeShortcut, removeShortcut, safeFileName } = require('./shortcut');

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

  async install(filePath, onProgress = () => {}) {
    onProgress({ stage: 'parse', message: '正在解析 APK…' });
    const meta = parseApk(filePath);
    onProgress({
      stage: 'parse-done',
      message: `已识别 ${meta.label}（${meta.package}）`,
      meta: { label: meta.label, package: meta.package, versionName: meta.versionName },
    });

    onProgress({ stage: 'runtime', message: '正在准备安卓运行时…' });
    const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
    if (!rt.ok) {
      const err = new Error(rt.error || '运行时不可用');
      err.needsSetup = rt.needsSetup || 'provision';
      throw err;
    }
    const client = rt.client;

    // 已安装 → 走覆盖安装
    const existing = store.getApp(meta.package);
    onProgress({ stage: 'install', message: existing ? '正在更新应用…' : '正在安装应用…' });
    await client.install(filePath);
    this.runtime.touch();

    // 图标落盘
    let iconPath = null;
    let icoPath = null;
    if (meta.iconPng) {
      try {
        iconPath = store.iconPath(meta.package);
        fs.writeFileSync(iconPath, meta.iconPng);
        const ico = pngToIco(meta.iconPng);
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

    const app = {
      package: meta.package,
      label: meta.label,
      versionName: meta.versionName,
      versionCode: meta.versionCode,
      activity: meta.launchActivity,
      abis: meta.abis,
      minSdk: meta.minSdk,
      sizeBytes: meta.sizeBytes,
      iconPath,
      icoPath,
      apkPath: apkCopy,
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
    if (meta.abis.length && !meta.abis.some((a) => /x86|x86_64/.test(a))) {
      warnings.push('此应用仅含 ARM 原生库，需要运行时的 ARM 转译支持（部分 x86 镜像需手动开启）。');
    }
    if (meta.minSdk && meta.minSdk >= 30) {
      warnings.push(`要求 Android ${meta.minSdk}+，请确认运行时版本足够新。`);
    }
    client.batteryOptimizeOff(meta.package).catch(() => {});

    onProgress({ stage: 'done', message: `${app.label} 安装完成`, app });
    return { app, warnings, engine: rt.engine };
  }

  createShortcut(app) {
    const { target, baseArgs } = this.shortcutTarget();
    const args = `${baseArgs ? baseArgs + ' ' : ''}--launch "${app.package}"`.trim();
    const ico = app.icoPath && fs.existsSync(app.icoPath) ? app.icoPath : undefined;
    return writeShortcut({
      shortcutPath: this.shortcutPath(app),
      target,
      args,
      iconIcoPath: ico,
      description: `${app.label} — 由 ApkStart 运行`,
      cwd: this.ctx.cwd,
    });
  }

  async uninstall(pkg, { removeShortcut: rm = true } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure();
    if (rt.ok) await rt.client.uninstall(pkg).catch(() => {});
    if (app && rm) removeShortcut(app.shortcutPath);
    if (app) {
      try { if (app.iconPath && fs.existsSync(app.iconPath)) fs.unlinkSync(app.iconPath); } catch (_) {}
      try { if (app.icoPath && fs.existsSync(app.icoPath)) fs.unlinkSync(app.icoPath); } catch (_) {}
      try { if (app.apkPath && fs.existsSync(app.apkPath)) fs.unlinkSync(app.apkPath); } catch (_) {}
    }
    store.removeApp(pkg);
    return true;
  }

  async launch(pkg, { onLog = () => {} } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure({ onLog });
    if (!rt.ok) throw new Error(rt.error || '运行时不可用');
    const settings = store.getSettings();
    await rt.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
      freeform: settings.freeform,
      bounds: app ? app.bounds : null,
    });
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

module.exports = { Installer, accentOf };
