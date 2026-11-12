'use strict';
/**
 * Emulator 引擎：驱动 Google 官方 Android Emulator 作为 ApkStart 的运行时。
 *
 * 与旧版最大的不同：这里不再假设「一套参数在所有电脑上都能跑」。
 *  1. 用 doctor.chooseProfile() 按内存/CPU/磁盘/加速状态/引擎版本自动推导参数；
 *  2. 启动失败时按 planVariants() 自动降级重试（GPU 后端 → 软件模拟 → 最小内存冷启动）；
 *  3. 动态挑空闲端口、清 AVD 锁、中文路径转短路径、镜像变更后自动作废快照；
 *  4. quickboot 快照 + 小数据分区，做到「像容器一样」共享只读基础层、秒级恢复。
 *
 * probe 回调由上层（Runtime）提供，用于判断 Android 是否真正就绪。
 */
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Provisioner } = require('./provision');
const doctor = require('./doctor');

const AVD_NAME = 'apkstart';
const SNAPSHOT_NAME = 'apkstart';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class EmulatorEngine {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.proc = null;
    this._log = [];
    this.port = 5554;
    this.adbPort = Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044;
    this.profile = null;
    this.attempts = [];
    this.lastDiagnosis = null;
    // 快照的 ram.bin ≈ 分配给虚拟机的内存（2-4GB）。
    // 冷启动本来就快的机器不该为它付出几个 GB 的磁盘，只在「真慢」时才保存。
    this.snapshotWorthSaving = null;
  }

  log(line) {
    this._log.push({ t: Date.now(), line });
    if (this._log.length > 600) this._log.shift();
  }

  get settings() { return store.getSettings(); }

  get serial() { return `emulator-${this.port}`; }

  /** emulator.exe 与系统镜像目录（优先用户运行时目录，回退到仓库内 engine/） */
  locate() {
    const p = this.provisioner.paths();
    const emuCandidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    const emulatorExe = emuCandidates.find((c) => fs.existsSync(c)) || '';
    const img = this.provisioner.systemImageInfo();
    return { emulatorExe, sysImgDir: img.dir, sysImgOk: img.ok, root: emulatorExe ? path.dirname(path.dirname(emulatorExe)) : p.root };
  }

  /** 选镜像：有通用镜像（API 34 Play）就用它，不再让用户切「兼容模式」 */
  imageChoice() {
    const play = this.provisioner.playImageInfo();
    const base = this.provisioner.systemImageInfo();
    if (play.ok) {
      return { compat: true, api: play.api, tag: play.tag, dir: play.dir, abi: 'x86_64' };
    }
    return { compat: false, api: base.api, tag: base.tag, dir: base.dir, abi: base.abi || this.provisioner.paths().sysAbi };
  }

  /**
   * 作废 quickboot 快照。
   * 快照同时保存内存和磁盘镜像，装完新应用/清了数据后如果还加载旧快照，
   * 用户会看到「刚刚装好的应用重启后又不见了」。
   */
  invalidateSnapshot() {
    try {
      const snapDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots');
      fs.rmSync(snapDir, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 清掉上次异常退出留下的锁。
   * 注意 hardware-qemu.ini.lock 是**目录**不是文件，bsdtar 式的 rmSync(force) 删不掉它，
   * 于是模拟器会一直报 "Running multiple emulators with the same AVD" 起不来
   * （被强杀过一次就会这样），必须递归删。
   */
  clearLocks(avdDir) {
    try {
      for (const f of fs.readdirSync(avdDir)) {
        if (!/\.lock$/i.test(f)) continue;
        try {
          fs.rmSync(path.join(avdDir, f), { recursive: true, force: true });
        } catch (_) { /* 被占用就跳过，下次再清 */ }
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * 准备 AVD：写 config.ini。每次启动按当前自动配置重写，保证降级重试即时生效。
   */
  ensureAvd({
    memoryMB = 2048, cores = 2, gpu = 'software', dataMB = 4096,
    heapMB = 256, accel = 'auto', snapshot = true, wipe = false, lcd = null,
  } = {}) {
    const p = this.provisioner.ensureDirs();
    const home = p.avdHome;
    const avdDir = path.join(home, `${AVD_NAME}.avd`);
    fs.mkdirSync(avdDir, { recursive: true });
    this.clearLocks(avdDir);

    // 屏幕分辨率：有硬件加速时 720x1280@320 画面清晰、文字不糊；
    // 纯软件模拟时降到 540x960，帧率优先（面积只有 56%，肉眼差距远小于流畅度差距）。
    const screen = lcd || doctor.lcdFor({ accelOk: this.profile ? this.profile.accelOk : accel !== 'off' });

    const choice = this.imageChoice();
    const tag = choice.tag;
    const api = choice.api;
    const tagDisplay = choice.compat ? 'Google Play (ARM 兼容)' : 'AOSP';

    fs.writeFileSync(
      path.join(home, `${AVD_NAME}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir.replace(/\\/g, '/')}\ntarget=android-${api}\n`,
    );

    const cfgPath = path.join(avdDir, 'config.ini');
    const wantImg = choice.dir
      ? `${choice.dir.replace(/\\/g, '/')}/`
      : `system-images/android-${api}/${tag}/${choice.abi}/`;
    this.wipePending = false;
    if (fs.existsSync(cfgPath)) {
      const prev = fs.readFileSync(cfgPath, 'utf8');
      const prevTag = /tag\.id=(.+)$/m.exec(prev);
      const prevImg = /image\.sysdir\.1=(.+)$/m.exec(prev);
      if ((prevTag && prevTag[1].trim() !== tag) || (prevImg && prevImg[1].trim() !== wantImg)) {
        // 旧 userdata 与新镜像不兼容（APEX 引导循环），必须重建
        this.wipePending = true;
      }
    }

    // 配置指纹变化 → 旧 quickboot 快照必然加载失败或产生黑屏，主动作废
    const key = `${doctor.snapshotKey({
      dataMB, emulatorVersion: this._emuVersion || '', api, tag,
    }, choice.dir)}|${screen.w}x${screen.h}@${screen.dpi}`;
    const keyFile = path.join(avdDir, 'snapshot.key');
    let prevKey = '';
    try { prevKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch (_) { /* 首次 */ }
    if (prevKey && prevKey !== key) this.wipePending = true;
    if (this.wipePending || wipe) {
      // 删除可能被系统/安全软件拦截（快照目录常有几个 GB）。
      // 失败就改名让 emulator 不再加载它，绝不因为清理失败而中断启动。
      const snapDir = path.join(avdDir, 'snapshots');
      try {
        fs.rmSync(snapDir, { recursive: true, force: true });
      } catch (_) {
        try { fs.renameSync(snapDir, `${snapDir}.stale-${Date.now()}`); } catch (__) { /* ignore */ }
      }
      // 用户数据不删（保留已装应用），只让模拟器按需重建；镜像切换本身由 -wipe-data 处理
    }
    fs.writeFileSync(keyFile, key, 'utf8');

    // hw.cpu.arch 必须是 ABI 本身（x86_64 不能截成 x86）
    const cpuArch = choice.abi === 'arm64-v8a' ? 'arm64'
      : choice.abi === 'armeabi-v7a' ? 'arm' : choice.abi;

    const cfg = [
      `AvdId=${AVD_NAME}`,
      'avd.ini.displayname=ApkStart',
      'avd.ini.encoding=UTF-8',
      `abi.type=${choice.abi}`,
      `hw.cpu.arch=${cpuArch}`,
      `hw.cpu.ncore=${cores}`,
      `hw.ramSize=${memoryMB}`,
      `vm.heapSize=${heapMB}`,
      `image.sysdir.1=${wantImg}`,
      `tag.id=${tag}`,
      `tag.display=${tagDisplay}`,
      // 旧版写死 16G，会在小硬盘/配额环境下生成巨型文件并拖慢首次开机
      `disk.dataPartition.size=${dataMB}M`,
      'hw.gpu.enabled=yes',
      `hw.gpu.mode=${gpu}`,
      'hw.keyboard=yes',
      'hw.lcd.width=' + screen.w,
      'hw.lcd.height=' + screen.h,
      'hw.lcd.density=' + screen.dpi,
      'hw.mainKeys=no',
      'ShowDeviceFrame=no',
      `PlayStore.enabled=${choice.compat}`,
      // 快照完全由命令行 -snapshot apkstart 控制：用独立名字，绝不误加载
      // 旧版遗留的 default_boot（那是 API30 镜像的内存状态，加载必进引导循环）。
      'hw.sdCard=no',
      'hw.audioInput=none',
      'hw.camera.back=none',
      'hw.camera.front=none',
      'hw.gps=no',
      'hw.sensors.orientation=no',
    ].join('\n') + '\n';
    fs.writeFileSync(cfgPath, cfg);

    return {
      home, avdDir, ini: path.join(home, `${AVD_NAME}.ini`), image: choice,
      wipePending: this.wipePending, screen,
    };
  }

  /** emulator 依赖这些环境变量定位 SDK / AVD；中文路径一律转 8.3 短路径 */
  env(root, plan = {}) {
    const safeRoot = doctor.shortPath(root);
    const avdHome = doctor.shortPath(path.join(root, 'avd'));
    const adbPort = String(plan.adbPort || process.env.ANDROID_ADB_SERVER_PORT || '5044');
    return {
      ...process.env,
      ANDROID_SDK_ROOT: safeRoot,
      ANDROID_HOME: safeRoot,
      ANDROID_AVD_HOME: avdHome,
      ANDROID_EMULATOR_HOME: avdHome,
      ANDROID_ADB_SERVER_PORT: adbPort,
      ANDROID_EMULATOR_USE_SYSTEM_LIBS: '',
      ...(plan.accel === 'off' ? { ANDROID_I_WANT_MY_TCG: 'yes' } : {}),
    };
  }

  buildArgs({
    headless = true, accel = 'auto', port = 5554,
    gpu = 'software', memoryMB = 2048, cores = 2,
    snapshot = true, wipe = false, lcd = null,
  } = {}) {
    const args = [
      '-avd', AVD_NAME,
      '-port', String(port),
      '-no-audio',
      '-no-boot-anim',
      '-no-metrics',
      '-gpu', gpu,
      '-memory', String(memoryMB),
      '-cores', String(cores),
    ];
    // 网络：AOSP 模拟器默认走 QEMU 用户态 NAT（-netdev user），安卓侧拿到
    // 10.0.2.x 的虚拟地址，出口直接复用主机的物理网卡 NAT 出去。
    // 这种模式【不会】在 Windows 上创建任何虚拟网卡 / 虚拟交换机
    // （那必须 -netdev tap 或桥接才会发生，我们全程不启用）。
    // 所以安卓应用用的是"一台挂在主机 NAT 后面的设备"，主机网络栈完全不动，
    // 不需要装驱动、也不多一个网络适配器。
    if (lcd) args.push('-skin', `${lcd.w}x${lcd.h}`);
    if (headless) {
      args.push('-no-window');
    } else {
      // 不要模拟器自带的手机外壳；侧边浮动工具栏由窗口代理隐藏。
      args.push('-no-skin');
    }
    if (snapshot && !wipe) args.push('-snapshot', SNAPSHOT_NAME);
    else args.push('-no-snapshot');
    if (wipe) args.push('-wipe-data');
    if (accel === 'off') args.push('-accel', 'off');
    return args;
  }

  /** 拉起单个进程（不做开机等待，开机等待在 start() 的 probe 循环里） */
  spawnOnce(plan, { headless, onLog, logFile }) {
    const loc = this.locate();
    const env = this.env(loc.root, plan);
    const args = this.buildArgs({
      headless, accel: plan.accel, port: plan.port, gpu: plan.gpu,
      memoryMB: plan.memoryMB, cores: plan.cores,
      snapshot: plan.snapshot, wipe: plan.wipe, lcd: plan.lcd,
    });
    fs.appendFileSync(logFile, `\n--- ${new Date().toISOString()} ${plan.label} ---\n${loc.emulatorExe} ${args.join(' ')}\n`);

    const proc = spawn(loc.emulatorExe, args, {
      cwd: path.dirname(loc.emulatorExe),
      env,
      windowsHide: true,
      // detached: 让模拟器独立于 ApkStart 进程组。
      // Electron 退出时会把自己创建的 job 对象关掉，顺带把子进程一起杀掉——
      // 表现就是"关掉 ApkStart 再打开又要冷启动 20 多秒"。独立出去之后模拟器留着，
      // 下次启动直接接管（见 Runtime.adoptExisting），点开就是秒进。
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    try { proc.unref(); } catch (_) { /* ignore */ }

    const pipe = (stream) => {
      stream.setEncoding('utf8');
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) {
          if (!l.trim()) continue;
          this.log(l.trim());
          fs.appendFileSync(logFile, `${l.trim()}\n`);
        }
      });
    };
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.on('exit', (code) => {
      this.log(`emulator exit ${code}`);
      fs.appendFileSync(logFile, `emulator exit ${code}\n`);
      this.proc = null;
      onLog(`运行时已退出（code=${code}）`);
    });
    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      fs.appendFileSync(logFile, `spawn error: ${e.message}\n`);
      this.proc = null;
    });
    return { proc, args };
  }

  /** 强杀当前尝试（含 qemu 子进程树） */
  async killAttempt() {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try { proc.kill(); } catch (_) { /* ignore */ }
    if (process.platform === 'win32' && proc.pid) {
      try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* ignore */ }
    }
    await sleep(1200);
  }

  /**
   * 启动 + 自动重试。
   * @param {Function} probe 异步回调，返回 'ok' | 'pending' | 'fatal'
   */
  async start({ headless = false, onLog = () => {}, probe = null, maxAttempts = 4 } = {}) {
    if (this.proc && !this.proc.killed) {
      return { ok: true, reused: true, serial: this.serial, port: this.port };
    }

    const loc = this.locate();
    if (!loc.emulatorExe) throw new Error('未安装运行时引擎，请先在「运行时」页完成部署');
    const choice = this.imageChoice();
    if (choice.compat ? !this.provisioner.playImageInfo().ok : !this.provisioner.systemImageInfo().ok) {
      throw new Error('系统镜像未就绪，请先在「运行时」页下载 Android 系统镜像');
    }

    const accelInfo = await this.provisioner.emulatorAccel();
    const emuVersion = (await this.provisioner.emulatorVersion()).version || '';
    this._emuVersion = emuVersion;
    const s = this.settings;
    const diskMB = doctor.freeDiskMB(loc.root);
    const startPort = await doctor.freePortPair(5554);
    const adbPort = await doctor.freeAdbPort(Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044);
    // 让本进程里所有 adb 调用和 emulator 用同一个 server 端口
    process.env.ANDROID_ADB_SERVER_PORT = String(adbPort);
    this.adbPort = adbPort;
    // 端口固定了，上一次运行留下的 server 可能还挂着旧设备记录，先清一次再起，
    // 否则新模拟器注册时会被旧记录挤成 offline。
    await new Promise((resolve) => {
      try {
        const adb = this.provisioner.adbVersionPath() || 'adb';
        execFile(adb, ['kill-server'], {
          timeout: 6000, windowsHide: true,
          env: { ...process.env, ANDROID_ADB_SERVER_PORT: String(adbPort) },
        }, () => resolve());
      } catch (_) { resolve(); }
    });

    // 与设置页 / 诊断报告共用同一个入口，保证「显示的」就是「实跑的」
    const profile = doctor.autoProfile({
      settings: s, accel: accelInfo, emulatorVersion: emuVersion, diskMB,
      port: startPort, adbPort,
    });
    this.profile = profile;
    const variants = doctor.planVariants(profile).slice(0, maxAttempts);

    const logFile = path.join(store.DATA_DIR, 'logs', 'emulator.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `\n\n=== ${new Date().toISOString()} START ${doctor.describeProfile(profile)} ===\n`);

    // 屏幕规格在整个启动过程中保持一致，否则每次重试都换分辨率会狂清快照
    const screen = doctor.lcdFor({ accelOk: accelInfo.ok });
    this.attempts = [];
    this.lastDiagnosis = null;
    let lastError = '';

    for (let i = 0; i < variants.length; i += 1) {
      const base = variants[i];
      // 端口占用也会导致失败，每次重试重新探测一次
      // eslint-disable-next-line no-await-in-loop
      const port = i === 0 ? startPort : await doctor.freePortPair(startPort + (i * 2));
      const plan = { ...base, port, adbPort, lcd: screen };
      this.port = port;
      onLog(`启动运行时（第 ${i + 1}/${variants.length} 次：${plan.label}）…`);

      // eslint-disable-next-line no-await-in-loop
      const avd = this.ensureAvd({
        ...plan,
        wipe: plan.wipe || !!this.wipePending,
      });
      // eslint-disable-next-line no-await-in-loop
      this.spawnOnce({ ...plan, wipe: plan.wipe || avd.wipePending }, { headless, onLog, logFile });

      // 参数错误 / DLL 缺失会立刻退出
      // eslint-disable-next-line no-await-in-loop
      await sleep(2500);
      if (!this.proc) {
        const d = doctor.diagnose(this.recentLog(60));
        this.attempts.push({ plan: plan.label, diagnosis: d.code });
        this.lastDiagnosis = d;
        lastError = `${d.title}：${d.hint}`;
        onLog(`${d.title}，自动换一组参数重试…`);
        continue;
      }

      if (!probe) {
        return { ok: true, serial: this.serial, port, accel: accelInfo, logFile, profile, attempts: this.attempts };
      }

      const started = Date.now();
      const timeout = plan.bootTimeoutMs || 240000;
      let ok = false;
      let fatal = false;
      let sawBooting = false;
      // eslint-disable-next-line no-await-in-loop
      while (Date.now() - started < timeout) {
        if (!this.proc) { fatal = true; break; }
        let state = 'pending';
        try {
          // eslint-disable-next-line no-await-in-loop
          state = await probe({ serial: this.serial, port, adbPort });
        } catch (_) { state = 'pending'; }
        if (state === 'ok') { ok = true; break; }
        if (state === 'fatal') { fatal = true; break; }
        // 只要 adb 能执行 shell，说明内核已经在引导，日志里的普通 Vulkan/EGL 信息不算失败
        if (state === 'booting') sawBooting = true;
        // 45 秒仍完全没连上，且日志出现明确致命错误 → 提前换方案，不干等 4 分钟
        if (!sawBooting && Date.now() - started > 45000) {
          const d = doctor.diagnose(this.recentLog(80));
          if (['GPU_INIT', 'ACCEL', 'GPU_MODE', 'IMAGE', 'DLL', 'MEMORY'].includes(d.code)) {
            this.lastDiagnosis = d;
            fatal = true;
            break;
          }
        }
        // eslint-disable-next-line no-await-in-loop
        if ((Date.now() - started) % 15000 < 3500) onLog(`正在开机… ${Math.round((Date.now() - started) / 1000)}s`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(3000);
      }

      if (ok) {
        const bootMs = Date.now() - started;
        // 一定要存 quickboot 快照：模拟器进程会随 ApkStart 退出而结束（Electron 的
        // job 对象会连带杀掉子进程），下次打开有没有快照直接决定是 25 秒还是 7 秒。
        // 装完新应用时 installer 会作废快照，避免"重启后应用消失"。
        this.snapshotWorthSaving = true;
        onLog(`运行时就绪（${Math.round(bootMs / 1000)}s，${plan.label}）`);
        return {
          ok: true, serial: this.serial, port, accel: accelInfo, logFile,
          profile, attempts: this.attempts, bootMs, quickBoot: true,
        };
      }

      const d = fatal ? (this.lastDiagnosis || doctor.diagnose(this.recentLog(80))) : doctor.diagnose(this.recentLog(80));
      this.attempts.push({ plan: plan.label, diagnosis: d.code, timeout: !fatal });
      this.lastDiagnosis = d;
      lastError = fatal ? `${d.title}：${d.hint}` : '开机超时（可能是首次引导较慢或硬件加速未生效）';
      onLog(`${lastError}，自动换一组参数重试…`);
      // eslint-disable-next-line no-await-in-loop
      await this.killAttempt();
    }

    const d = this.lastDiagnosis || doctor.diagnose(this.recentLog(120));
    const report = doctor.writeReport({
      dataDir: store.DATA_DIR, profile, logLines: this.recentLog(300),
      extra: { attempts: this.attempts, diagnosis: d, image: choice },
    });
    const err = new Error(
      `运行时多次尝试仍未能启动（${d.title}）。\n${d.hint}\n\n`
      + `已尝试：${this.attempts.map((a) => `${a.plan} → ${a.diagnosis}`).join('；')}\n`
      + `诊断报告：${report.file}`,
    );
    err.diagnosis = d;
    err.report = report.file;
    err.attempts = this.attempts;
    throw err;
  }

  running() { return !!(this.proc && !this.proc.killed); }

  /**
   * 开机成功后顺手存一份 quickboot 快照。
   * 模拟器进程活不过 ApkStart（Electron 退出会连带清理子进程），所以不能指望
   * "退出时再存"；开机完趁系统干净存一份，下次打开直接 7 秒进桌面而不是 25 秒。
   * 装新应用后 installer 会作废快照，不用担心应用消失。
   */
  saveSnapshotSoon(adbPath) {
    if (this._snapQueued || !adbPath) return;
    this._snapQueued = true;
    const serial = this.serial;
    setTimeout(() => {
      execFile(adbPath, ['-s', serial, 'emu', 'avd', 'snapshot', 'save', SNAPSHOT_NAME],
        { timeout: 60000, windowsHide: true }, () => { /* 存不上就算了，下次照常冷启动 */ });
    }, 6000).unref?.();
  }

  /** 优雅停止：慢机器先保存 quickboot 快照，再走控制台关机，最后强杀进程树 */
  async stop({ adbPath } = {}) {
    if (!this.proc) return true;
    const serial = this.serial;
    if (adbPath && this.snapshotWorthSaving !== false) {
      await new Promise((resolve) => {
        execFile(adbPath, ['-s', serial, 'emu', 'avd', 'snapshot', 'save', SNAPSHOT_NAME],
          { timeout: 8000, windowsHide: true }, () => resolve());
      });
    }
    if (adbPath) {
      await new Promise((resolve) => {
        execFile(adbPath, ['-s', serial, 'emu', 'kill'],
          { timeout: 8000, windowsHide: true }, () => resolve());
      });
    }
    for (let i = 0; i < 20 && this.proc; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
    }
    await this.killAttempt();
    return true;
  }

  recentLog(n = 40) { return this._log.slice(-n).map((x) => x.line); }
}

module.exports = { EmulatorEngine, AVD_NAME, SNAPSHOT_NAME };
