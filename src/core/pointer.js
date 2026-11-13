'use strict';
/**
 * 鼠标键位映射（纯计算，不依赖 Electron / adb，便于单测）
 *
 * 应用窗口里嵌的是 Android Emulator 的 Qt 子窗口，原生行为是：
 *   左键 = 手指点击（正好就是「确认」，不需要我们介入）
 *   右键 = 也当成一次手指点击（会误触，必须拦下来改成「返回」）
 *   滚轮 = 单指滑动，但 Qt 每一格都单独发一次触摸事件，画面会抽搐
 *
 * 因此 ApkStart 只在「应用窗口处于前台」时装一个专用线程上的低级钩子，
 * 拦下右键与滚轮；滚轮按时间窗合并后翻译成一条 `input swipe`，
 * 既平滑又不会每次滚动都拉起一个 adb 进程。
 */

const WHEEL_NOTCH = 120;

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function clampInt(v, lo, hi) { return Math.round(clamp(v, lo, hi)); }

/**
 * 读取设置，得到钩子需要的开关。
 * 老配置里没有这些键时，按「右键返回 + 平滑滚轮、侧键关闭」迁移。
 */
function pointerOptions(settings = {}) {
  const e = (settings && settings.engine) || {};
  const rightBack = e.mouseRightBack !== false;
  const wheel = e.mouseWheelMode === 'native' || e.mouseWheelMode === 'off'
    ? e.mouseWheelMode : 'smooth';
  const side = !!e.mouseSideButtons;
  return { rightBack, wheel, side, enabled: rightBack || wheel === 'smooth' || side };
}

/** 把任意来源的配置收敛成 agent 能直接消费的 0/1 组合 */
function hookOptions(raw = {}) {
  let v = raw;
  // 兼容旧的布尔写法：true = 只开侧键映射
  if (typeof v === 'boolean') v = { enabled: v, rightBack: false, wheel: 'off', side: v };
  if (typeof v === 'function') v = v();
  if (!v || typeof v !== 'object') v = {};
  const rightBack = !!v.rightBack;
  const wheel = v.wheel === 'smooth' || v.wheel === true;
  const side = !!v.side;
  const enabled = 'enabled' in v ? !!v.enabled : (rightBack || wheel || side);
  return {
    enabled,
    rightBack: enabled && rightBack,
    wheel: enabled && wheel,
    side: enabled && side,
  };
}

/** 只允许我们自己在内部拼出来的 input 命令进 adb shell，杜绝命令注入 */
const INPUT_RE = /^input (?:keyevent \d{1,3}|swipe -?\d+ -?\d+ -?\d+ -?\d+ \d{1,4}|tap -?\d+ -?\d+)$/;
function isInputCommand(cmd) { return INPUT_RE.test(String(cmd || '')); }

/**
 * 把一批滚轮位移翻译成一次滑动手势。
 * @param {object} o { dx, dy, nx, ny, width, height } —— nx/ny 是光标在 LCD 内的归一化位置
 * @returns {{x1:number,y1:number,x2:number,y2:number,duration:number}|null}
 */
function wheelToSwipe({ dx = 0, dy = 0, nx = 0.5, ny = 0.5, width = 900, height = 1600 } = {}) {
  const w = clampInt(width, 240, 4096);
  const h = clampInt(height, 320, 4096);
  const vertical = Math.abs(Number(dy) || 0) >= Math.abs(Number(dx) || 0);
  const delta = vertical ? (Number(dy) || 0) : (Number(dx) || 0);
  if (!delta) return null;

  // 一格滚轮 = 约 30% 屏宽的滑动；连续快滚合并成一次更长的滑动（最多 78% 屏宽）
  const steps = clamp(Math.abs(delta) / WHEEL_NOTCH, 0.6, 6);
  const axis = vertical ? h : w;
  const span = clamp(Math.round(axis * 0.30 * steps), 80, Math.round(axis * 0.78));
  const half = Math.round(span / 2);
  const cx = clampInt(clamp(nx, 0, 1) * w, 8, w - 8);
  const cy = clampInt(clamp(ny, 0, 1) * h, 8, h - 8);

  let x1 = cx, y1 = cy, x2 = cx, y2 = cy;
  if (vertical) {
    // dy > 0（滚轮向上/远离）→ 手指向下滑，内容往顶部滚
    const dir = delta > 0 ? 1 : -1;
    y1 = clampInt(cy - half * dir, 1, h - 1);
    y2 = clampInt(cy + half * dir, 1, h - 1);
  } else {
    // dx > 0（横向滚轮向右）→ 手指向左滑
    const dir = delta > 0 ? -1 : 1;
    x1 = clampInt(cx - half * dir, 1, w - 1);
    x2 = clampInt(cx + half * dir, 1, w - 1);
  }
  const duration = clampInt(100 + 22 * steps, 100, 240);
  return { x1, y1, x2, y2, duration };
}

function swipeToCommand(swipe) {
  if (!swipe) return '';
  return `input swipe ${swipe.x1} ${swipe.y1} ${swipe.x2} ${swipe.y2} ${swipe.duration}`;
}

/**
 * 滚轮合并器：一个时间窗内的所有滚动只产生一条滑动命令。
 * 注入是异步的（adb shell 里 input swipe 要跑完整个手势），期间继续累计，
 * 完成后再补发一次，避免命令在 shell 里排队造成越滚越卡。
 */
class WheelRouter {
  constructor({ inject, getSize, flushMs = 80 } = {}) {
    this.inject = inject || (() => Promise.resolve());
    this.getSize = getSize || (() => ({ width: 900, height: 1600 }));
    this.flushMs = flushMs;
    this._acc = { dx: 0, dy: 0, nx: 0.5, ny: 0.5 };
    this._timer = null;
    this._busy = false;
    this._closed = false;
  }

  push(ev = {}) {
    if (this._closed) return;
    const dx = Number(ev.dx) || 0;
    const dy = Number(ev.dy) || 0;
    if (!dx && !dy) return;
    this._acc.dx += dx;
    this._acc.dy += dy;
    this._acc.nx = clamp(ev.nx, 0, 1);
    this._acc.ny = clamp(ev.ny, 0, 1);
    this._schedule();
  }

  _schedule() {
    if (this._closed || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._flush();
    }, this.flushMs);
    if (this._timer.unref) this._timer.unref();
  }

  _take() {
    const b = this._acc;
    this._acc = { dx: 0, dy: 0, nx: 0.5, ny: 0.5 };
    return (b.dx || b.dy) ? b : null;
  }

  async flush() { return this._flush(); }

  async _flush() {
    if (this._closed || this._busy) return;
    const batch = this._take();
    if (!batch) return;
    this._busy = true;
    try {
      const size = await this.getSize();
      const cmd = swipeToCommand(wheelToSwipe({ ...batch, width: size.width, height: size.height }));
      if (cmd && isInputCommand(cmd)) await this.inject(cmd);
    } catch (_) { /* 输入注入失败不能影响鼠标钩子 */ }
    finally {
      this._busy = false;
      if (!this._closed && (this._acc.dx || this._acc.dy)) this._schedule();
    }
  }

  dispose() {
    this._closed = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._acc = { dx: 0, dy: 0, nx: 0.5, ny: 0.5 };
  }
}

module.exports = {
  WHEEL_NOTCH, clamp, pointerOptions, hookOptions,
  isInputCommand, wheelToSwipe, swipeToCommand, WheelRouter,
};
