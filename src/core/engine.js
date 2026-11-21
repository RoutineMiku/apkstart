'use strict';
/**
 * 运行时引擎：ApkStart 自带的 QEMU + Android-x86 虚拟机
 *
 * 设计原则：
 *  - 默认完全自持（builtin）：adb / QEMU / 系统镜像都由 ApkStart 自己管理，不依赖任何第三方模拟器
 *  - 所有对安卓的操作统一走 adb，因此引擎可替换
 *  - 虚拟机按需启动，空闲自动回收；启动后常驻复用，装/开应用几乎零等待
 */
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { AdbClient, isUnauthorizedError } = require('./adb');
const store = require('./store');
const { Provisioner } = require('./provision');
const { EmulatorEngine } = require('./emulator');
const doctor = require('./doctor');
const container = require('./container');
const backends = require('./backends');

const LOG_DIR = path.join(store.DATA_DIR, 'logs');
const MONITOR_PORT = 5556;
const EMU_PORT = 5554;
const EMU_SERIAL = `emulator-${EMU_PORT}`;

/** TCP 端口是否有人监听（用来判断上次留下的模拟器还在不在） */
function portAlive(port, timeout = 150) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeout, () => fin(false));
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
  });
}

class Runtime {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.emulator = new EmulatorEngine(appRoot);
    this.vmProc = null;
    this.vmStarting = false;
    this.installing = false;
    this.lastActivity = Date.now();
    this._watchdog = null;
    this._freeformReady = false;
    this._client = null;
    this._bootLog = [];
    this._activeApps = new Set();  // 容器会话：当前打开的应用窗口
    // 多窗口模式下被墓碑化（force-stop 但保留数据）的后台应用；下次点开走热恢复。
    this._tombstoned = new Set();
    // 最近一次网络体检结果。状态栏要显示「网络正常/未联网」，但状态是高频轮询的，
    // 不能每次都去 guest 里跑一遍 shell；这里只缓存结论，过期（>5 分钟）就不采信。
    this._lastNetwork = null;
    this.emuSerial = EMU_SERIAL;   // 端口是动态挑的，serial 跟着变
    /**
     * 后端适配层：把「安卓从哪来」从本类里抽出去。
     *
     * 0.5.6 起这里**只有一个实现**：builtin（自带 emulator + 系统镜像）。
     * 不再有 mumu / fydeos / attach 这些分支 —— 任何机器、任何设置、任何残留配置
     * 都只会拿到自带运行时，保证 ApkStart 永远独立运行、与第三方模拟器无关。
     */
    this._backend = null;
    this._backendId = '';
    store.ensureDirs();
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  /**
   * 当前后端实例（只有一个：builtin）。
   * @returns {import('./backends/base').Backend}
   */
  get backend() {
    if (!this._backend) {
      const made = backends.create({
        appRoot: this.appRoot, settings: this.settings, runtime: this, store, log: (l) => this.log(l),
      });
      this._backend = made.backend;
      this._backendId = made.id;
    }
    return this._backend;
  }

  /**
   * 设置里要的底座本机到底有没有。
   *
   * 现在只有自带运行时，它永远可用（缺镜像那是 provision 阶段的事，不是「底座不存在」）。
   * 保留这个方法是为了不改上层调用点。
   */
  async backendAvailable() {
    return { ok: true, id: 'builtin' };
  }

  /** 后端 id，永远是 'builtin'；界面和日志用 */
  get backendId() { return this.backend.id; }

  /** 丢掉旧的连接与端口假设（换运行时目录、重置数据后调用） */
  resetBackend() {
    if (this._backend && this._backend.dispose) {
      try { this._backend.dispose(); } catch (_) { /* ignore */ }
    }
    this._backend = null;
    this._backendId = '';
  }

  get settings() { return store.getSettings(); }

  /** emulator 引擎是否在运行 */
  get emuRunning() { return this.emulator.running(); }

  // ---------------- 基础 ----------------

  adbPath() {
    const s = this.settings;
    const p = this.provisioner.paths();
    // 自带 adb 永远排在第一位：同一台设备只认一份 adb 状态，不会出现 offline 反复抖动。
    if (fs.existsSync(p.adbExe)) return p.adbExe;
    if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    const local = path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe');
    if (fs.existsSync(local)) return local;
    return AdbClient.resolveAdb('', this.appRoot);
  }

  client(serial) {
    const useSerial = serial || this.emuSerial;
    const adbPath = this.adbPath();
    if (!this._client || this._client.serial !== useSerial || this._client.adbPath !== adbPath) {
      // 换端口/换 adb 时别把旧的常驻 adb shell 留在后台占着连接
      if (this._client && this._client.disposeInput) this._client.disposeInput();
      this._client = new AdbClient({ adbPath, serial: useSerial });
    }
    return this._client;
  }

  touch() { this.lastActivity = Date.now(); }

  log(line) {
    this._bootLog.push({ t: Date.now(), line });
    if (this._bootLog.length > 300) this._bootLog.shift();
  }

  // ---------------- 状态 ----------------

  /**
   * 给状态栏用的网络快照（最近一次体检结论）。
   * 超过 5 分钟就不采信：中间可能断过网，宁可显示「未知」也不要骗用户说还行。
   */
  _networkSnapshot() {
    const n = this._lastNetwork;
    if (!n) return null;
    if (Date.now() - n.at > 5 * 60 * 1000) return null;
    return { ok: n.ok, ip: n.ip, reason: n.reason };
  }

  /**
   * 后台补一次网络体检（不阻塞 status 返回）。
   * 状态栏要显示网络状态，但 status() 是高频轮询的，不能每次都去 guest 里跑 shell。
   * 所以第一次（或过期后）在后台跑一遍，结论缓存进 _lastNetwork，下一次轮询就能显示。
   */
  _probeNetworkInBackground() {
    if (this._netProbing) return;
    const n = this._lastNetwork;
    if (n && Date.now() - n.at < 60000) return;  // 一分钟内刚查过，别重复
    this._netProbing = true;
    this.emulator.checkNetwork(this.adbPath())
      .then((r) => {
        this._lastNetwork = { ok: !!(r && r.ok), ip: (r && r.ip) || '', reason: (r && r.reason) || '', at: Date.now() };
      })
      .catch(() => { /* 查不到就保持原样，下一轮再试 */ })
      .finally(() => { this._netProbing = false; });
  }

  async status() {
    const backend = this.backend;
    const env = await this.provisioner.checkEnv();
    const s = this.settings;
    const client = this.client();
    const result = {
      mode: s.engine.mode,
      backend: backend.id,
      backendLabel: backend.label,
      installed: !!s.runtime.installed,
      env,
      engineKind: env.engine,
      emulatorOk: env.emulator.ok,
      emulatorVersion: env.emulator.version,
      sysimgOk: env.sysimg.ok,
      sysimgNote: env.sysimg.note,
      accel: env.accel,
      vmRunning: this.emulator.running() || !!(this.vmProc && !this.vmProc.killed),
      vmStarting: this.vmStarting,
      installing: this.installing,
      adbOk: env.adb.ok,
      adbVersion: env.adb.version,
      qemuOk: env.qemu.ok,
      qemuVersion: env.qemu.version,
      deviceOnline: false,
      android: '',
      sdk: 0,
      freeform: false,
      ready: false,
      needsSetup: null,
      error: '',
      serial: this.emuSerial,
      network: this._networkSnapshot(),
      autoProfile: this.emulator.profile ? doctor.describeProfile(this.emulator.profile) : '',
      diagnosis: this.emulator.lastDiagnosis || null,
      attempts: this.emulator.attempts || [],
      // 「上次为什么没起来」：内存里没有就回落到落盘记录，设置页/诊断都能显示真实原因
      lastFailure: (this.emulator.lastFailure ? this.emulator.lastFailure() : null),
    };

    if (!env.adb.ok) {
      result.needsSetup = 'adb';
      result.error = '缺少 adb：点击「一键部署」自动下载';
      return result;
    }

    try {
      result.deviceOnline = await client.isOnline();
      if (result.deviceOnline) {
        const [android, sdk, ff] = await Promise.all([
          client.androidVersion().catch(() => ''),
          client.sdkInt().catch(() => 0),
          client.shell('settings get global enable_freeform_support').catch(() => '0'),
        ]);
        result.android = android;
        result.sdk = sdk;
        result.freeform = String(ff).trim() === '1' || this._freeformReady;
        this._probeNetworkInBackground();
      }
    } catch (e) {
      result.error = e.message;
    }

    if (result.deviceOnline) result.ready = true;
    else if (!env.emulator.ok) result.needsSetup = 'emulator';
    else if (!env.sysimg.ok) result.needsSetup = 'sysimg';
    // 不再把「没有硬件加速」当成阻塞步骤：doctor 会自动回退软件模拟，
    // 并在开机失败时按 GPU/加速/内存组合依次重试。
    else result.needsSetup = 'boot';

    result.phase = result.deviceOnline
      ? 'ready'
      : this.installing
        ? 'installing'
        : result.vmRunning
          ? 'booting'
          : 'idle';

    return result;
  }

