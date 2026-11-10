'use strict';
/**
 * Emulator 引擎：驱动 Google 官方 Android Emulator 作为 ApkStart 的运行时。
 *
 * 为什么用官方 emulator 而不是裸 QEMU：
 *  - 它自带 Android 专用设备模型（ranchu）、GPU 转译（swiftshader/host）与快照机制，
 *    冷启动与交互体验远超"QEMU + 通用 ISO"；
 *  - 支持 -no-window 无头运行，便于把画面渲染进 ApkStart 自己的窗口；
 *  - 官方源（dl.google.com）下载速度远高于 SourceForge 上的社区镜像。
 *
 * 本模块只负责"把模拟器正确拉起来/停下去"，不关心装了哪些应用。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Provisioner } = require('./provision');

const AVD_NAME = 'apkstart';

class EmulatorEngine {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.proc = null;
    this._log = [];
  }

  log(line) {
    this._log.push({ t: Date.now(), line });
    if (this._log.length > 400) this._log.shift();
  }

  get settings() { return store.getSettings(); }

  /** emulator.exe 与系统镜像目录（优先用户运行时目录，回退到仓库内 engine/） */
  locate() {
    const p = this.provisioner.paths();
    const emuCandidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    const emulatorExe = emuCandidates.find((c) => fs.existsSync(c)) || '';
    const img = this.provisioner.systemImageInfo();
    return { emulatorExe, sysImgDir: img.dir, sysImgOk: img.ok, root: emulatorExe ? path.dirname(path.dirname(emulatorExe)) : p.root };
  }

  /**
   * 准备 AVD：写 config.ini。放在运行时目录下，不污染用户 ~/.android。
   * 每次启动都重写，保证设置项（内存/核数/分辨率）改了立即生效。
   */
  ensureAvd({ memoryMB = 4096, cores = 4, width = 1080, height = 1920, density = 420, gpu = 'swiftshader_indirect' } = {}) {
    const p = this.provisioner.ensureDirs();
    const home = p.avdHome;
    const avdDir = path.join(home, `${AVD_NAME}.avd`);
    fs.mkdirSync(avdDir, { recursive: true });

    fs.writeFileSync(
      path.join(home, `${AVD_NAME}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir.replace(/\\/g, '/')}\ntarget=android-${p.sysApi}\n`,
    );

    // hw.cpu.arch 必须是 ABI 本身（x86_64 不能截成 x86），
    // 否则模拟器会按 32 位启动却加载 64 位内核，报 "requires an x86-64 CPU, but only detected an i686 CPU"。
    const cpuArch = p.sysAbi === 'arm64-v8a' ? 'arm64'
      : p.sysAbi === 'armeabi-v7a' ? 'arm'
        : p.sysAbi;

    const cfg = [
      `AvdId=${AVD_NAME}`,
      'avd.ini.displayname=ApkStart',
      'avd.ini.encoding=UTF-8',
      `abi.type=${p.sysAbi}`,
      `hw.cpu.arch=${cpuArch}`,
      `hw.cpu.ncore=${cores}`,
      `hw.ramSize=${memoryMB}`,
      'vm.heapSize=512',
      `image.sysdir.1=system-images/android-${p.sysApi}/${p.sysTag}/${p.sysAbi}/`,
      `tag.id=${p.sysTag}`,
      'tag.display=AOSP',
      'disk.dataPartition.size=16G',
      'hw.gpu.enabled=yes',
      `hw.gpu.mode=${gpu}`,
      'hw.keyboard=yes',
      `hw.lcd.width=${width}`,
      `hw.lcd.height=${height}`,
      `hw.lcd.density=${density}`,
      'hw.mainKeys=no',
      'ShowDeviceFrame=no',
      'PlayStore.enabled=false',
      'fastboot.forceColdBoot=yes',
      'hw.sdCard=no',
      'hw.audioInput=none',
      'hw.camera.back=none',
      'hw.camera.front=none',
      'hw.gps=no',
      'hw.sensors.orientation=no',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(avdDir, 'config.ini'), cfg);

    return { home, avdDir, ini: path.join(home, `${AVD_NAME}.ini`) };
  }

  /** emulator 依赖这三个环境变量定位 SDK / AVD */
  env(root) {
    return {
      ...process.env,
      ANDROID_SDK_ROOT: root,
      ANDROID_HOME: root,
      ANDROID_AVD_HOME: path.join(root, 'avd'),
      ANDROID_EMULATOR_HOME: path.join(root, 'avd'),
      // 不弹 metrics 询问、不写用户级配置
      ANDROID_EMULATOR_USE_SYSTEM_LIBS: '',
    };
  }

  buildArgs({ headless = true, accel = 'auto', port = 5554, snapshot = false, wipe = false } = {}) {
    const s = this.settings;
    const args = [
      '-avd', AVD_NAME,
      '-port', String(port),
      '-no-audio',
      '-no-boot-anim',
      '-no-metrics',
      '-gpu', s.engine.gpuMode || 'swiftshader_indirect',
    ];
    if (headless) args.push('-no-window');
    if (snapshot) args.push('-snapshot', 'default');
    else args.push('-no-snapshot');
    if (wipe) args.push('-wipe-data');
    if (accel === 'off') args.push('-accel', 'off');
    return args;
  }

  /**
   * 启动模拟器。返回 { ok, port, serial, accel, proc }。
   * 只负责把进程拉起来；"Android 是否可用"由上层等 adb 判断。
   */
  async start({ headless = true, onLog = () => {}, port = 5554, wipe = false } = {}) {
    if (this.proc && !this.proc.killed) return { ok: true, reused: true, serial: `emulator-${port}`, port };

    const loc = this.locate();
    if (!loc.emulatorExe) throw new Error('未安装运行时引擎，请先在「运行时」页完成部署');
    if (!loc.sysImgOk) throw new Error('系统镜像未就绪，请先在「运行时」页下载 Android 系统镜像');

    const s = this.settings;
    this.ensureAvd({
      memoryMB: s.engine.memoryMB || 4096,
      cores: s.engine.cores || 4,
    });

    const accelInfo = await this.provisioner.emulatorAccel();
    const accel = accelInfo.ok ? 'auto' : 'off';
    const args = this.buildArgs({ headless, accel, port, wipe });

    const env = this.env(loc.root);
    // 没有硬件加速时必须显式授权 TCG，否则 emulator 直接拒绝启动
    if (accel === 'off') env.ANDROID_I_WANT_MY_TCG = 'yes';

    onLog(accelInfo.ok
      ? `启动运行时（${accelInfo.note}）…`
      : `启动运行时（${accelInfo.note}）…`);

    const logFile = path.join(store.DATA_DIR, 'logs', 'emulator.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `\n\n=== ${new Date().toISOString()} START ===\n${loc.emulatorExe} ${args.join(' ')}\n`);

    const proc = spawn(loc.emulatorExe, args, {
      cwd: path.dirname(loc.emulatorExe),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;

    const pipe = (stream) => {
      stream.setEncoding('utf8');
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) {
          if (l.trim()) this.log(l.trim());
        }
      });
    };
    pipe(proc.stdout);
    pipe(proc.stderr);

    proc.on('exit', (code) => {
      this.log(`emulator exit ${code}`);
      this.proc = null;
      onLog(`运行时已退出（code=${code}）`);
    });
    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      this.proc = null;
    });

    // 等进程稳定；emulator 参数错误会立刻退出
    await new Promise((r) => setTimeout(r, 2500));
    if (!this.proc) throw new Error(`运行时启动失败，详见日志：${logFile}`);

    return { ok: true, serial: `emulator-${port}`, port, accel: accelInfo, logFile };
  }

  running() {
    return !!(this.proc && !this.proc.killed);
  }

  /** 优雅停止：优先走模拟器控制台，失败再杀进程树 */
  async stop({ adbPath } = {}) {
    if (!this.proc) return true;
    const port = 5554;
    try {
      if (adbPath) {
        const { execFile } = require('child_process');
        await new Promise((resolve) => {
          execFile(adbPath, ['-s', `emulator-${port}`, 'emu', 'kill'], { timeout: 8000 }, () => resolve());
        });
      }
    } catch (_) { /* 落到强杀 */ }

    for (let i = 0; i < 20 && this.proc; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 300));
    }
    if (this.proc) {
      try { this.proc.kill(); } catch (_) { /* ignore */ }
      // emulator 会拉起子进程（qemu-system），必须整棵树杀
      try {
        spawn('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { windowsHide: true });
      } catch (_) { /* ignore */ }
    }
    this.proc = null;
    return true;
  }

  recentLog(n = 40) {
    return this._log.slice(-n).map((x) => x.line);
  }
}

module.exports = { EmulatorEngine, AVD_NAME };
