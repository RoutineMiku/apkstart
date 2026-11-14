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
const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Provisioner } = require('./provision');
const doctor = require('./doctor');
const userdata = require('./userdata');

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
    this.cancelSnapshotSave();
    this._snapSaved = false;
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
   * AVD 目录里是否真的有一份**完整**的 quickboot 快照。
   * 只判断「目录非空」是不够的：保存被中断时会留下一个只有 12 字节 snapshot.pb 的空壳，
   * emulator 会尝试加载、失败（日志 "does not have the requested snapshot"）再回退冷启动，
   * 白等几秒。这里按文件大小校验，顺手清掉空壳和旧版遗留的 default_boot（单个 3GB）。
   */
  hasSnapshot() {
    const base = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME);
    const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
    const pb = size(path.join(base, 'snapshot.pb'));
    // 新版 emulator（37.x）写的是 ram.bin，老版本写 ram.img。
    // 只认 ram.img 的后果非常严重：刚存好的 3GB 快照会被当成空壳删掉，
    // 于是每次都带 -no-snapshot-load，永远冷启动 —— 这是「打开很慢」的一半原因。
    const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
    if (pb > 1024 && ram > 1024 * 1024) return true;
    if (pb === 0 && ram === 0) return false;   // 目录本来就没有，别白删
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    this._cleanLegacySnapshots();
    return false;
  }

  /** 清掉旧版遗留/失败重命名留下的快照目录（default_boot 里的 ram.img 可达 3GB） */
  _cleanLegacySnapshots() {
    const dir = path.dirname(path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME));
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      if (name === SNAPSHOT_NAME) continue;
      if (/^default_boot$|\.stale-\d+$/i.test(name)) {
        try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    }
  }

  /**
   * 清掉占着 AVD 锁的孤儿模拟器。
   * emulator.exe 只是个启动器，真正的 qemu 被 spawn 成独立进程（detached），
   * 所以只 kill 自己手上的 proc 句柄经常留个孤儿在那占着 multiinstance.lock，
   * 下一次启动就会 FATAL "Running multiple emulators with the same AVD"。
   * 按「AVD 锁里的 pid」+「命令行带本 AVD 名的 qemu/emulator」两个来源清。
   */
  async killOrphanProcesses({ onLog = () => {} } = {}) {
    if (process.platform !== 'win32') return 0;
    const avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);

    // 快速路径（每次冷启动都会走到）：
    //  - 没有 .lock → 不可能有活着的 emulator 占着这个 AVD，直接返回；
    //  - 有 lock 但端口没人监听 → 只是上次强杀留下的残留目录，清掉即可。
    // 以前无论什么情况都要跑一次 wmic（1~3 秒，还很吃 CPU），冷启动时明显拖慢。
    let locks = [];
    try { locks = fs.readdirSync(avdDir).filter((f) => /\.lock$/i.test(f)); } catch (_) { locks = []; }
    if (!locks.length) return 0;
    if (!(await this._anyEmulatorPortAlive())) {
      this.clearLocks(avdDir);
      return 0;
    }

    const pids = new Set();
    // 1) 锁文件里 emulator 自己写的 pid（最可靠）
    try {
      const f = path.join(avdDir, 'hardware-qemu.ini.lock', 'pid');
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
        if (pid) pids.add(pid);
      }
    } catch (_) { /* ignore */ }
    // 2) 兜底：按进程名 + 端口找活着的 qemu（tasklist/netstat 比 wmic 快一个量级）
    try {
      const [tl, ns] = await Promise.all([
        new Promise((res) => execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
        new Promise((res) => execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
      ]);
      const qemuPids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) qemuPids.add(m[2]);
      }
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && qemuPids.has(m[2])) pids.add(Number(m[2]));
      }
    } catch (_) { /* 拿不到进程列表就只靠锁文件里的 pid */ }
    pids.delete(process.pid);
    if (!pids.size) {
      this.clearLocks(avdDir);
      return 0;
    }
    onLog(`清理 ${pids.size} 个残留模拟器进程`);
    await Promise.all([...pids].map((pid) => new Promise((r) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r());
    })));
    await sleep(1200);
    this.clearLocks(avdDir);
    return pids.size;
  }

  /** 5554~5620 里是否有 emulator 控制台端口在监听（连接被拒会立刻返回，代价极小） */
  async _anyEmulatorPortAlive() {
    const net = require('net');
    const probe = (port) => new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(120, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await probe(port)) return true;
    }
    return false;
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

    // 配置指纹变化 → 旧 quickboot 快照必然加载失败或产生黑屏，主动作废。
    // 注意：这里只作废**快照**，绝不能顺手 -wipe-data —— 用户数据里是已装的应用和存档。
    const key = `${doctor.snapshotKey({
      dataMB, emulatorVersion: this._emuVersion || '', api, tag,
    }, choice.dir)}|${screen.w}x${screen.h}@${screen.dpi}`;
    const keyFile = path.join(avdDir, 'snapshot.key');
    let prevKey = '';
    try { prevKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch (_) { /* 首次 */ }
    const snapshotStale = !!(prevKey && prevKey !== key);
    if (this.wipePending || snapshotStale || wipe) {
      // 删除可能被系统/安全软件拦截（快照目录常有几个 GB）。
      // 失败就改名让 emulator 不再加载它，绝不因为清理失败而中断启动。
      const snapDir = path.join(avdDir, 'snapshots');
      try {
        fs.rmSync(snapDir, { recursive: true, force: true });
      } catch (_) {
        try { fs.renameSync(snapDir, `${snapDir}.stale-${Date.now()}`); } catch (__) { /* ignore */ }
      }
    }
    // 只有「镜像换了」（tag / sysdir 变化）才需要 -wipe-data：旧 userdata 与新镜像
    // 的 APEX 不兼容，不重建会一直卡在引导循环。改容量 / 改分辨率 / 换渲染后端都不算。
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

    // /data 分区必须先「真的能用」，否则后面一切都是白等（见 ensureDataPartition 注释）
    const data = this.ensureDataPartition(avdDir, dataMB);

    return {
      home, avdDir, ini: path.join(home, `${AVD_NAME}.ini`), image: choice,
      wipePending: this.wipePending, screen, data,
    };
  }

  /**
   * 保证 userdata 分区是一个**真正可用**的 ext4 —— 这是「点开应用 30 秒进桌面」的地基。
   *
   * 为什么必须自己做（三条都是实测踩出来的）：
   *  1. 系统镜像包里的 userdata.img 是 1MB 全零占位，真正格式化靠 avdmanager 调 SDK 的
   *     mke2fs。ApkStart 直接写 config.ini 拉 emulator，跳过那一步 → /data 全零 →
   *     内核 "Invalid ext4 superblock on /dev/block/vdc" → guest 掉进 recovery 重启循环 →
   *     adbd 永远不上线 → 上层 probe 一直 pending，最后 240s 超时。原表现：点开要等好几分钟。
   *  2. emulator 自带的 e2fsck/resize2fs 是 cygwin 版 e2fsprogs 1.42.12，**不认识 encrypt
   *     特性**，带这个位它直接 exit 8 拒绝干活，所以「扩文件系统」必须排在补位之前。
   *  3. 文件系统必须 ≥ 分区大小：只给 64MB 的话，APEX 解压 + dexopt 立刻写满，
   *     之后所有 setxattr 返回 ENOSPC → SELinux 标签写不进去 → netd/media/tombstoned
   *     一起 exit 1 → 开机卡在启动动画，adb 永远 offline。
   */
  ensureDataPartition(avdDir, dataMB = 4096) {
    const emulatorExe = this.locate().emulatorExe;
    if (!emulatorExe || !fs.existsSync(emulatorExe)) return { ok: false, reason: 'no-emulator' };
    try { fs.mkdirSync(avdDir, { recursive: true }); } catch (_) { /* ignore */ }
    const emuDir = path.dirname(emulatorExe);
    const img = path.join(avdDir, 'userdata-qemu.img');
    const wantBytes = Math.max(1024, Math.round(dataMB || 4096)) * 1024 * 1024;
    let size = 0;
    try { size = fs.statSync(img).size; } catch (_) { /* 不存在 */ }

    if (size > 0 && userdata.hasExt4Superblock(img)) {
      // 文件够大 + 文件系统也真的长到了这个大小，才算「不用动」。
      // 只看文件大小会漏掉一种真实故障：qemu-img 撑开了文件、resize2fs 却失败了，
      // 于是文件 6GB、安卓只有 64MB —— 用户看到的就是「装游戏说空间不足」。
      const fsBytes = userdata.fsBytes(img);
      const fsOk = fsBytes >= Math.min(size, wantBytes) * 0.95;
      if (size >= wantBytes && fsOk) return { ok: true, created: false, size, fsBytes };
      // 容量配置变大了（或文件系统没长到位）：就地扩容，不重建、保留已装应用
      try {
        userdata.clearEncryptFlag(img);
        if (size < wantBytes) this._qemuImg('resize', img, wantBytes);
        this._resize2fs(img);
        userdata.setEncryptFlag(img);
        const grown = userdata.fsBytes(img);
        this.log(`userdata 扩容：文件 ${size} → ${wantBytes}，文件系统 ${fsBytes} → ${grown}`);
        return { ok: true, created: false, grown: true, size: wantBytes, fsBytes: grown };
      } catch (e) {
        this.log(`扩容 userdata 失败（继续用现有分区）：${e.message}`);
        // 老分区仍然可用，但必须如实告诉调用方「这次没扩成」，不能让设置页显示成功
        return { ok: false, created: false, size, fsBytes, error: e.message };
      }
    }

    // 首次 / 旧版留下的全零占位 / 镜像损坏：全新造一个
    try {
      fs.rmSync(img, { force: true });
      fs.rmSync(`${img}.qcow2`, { force: true });
      // 先不带 encrypt 位（老 e2fsck/resize2fs 才肯干活）
      fs.writeFileSync(img, userdata.buildEmptyExt4({ sizeMB: 64, encrypt: false }));
      this._qemuImg('resize', img, wantBytes);
      this._resize2fs(img);
      userdata.setEncryptFlag(img);
      this.log(`已重建 userdata：${(wantBytes / 1024 / 1024 / 1024).toFixed(1)}GB ext4（4K block，支持 FBE）`);
      return { ok: true, created: true, size: wantBytes };
    } catch (e) {
      // 尽力而为：哪怕扩容失败，也要把 encrypt 位补回去，让 FBE 能初始化（分区会偏小）
      try { userdata.setEncryptFlag(img); } catch (_) { /* ignore */ }
      this.log(`重建 userdata 失败：${e.message}`);
      return { ok: false, created: true, error: e.message };
    }
  }

  /** emulator 自带 qemu-img.exe：把原始镜像文件撑到目标大小（稀疏，瞬间完成）
   *  注意参数顺序：`qemu-img <命令> -f raw <文件> <大小>`。
   *  把 -f 放命令前面会被它当成全局参数直接报 unrecognized option。 */
  _qemuImg(op, ...rest) {
    const exe = path.join(path.dirname(this.locate().emulatorExe), 'qemu-img.exe');
    const r = spawnSync(exe, [op, '-f', 'raw', ...rest], {
      cwd: path.dirname(exe), windowsHide: true, encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`qemu-img ${op} 失败: ${(r.stderr || '').trim() || r.status}`);
  }

  /** emulator 自带 resize2fs.exe（cygwin 版，必须在 bin64 目录下跑才能找到 DLL） */
  _resize2fs(img) {
    const bin = path.join(path.dirname(this.locate().emulatorExe), 'bin64');
    const exe = path.join(bin, 'resize2fs.exe');
    if (!fs.existsSync(exe)) throw new Error('缺少 resize2fs.exe');
    const r = spawnSync(exe, [img], {
      cwd: bin, windowsHide: true, encoding: 'utf8', timeout: 180000,
    });
    if (r.status !== 0) throw new Error(`resize2fs 失败: ${(r.stderr || '').trim() || r.status}`);
  }

  /** emulator 依赖这些环境变量定位 SDK / AVD；中文路径一律转 8.3 短路径 */
  env(root, plan = {}) {
    const safeRoot = doctor.shortPath(root);
    // AVD 目录必须与 provisioner.paths().avdHome 一致：bundled 只读运行时（EXE 旁
    // resources/runtime）时 root/avd 不存在也不可写，AVD 要落到用户数据目录。
    const avdHome = doctor.shortPath(this.provisioner.paths().avdHome);
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
      // 音频：默认开启（让安卓应用的提示音/视频声音能放出来）。
      // 仅当用户在设置里显式关闭时才传 -no-audio 省一点 CPU。
      ...(this.settings?.engine?.audio === false ? ['-no-audio'] : []),
      '-no-boot-anim',
      '-no-metrics',
      // 关掉崩溃上报：一旦历史崩溃报告存在，emulator 会弹「同意上传」模态框，
      // 主线程被卡住、永远不开机（日志表现为 Showing crashdialog to get consent）。
      '-crash-report-mode', 'disabled',
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
    // 显式声明不限速：默认值虽然是 full，但某些 -gpu / -net 组合下会被带上
    // 模拟器的保守配置，视频类应用（红果、抖音）首屏就会明显慢半拍。
    args.push('-netdelay', 'none', '-netspeed', 'full');
    // DNS：安卓默认用 10.0.2.3（转发到主机 DNS）。主机走 VPN / 公司网 / 某些运营商
    // 时，一次解析能拖到几百毫秒，表现为「页面转圈半天才开始加载」。给一份国内公共
    // DNS 作为首选，失败时系统仍会回退。用户可在设置里关掉（内网域名场景）。
    if (this.settings?.engine?.fastDns !== false) {
      args.push('-dns-server', '223.5.5.5,119.29.29.29');
    }
    if (lcd) args.push('-skin', `${lcd.w}x${lcd.h}`);
    if (headless) {
      args.push('-no-window');
    } else {
      // 不要模拟器自带的手机外壳；侧边浮动工具栏由窗口代理隐藏。
      args.push('-no-skin');
      // 注意：不能用 -qt-hide-window。它会让模拟器**根本不创建**那个 Qt 窗口，
      // 而窗口代理正是靠 SetParent 把这个窗口嵌进应用窗口来显示画面的 ——
      // 用了它之后 probe 永远找不到窗口，用户看到的是一个全黑的应用窗口。
      // 窗口的隐藏改由窗口代理常驻压制完成（见 win/agent.ps1 的 QuietSweep）。
    }
    // 只有快照真的存在才传 -snapshot：全新 AVD（或快照刚被作废）时传了它，
    // qemu 会一直等一份不存在的内存状态，进程活着但永远不开机——
    // 上层只看到「开机超时」，接着换参数重试，反而被 AVD 锁挡成
    // "Running multiple emulators with the same AVD"。
    // 快照参数决定「下次开机是 8 秒还是 90 秒」，这里是第二个致命点：
    // 老实现「没有快照就传 -no-snapshot」，而 -no-snapshot 同时禁掉了**退出时保存**，
    // 于是第一次冷启动结束后永远产生不了快照，用户每次点开都是全量引导。
    // 正确做法是 -no-snapshot-load：这次不加载（避免等一个不存在的快照），
    // 但退出时照常把内存状态写成 apkstart，下次就直接恢复。
    // 快照要占一份约 2~3GB 的 ram.bin（磁盘紧张的用户可以关掉，只影响启动速度）
    const wantSnapshot = this.settings?.engine?.keepSnapshot !== false;
    if (wipe || !wantSnapshot) {
      args.push('-no-snapshot');
    } else if (snapshot !== false) {
      args.push('-snapshot', SNAPSHOT_NAME);
      if (!this.hasSnapshot()) args.push('-no-snapshot-load');
    } else {
      args.push('-no-snapshot');
    }
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
    this._logWrite(logFile, `\n--- ${new Date().toISOString()} ${plan.label} ---\n${loc.emulatorExe} ${args.join(' ')}\n`);

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
          this._logWrite(logFile, `${l.trim()}\n`);
        }
      });
    };
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.on('exit', (code) => {
      this.log(`emulator exit ${code}`);
      this._logWrite(logFile, `emulator exit ${code}\n`);
      this.proc = null;
      onLog(`运行时已退出（code=${code}）`);
    });
    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      this._logWrite(logFile, `spawn error: ${e.message}\n`);
      this.proc = null;
    });

    // qemu 是 detached 的独立进程，等它真正起来再把优先级降下来。
    // 不降的话 2~4 个 vCPU 线程会以 Normal 优先级和 Windows 桌面抢 CPU，
    // 用户最直观的感受就是「一打开 ApkStart，鼠标就发飘、整机变卡」。
    const perf = this.settings?.engine?.priorityMode === 'performance';
    setTimeout(() => {
      this.setPriority(perf ? 'normal' : 'below').catch(() => {});
    }, 3500).unref?.();
    return { proc, args };
  }

  /** 写模拟器日志：带大小滚动，避免长期使用把磁盘写满 */
  _logWrite(file, text) {
    const limit = Math.max(2048, Number(this.settings?.engine?.logLimitKB || 2048) * 4);
    require('./logfile').append(file, text, limit);
  }

  /** 当前 /data 镜像的实际情况（设置页展示用，不启动安卓也能取） */
  dataInfo() {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    let bytes = 0;
    try { bytes = fs.statSync(img).size; } catch (_) { /* 还没建 */ }
    return {
      avdDir: dir,
      imageBytes: bytes,
      imageGB: bytes ? Number((bytes / 1073741824).toFixed(1)) : 0,
      configuredGB: Number(this.settings?.engine?.dataPartitionGB || 0),
    };
  }

  /**
   * 立即把 /data 分区扩容到指定大小（必须保证模拟器已停止，否则镜像被占用）。
   * 走的是 ensureDataPartition 的就地扩容路径：qemu-img resize + resize2fs，
   * 不重建、不丢已装应用与存档。
   */
  resizeDataPartition(dataMB) {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    return this.ensureDataPartition(dir, dataMB);
  }

  /**
   * 调整本机 qemu/emulator 进程的优先级（只匹配命令行里带本 AVD 名的进程）。
   * level: idle（容器停放）| below（有应用在前台）| normal（性能优先）。
   */
  setPriority(level = 'below') {
    if (process.platform !== 'win32') return Promise.resolve(0);
    const script = path.join(__dirname, 'win', 'priority.ps1');
    if (!fs.existsSync(script)) return Promise.resolve(0);
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Avd', AVD_NAME, '-Level', level,
      ], { windowsHide: true, timeout: 15000 }, (_err, out) => {
        const m = /CHANGED=(\d+)/.exec(String(out || ''));
        resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /** 强杀当前尝试（含 qemu 子进程树） */
  async killAttempt() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.kill(); } catch (_) { /* ignore */ }
      if (process.platform === 'win32' && proc.pid) {
        try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* ignore */ }
      }
    }
    await sleep(800);
    // proc 句柄常常已经没了（emulator.exe 启动完就退出，qemu 是 detached 的独立进程），
    // 不按进程名兜底清一遍，下一轮就会被 AVD 锁挡成 FATAL。
    await this.killOrphanProcesses().catch(() => {});
  }

  /**
   * 重建本专用端口上的 adb server。
   *
   * 这里是「打开应用要等两分钟」最主要的元凶，历史实现只 kill-server 就返回了：
   * emulator 在启动瞬间会去连 ANDROID_ADB_SERVER_PORT 上的 adb daemon，
   * 连不上就**再也不注册这台设备** —— adb devices 里要么没有 emulator-5554，
   * 要么永远停在 offline（日志里就是那句 "Unable to connect to adb daemon on port: 5044"）。
   * 于是上层 probe 一直拿不到 sys.boot_completed，白等 3 分钟超时后重试，
   * 每次重试都是全量冷启动，快照也因为「设备不在线」保存不了，形成死循环。
   *
   * 所以必须先 kill（清掉旧设备记录）再 start，并等到端口真的在监听才返回。
   */
  /** 供上层在 adb 传输卡住（offline / unauthorized）时主动重启一次 server */
  async resetAdbServer() {
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    return this._resetAdbServer(port);
  }

  async _resetAdbServer(adbPort) {
    let adb = 'adb';
    try { adb = this.provisioner.adbVersionPath() || 'adb'; } catch (_) { /* 用 PATH 里的 */ }
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(adbPort) };
    const run = (args, timeout) => new Promise((resolve) => {
      try {
        execFile(adb, args, { timeout, windowsHide: true, env }, () => resolve());
      } catch (_) { resolve(); }
    });
    await run(['kill-server'], 6000);
    await run(['start-server'], 12000);
    // adb start-server 在部分机器上同步返回得很快，但端口还没真正 listen，
    // 这里等到能连上为止（最多 ~3 秒，正常几十毫秒）。
    const net = require('net');
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const alive = await new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port: Number(adbPort) });
        let done = false;
        const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
        sock.setTimeout(150, () => fin(false));
        sock.once('connect', () => fin(true));
        sock.once('error', () => fin(false));
      });
      if (alive) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(120);
    }
    return false;
  }

  /**
   * 等待「spawn 后马上退」的情况。
   * 参数错误/DLL 缺失时 emulator 通常 1 秒内就退；进程还在则立刻返回，
   * 不必再干等固定 2.5 秒 —— 快照恢复时这段时间足够开机跑完一半。
   */
  _waitSpawnSettled(ms = 900) {
    const proc = this.proc;
    if (!proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const onExit = () => fin(true);
      const fin = (exited) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { proc.removeListener('exit', onExit); } catch (_) { /* ignore */ }
        resolve(exited);
      };
      const timer = setTimeout(() => fin(false), ms);
      proc.once('exit', onExit);
    });
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

    const s = this.settings;
    // 开机前先看一眼磁盘：模拟器写的是 AVD（数据分区 + 快照，几个 GB），
    // 只有它所在磁盘的余量才决定能不能开机；运行时目录只写日志，要求低得多。
    // 之前把两者的余量取最小值，结果「数据目录已经挪到 D 盘、C 盘只剩 400MB」
    // 会被误判成磁盘不足 —— 挪盘等于白挪。
    const avdHome = this.provisioner.paths().avdHome;
    const avdFreeMB = doctor.freeDiskMB(avdHome);
    const diskMB = doctor.freeDiskMB(loc.root);
    const needMB = 2500;
    if (avdFreeMB && avdFreeMB < needMB) {
      const msg = `磁盘空间不足：安卓数据目录（${avdHome}）所在磁盘只剩 ${(avdFreeMB / 1024).toFixed(1)} GB，`
        + `运行时至少要 ${(needMB / 1024).toFixed(1)} GB 可用。请在「设置 → 系统集成 → 安卓数据目录」`
        + '把它改到空间充足的盘（例如 D:），或先清理磁盘。你的应用与存档不会被自动删除。';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    if (diskMB && diskMB < 300) {
      const msg = `运行时目录（${loc.root}）所在磁盘只剩 ${(diskMB / 1024).toFixed(1)} GB，`
        + '连日志和临时文件都写不下。请清理磁盘，或把「运行时数据目录」也换到别的盘。';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    const adbPort = await doctor.freeAdbPort(Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044);
    // 让本进程里所有 adb 调用和 emulator 用同一个 server 端口
    process.env.ANDROID_ADB_SERVER_PORT = String(adbPort);
    this.adbPort = adbPort;

    // 这四件事互不依赖，并行做：以前是「加速检查 → 版本 → 探端口 → 清 adb server」串行，
    // 冷启动前白等 3~5 秒，正好是用户点开应用后盯着加载框的那段时间。
    // 上一次运行留下的 adb server 可能还挂着旧设备记录（会把新模拟器挤成 offline），
    // 所以清 server 仍然要做，只是不必单独等它。
    const [accelInfo, verInfo, startPort] = await Promise.all([
      this.provisioner.emulatorAccel(),
      this.provisioner.emulatorVersion(),
      doctor.freePortPair(5554),
      this._resetAdbServer(adbPort),
    ]);
    const emuVersion = verInfo.version || '';
    this._emuVersion = emuVersion;

    // 与设置页 / 诊断报告共用同一个入口，保证「显示的」就是「实跑的」
    const profile = doctor.autoProfile({
      settings: s, accel: accelInfo, emulatorVersion: emuVersion, diskMB,
      port: startPort, adbPort,
    });
    this.profile = profile;
    const variants = doctor.planVariants(profile).slice(0, maxAttempts);

    // 记住「上次拉起就崩」的 GPU 后端，下次把它排到最后。
    // 实测：AMD Radeon 780M 上 `-gpu host` 能通过 emulator 自己的硬件检查，
    // 但 VM 起来十几秒后进程直接 exit 1（日志里只有 "AEHD is operational"），
    // 每次都要白等 20 多秒再退到 swangle。key 里带上 emulator 版本，
    // 升级运行时后自动重新给它一次机会。
    const badGpuKey = this.settings.engine.badGpu || '';
    const [badVer, badGpu] = badGpuKey.includes('|') ? badGpuKey.split('|') : ['', ''];
    if (badGpu && badVer === emuVersion) {
      const rank = (v) => (v.gpu === badGpu ? 1 : 0);
      variants.sort((a, b) => rank(a) - rank(b));
      if (variants[0] && variants[0].gpu === badGpu && variants.length > 1) {
        onLog(`上次 ${badGpu} 渲染后端启动即崩溃，本次改用 ${variants[1].gpu} 先试`);
      }
    }

    const logFile = path.join(store.DATA_DIR, 'logs', 'emulator.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this._logWrite(logFile, `\n\n=== ${new Date().toISOString()} START ${doctor.describeProfile(profile)} ===\n`);

    // 屏幕规格在整个启动过程中保持一致，否则每次重试都换分辨率会狂清快照。
    // 分辨率来自 doctor 的 profile（设置里可改「画质」），auto 时按加速状态选。
    const screen = (profile && profile.lcd) || doctor.lcdFor({ accelOk: accelInfo.ok });
    this.attempts = [];
    this.lastDiagnosis = null;
    let lastError = '';

    // 冷启前先清孤儿：上一次运行留下的 qemu 仍占着 AVD 锁时，
    // 所有尝试都会立刻 FATAL "Running multiple emulators with the same AVD"。
    // eslint-disable-next-line no-await-in-loop
    await this.killOrphanProcesses({ onLog }).catch(() => {});

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
      // 埋点：上层（main）用它在拉起模拟器**之前**打开黑窗压制。
      // 控制台窗口在 spawn 之后几十毫秒就冒出来，事后再补一次扫描必然闪一下，
      // 所以这里必须先把它打开、再拉起进程。
      if (this.onBeforeSpawn) {
        // eslint-disable-next-line no-await-in-loop
        try { await this.onBeforeSpawn(); } catch (_) { /* ignore */ }
      }
      // eslint-disable-next-line no-await-in-loop
      this.spawnOnce({ ...plan, wipe: plan.wipe || avd.wipePending }, { headless, onLog, logFile });

      // 参数错误 / DLL 缺失会立刻退出
      // eslint-disable-next-line no-await-in-loop
      const dead = await this._waitSpawnSettled(2200);
      if (dead || !this.proc) {
        const d = doctor.diagnose(this.recentLog(60));
        this.attempts.push({ plan: plan.label, diagnosis: d.code });
        this.lastDiagnosis = d;
        lastError = `${d.title}：${d.hint}`;
        // 磁盘写满不是「换组参数就能好」的问题：继续重试只会反复失败，
        // 而且历史上最后那组参数带 wipe，会把用户数据一起抹掉。直接收工、如实报错。
        if (d.code === 'DISK_FULL') {
          onLog('磁盘空间不足，已停止重试（不会动你的应用与存档）。');
          return { ok: false, error: lastError, needsSpace: true, attempts: this.attempts };
        }
        // 加速/镜像类结论可能是缓存里的旧数据，作废掉，下次启动重新探测
        if (['ACCEL', 'GPU_INIT', 'GPU_MODE', 'IMAGE', 'DLL'].includes(d.code)) {
          try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
        }
        onLog(`${d.title}，自动换一组参数重试…`);
        this._noteGpuFailure(plan);
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
      // 快照恢复往往几秒内就能起，固定 3 秒一次意味着平均要多等 1.5 秒才「发现」
      // 它已经好了。这里从 200ms 起步逐步放宽到 1.2 秒：开机早期能立刻抓到，
      // 长引导过程也不会把 CPU 花在轮询上。
      let interval = 200;
      let lastNotice = 0;
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
            try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
            fatal = true;
            break;
          }
        }
        // 每 15 秒一条进度：以前用「取模」判断，自适应间隔下会连着打两三条重复的
        if (Date.now() - lastNotice > 15000) {
          lastNotice = Date.now();
          onLog(`正在开机… ${Math.round((Date.now() - started) / 1000)}s`);
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(interval);
        interval = Math.min(1200, Math.round(interval * 1.6));
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
      this._noteGpuFailure(plan);
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
   * 保存 quickboot 快照（下次开机直接恢复内存状态，像 WSA/应用宝的快速启动）。
   *
   * 时机很重要：以前的实现是开机后 6 秒就存，正好和用户点开应用抢磁盘 I/O
   * （快照要写 1~3GB），体感反而更慢。改成「空闲时再存」，并由 Runtime 在
   * 最后一个应用窗口关闭时触发；关机前若还没来得及存，也会补一次。
   */
  async saveSnapshotNow(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    const ok = await this._saveViaAdb(adbPath, { timeout });
    // emulator 的 save 命令可能在写盘中途就回 OK，这里按文件完整性再确认一次，
    // 只有 snapshot.pb 真正落盘才算数（否则下次加载会失败并白等几秒）。
    if (!ok) return false;
    return this.hasSnapshot();
  }

  /**
   * 安排一次「空闲时保存快照」。
   * 只排一次；如果到点时容器还有应用在前台，就推迟到真正空闲。
   */
  scheduleSnapshotSave(adbPath, { delay = 20000, isIdle = () => true } = {}) {
    if (!adbPath) return;
    if (this._snapTimer) clearTimeout(this._snapTimer);
    const arm = (ms) => {
      this._snapTimer = setTimeout(async () => {
        this._snapTimer = null;
        if (!this.running()) return;
        if (!isIdle()) { arm(15000); return; }
        // 磁盘余量不够写快照（内存大小 + 1GB 余量）就跳过：硬写只会把磁盘写满，
        // 进而让下一次开机直接失败。快照只影响启动速度，不写也不影响数据。
        const freeMB = require('./doctor').freeDiskMB(store.DATA_DIR);
        const needMB = Math.round(Number(this.profile?.memoryMB || 3072) * 1.15) + 1024;
        if (freeMB && freeMB < needMB) {
          this.log(`跳过快照保存：磁盘剩余 ${(freeMB / 1024).toFixed(1)}GB < 需要 ${(needMB / 1024).toFixed(1)}GB`);
          return;
        }
        await this.saveSnapshotNow(adbPath).catch(() => false);
        this._snapSaved = true;
      }, ms);
      if (this._snapTimer.unref) this._snapTimer.unref();
    };
    arm(delay);
  }

  cancelSnapshotSave() {
    if (this._snapTimer) clearTimeout(this._snapTimer);
    this._snapTimer = null;
  }

  /** 优雅停止：慢机器先保存 quickboot 快照，再走控制台关机，最后强杀进程树 */
  async stop({ adbPath } = {}) {
    if (!this.proc) {
      // 接管来的实例没有 proc 句柄，但端口上确实有机器在跑，不能直接返回 true 走人
      if (!(await this._anyEmulatorPortAlive())) return true;
    }
    this.cancelSnapshotSave();
    const serial = this.serial;
    if (adbPath && this.snapshotWorthSaving !== false) {
      // 关机前补存一次：空闲路径没来得及存（比如用户装完应用马上退出）时，
      // 下一次开机仍然能走快照恢复，而不是重新冷启动。
      // 3GB 内存写盘要几秒到二十几秒，超时给足，别让快照写一半就被 kill 掉。
      await this._saveViaAdb(adbPath, { timeout: 60000 });
    }
    if (adbPath) {
      await new Promise((resolve) => {
        execFile(adbPath, ['-s', serial, 'emu', 'kill'],
          { timeout: 10000, windowsHide: true }, () => resolve());
      });
    }
    // 等它自己走完「落盘 → 退出」的流程。以前固定等 6 秒就强杀，
    // 正好把快照写盘掐断，留下一个只有 ram.img 没有 snapshot.pb 的空壳。
    //
    // 注意不能等 this.proc：emulator.exe 只是个启动器，spawn 完 qemu 自己就退了，
    // 拿它的 exit 当「关机完成」会立刻进入强杀分支。这里以控制台端口为准。
    for (let i = 0; i < 100 && (await this._consoleAlive()); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
    }
    await this.killAttempt();
    return true;
  }

  /**
   * 记下「拉起就崩」的 GPU 后端，下次启动把它排到最后。
   * 只对 auto 模式生效：用户显式指定后端时尊重用户选择，不偷偷改。
   */
  _noteGpuFailure(plan) {
    try {
      const gpu = plan && plan.gpu;
      if (!gpu) return;
      // 软件渲染是兜底项，它已经是最慢/最稳的选择，没有更差的替代品可退
      if (/software|swiftshader|swangle/.test(gpu)) return;
      if ((this.settings.engine.gpuMode || 'auto') !== 'auto') return;
      store.saveSettings({ engine: { badGpu: `${this._emuVersion || ''}|${gpu}` } });
    } catch (_) { /* ignore */ }
  }

  /** 本实例的控制台端口（5554）上是否还有机器在跑 —— 判断「到底关干净了没有」 */
  _consoleAlive() {
    const net = require('net');
    const port = this.port || 5554;
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(200, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
  }

  /** 用 adb 触发一次快照保存（失败返回 false，调用方决定要不要再试） */
  _saveViaAdb(adbPath, { timeout = 45000 } = {}) {
    return new Promise((resolve) => {
      execFile(adbPath, ['-s', this.serial, 'emu', 'avd', 'snapshot', 'save', SNAPSHOT_NAME],
        { timeout, windowsHide: true }, (err) => resolve(!err));
    });
  }

  recentLog(n = 40) { return this._log.slice(-n).map((x) => x.line); }
}

module.exports = { EmulatorEngine, AVD_NAME, SNAPSHOT_NAME };