  /**
   * 本机 adb 已连上的设备清单（只读诊断用）。
   *
   * 0.5.6 起不再有「连接已有运行时」模式：这里不会去主动 connect 别的模拟器端口，
   * 只把 adb 当前看到的设备如实列出来，方便排障时确认「是不是我们的 emulator-5554」。
   */
  async probe() {
    try {
      const devices = await this.client().devices();
      return devices
        .filter((d) => d.state === 'device')
        .map((d) => ({ name: d.serial, serial: d.serial }));
    } catch (_) {
      return [];
    }
  }

  // ---------------- 启动 / 停止虚拟机 ----------------

  buildArgs({ install = false, headless = false } = {}) {
    const s = this.settings;
    const p = this.provisioner.paths();
    const hv = this._hv || { whpx: false };
    const disk = s.runtime.diskPath || p.disk;
    const iso = s.runtime.isoPath || p.iso;
    const accel = hv.whpx ? 'whpx' : 'tcg';

    const args = [
      '-name', 'ApkStart Runtime',
      '-machine', `q35,accel=${accel}`,
      '-cpu', hv.whpx ? 'host' : 'max',
      '-smp', String(Math.max(2, s.engine.cores || 4)),
      '-m', String(s.engine.memoryMB || 4096),
      '-rtc', 'base=localtime',
      '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:5555-:5555',
      '-device', 'virtio-net-pci,netdev=net0',
      '-vga', 'std',
      '-usb', '-device', 'usb-tablet',
      '-monitor', `tcp:127.0.0.1:${MONITOR_PORT},server,nowait`,
    ];

    if (headless || s.runtime.headless) args.push('-display', 'none');

    if (install) {
      args.push('-boot', 'order=d');
      args.push('-cdrom', iso);
    } else {
      args.push('-boot', 'order=c');
    }
    args.push('-drive', `file=${disk},if=virtio,format=qcow2,cache=writeback`);
    return args;
  }

  async boot({ install = false, onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    this._hv = env.hypervisor;

    // 首选：官方 emulator（自带设备模型与 GPU 转译，体验最好）
    if (env.emulator.ok && env.sysimg.ok) {
      return this.bootEmulator({ env, onLog });
    }

    return this.bootQemu({ install, env, onLog });
  }

  /**
   * 用官方 emulator 启动 Android。
   * 与 QEMU+ISO 不同，这里没有"安装系统"这一步：镜像本身就是系统，首次启动即开机。
   */
  async bootEmulator({ env, onLog = () => {} } = {}) {
    if (this.vmStarting) {
      const started = Date.now();
      while (this.vmStarting && Date.now() - started < 300000) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
      }
      const c = this.client();
      if (await c.isOnline()) {
        await this.prepare(c);
        return { ok: true, client: c, reused: true };
      }
    }

    const accel = env && env.accel ? env.accel : await this.provisioner.emulatorAccel();
    if (!accel.ok) {
      onLog('未检测到硬件加速：将自动回退软件模拟（首次开机会明显变慢，无需手动设置）');
    }

    this.vmStarting = true;
    try {
      // probe 交给 EmulatorEngine 的开机循环：进程退出/致命日志时它会换一组参数重试
      // 每轮只发一次 adb 命令：以前是 get-state + getprop + pm path 三次进程拉起，
      // 快照恢复时一轮就差 300~500ms，正好卡在「点开应用」的观感上。
      let probeStart = Date.now();
      let errStreak = 0;
      let lastHeal = 0;
      let authHealed = false;  // 本次 start() 是否已因「未授权」作废旧快照冷启动过
      const diagUnauthorized = () => ({
        code: 'ADB_UNAUTHORIZED',
        title: '安卓调试授权未完成（需要点一次「允许」）',
        // 旧文案让人去删 %USERPROFILE%\.android\adbkey —— 实测那是**反向操作**：
        // 换了新密钥后，系统里已存的旧公钥仍然生效，两者对不上，反而永远授权不了
        // （Android 只在 adb_keys 不存在时才写入新公钥）。正确做法是在模拟器窗口里
        // 点一次「允许」，或者清空安卓数据让系统重建授权表。
        hint: '模拟器停在「允许 USB 调试？」对话框。请在那个模拟器窗口里点「允许」——'
          + '勾选「一律允许使用这台计算机进行调试」再点，之后就不会再问。'
          + '若窗口点不动或一直不出现：设置 → 运行时 → 清空安卓数据后重试'
          + '（会清掉已装应用，重新安装即可，不会影响 APK 文件）。',
      });
      const probe = async ({ serial }) => {
        if (!this.emulator.running()) return 'fatal';
        if (!this._probeClient || this._probeClient.serial !== serial) {
          this._probeClient = new AdbClient({ adbPath: this.adbPath(), serial });
        }
        const c = this._probeClient;
        try {
          const out = String(await c.shell('getprop sys.boot_completed; pm path android', { timeout: 8000 }));
          const lines = out.split(/\r?\n/).map((l) => l.trim());
          const booted = lines[0] === '1' || /^1$/.test(lines[0] || '');
          const pmReady = lines.some((l) => /^package:/.test(l));
          errStreak = 0;
          if (booted && pmReady) return 'ok';
          return booted ? 'pending' : 'booting';
        } catch (e) {
          errStreak += 1;
          // 关键分支：adb shell 报错可能是「还没开机」也可能是「授权对话框卡住」。
          // 后者每轮 shell 都抛异常，旧实现只当普通 offline：重启 server 后继续按
          // 240s×4 组参数干等，最后报「运行时未能完成开机」，让用户以为是显卡/虚拟化。
          // 这里先按报错文本、再按 devices 的 state 列（get-state 分不清 authorized）
          // 双重确认 unauthorized，命中就作废旧快照冷启动 + 给出准确诊断，不再空等。
          const raw = String((e && (e.raw || e.stdout || e.message)) || '');
          let unauthorized = isUnauthorizedError(raw);
          if (!unauthorized) {
            const st = await c.deviceState().catch(() => '');
            unauthorized = st === 'unauthorized';
          }
          if (unauthorized) {
            this.emulator.lastDiagnosis = diagUnauthorized();
            if (!authHealed) {
              authHealed = true;
              onLog('adb 卡在「允许 USB 调试」授权对话框，正在作废旧快照并冷启动以重新注入公钥…');
              try { this.emulator.invalidateSnapshot(); } catch (_) { /* ignore */ }
              this.emulator._coldBoot = true; // 下一轮强制冷启动，让 emulator 重新注入 adb 公钥
              await this.emulator.resetAdbServer().catch(() => {});
              this._probeClient = null;
            }
            // 交给 start() 立刻换一组参数重试；冷启动后 dialog 问题会消失
            return 'fatal';
          }
          // 其它 adb 传输异常：沿用原来的重启 server 自愈
          const now = Date.now();
          if (errStreak >= 6 && now - probeStart > 25000 && now - lastHeal > 30000) {
            lastHeal = now;
            onLog('adb 连接异常，重启 adb server 后继续等待…');
            await this.emulator.resetAdbServer().catch(() => {});
            this._probeClient = null;
          }
          return 'pending';
        }
      };

      const st = await this.emulator.start({
        headless: this.settings.engine.headless !== false,
        onLog,
        probe,
      });
      // start() 失败时是「返回 {ok:false}」而不是抛异常（磁盘不足、多次重试仍失败等）。
      // 老实现不看这个字段，直接把 ok:true 往上返回 —— 上层于是认为「已经就绪」，
      // 接着 adb 一顿报 device not found，用户看到的是「点开没反应」而不是真实原因。
      if (!st || st.ok === false) {
        return {
          ok: false,
          error: (st && st.error) || '安卓运行时未能启动',
          needsSpace: !!(st && st.needsSpace),
          attempts: (st && st.attempts) || [],
          diagnosis: this.emulator.lastDiagnosis,
          exitCode: st && st.exitCode,
        };
      }
      this.lastActivity = Date.now();
      this.emuSerial = st.serial || this.emulator.serial;
      const client = this.client(this.emuSerial);
      await this.prepare(client);
      // 快照改成「空闲时再存」：立刻存要写 1~3GB，会和用户刚点开的应用抢磁盘 I/O
      this._armSnapshotSave(20000);
      return { ok: true, client, engine: 'emulator', serial: this.emuSerial, profile: st.profile, network: st.network || null };
    } catch (e) {
      // 把自动重试/诊断结论原样抛给 UI，避免再包一层含糊的「启动失败」
      return { ok: false, error: e.message, diagnosis: e.diagnosis, report: e.report, attempts: e.attempts };
    } finally {
      this.vmStarting = false;
    }
  }

