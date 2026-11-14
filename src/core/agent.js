'use strict';
/**
 * Windows 窗口代理：与 src/core/win/agent.ps1 里的常驻进程通信。
 *
 * 为什么不是每次 spawn 一个 PowerShell：窗口跟随鼠标拖动时会频繁改尺寸，
 * 每次起一个 powershell.exe 要 150~300ms，拖动就会一顿一顿的。
 * 这里只启动一次，之后走本机回环 TCP（一行一个 JSON），单次往返 <2ms。
 *
 * 代理可选负责 WH_MOUSE_LL 鼠标钩子：右键返回 / 滚轮滑动 / 侧键前进后退。
 * 该钩子是全局的，会介入系统里每一次鼠标事件，因此只在「应用窗口处于前台」
 * 且至少启用一项映射时安装，失焦立即卸载；回调只处理我们关心的 7 个消息。
 * 见 setHook(on, opts)。
 */
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const SCRIPT = path.join(__dirname, 'win', 'agent.ps1');
const CALL_TIMEOUT = 6000;

class WinAgent extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.sock = null;
    this.port = 0;
    this.ready = null;
    this.buf = '';
    this.pending = [];
    this.dead = false;
    this.hooked = false;
    this.hookConf = null;
  }

  get available() { return process.platform === 'win32' && fs.existsSync(SCRIPT); }

  /** 启动代理并等到 TCP 连上（幂等） */
  ensure() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      if (!this.available) { reject(new Error('窗口代理不可用')); return; }
      let out = '';
      let settled = false;
      const proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Port', '0',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

      this.proc = proc;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        this.ready = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      const onData = (chunk) => {
        out += chunk.toString('utf8');
        const m = /PORT=(\d+)/.exec(out);
        if (!m || settled) return;
        settled = true;
        this.port = Number(m[1]);
        this._connect().then(resolve).catch(fail);
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', (d) => { out += d.toString('utf8'); });
      proc.on('error', fail);
      proc.on('exit', () => {
        const wasReady = !!this.sock;
        this.proc = null;
        this.sock = null;
        this.ready = null;
        this.hooked = false;
        this.hookConf = null;
        this._failAll('窗口代理已退出');
        if (wasReady) this.emit('exit');
        fail(new Error('窗口代理启动失败'));
      });
      setTimeout(() => { if (!settled) fail(new Error('窗口代理启动超时')); }, 15000);
    });
    return this.ready;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: this.port }, () => resolve(this));
      sock.setEncoding('utf8');
      sock.setNoDelay(true);
      sock.on('data', (d) => this._onData(d));
      sock.on('error', (e) => { reject(e); });
      sock.on('close', () => {
        this.sock = null;
        this.ready = null;
        this._failAll('窗口代理连接断开');
      });
      this.sock = sock;
      this.buf = '';
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      // 事件带负载（滚轮的 dx/dy/nx/ny），老监听器忽略多余参数即可
      if (msg.ev) { this.emit(msg.ev, msg); continue; }
      const p = this.pending.shift();
      if (p) { clearTimeout(p.timer); p.resolve(msg); }
    }
  }

  _failAll(reason) {
    const list = this.pending;
    this.pending = [];
    for (const p of list) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  }

  /** 发送一条命令并等待回包 */
  async call(obj, timeout = CALL_TIMEOUT) {
    await this.ensure();
    if (!this.sock) throw new Error('窗口代理未连接');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`窗口代理超时: ${obj.cmd}`)), timeout);
      this.pending.push({ resolve, reject, timer });
      this.sock.write(`${JSON.stringify(obj)}\n`);
    });
  }

  // ---------------- 便捷方法 ----------------

  /** 把模拟器窗口嵌进宿主窗口，并摆到 x,y,w,h（宿主客户区坐标） */
  async embed(hostHwnd, rect) {
    return this.call({
      cmd: 'embed', host: String(hostHwnd),
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    });
  }

  async fit(rect) {
    return this.call({
      cmd: 'fit',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    }, 3000);
  }

  async rotate(dir = 'left') { return this.call({ cmd: 'rotate', dir }, 8000); }
  async hide() { return this.call({ cmd: 'hide' }, 3000); }
  async show() { return this.call({ cmd: 'show' }, 3000); }
  async detach() { return this.call({ cmd: 'detach' }, 5000); }
  async probe() { return this.call({ cmd: 'probe' }, 4000); }

  /**
   * 开机阶段把模拟器窗口（QWindowIcon 主帧缓冲）+ 它的工具栏（QWindowTool）
   * + qemu 的黑色控制台窗口全部藏起来，直到 embed 完成才显示。
   * 这是「彻底隐藏命令窗口 / 模拟器浮窗」的关键：emulator 拉起 detached 的
   * qemu 控制台子进程，Node 的 windowsHide 覆盖不到它；只能由窗口代理周期性
   * 用 ShowWindow(SW_HIDE) 压住。启动即调用，boot 期间每帧都压一次，
   * 避免任何闪现。失败（非 Windows / 代理不可用）时静默降级，不阻断启动。
   *
   * maxWaitMs：代理本身要现编译启动（几百毫秒，异常时可能十几秒）。调用点是在
   * 「拉起模拟器之前」，绝不能因为代理起不来把开机拖住，所以这里给个硬上限。
   * @param {number} maxWaitMs
   */
  async bootHide(maxWaitMs = 3000) {
    const call = this.call({ cmd: 'boothide', on: 1 }, 4000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /** 开机完成：停止隐藏，并让模拟器窗口显示出来（随后会被 embed 重新父化） */
  async bootShow() {
    return this.call({ cmd: 'boothide', on: 0 }, 4000).catch(() => ({ ok: false }));
  }

  /**
   * 全局鼠标钩子开关（幂等）。
   * 只在应用窗口前台、且至少一项映射开启时才安装；opts 变化时不重装线程，
   * 只把新开关发给常驻代理，避免窗口反复 focus / 改设置时反复装卸钩子。
   * @param {boolean} on
   * @param {{rightBack?:boolean, wheel?:boolean, side?:boolean}} opts
   */
  async setHook(on, opts = {}) {
    const want = !!on;
    const conf = {
      right: !!(opts && opts.rightBack),
      wheel: !!(opts && opts.wheel),
      side: !!(opts && opts.side),
    };
    // 默认关闭状态下不为了「关」而拉起 PowerShell 进程（冷启动零开销）
    if (!want && !this.hooked) return { ok: true, hooked: false };
    const sameConf = this.hookConf
      && this.hookConf.right === conf.right
      && this.hookConf.wheel === conf.wheel
      && this.hookConf.side === conf.side;
    if (want === this.hooked && sameConf) return { ok: true, hooked: this.hooked };
    const req = { cmd: 'hook', on: want ? 1 : 0, right: conf.right ? 1 : 0, wheel: conf.wheel ? 1 : 0, side: conf.side ? 1 : 0 };
    if (!want) {
      this.hooked = false;
      this.hookConf = null;
      return this.call(req, 3000).catch(() => ({ ok: false, hooked: false }));
    }
    const r = await this.call(req, 3000).catch(() => null);
    this.hooked = !!(r && r.hooked !== false);
    this.hookConf = this.hooked ? conf : null;
    return { ok: this.hooked, hooked: this.hooked };
  }

  dispose() {
    // 先卸载全局钩子再结束进程：即使代理被强杀，也不给系统留残留钩子
    if (this.hooked && this.sock) {
      try { this.sock.write('{"cmd":"hook","on":0}\n'); } catch (_) { /* ignore */ }
    }
    this.hooked = false;
    this.hookConf = null;
    try { this.sock?.end(); } catch (_) { /* ignore */ }
    try { this.sock?.destroy(); } catch (_) { /* ignore */ }
    try { this.proc?.kill(); } catch (_) { /* ignore */ }
    this.sock = null;
    this.proc = null;
    this.ready = null;
  }
}

module.exports = { WinAgent, AGENT_SCRIPT: SCRIPT };
