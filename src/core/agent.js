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

  /**
   * 声明「哪些目录里的进程才算我们的」。
   * 必须在 bootHide / embed 之前调用：窗口代理只允许碰这些进程创建的窗口。
   * 不传（或传空）时代理一个窗口都不动 —— 宁可偶尔漏一个黑窗，
   * 也绝不把别的 Qt 应用（微信 4.x 就是 Qt6、MuMu、音乐播放器）的窗口藏掉或嵌进来。
   * @param {string[]} dirs 运行时根目录 / 随包的 engine 目录
   * @param {number} [appPid] 主进程 pid：代理只允许把窗口嵌进这个进程的窗口，
   *        并以此为据决定「鼠标事件的当前窗口是不是我们的」（防止句柄被回收复用）
   */
  async scope(dirs, appPid) {
    /**
     * 目录必须解析成**真实路径**再交给代理。
     *
     * 代理是按「进程可执行文件路径前缀」判断窗口归属的，而 Windows 的
     * `Process.MainModule.FileName` 返回的是解析过 junction / 符号链接的真实路径。
     * 如果 ApkStart 自己是从一个目录联接（junction）启动的（例如把 dist\ApkStart-win64-portable
     * 链接到 build\_packout\...），传给代理的仍是链接路径，前缀就对不上 →
     * 代理认为「这不是我们的进程」→ 找不到模拟器窗口（日志里的 emu:0）→
     * 原生窗口接管失败 → 退回嵌入模式，用户看到的就是那个带旋转按钮的壳窗口。
     * 两个路径都保留：真实路径用于匹配，原路径兼容极少数会返回链接路径的环境。
     */
    const raw = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
    const list = [];
    for (const d of raw) {
      try {
        const real = fs.realpathSync.native ? fs.realpathSync.native(d) : fs.realpathSync(d);
        if (real) list.push(real);
      } catch (_) { /* 目录不存在就只留原路径 */ }
      list.push(d);
    }
    const uniq = [...new Set(list.filter(Boolean))];
    const req = { cmd: 'scope', dirs: uniq.join(';') };
    if (Number(appPid) > 0) req.pid = Number(appPid);
    return this.call(req, 4000).catch(() => ({ ok: false, n: 0 }));
  }

  /**
   * 把画面窗口嵌进宿主窗口，并摆到 x,y,w,h（宿主客户区坐标）。
   *
   * @param {number|string} hostHwnd 宿主窗口句柄
   * @param {object} rect { x, y, w, h, clipTop }
   * @param {string[]} [targets] 第三方底座报上来的候选句柄（"0x…"）。
   *        不传 = 老行为：由代理按进程作用域自己找自带 emulator 的窗口。
   *        传了 = 只嵌这些句柄里的一个（MuMu / 其它模拟器的画面窗口）。
   */
  async embed(hostHwnd, rect, targets = null) {
    const req = {
      cmd: 'embed', host: String(hostHwnd),
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    };
    if (Array.isArray(targets) && targets.length) {
      req.target = targets.map((t) => String(t)).join(',');
    }
    return this.call(req, 6000);
  }

  /** 候选句柄现在还存在几个（第三方底座就绪门禁用） */
  async windowReady(targets = []) {
    if (!Array.isArray(targets) || !targets.length) return { ok: false, alive: 0 };
    return this.call({ cmd: 'winready', target: targets.join(',') }, 3000)
      .catch(() => ({ ok: false, alive: 0 }));
  }

  async fit(rect) {
    return this.call({
      cmd: 'fit',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
      // 模拟器 Qt 窗口比 LCD 多出 EMU_PAD 的外框，我们让它向上/向左溢出把这个外框
      // 挤出客户区；溢出到标题栏上的那一条会被裁掉（否则点标题栏按钮时会冒黑边）。
      clipTop: Math.round(rect.clipTop || 0),
    }, 3000);
  }

  async rotate(dir = 'left') { return this.call({ cmd: 'rotate', dir }, 8000); }
  async hide() { return this.call({ cmd: 'hide' }, 3000); }
  async show() { return this.call({ cmd: 'show' }, 3000); }
  /** 通知代理进入低延迟模式：大幅降低窗口扫描频率，把 CPU 留给安卓渲染 */
  async setPerformanceMode(on) { return this.call({ cmd: 'perf', on: on ? 1 : 0 }, 3000); }
  /** @param {boolean} keep true=切到独立窗口模式（别把模拟器窗口藏掉，并保留句柄） */
  async detach(keep = false) { return this.call({ cmd: 'detach', keep: keep ? 1 : 0 }, 5000); }
  /** 独立窗口模式：把模拟器原生窗口摆到指定屏幕矩形（不嵌入） */
  async layout(rect) {
    return this.call({
      cmd: 'layout',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    }, 4000);
  }
  /**
   * 把模拟器原生窗口的标题从 "Android Emulator - apkstart:5554" 改成用户看得懂的名字。
   * 传空串时默认 "ApkStart"。代理会在巡检里持续补设（Qt 偶尔会自己改回去）。
   */
  async setTitle(text = 'ApkStart') {
    return this.call({ cmd: 'title', text: String(text || 'ApkStart') }, 4000);
  }
  /**
   * 给模拟器原生窗口设图标（独立窗口模式下任务栏/Alt+Tab 显示当前应用图标）。
   * @param {string} file PNG/ICO 绝对路径
   */
  async setIcon(file) {
    return this.call({ cmd: 'icon', file: String(file || '') }, 4000);
  }
  async probe() { return this.call({ cmd: 'probe' }, 4000); }
  /** 列出当前可见的顶层窗口（用于验证「只有软件界面 / 只有安卓应用窗口」） */
  async windows() { return this.call({ cmd: 'windows' }, 4000); }

  /**
   * 把头号可疑窗口「摘下 + 藏好」。
   * 宿主窗口销毁前必须调用：Windows 会在父窗口销毁时把跨进程的子窗口重新挂到桌面，
   * 并保持它原来的可见状态 —— 桌面上凭空多出来的 Android Emulator 黑窗就是这么来的。
   * 代理很忙（可能在编译 C#）时也不能拖着不关窗，所以这里给 700ms 硬上限。
   */
  async park(maxWaitMs = 700) {
    const call = this.call({ cmd: 'park' }, 2000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /**
   * 开启「常驻压制」：模拟器主窗（QWindowIcon）+ 工具栏 + qemu / netsimd 的控制台黑窗
   * 一律不允许露面，只有被 embed 进我们窗口的那一个除外。
   * 这是「打开软件只看到软件界面」的关键：emulator 拉起 detached 的 qemu / netsimd
   * 控制台子进程，Node 的 windowsHide 覆盖不到它们，只能由窗口代理周期性压住。
   * 现在模拟器还带 -qt-hide-window（窗口创建即隐藏），双保险，连第一帧都不会闪。
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

  /** 关掉常驻压制（正常情况下不再需要：嵌入后压制会自动跳过被嵌入的那个窗口） */
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
    // 故意不 kill 代理进程：断开连接后它会自己进入「守卫」状态（见 agent.ps1 的
    // _lingerUntil）。模拟器可能还在开机，几十秒后才把窗口显示出来；那时如果
    // 代理已经死了，桌面上就会留一个 Android Emulator 黑窗。模拟器进程消失后
    // 代理会自行退出，最多守 3 分钟。
    this.sock = null;
    this.proc = null;
    this.ready = null;
  }
}

module.exports = { WinAgent, AGENT_SCRIPT: SCRIPT };