  // ---------------- 预热（像 WSA 一样让环境常驻） ----------------

  /** 空闲时保存 quickboot 快照：只在没有应用窗口时写盘，避免和应用启动抢 I/O */
  _armSnapshotSave(delay = 20000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), {
      delay,
      isIdle: () => this._activeApps.size === 0,
    });
  }

  /** 供安装器等外部调用：装完应用后重新存一份快照，下次开机仍是秒进 */
  scheduleSnapshotSave(delay = 12000) { this._armSnapshotSave(delay); }

  /**
   * 强制存一份快照，**不等空闲**。
   *
   * 什么时候需要：刚修好网络、马上就要启动应用的时候。正常的
   * scheduleSnapshotSave 只在没有应用窗口时才写盘，而应用一起来就永远不空闲，
   * 于是「网络已连上」这个状态从来没被存下来 —— 下次开机又从旧快照恢复成
   * 断网状态，每次都要重连一遍。这里显式绕过空闲判断，一次写盘换之后次次省。
   */
  forceSnapshotSave(delay = 3000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), { delay, isIdle: () => true });
  }

  /**
   * 预热：在用户点开应用之前，先把安卓环境在后台引导好。
   * WSA / 应用宝电脑版都是这个思路 —— 环境常驻，点图标时只剩一次 am start。
   *  - 完全静默：不弹窗、不报错，失败不影响正常打开应用；
   *  - 幂等：正在开机或已就绪时复用同一个 Promise，不会重复拉起第二台；
   *  - 省资源：开机完成后把 qemu 降到最低优先级停放。
   */
  prewarm({ onLog = () => {} } = {}) {
    if (this._prewarmPromise) return this._prewarmPromise;
    if (this._activeApps.size > 0) return Promise.resolve({ ok: true, skipped: 'busy' });
    const t0 = Date.now();
    const p = (async () => {
      try {
        const env = await this.provisioner.checkEnv();
        if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) return { ok: false, skipped: 'not-ready' };
        const r = await this.ensure({ onLog: (m) => onLog(`预热：${m}`) });
        if (r && r.ok) {
          // 预热期间用户可能已经点开了应用：这时不能把它摁到 idle 优先级
          if (this._activeApps.size === 0) await this.emulator.setPriority('idle').catch(() => {});
          const ms = Date.now() - t0;
          this.log(`预热完成（${Math.round(ms / 1000)}s）`);
          return { ok: true, bootMs: ms };
        }
        return { ok: false, error: r && r.error };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })();
    this._prewarmPromise = p;
    const clear = () => { if (this._prewarmPromise === p) this._prewarmPromise = null; };
    p.then(clear, clear);
    return p;
  }

  async bootQemu({ install = false, env, onLog = () => {} } = {}) {
    if (!env.qemu.ok) throw new Error('未安装 QEMU，请先完成运行时部署');
    if (install && !env.iso.ok) throw new Error('系统镜像（ISO）未就绪');

    const p = this.provisioner.paths();
    const disk = this.settings.runtime.diskPath || p.disk;
    if (!install && !fs.existsSync(disk)) throw new Error('尚未安装 Android 系统到虚拟磁盘');

    this.vmStarting = true;
    const args = this.buildArgs({ install });
    const logFile = path.join(LOG_DIR, install ? 'qemu-install.log' : 'qemu.log');
    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n\n=== ${new Date().toISOString()} ${install ? 'INSTALL' : 'BOOT'} ===\n${env.qemu.path} ${args.join(' ')}\n`);

    onLog(`启动运行时（${env.hypervisor.whpx ? 'WHPX 硬件加速' : '纯软件模拟'}）…`);
    if (!env.hypervisor.whpx) onLog(env.hypervisor.note);

    const proc = spawn(env.qemu.path, args, {
      cwd: path.dirname(env.qemu.path),
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    this.vmProc = proc;
    this.installing = install;
    this.lastActivity = Date.now();

    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      onLog(`启动失败：${e.message}`);
      this.vmProc = null;
      this.vmStarting = false;
    });
    proc.on('exit', (code) => {
      this.log(`qemu exit ${code}`);
      onLog(`运行时已退出（code=${code}）`);
      this.vmProc = null;
      this.vmStarting = false;
      this.installing = false;
    });

    await new Promise((r) => setTimeout(r, 1500));
    this.vmStarting = false;
    if (!this.vmProc) throw new Error(`QEMU 启动失败，详见日志：${logFile}`);

    // 装机模式：ISO 里是 Linux 安装程序，没有 adb，不能按「等 adb」处理
    if (install) {
      onLog('安装程序已启动，请在虚拟机窗口里按引导完成安装');
      return { ok: true, install: true, needsManualInstall: true };
    }

    const client = this.client('127.0.0.1:5555');
    const timeout = env.hypervisor.whpx ? 180000 : 900000;
    const linked = await this.waitAdb(client, timeout, onLog);
    if (!linked) {
      return {
        ok: false,
        error: '虚拟机已启动，但 adb 未能连接：请在虚拟机里开启「开发者选项 → ADB over network」后重试',
      };
    }
    const ready = await this.waitAndroidReady(client, Math.max(60000, timeout / 2), onLog);
    if (!ready.ok) {
      return {
        ok: false,
        error: ready.stage === 'kernel'
          ? 'Android 内核未完成引导，请查看运行时日志（可能镜像损坏或加速未生效）'
          : 'Android 已引导但系统服务未就绪（可能停在首次开机设置界面，请在虚拟机窗口里完成向导）',
      };
    }
    await this.prepare(client);
    return { ok: true, client };
  }

  /**
   * 等待 Android 真正可用：adb 在线 ≠ 系统可用。
   * 必须等到 sys.boot_completed=1 且包管理器可响应，否则 am start 会直接失败。
   */
  async waitAndroidReady(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let bootCompleted = false;
    let lastNotice = 0;
    while (Date.now() - start < timeoutMs) {
      /* eslint-disable no-await-in-loop */
      const online = await client.isOnline();
      if (!online) {
        await client.connect().catch(() => false);
      } else {
        if (!bootCompleted) {
          const v = await client.shell('getprop sys.boot_completed').catch(() => '');
          if (String(v).trim() === '1') {
            bootCompleted = true;
            onLog(`Android 内核已启动，等待系统服务就绪…（${Math.round((Date.now() - start) / 1000)}s）`);
          }
        }
        if (bootCompleted) {
          const pm = await client.shell('pm path android').catch(() => '');
          if (/package:/.test(pm)) {
            onLog(`Android 已就绪（${Math.round((Date.now() - start) / 1000)}s）`);
            return { ok: true, ms: Date.now() - start };
          }
        }
      }
      if (Date.now() - lastNotice > 15000) {
        lastNotice = Date.now();
        onLog(bootCompleted
          ? `正在等待系统服务… ${Math.round((Date.now() - start) / 1000)}s`
          : `正在引导 Android… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      /* eslint-enable no-await-in-loop */
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, stage: bootCompleted ? 'services' : 'kernel', ms: Date.now() - start };
  }

  async waitAdb(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let lastNotice = 0;
    const needConnect = String(client.serial || '').includes(':')
      && !/^emulator-/.test(client.serial);
    while (Date.now() - start < timeoutMs) {
      // emulator-5554 这类由 emulator 自己注册，不需要 adb connect
      if (needConnect) {
        // eslint-disable-next-line no-await-in-loop
        await client.connect().catch(() => false);
      }
      // eslint-disable-next-line no-await-in-loop
      if (await client.isOnline()) return true;
      if (Date.now() - lastNotice > 20000) {
        lastNotice = Date.now();
        onLog(`等待 Android 启动… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async prepare(client) {
    if (!this._freeformReady) {
      try { this._freeformReady = await client.ensureFreeform(); } catch (_) { /* ignore */ }
    }
    // 中文环境（系统语言 + 中文输入法）每次**开机**只做一次。
    // 系统语言靠 emulator -prop 注入（SELinux 保护，运行时改不了），这里补的是
    // 应用级 locale / 时区，以及静默装好并启用随包带的谷歌拼音输入法。
    // 用户可在设置里关掉自动配置（engine.chineseIme=false）。
    if (!this._chineseReady && this.settings.engine.chineseIme !== false) {
      try {
        const locale = this.settings.engine.locale || 'zh-CN';
        await client.ensureChineseLocale(locale);
        const path = require('path');
        const apk = path.join(this.appRoot, 'assets', 'PinyinIME.apk');
        const r = await client.ensureChineseIme(apk, {
          setDefault: this.settings.engine.chineseImeDefault !== false,
        });
        // 只有真的成功了才置位。失败时允许下一次 prepare() 重试 ——
        // 否则一次偶发的 adb 抖动就会让这台机器永远没有中文输入法。
        if (r && r.ok) this._chineseReady = true;
        this.log(`中文输入法：${r.ok ? (r.installed ? '已安装并启用' : '已就绪') : (r.reason || '未就绪')}`);
        // -change-locale 只在「全量引导」时执行并重启 framework；从 quickboot 快照
        // 恢复时会被跳过。旧快照是英文的，所以检测到系统语言不对就作废快照、
        // 让下次开机冷启动一次（带 -change-locale）。之后存的新快照就是中文的，
        // 不用再重启。marker 保证一生只纠正一次。
        await this._ensureSystemLocale(client, locale);
      } catch (e) {
        this.log(`中文环境初始化跳过：${e.message}`);
      }
    }
    this.startWatchdog();
  }

  /**
   * 系统 UI 语言校正（一次性）。
   *
   * 实测结论（很容易踩错）：-change-locale 生效后**不会**写 persist.sys.locale，
   * ro.product.locale 也仍是镜像的 en-US；它真正改的是
   * `settings system system_locales`（语言设置页显示「中文（中国）」，系统 UI 全中文）。
   * 所以判断「中文是否已经生效」要看 system_locales，不是 getprop。
   *
   * -change-locale 只在「全量引导」时执行并重启 framework；从 quickboot 快照恢复时
   * 会被跳过。旧快照是英文的，所以检测到不对就作废快照、让下次开机冷启动一次。
   * 之后存的新快照就是中文的，不用再重启。marker 保证一生只纠正一次。
   */
  async _ensureSystemLocale(client, locale) {
    const fs = require('fs');
    const path = require('path');
    const want = String(locale || 'zh-CN');
    if (want === 'off' || want === 'en-US') return;
    // 已经生效（system_locales 是目标语言，或语言列表里第一项是它）
    const cur = await client.shell('settings get system system_locales', { timeout: 8000 }).catch(() => '');
    const s = String(cur).trim();
    if (s === want || s.indexOf(want) === 0 || /^zh[-_]/.test(s)) return;
    const marker = path.join(store.DATA_DIR, 'locale-' + want.replace(/[^a-zA-Z0-9_-]/g, '_') + '.done');
    if (fs.existsSync(marker)) return;
    try {
      fs.writeFileSync(marker, String(Date.now()));
      this.log(`系统语言仍为 ${s || '(空)'}，作废旧快照，下次开机冷启动切到 ${want}`);
      this.emulator.invalidateSnapshot();
      this.emulator.forceColdBootOnNextStart();
    } catch (e) {
      this.log(`系统语言校正跳过：${e.message}`);
    }
  }

  /** 优雅停止：emulator 走控制台关机，QEMU 走 monitor */
  async stop({ graceful = true } = {}) {
    // 运行时一停，之前缓存的 guest 网络结论立即作废。否则旋转/重启后新机器
    // 还没联网，waitForNetwork 却因为 8 秒缓存直接返回 ok，应用又会黑屏。
    this._lastNetwork = null;
    const adbPath = this.adbPath();
    if (this.emulator.running()) {
      await this.emulator.stop({ adbPath });
      return true;
    }
    // 接管来的模拟器（adoptExisting）在本进程里没有 proc 句柄，旧逻辑会直接
    // return false —— 结果空闲看门狗永远关不掉它，容器一直占着 CPU/内存。
    // 这条路径改用 adb 控制台关机，必要时再按端口强杀兜底。
    //
    // 注意：emulator.exe 只是个启动器，spawn 完 qemu 自己就退了，所以「自己拉起来的」
    // 机器也常常落到这条分支。关机前必须补一次 saveSnapshotNow，否则快照永远存不下来，
    // 用户每次点开都是全量冷启动（25 秒 vs 8 秒的差别就在这一步）。
    let online = false;
    try { online = await this.client().isOnline(); } catch (_) { /* ignore */ }
    if (online && this.emuSerial) {
      if (adbPath && this.emulator.snapshotWorthSaving !== false) {
        await this.emulator.saveSnapshotNow(adbPath, { timeout: 60000 }).catch(() => false);
      }
      await this.client().exec(['emu', 'kill'], { timeout: 8000 }).catch(() => {});
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 400));
        // eslint-disable-next-line no-await-in-loop
        const still = await this.client().isOnline().catch(() => false);
        if (!still) break;
      }
      const still = await this.client().isOnline().catch(() => false);
      if (still) {
        const m = /:(\d+)$/.exec(this.emuSerial);
        const port = m ? Number(m[1]) - 1 : this.emulator.port;
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
      }
      this._activeApps.clear();
      return true;
    }
    if (!this.vmProc) return false;
    if (graceful) {
      try { await this.monitorCmd('system_powerdown'); } catch (_) { /* ignore */ }
      for (let i = 0; i < 16; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
        if (!this.vmProc) return true;
      }
      try { await this.monitorCmd('quit'); } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
    return true;
  }

  // ---------------- QEMU monitor ----------------

  monitorCmd(cmd, { timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: MONITOR_PORT });
      let buf = '';
      let sent = false;
      const done = (err, data) => {
        try { sock.destroy(); } catch (_) { /* ignore */ }
        if (err) reject(err); else resolve(data);
      };
      sock.setTimeout(timeout, () => done(new Error('monitor 超时')));
      sock.on('error', (e) => {
        // QEMU 执行 quit 等命令后会主动断开连接（ECONNRESET/EPIPE），属于正常现象
        if (sent && /ECONNRESET|EPIPE/i.test(e.code || String(e))) done(null, buf);
        else done(e);
      });
      sock.on('data', (c) => {
        buf += c.toString();
        if (!sent && buf.includes('(qemu)')) {
          sent = true;
          sock.write(`${cmd}\n`);
          setTimeout(() => done(null, buf), 300);
        }
      });
      sock.on('connect', () => {
        if (!cmd) setTimeout(() => done(null, buf), 250);
      });
    });
  }

  async sendKey(keys, delay = 140) {
    for (const k of keys) {
      // eslint-disable-next-line no-await-in-loop
      await this.monitorCmd(`sendkey ${k}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // ---------------- 安装系统到虚拟磁盘 ----------------

  async startInstaller({ onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    if (!env.iso.ok) {
      throw new Error(env.iso.reason || '请先下载/导入 Android 系统镜像（ISO）');
    }
    if (!env.disk.ok) await this.provisioner.createDisk(this.settings.runtime.diskSizeGB || 24, () => {});
    this.installing = true;
    const r = await this.boot({ install: true, onLog });
    if (!r.ok) throw new Error(r.error || '安装环境启动失败');
    return r;
  }

  /** 安装完成后：关掉安装程序 → 写标记 → 之后直接从磁盘启动 */
  async markInstalled() {
    if (this.installing) {
      try { await this.stop({ graceful: true }); } catch (_) { /* ignore */ }
    }
    store.saveSettings({ runtime: { installed: true } });
    this.installing = false;
    return true;
  }

  // ---------------- ensure ----------------

  /**
   * 接管上一次运行留下的模拟器。
   * 每台模拟器都有自己的控制台端口（5554/5556/…），adb 端口是 +1。
   * 端口能连上并且 system 已经 boot_completed，就直接当成我们的运行时用，
   * 这样「关掉 ApkStart 再点开应用」是秒进，而不是再冷启一台。
   */
  /**
   * 找出所有还活着的模拟器控制台端口。
   * 不能用「从 5554 顺序试」：端口会随着多次启动往上漂（5554→5556→5558…），
   * 试固定范围总有试漏的时候，漏了就会再开一台新机器。这里直接按进程名
   * 找出 qemu 监听的所有 TCP 端口，一个都不会漏。
   */
  async emulatorPorts() {
    const run = (cmd, args) => new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        resolve(err ? '' : String(out || ''));
      });
    });
    const ports = new Set();
    try {
      const tl = await run('tasklist', ['/FO', 'CSV', '/NH']);
      const pids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) pids.add(m[2]);
      }
      if (!pids.size) return [];
      const ns = await run('netstat', ['-ano', '-p', 'TCP']);
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && pids.has(m[2])) ports.add(Number(m[1]));
      }
    } catch (_) { /* 退回到端口探测 */ }

    if (ports.size) {
      // 控制台端口（偶数）和 adb 端口（+1）都会被监听，只保留控制台端口
      const all = [...ports].sort((a, b) => a - b);
      const consoles = all.filter((p) => ports.has(p + 1));
      return consoles.length ? consoles : all;
    }
    // 兜底：没有 qemu 进程信息时，直接探测（连接被拒绝会立刻返回，代价很小）
    const found = [];
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await portAlive(port, 120)) found.push(port);
    }
    return found;
  }

  async adoptExisting({ onLog = () => {} } = {}) {
    const alive = await this.emulatorPorts();
    if (!alive.length) {
      onLog('没有发现上一台运行时，准备冷启动');
      return null;
    }
    onLog(`发现 ${alive.length} 台残留运行时（端口 ${alive.join(', ')}），尝试接管`);

    // adb server 里可能还留着上个进程的 offline 记录（模拟器重启过 adbd 就会这样），
    // 先清掉再连，否则 get-state 永远返回 offline，会误判成"没就绪"把好好的机器杀掉。
    await this.client().exec(['kill-server'], { withSerial: false, timeout: 8000 }).catch(() => {});

    for (const port of alive) {
      const serial = `127.0.0.1:${port + 1}`;
      const c = this.client(serial);
      let booted = '';
      for (let i = 0; i < 6 && booted !== '1'; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await c.connect().catch(() => false);
        // eslint-disable-next-line no-await-in-loop
        const state = (await c.exec(['get-state'], { timeout: 5000 }).then((r) => r.stdout).catch(() => '')).trim();
        if (state === 'device') {
          // eslint-disable-next-line no-await-in-loop
          booted = (await c.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '')).trim();
        }
        if (booted !== '1') await new Promise((r) => setTimeout(r, 700));
      }
      if (booted !== '1') {
        onLog(`发现上一台运行时（${serial}）但没就绪，先关掉它再重新开机`);
        // AVD 目录有锁：留着这台会让新实例直接退出，表现成"怎么都开不了机"。
        // adb 都连不上了，只能按控制台端口找到进程强杀。
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            const { execFile } = require('child_process');
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      this.emuSerial = serial;
      this.emulator.port = port;
      store.saveSettings({ device: serial });
      onLog(`已接管正在运行的运行时（${serial}）`);
      // eslint-disable-next-line no-await-in-loop
      await this.prepare(c);
      return { ok: true, client: c, engine: 'emulator', reused: true };
    }
    return null;
  }

  /** 某个 TCP 端口是哪个进程在监听（用于强杀卡死的模拟器） */
  async pidOnPort(port) {
    return new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(0);
        const line = stdout.split('\n').find((l) => new RegExp(`:${port}\\s`).test(l) && /LISTENING/i.test(l));
        const m = line && /(\d+)\s*$/.exec(line.trim());
        return resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /**
   * 清理上一次运行遗留、却没被接管的孤儿模拟器。
   * 关掉 ApkStart 时 emulator 是 detached 的，qemu 会存活；下次启动时它仍占着 AVD 锁，
   * 表现为冷启直接 FATAL "Running multiple emulators with the same AVD"。
   * 实现收敛到 EmulatorEngine，重试路径（killAttempt）也用同一份逻辑。
   */
  async killOrphanEmulators({ onLog = () => {} } = {}) {
    return this.emulator.killOrphanProcesses({ onLog });
  }

  /**
   * 幂等入口：预热与用户点击可能同时发生，共用一个 Promise，
   * 避免两边各判断一次「没在线」后各自拉起一台模拟器（AVD 锁冲突 + 双倍内存）。
   */
  async ensure({ onLog = () => {} } = {}) {
    if (this._ensurePromise) return this._ensurePromise;
    const p = this._ensureInner({ onLog });
    this._ensurePromise = p;
    const clear = () => { if (this._ensurePromise === p) this._ensurePromise = null; };
    p.then(clear, clear);
    return p;
  }

  async _ensureInner({ onLog = () => {} } = {}) {
    const client = this.client();
    if (await client.isOnline()) {
      /**
       * 「在线」不等于「能干活」。
       *
       * 模拟器进程刚退出、或正在重启的那几百毫秒里，adb 对
       * `-s emulator-5554 get-state` 仍然回 `device`。旧逻辑据此直接
       * returned reused，换面板方向的启动链于是拿到一个已经死掉的客户端 ——
       * 后面每条命令都是 `device 'emulator-5554' not found`（实测 ensure
       * 0.2 秒就"就绪"，应用启动全军覆没）。
       *
       * 这里补一条真实命令：能执行 getprop 才算设备真的在（返回 0 说明还在
       * 开机，那是正常情况，按原逻辑复用并等待）；命令失败则当作没就绪，
       * 继续走下面的拉起流程。
       */
      const probe = await client.shell('getprop sys.boot_completed', { timeout: 5000 })
        .then((v) => String(v == null ? '' : v).trim())
        .catch(() => null);
      if (probe !== null) {
        await this.prepare(client);
        return { ok: true, client, engine: 'builtin', reused: true };
      }
      onLog('adb 报告设备在线但命令不通（模拟器可能正在重启），重新拉起运行时…');
    }

    // 上一次 ApkStart 退出时模拟器会留着（下次点开秒进），但新进程里没有它的
    // 句柄，adb server 也可能被重启过——只靠 isOnline() 会判成"没有运行时"，
    // 于是又开一台新的。这里先把还活着的模拟器接管过来，避免重复开机器吃内存。
    const adopted = await this.adoptExisting({ onLog });
    if (adopted) return adopted;

    // 上次会话遗留 / 别的进程拉起的 emulator：换个端口也要复用，绝不重复开一台
    try {
      const devices = await client.devices();
      const running = devices.find((d) => /^emulator-\d+$/.test(d.serial) && d.state === 'device');
      if (running) {
        this.emuSerial = running.serial;
        const m = /(\d+)$/.exec(running.serial);
        if (m) this.emulator.port = Number(m[1]);
        const c2 = this.client(running.serial);
        await this.prepare(c2);
        return { ok: true, client: c2, engine: 'emulator', reused: true };
      }
    } catch (_) { /* 没找到就正常拉起 */ }

    // 进程还在但设备离线（多半卡在引导）：先停掉再重新拉起，避免干等
    if (this.emulator.running()) {
      onLog('检测到卡住的运行时，正在重启…');
      await this.emulator.stop({ adbPath: this.adbPath() });
    }

    const s = this.settings;

    // 唯一路径：自带运行时
    // 单文件发行版的镜像是压缩的，先展开（已展开过就秒过）。
    // 展开失败不要把错误吞掉：否则后面 checkEnv() 只会说「还差系统镜像」，
    // 用户会以为是没下载，而不是解压失败（磁盘满 / 文件损坏）。
    await this.provisioner.materializeImages(onLog).catch((e) => {
      onLog(`系统镜像展开失败：${e.message}`);
      this.log(`materialize failed: ${e.message}`);
    });
    const env = await this.provisioner.checkEnv();

    // emulator 路径：镜像即系统，没有"安装到磁盘"这一步
    if (env.emulator.ok && env.sysimg.ok) {
      // 关掉 ApkStart 后可能残留未接管的模拟器（detached 的 qemu 仍存活），
      // 它一直占着 AVD 锁，会让冷启直接 FATAL "Running multiple emulators with the same AVD"。
      // 接管失败时先把这些孤儿清掉，再冷启，保证「关掉再开」一定能起来。
      await this.killOrphanEmulators({ onLog }).catch(() => {});
      try {
        const r = await this.boot({ onLog });
        if (r.ok) return { ok: true, client: r.client, engine: 'emulator', profile: r.profile, network: r.network || null };
        return {
          ok: false, error: r.error, env,
          diagnosis: r.diagnosis, report: r.report, attempts: r.attempts, exitCode: r.exitCode,
        };
      } catch (e) {
        return { ok: false, error: e.message, env };
      }
    }

    // QEMU 路径（用户自备 ISO 并已装到虚拟磁盘）
    if (!s.runtime.installed) {
      return {
        ok: false,
        needsSetup: env.emulator.ok ? 'sysimg' : 'provision',
        error: env.emulator.ok
          ? '还差系统镜像：点「下载系统镜像」即可'
          : '运行时组件尚未部署完成',
        env,
      };
    }

    try {
      const r = await this.boot({ onLog });
      if (r.ok) return { ok: true, client: r.client, engine: 'builtin' };
      return { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------------- 应用级容器会话 ----------------

  /**
   * 「像容器一样打开」的具体实现：
   * Android 环境只引导一次并常驻（quickboot 快照 + adoptExisting 接管），
   * 之后每次打开 App 只是 am start + 把已有窗口挂进来，不再重跑整个系统。
   * 这里额外做三件降低系统压力的事：
   *   - 停掉其他用户 App 的进程，让环境里只跑当前 App 需要的东西；
   *   - 有窗口时给 qemu 一个「让着前台」的优先级；
   *   - 只在有窗口时才开启文件同步 / 通知轮询（由 onActive 回调交给 UI 层）。
   */
  async beginApp(pkg, { onActive = () => {} } = {}) {
    const first = this._activeApps.size === 0;
    this._activeApps.add(pkg);
    this.touch();
    const s = this.settings;
    const mode = (s.engine && s.engine.priorityMode) || 'balanced';
    // 有应用在前台时的调度级别。balanced 用 normal（不是 below）：
    // below 会让 qemu 在系统繁忙时被饿到，表现为视频解码掉帧、点击要等一下才响应 ——
    // 这正是「点击不跟手」的主因。normal 只是与桌面同档，并不额外吃 CPU/内存/GPU。
    const level = mode === 'game' ? 'game' : 'normal';

    if (first) {
      // 有应用要开了：把「空闲存快照」推迟，别在应用启动时抢磁盘
      this.emulator.cancelSnapshotSave();
    }
    // 每次打开/切回应用都确保优先级到位：endApp 会把空闲的 qemu 降到 idle，
    // 切换回来时若不重新提，就会停在低优先级 → 点起来发木。setPriority 幂等，
    // 已经是目标值时脚本内部不改、开销极小。
    await this.emulator.setPriority(level).catch(() => {});
    if (first) {
      try { onActive(true); } catch (_) { /* 轮询启动失败不影响打开应用 */ }
    }

    // 多窗口模式（B 方案）：开新应用**不再** force-stop 其它应用，否则等于没多开。
    // 改为按墓碑策略回收「太久没看的后台」，既允许多个并存、又不会内存失控。
    // 关掉 multiWindow 时退回旧的「只留当前这个」行为，保证可回退。
    if (s.engine && s.engine.multiWindow) {
      const roles = container.sessionRoles([...this._activeApps], pkg);
      const { tombstone } = container.planTombstones({
        background: roles.background,
        keepRecent: Number(s.engine.keepBackground) >= 0 ? Number(s.engine.keepBackground) : 1,
      });
      const cmds = container.buildTombstoneCommands(tombstone);
      if (cmds.length) {
        await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
        for (const p of tombstone) this._tombstoned.add(p);   // 记下被挂起的，下次点开热恢复
        this.log(`多窗口：前台 ${pkg}，保留后台 ${roles.background.length - tombstone.length} 个，墓碑化 ${tombstone.length} 个`);
      } else {
        this.log(`多窗口：${roles.count} 个应用并存，无需回收`);
      }
      return { ...roles, plan: { commands: cmds, stopped: tombstone } };
    }

    const installed = store.getApps().map((a) => a && a.package).filter(Boolean);
    const state = container.nextSessionState([...this._activeApps], 'open', pkg);
    const plan = container.buildSessionCommands({
      pkg,
      installed,
      deep: !!(s.engine && s.engine.deepTrim),
      // App 刚 am start 完，此刻清后台可能误伤正在进前台的进程；清理放到 endApp
      killBackground: false,
    });
    if (plan.commands.length) {
      await this.client().shell(plan.commands.join(' ; '), { timeout: 20000 }).catch(() => '');
    }
    this.log(container.describeSession(state, plan));
    return { ...state, plan };
  }

  /**
   * 关掉一个应用窗口：停掉它的进程；如果是最后一个窗口，让容器进入
   * 「常驻但几乎不耗资源」的停放状态（清后台 + Android idle + qemu 降优先级）。
   * 不关机、不删 AVD —— 下次点开还是秒进。
   */
  async endApp(pkg, { onIdle = () => {} } = {}) {
    this._activeApps.delete(pkg);
    await this.client().forceStop(pkg).catch(() => {});
    const state = container.nextSessionState([...this._activeApps], 'close', pkg);
    if (state.idle) {
      const s = this.settings;
      const cmds = container.buildIdleCommands({ deep: !!(s.engine && s.engine.deepTrim) });
      await this.client().shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => '');
      // game 模式下即使暂时没有应用窗口也保持高优先级，
      // 否则下次点开要重新提权、首个输入会有明显延迟。
      const keepHigh = (s.engine && s.engine.priorityMode) === 'game';
      await this.emulator.setPriority(keepHigh ? 'normal' : 'idle').catch(() => {});
      // 现在最空闲：把内存状态存成快照，下次开机走恢复而不是冷启动
      this._armSnapshotSave(8000);
      try { onIdle(true); } catch (_) { /* ignore */ }
      this.log('容器已停放（Android 常驻，0 个应用进程，qemu 最低优先级）');
    }
    return state;
  }

  get activeApps() { return [...this._activeApps]; }
  get containerIdle() { return this._activeApps.size === 0; }

  /** 供设置页切换「深度裁剪」时恢复被禁用的系统包 */
  async restoreSystemApps() {
    const cmds = container.buildRestoreCommands();
    await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
    return true;
  }

  setGuestPriority(level) { return this.emulator.setPriority(level); }

  // ---------------- 空闲回收 ----------------

  /**
   * 方向自愈：保证「逻辑显示空间」和「物理面板」方向一致。
   *
   * 判断依据（实机 dumpsys window displays）：
   *   init=1280x720 ... cur=1280x720   → 正常（横屏面板 + 横屏逻辑）
   *   init=1280x720 ... cur=720x1280   → 躺倒：逻辑空间被旋转了 90°
   * 一旦看到 cur 与 init 的宽高顺序相反，就说明有应用/系统把方向改回去了，
   * 此时重新锁方向并忽略应用的方向请求即可纠正，不用重启虚拟机。
   *
   * 只在真的不一致时写 settings，正常情况下每 60 秒只有一次只读 shell。
   */
  async _healOrientation() {
    if (!this.emulator || !this.emulator.running()) return;
    const wantLand = !!this.settings.display.landscape;
    const panelLand = typeof this.emulator.panelLandscape === 'function'
      ? this.emulator.panelLandscape() : null;
    // 面板方向和设置不一致 → 该重启，不是这里能修的（runLaunch.beforeStart 会处理）
    if (panelLand !== null && panelLand !== wantLand) return;
    const c = this.client();
    const out = await c.shell('dumpsys window displays', { timeout: 12000 }).catch(() => '');
    const init = /init=(\d+)x(\d+)/.exec(out);
    const cur = /cur=(\d+)x(\d+)/.exec(out);
    if (!init || !cur) return;
    const initLand = Number(init[1]) > Number(init[2]);
    const curLand = Number(cur[1]) > Number(cur[2]);
    if (initLand !== curLand) {
      // 真躺倒了：重新锁方向 + 忽略应用方向请求 + 恢复 density
      this.log(`方向自愈：init=${init[1]}x${init[2]} cur=${cur[1]}x${cur[2]} 已躺倒，重新收敛`);
      await c.resetDisplayOverrides(wantLand).catch(() => {});
      await c.setOrientation(wantLand).catch(() => {});
      return;
    }
    // 没躺倒 ≠ 状态就对。平板排版依赖两个易丢的运行时状态：
    //   - mSetIgnoreOrientationRequest（横屏时必须为 true，否则面板会被应用方向带歪）
    //   - wm density 覆盖为 190（720 宽 → sw606dp ≥ 600dp 才走平板排版）
    // 这两项一旦丢失，会退回手机形态 —— 正是「平板模式不稳定」的表现。
    // 这里做一次轻量校验，缺哪个补哪个（都是幂等命令，正常情况不写）。
    const densityWanted = (this.settings.display || {}).tabletMode !== false ? 190 : null;
    let ignoreOk = true;
    if (wantLand) {
      const win = await c.shell('dumpsys window | grep -oE "mSetIgnoreOrientationRequest=(true|false)"', { timeout: 8000 }).catch(() => '');
      ignoreOk = /mSetIgnoreOrientationRequest=true/.test(String(win));
    }
    let densityOk = true;
    if (densityWanted) {
      const dens = await c.shell('wm density', { timeout: 6000 }).catch(() => '');
      // 「Override density: N」行存在且等于目标值才算对
      const m = /Override density:\s*(\d+)/.exec(String(dens));
      densityOk = !!m && Number(m[1]) === densityWanted;
    }
    if (!ignoreOk || !densityOk) {
      this.log(`显示状态收敛：ignore-orientation=${ignoreOk} density=${densityOk} → 补齐`);
      if (!ignoreOk) await c.shell('wm set-ignore-orientation-request true', { timeout: 8000 }).catch(() => {});
      // density 只在**没有应用在前台**时才补。
      // 改密度会触发配置变更 + Activity 重建，而缓存了 DisplayMetrics 的应用
      // （墨读）会按旧密度重算一遍 dp，画面缩成左上角一小块、右边全是空白 ——
      // 用户看到的就是「墨读没有填满窗口」。有应用在跑时留给下一次启动路径，
      // installer.launch 的 resetDisplayOverrides 会在 am start 之前设好。
      if (!densityOk) {
        if (this._activeApps.size === 0) {
          await c.shell(`wm density ${densityWanted}`, { timeout: 8000 }).catch(() => {});
        } else {
          this.log(`density=${densityWanted} 缺失但有应用在前台：跳过，等下次启动时设置（避免画面缩水）`);
        }
      }
    }
  }

  startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(async () => {
      const s = this.settings;
      // 方向自愈：应用启动 / Activity 重建 / 系统弹窗都可能把 user-rotation 或
      // 「忽略应用方向请求」改回去。一旦被改回去，横屏面板上的画面就会躺倒 90°
      // （用户说的「平板模式软件总是 90 度躺着」）。这里每轮巡检读一次真实状态，
      // 只有在**确实不一致**时才纠正，正常情况零写入。
      await this._healOrientation().catch(() => {});
      const limit = (s.engine.idleShutdownMinutes || 0) * 60000;
      if (!limit) return;
      // 接管来的模拟器没有本地 proc 句柄，vmRunning 会是 false：
      // 以前这里直接 return，导致容器永不回收。改成同时看 adb 是否在线。
      if (!this.vmRunning) {
        const online = await this.client().isOnline().catch(() => false);
        if (!online) return;
      }
      if (this._activeApps.size > 0 || Date.now() - this.lastActivity < limit) return;
      try {
        const running = await this.client().runningPackages();
        const alive = running.filter((p) => !/launcher|systemui|settings|inputmethod|android\.systemui/i.test(p));
        if (alive.length === 0) await this.stop();
        else this.lastActivity = Date.now();
      } catch (_) { /* ignore */ }
    }, 60000);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  get vmRunning() { return this.emulator.running() || !!(this.vmProc && !this.vmProc.killed); }

  // ---------------- 诊断 / 瘦身（供 UI 调用） ----------------

  async diagnostics() {
    const env = this.provisioner.paths();
    const checked = await this.provisioner.checkEnv();
    const profile = this.emulator.profile || doctor.autoProfile({
      settings: this.settings,
      accel: checked.accel,
      emulatorVersion: checked.emulator.version || '',
      diskMB: doctor.freeDiskMB(store.DATA_DIR),
    });
    // 内存里的 attempts 只在本次会话有效；用户重启后再导出报告时它是空的。
    // 这时改用上次落盘的失败记录，并把 emulator.log 的尾部带上 —— 否则报告
    // 只有一句 UNKNOWN，看不到真正原因（issue #20/#25 都栽在这里）。
    const persisted = this.emulator.lastFailure ? this.emulator.lastFailure() : null;
    const liveAttempts = this.emulator.attempts || [];
    const attempts = liveAttempts.length ? liveAttempts : ((persisted && persisted.attempts) || []);
    const diagnosis = this.emulator.lastDiagnosis || (persisted && persisted.diagnosis) || null;
    const exitCode = this.emulator.lastExitCode != null ? this.emulator.lastExitCode
      : (persisted ? persisted.exitCode : null);
    let logLines = this.emulator.recentLog(300);
    if (!logLines.length && this.emulator.tailLogFile) logLines = this.emulator.tailLogFile(300);
    return doctor.writeReport({
      dataDir: store.DATA_DIR,
      profile,
      logLines,
      extra: {
        attempts,
        diagnosis,
        exitCode,
        exitMeaning: persisted && persisted.exitMeaning ? persisted.exitMeaning : '',
        lastFailure: persisted,
        runtimeDir: env.root,
        serial: this.emuSerial,
        bootLog: this.bootLog,
      },
    });
  }

  usage() { return require('./layers').summary(this.provisioner.paths().root); }

  /**
   * 回收运行时里的旧镜像 / 旧 AVD / 锁文件 / 快照。
   * 之前「点清理却清不掉」的根因：运行时正在跑时 keepSnapshots 把当前 AVD 的
   * 快速启动快照（≈几 GB 的 ram.img）排除掉了，单 AVD 环境下几乎没有可清项。
   * 现在调用方可以显式传 includeSnapshots：先停运行时再裁，快照就能真正回收。
   */
  async cleanup({ apply = false, aggressive = false, includeSnapshots = false } = {}) {
    let stoppedVm = false;
    if (includeSnapshots && this.vmRunning) {
      await this.stop().catch(() => {});
      stoppedVm = true;
    }
    const report = require('./layers').prune(this.provisioner.paths().root, {
      apply, aggressive, keepSnapshots: !includeSnapshots && this.vmRunning,
    });
    // 预览阶段若停了机，给用户一个提示：清完可手动重启运行时
    return { ...report, apply, stoppedVm };
  }

  /**
   * 彻底重置安卓数据（清空 /data 用户分区 + 已装应用 + 快速启动快照），
   * 把 AVD 还原成「刚装好系统、没有任何第三方 app」的干净状态。
   * 这一项会真实删除 8–16GB 的用户数据镜像，必须二次确认（UI 负责），且只动
   * 当前活动 AVD（apkstart.avd），不动只读基础镜像、不动其它 AVD。
   * 保留 config.ini / hardware-qemu.ini，AVD 仍有效，下次点开应用会重新冷启动建数据。
   * @returns {{ok:boolean, reclaimed:number, avdDir:string, error?:string}}
   */
  async resetAndroidData() {
    const fs = require('fs');
    const path = require('path');
    try {
      if (this.vmRunning) await this.stop().catch(() => {});
      const avdDir = path.join(this.provisioner.paths().avdHome, 'apkstart.avd');
      let reclaimed = 0;
      if (fs.existsSync(avdDir)) {
        for (const e of fs.readdirSync(avdDir, { withFileTypes: true })) {
          const p = path.join(avdDir, e.name);
          // 删除：用户数据镜像（含 qcow2 差量 + 基址）、快速启动快照、残留锁文件/锁目录。
          // 保留：config.ini / hardware-qemu.ini / AVD.conf / cache.img / encryptionkey* / initrd /
          //       modem_simulator / 各类 *.ini / *.txt / *.cache —— 它们是 AVD 的身份与基础设施，
          //       删了 AVD 直接失效或下次开机异常。下次点开应用，模拟器会按 -wipe-data 语义重建 /data。
          const isUserdata = /^userdata(-qemu)?(-[0-9]+)?\.img(\.qcow2)?$/.test(e.name)
            || /^userdata\.img(\.qcow2)?\.\d+$/.test(e.name);
          const isSnapshot = /^snapshots(\.stale-\d+)?$/.test(e.name);
          const isLock = /\.lock$/.test(e.name);
          if (!e.isDirectory() && !isUserdata && !isLock) continue;
          if (e.isDirectory() && !isSnapshot && !isLock) continue;
          try {
            if (e.isDirectory()) {
              const s = require('./layers').dirSize(p);
              fs.rmSync(p, { recursive: true, force: true });
              reclaimed += s;
            } else {
              const s = fs.statSync(p).size;
              fs.rmSync(p, { force: true });
              reclaimed += s;
            }
          } catch (_) { /* 占用中的暂跳，下次再清 */ }
        }
      }
      // 用户数据镜像被删后，用户侧「已安装 app」的记录也要清掉，
      // 否则桌面/启动器还显示着其实已不存在的 app。
      try { store.saveApps([]); } catch (_) { /* ignore */ }
      return { ok: true, reclaimed, avdDir };
    } catch (e) {
      return { ok: false, reclaimed: 0, avdDir: '', error: e.message };
    }
  }

  /**
   * 把「已保存但不会自动连」的 AndroidWifi 连上（非破坏性，不重启、不清数据）。
   * 具体实现与实机原因见 emulator.repairWifi。
   *
   * @returns {Promise<boolean>} 是否已连上
   */
  async repairWifi(adbPath = '') {
    const adb = adbPath || (typeof this.adbPath === 'function' ? this.adbPath() : '');
    return this.emulator.repairWifi(adb).catch(() => false);
  }

  /**
   * 等待虚拟机联网。
   *
   * 实测：`sys.boot_completed` 只代表系统起来了，Wi-Fi 关联 + DHCP 还要再等
   * 十几秒到一分多钟才会拿到 10.0.2.16。红果这类应用一进去就拉首页数据，
   * 没网时页面渲染成一整块黑底（隐私弹窗是本地页面所以正常显示），
   * 用户看到的就是「点同意并继续之后一直黑屏」。所以拉起应用前先等网络就绪。
   *
   * @returns {Promise<{ok:boolean,reason:string,ip?:string,gateway?:string}>}
   */
  async waitForNetwork({ timeoutMs = 90000, onLog = () => {}, adbPath = '' } = {}) {
    const done = (r) => {
      this._lastNetwork = { ok: !!(r && r.ok), ip: (r && r.ip) || '', reason: (r && r.reason) || '', at: Date.now() };
      return r;
    };
    // 速度优化：热启动 / 旋转重启后，启动路径上会连续调用本函数
    // （restartForOrientation 等一次、installer.launch 又等一次）。
    // 网络就绪是稳定的，8 秒内刚确认过就直接用结论，省掉整轮 adb 往返
    // （每次 isOnline + checkNetwork 都是两次 shell，实测要几百毫秒到 1 秒）。
    // 窗口取 8 秒：足够覆盖连续调用，又不会在真的断网后长时间骗用户。
    // 注意 stop() 会清掉 _lastNetwork，所以重启后不会误用关机前的旧状态。
    const cached = this._lastNetwork;
    if (cached && cached.ok && Date.now() - cached.at < 8000) return cached;
    const t0 = Date.now();
    let last = null;
    let lastNotice = 0;
    let offlineSince = 0;
    let notConnectedStreak = 0;
    while (Date.now() - t0 < timeoutMs) {
      const online = await this.client().isOnline().catch(() => false);
      if (!online) {
        // 刚重启的虚拟机会有一段时间连 adb 都还没上线，不能一看到 offline 就放弃
        // （之前就是这样：重置数据后立刻返回 device-offline，判定「修复失败」）。
        if (!offlineSince) offlineSince = Date.now();
        if (Date.now() - offlineSince > 45000) return done({ ok: false, reason: 'device-offline' });
      } else {
        offlineSince = 0;
        // eslint-disable-next-line no-await-in-loop
        last = await this.emulator.checkNetwork(adbPath || this.adbPath()).catch(() => null);
        if (last && last.ok) return done(last);
        // `wifi-not-connected` 是「Wi-Fi 压根没关联上」，不是「关联了还在等 DHCP」。
        // 这种状态下死等超时纯属浪费：本轮开机它不会自己连上（实机上 AndroidWifi
        // 常落成「已保存但不会自动连接」）。连续几次都是这个原因就提前收工，
        // 让调用方赶紧去做真正有效的重连，别把 20 秒耗在原地。
        // 取 3 次（≈9 秒）而不是 2 次：刚开机时 Wi-Fi 本来就要几秒关联，
        // 判太早会去点设置页，反而打断它自己连上的过程。
        if (last && last.reason === 'wifi-not-connected') {
          notConnectedStreak += 1;
          if (notConnectedStreak >= 3) return done(last);
        } else {
          notConnectedStreak = 0;
        }
      }
      if (Date.now() - lastNotice > 10000) {
        lastNotice = Date.now();
        onLog(`正在等待安卓虚拟机联网… ${Math.round((Date.now() - t0) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 3000));
    }
    return done(last || { ok: false, reason: 'timeout' });
  }

  /**
   * 修复「安卓虚拟机没有网络」。
   * 绝大多数情况只是 Wi-Fi 关联比开机完成慢，重启并等一会儿就能好，
   * **不需要**清掉用户数据；只有在等待超时后才提示用户走「重置安卓数据」。
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, error?:string}>}
   */
  /**
   * 确保虚拟机联网：先等，等不到就冷启动一次（绕开可能「没网」的快照）再等。
   * 这是「红果点同意后黑屏」的根治手段：应用一定要在网络就绪后才启动。
   *
   * @returns {Promise<{ok:boolean,reason?:string,ip?:string,gateway?:string}>}
   */
  async ensureNetwork({ onLog = () => {}, firstWaitMs = 25000, secondWaitMs = 90000 } = {}) {
    let net = await this.waitForNetwork({ onLog, timeoutMs: firstWaitMs });
    if (net && net.ok) return net;
    // 先试便宜的办法：把「已保存但不会自动连」的 AndroidWifi 点一下。
    // 这一步比冷启动、比清数据都轻几个数量级——不重启虚拟机、不动用户数据。
    // 实机上这才是绝大多数「虚拟机没网」的真正原因（见 emulator.repairWifi 注释）。
    if (!this._wifiRepairTried) {
      this._wifiRepairTried = true;
      onLog('虚拟机连不上 Wi-Fi，正在尝试重新连接…');
      try {
        const fixed = await this.emulator.repairWifi(this.adbPath());
        if (fixed) {
          net = await this.waitForNetwork({ onLog, timeoutMs: 15000 });
          if (net && net.ok) {
            onLog(`网络已恢复（${net.ip || ''}），正在保存可用状态，下次直接就好。`);
            try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
            return net;
          }
        }
      } catch (_) { /* 修复失败就走下面的重路径 */ }
    }
    // 冷启动很贵（几十秒），一个进程里只做一次：否则每次点开应用都要重来一遍，
    // 用户感受到的就是「点开要等好几分钟」。
    if (this._netColdBootTried) return net;
    this._netColdBootTried = true;
    onLog('网络仍未就绪，正在冷启动一次虚拟机（不加载快照）后重试…');
    try {
      await this.stop({ graceful: false }).catch(() => {});
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) return { ok: false, reason: 'boot-failed' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    net = await this.waitForNetwork({ onLog, timeoutMs: secondWaitMs });
    if (net && net.ok) {
      // 网络正常后立刻存快照，下次恢复时网卡状态一起还原
      try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
    }
    return net;
  }

  /**
   * 修复「安卓虚拟机没有网络」。
   * 顺序：冷启动（不动数据）→ 等网络 → 还不行才重置数据（会丢应用内数据）。
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, wiped?:boolean, error?:string}>}
   */
  async repairNetwork({ onLog = () => {} } = {}) {
    try {
      // 阶梯式修复，从最便宜的开始，能不丢数据就绝不丢：
      //   1) 重新连一次 Wi-Fi（不重启、不动数据）
      //   2) 冷启动（不加载快照，仍不动数据）
      //   3) 最后才重置数据
      onLog('正在修复虚拟机网络：先尝试重新连接 Wi-Fi（不影响已装应用）…');
      if (!this.vmRunning) {
        const boot0 = await this.ensure({ onLog });
        if (!boot0 || !boot0.ok) {
          return { ok: false, error: (boot0 && boot0.error) || '虚拟机没能启动', boot: false };
        }
      }
      this._wifiRepairTried = true;
      let fixed = false;
      try { fixed = await this.emulator.repairWifi(this.adbPath()); } catch (_) { fixed = false; }
      if (fixed) {
        const net1 = await this.waitForNetwork({ onLog, timeoutMs: 30000 });
        if (net1 && net1.ok) {
          try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
          onLog(`网络已恢复（${net1.ip || ''}），已存好可用快照。`);
          return { ok: true, network: net1, boot: true, wiped: false };
        }
      }
      // 第 2 步：冷启动，绕开可能「没网」的快照
      onLog('重新连接没成功，正在冷启动一次虚拟机（不加载快照，数据保留）…');
      await this.stop({ graceful: false }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) {
        return { ok: false, error: (boot && boot.error) || '虚拟机没能启动', boot: false };
      }
      let network = await this.waitForNetwork({ onLog, timeoutMs: 90000 });
      if (network && network.ok) {
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(`网络已恢复（${network.ip || ''}），已存好可用快照。`);
        return { ok: true, network, boot: true, wiped: false };
      }
      // 第 3 步：还没网，只能重置数据了（会丢应用内数据）
      onLog('仍然没有网络，正在重置安卓数据并重新开机（应用清单会保留，点开时自动重装）…');
      if (this.vmRunning) await this.stop({ graceful: false }).catch(() => {});
      // 给上一次的 qemu / netsimd 一点时间退干净，否则 -wipe-data 会撞 AVD 锁
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceWipeOnNextStart();
      const boot2 = await this.ensure({ onLog });
      if (!boot2 || !boot2.ok) {
        return { ok: false, error: (boot2 && boot2.error) || '虚拟机没能启动', boot: false, wiped: true };
      }
      network = await this.waitForNetwork({ onLog, timeoutMs: 240000 });
      if (network && network.ok) {
        // 立刻把「网络正常」的状态存成快照：下次恢复时网卡状态一起还原，
        // 否则关掉再开又会回到没网状态。
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(`网络已恢复（${network.ip || ''} 网关 ${network.gateway || '可达'}），已存好可用快照。`);
      } else {
        onLog('重置后仍未联网。请检查本机网络/防火墙是否拦截了模拟器（netsimd 走本机回环端口）。');
      }
      return { ok: !!(network && network.ok), network, boot: true, wiped: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  dispose() {
    if (this._watchdog) clearInterval(this._watchdog);
    if (this._client && this._client.disposeInput) this._client.disposeInput();
    // 后端适配层只有自带运行时；dispose 只做自己的清理，不会去动任何外部模拟器
    if (this._backend && this._backend.dispose) {
      try { this._backend.dispose(); } catch (_) { /* ignore */ }
    }
    this.emulator.cancelSnapshotSave();
    // 这里【绝对不能】强杀 qemu：
    //  1) 强杀会把正在写盘的 quickboot 快照截断，只留下几 GB 的 ram.img 空壳，
    //     下次开机加载失败 → 全量冷启动，这就是「每次打开都要等两分钟」的直接原因；
    //  2) 留着它，下次打开 ApkStart 可以直接接管，点应用秒开（WSA / 应用宝电脑版同款行为）。
    // 卸载时另走一条路（app:removeSelf 会显式清理进程）。
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
  }

  get bootLog() { return this._bootLog.slice(-60); }
}

module.exports = { Runtime, MONITOR_PORT };
