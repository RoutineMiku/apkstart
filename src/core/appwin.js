'use strict';
/**
 * 应用窗口：一个正在运行的安卓应用 = 一个干净的 Windows 窗口。
 *
 * 窗口里只有顶部一条 38px 的标题栏（旋转 / 最小化 / 最大化 / 关闭），
 * 下面的整块画面是嵌进来的模拟器窗口（SetParent），所以看不到安卓桌面、
 * 看不到模拟器自带的侧边工具栏，也不会多出第二个任务栏图标。
 */
const { BrowserWindow, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { hookOptions } = require('./pointer');

const TITLEBAR_H = 38;
/**
 * 模拟器窗口四周自带 8px 的灰色内边距（Qt 的边框留白），
 * 而真正的 LCD 画面是从 +8px 开始的。把子窗口整体放大 16px 并向左上偏移 8px，
 * 这圈灰边就正好被推到客户区外面，画面干净地贴满四周。
 */
const EMU_PAD = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function iconUrl(p) {
  if (!p || !fs.existsSync(p)) return '';
  return `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}?v=${fs.statSync(p).mtimeMs}`;
}

class AppWindow {
  constructor({ agent, setOrientation, mouseHook = false, pointerConfig = null }) {
    this.agent = agent;
    this.setOrientation = setOrientation || null;
    // 全局鼠标钩子只在「应用窗口前台 + 至少一项映射开启」时安装。
    // pointerConfig 传函数：设置页改了开关，下一次 focus 就生效，不用重启。
    this.mouseHook = mouseHook;
    this.pointerConfig = pointerConfig;
    this.win = null;
    this.pkg = null;
    this.state = { label: '', tip: '', ready: false, landscape: false };
    this._fitTimer = null;
    this._closedCb = null;
  }

  get isOpen() { return !!(this.win && !this.win.isDestroyed()); }

  /** 竖屏 / 横屏下窗口内容的目标尺寸（自动缩放到屏幕内） */
  static sizeFor(area, portrait, landscape) {
    const p = portrait || { w: 540, h: 960 };
    const availH = Math.max(360, (area.h || 1040) - TITLEBAR_H - 48);
    const availW = Math.max(300, (area.w || 1920) - 80);
    if (landscape) {
      const k = Math.min(availW / p.h, availH / p.w);
      return { w: Math.round(p.h * k), h: Math.round(p.w * k) };
    }
    const k = Math.min(availH / p.h, availW / p.w);
    return { w: Math.round(p.w * k), h: Math.round(p.h * k) };
  }

  _area() {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const a = d.workArea || d.bounds;
    return { x: a.x, y: a.y, w: a.width, h: a.height };
  }

  _scale() {
    try {
      const b = this.win ? this.win.getBounds() : this._area();
      return screen.getDisplayMatching(b).scaleFactor || 1;
    } catch (_) {
      return 1;
    }
  }

  /**
   * 打开（或复用）应用窗口。
   * @param {object} o { pkg, label, iconPath, portrait, fullscreen, onClosed }
   */
  open(o) {
    const { pkg, label, iconPath, portrait, fullscreen } = o;
    this._closedCb = o.onClosed || null;
    if (this.isOpen && this.pkg === pkg) {
      this.win.show();
      this.win.focus();
      return this.win;
    }
    this.close({ keepApp: true });

    this.pkg = pkg;
    this.portrait = portrait || { w: 540, h: 960 };
    this.state = { label: label || '应用', tip: '正在启动安卓运行时…', ready: false, landscape: false };

    const area = this._area();
    const size = AppWindow.sizeFor(area, this.portrait, false);
    const w = Math.max(320, size.w);
    const h = Math.max(420, size.h + TITLEBAR_H);

    const iconFile = iconPath && fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

    this.win = new BrowserWindow({
      width: w,
      height: h,
      minWidth: 320,
      minHeight: 420,
      x: Math.round(area.x + (area.w - w) / 2),
      y: Math.round(area.y + (area.h - h) / 2),
      show: false,
      frame: false,
      thickFrame: true,
      resizable: true,
      maximizable: true,
      backgroundColor: '#0b0c0e',
      title: label || 'ApkStart',
      icon: iconFile,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    this.win.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));
    // 页面标题会把窗口标题改成 shell.html 的 <title>，任务栏就认不出是哪个应用了，
    // 这里挡住，让 OS 标题一直等于应用名（任务栏悬浮提示、Alt+Tab 都靠它）。
    this.win.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      try { this.win.setTitle(label || 'ApkStart'); } catch (_) { /* 窗口可能已销毁 */ }
    });
    this.win.once('ready-to-show', () => {
      this.win.show();
      this._push();
    });

    const refit = () => this.scheduleFit();
    this.win.on('resize', refit);
    this.win.on('move', refit);
    this.win.on('maximize', refit);
    this.win.on('unmaximize', refit);
    this.win.on('restore', () => {
      this.agent.show().catch(() => {});
      this.scheduleFit();
    });
    this.win.on('minimize', () => { this.agent.hide().catch(() => {}); });
    this.win.on('close', () => { this._closing = true; });
    this.win.on('closed', () => {
      if (this._selfClose) return;   // close() 自己在 park 完成后收尾
      this.win = null;
      const pkg = this.pkg;
      this.pkg = null;
      this._closing = false;
      // 不走 close() 的关闭路径（Alt+F4、任务栏关闭、系统关机）也必须停掉安卓应用、
      // 把模拟器窗口摘下来。否则窗口消失了但应用还在后台跑，用户再点开会因为
      // 「已在运行」直接切过去，看起来就是「关不掉」。
      if (pkg && this._onCloseApp) {
        try { this._onCloseApp(pkg); } catch (_) { /* ignore */ }
      }
      Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(() => {
        if (this._closedCb) this._closedCb(pkg);
      });
    });
    // 只在「应用窗口真正处于前台」且至少一项鼠标映射开启时装全局钩子；
    // 失焦/关闭立即卸载，绝不让 ApkStart 在后台拖慢整个系统的鼠标。
    this.win.on('focus', () => this._syncHook(true));
    this.win.on('blur', () => this._syncHook(false));

    if (fullscreen) this.win.maximize();
    return this.win;
  }

  _pointerOptions() {
    const getter = this.pointerConfig || this.mouseHook;
    const raw = typeof getter === 'function' ? getter() : getter;
    return hookOptions(raw);
  }

  _syncHook(active) {
    const opts = this._pointerOptions();
    const on = !!active && opts.enabled;
    if (this.agent && typeof this.agent.setHook === 'function') {
      this.agent.setHook(on, opts).catch(() => {});
    }
  }

  /** 设置页改了鼠标映射：按当前焦点重新同步一次（不重装钩子线程） */
  refreshPointer() {
    const focused = this.isOpen && !!this.win.isFocused();
    if (!focused) {
      // 窗口没在前台：只卸载，别让钩子在后台空转
      if (this.agent && typeof this.agent.setHook === 'function') {
        this.agent.setHook(false).catch(() => {});
      }
      return;
    }
    this._syncHook(true);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this._push();
  }

  _push() {
    if (!this.isOpen) return;
    try {
      this.win.webContents.send('shell:state', {
        ...this.state,
        iconUrl: this.iconUrl || '',
      });
    } catch (_) { /* 窗口可能刚关闭 */ }
  }

  setIcon(p) { this.iconUrl = iconUrl(p); this._push(); }

  /**
   * 把模拟器窗口嵌进当前窗口，并铺满标题栏以下的区域。
   * 常驻压制不关闭：它会跳过「已经嵌进我们窗口」的那一个，其余窗口（含 qemu /
   * netsimd 的控制台黑窗）继续压住 —— 关了反而会给它们再露一次脸的机会。
   * 模拟器窗口偶尔还没创建好（快照恢复太快的机器上），这里重试两次。
   */
  async embed() {
    if (!this.isOpen) return false;
    let last = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!this.isOpen) return false;
      const hwnd = this._hwnd();
      if (!hwnd) return false;
      // eslint-disable-next-line no-await-in-loop
      const r = await this.agent.embed(hwnd, this._rect()).catch((e) => ({ ok: false, error: e.message }));
      last = r;
      if (r && r.ok) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(attempt < 2 ? 300 : 800);
    }
    // 把失败原因带出去：上层会写进 app.log，出问题时一眼能看出是「没找到模拟器窗口」
    // 还是「SetParent 失败」，不用再靠猜。
    this.lastEmbedError = last ? (last.error || `emu=${last.emu}`) : 'no-response';
    return false;
  }

  async fitNow() {
    if (!this.isOpen) return;
    await this.agent.fit(this._rect()).catch(() => {});
  }

  /** 模拟器子窗口应该占据的矩形（物理像素，已把 8px 内边距推出可视区） */
  _rect() {
    const sf = this._scale();
    const b = this.win.getContentBounds();
    return {
      x: -EMU_PAD,
      y: Math.round(TITLEBAR_H * sf) - EMU_PAD,
      w: Math.round(b.width * sf) + EMU_PAD * 2,
      h: Math.round((b.height - TITLEBAR_H) * sf) + EMU_PAD * 2,
    };
  }

  scheduleFit() {
    if (!this.isOpen) return;
    if (this._fitTimer) return;
    this._fitTimer = setTimeout(() => {
      this._fitTimer = null;
      this.fitNow();
    }, 40);
  }

  _hwnd() {
    try {
      const buf = this.win.getNativeWindowHandle();
      const v = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
      return v.toString();
    } catch (_) {
      return null;
    }
  }

  /**
   * 横竖屏切换。
   * 两步：先让 Android 按目标方向重新排版（画面始终是正的），再让模拟器按新比例
   * 重排一次窗口（它自己会算，CtrL+← 只是触发重排，不会改 Android 的方向），
   * 最后把我们的窗口换成同样的比例。
   */
  async rotate() {
    if (!this.isOpen) return this.state.landscape;
    const next = !this.state.landscape;
    if (this.setOrientation) await this.setOrientation(next).catch(() => {});
    await sleep(700);
    await this.agent.rotate(next ? 'left' : 'right').catch(() => {});
    await sleep(800);
    const area = this._area();
    const size = AppWindow.sizeFor(area, this.portrait, next);
    if (!this.win.isMaximized()) {
      this.win.setContentSize(Math.max(320, size.w), Math.max(420, size.h + TITLEBAR_H));
      const b = this.win.getBounds();
      this.win.setPosition(
        Math.round(area.x + (area.w - b.width) / 2),
        Math.round(area.y + (area.h - b.height) / 2),
      );
    }
    this.state.landscape = next;
    this._push();
    await sleep(250);
    await this.fitNow();
    // 模拟器换比例后还会自己再调一次窗口，收尾再贴合一次免得留黑边
    await sleep(600);
    await this.fitNow();
    return next;
  }

  toggleMaximize() {
    if (!this.isOpen) return;
    if (this.win.isMaximized()) this.win.unmaximize();
    else this.win.maximize();
    this.scheduleFit();
  }

  minimize() { if (this.isOpen) this.win.minimize(); }

  /**
   * 关闭窗口。默认同时停掉这个安卓应用（省内存），但保留引擎，下次点开是秒开。
   *
   * 顺序很重要：必须先把模拟器窗口从宿主窗口上「摘下并藏好」，再销毁宿主。
   * 反过来的话 Windows 会把跨进程的子窗口重新挂到桌面、并保持它原来的可见状态，
   * 用户桌面上就会凭空多出一个 "Android Emulator - apkstart5554" 的黑窗。
   */
  close({ keepApp = false } = {}) {
    if (!this.isOpen) return;
    const win = this.win;
    const pkg = this.pkg;
    this._syncHook(false);
    if (!keepApp && pkg && this._onCloseApp) this._onCloseApp(pkg);
    this._selfClose = true;
    this.win = null;
    this.pkg = null;
    const done = () => {
      try { win.destroy(); } catch (_) { /* ignore */ }
      this._selfClose = false;
      this._closing = false;
      if (this._closedCb) this._closedCb(pkg);
    };
    Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(done, done);
  }

  onCloseApp(cb) { this._onCloseApp = cb; }
}

module.exports = { AppWindow, TITLEBAR_H };
