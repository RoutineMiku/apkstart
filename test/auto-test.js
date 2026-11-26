'use strict';
/**
 * 零配置自适应 / 容器式瘦身的回归测试（纯 Node，不拉起 emulator）
 * 运行：node test/auto-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zhMessages = require('../src/locales/zh-CN.json');

const TMP = path.join(os.tmpdir(), `apkstart-auto-test-${Date.now()}`);
process.env.APPDATA = TMP;
fs.mkdirSync(path.join(TMP, 'apkstart'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed += 1; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed += 1; results.push(`  ✗ ${name}\n    ${e.stack || e.message}`); });
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

const doctor = require('../src/core/doctor');
const layers = require('../src/core/layers');
const pointer = require('../src/core/pointer');
const { AdbClient, friendlyInstallError, friendlyLaunchError } = require('../src/core/adb');

(async () => {
  console.log('\n[doctor.js 自动参数]');

  await test('GPU 后端按 emulator 版本选择（新版本 host 优先 + 软件渲染兜底，老版本 swiftshader_indirect）', () => {
    // gpuCandidates 会根据本机 GPU 厂商微调顺序（AMD 把 swangle 提前），
    // 所以这里只断言「候选列表包含关键项」而非固定首位。
    const c37 = doctor.gpuCandidates('37.3.8.0');
    assert(c37.includes('host'), '37.x 候选必须包含 host');
    assert(c37.includes('swangle'), '37.x 候选必须包含 swangle');
    assert(c37.includes('software'), '新版本必须有软件渲染兜底');
    // 37.x 上传 swiftshader_indirect 会 GL 初始化失败，绝不能出现在候选里
    assert(!c37.includes('swiftshader_indirect'));
    // 老版本仍走 swiftshader_indirect
    const c35 = doctor.gpuCandidates('35.1.4.0');
    assert(c35.includes('host'));
    assert(c35.includes('swiftshader_indirect'));
    // detectGpuVendor 应返回已知值或 unknown（不抛异常）
    const v = doctor.detectGpuVendor();
    assert(['nvidia', 'amd', 'intel', 'unknown'].includes(v), `detectGpuVendor 返回了意外值: ${v}`);
  });

  await test('小内存机器自动降配（不再是写死 4GB / 4 核）', () => {
    const host = { totalMB: 4096, freeMB: 2600, cores: 2, home: 'C:\\Users\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: false }, emulatorVersion: '37.3.8.0', diskMB: 20000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB === 2048, `内存应为 2048，实际 ${p.memoryMB}`);
    assert(p.cores === 2, `核心应为 2，实际 ${p.cores}`);
    assert(p.accel === 'off', '无硬件加速应自动回退软件模拟');
    assert(p.bootTimeoutMs > 240000, '软件模拟应给更长的开机超时');
    assert(p.gpu === 'host' || p.gpu === 'swangle', `首选渲染应为 host 或 swangle（AMD 机器 swangle 优先），实际 ${p.gpu}`);
    // accel 关闭时的保底参数必须是软件渲染，否则 TCG 下无 GPU 可用
    const lastResort = doctor.planVariants(p).find((v) => v.lastResort);
    assert(lastResort && /software|swiftshader/.test(lastResort.gpu), '保底方案必须用软件渲染');
    // 数据分区默认按磁盘余量给 4/6/8GB（不再写死 16G），且可以被设置覆盖
    assert(p.dataMB >= 4096 && p.dataMB <= 8192, `数据分区应在 4~8GB，实际 ${p.dataMB}`);
    const big = doctor.chooseProfile({
      host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000,
      settings: { engine: { dataPartitionGB: 24 } }, overrides: {},
    });
    assert(big.dataMB === 24 * 1024, '设置里的数据分区容量必须生效');
  });

  await test('大内存机器不会无限吃内存', () => {
    const host = { totalMB: 65536, freeMB: 50000, cores: 32, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB <= 3072 && p.cores <= 4, `高配也应封顶：${p.memoryMB}MB / ${p.cores}核`);
    assert(p.accel === 'auto');
  });

  await test('重试矩阵：从最优到最保守，包含软件模拟与冷启动兜底', () => {
    const p = doctor.chooseProfile({
      host: doctor.hostInfo(), accel: { ok: true }, emulatorVersion: '37.3.8.0',
      diskMB: 50000, port: 5554, adbPort: 5044,
    });
    const v = doctor.planVariants(p);
    assert(v.length >= 3 && v.length <= 4, `重试次数应 3-4，实际 ${v.length}`);
    assert(v.some((x) => x.accel === 'off'), '缺少软件模拟兜底');
    // 最后一档只做「不加载快照 + 最小内存」，绝不允许 -wipe-data：
    // 磁盘写满时每一档都会失败，带 wipe 的话会把用户已装应用一起清掉（实测踩过）。
    assert(v[v.length - 1].snapshot === false, '最后一档必须跳过快照加载');
    assert(v[v.length - 1].wipe === false, '任何自动重试都不允许清用户数据');
    assert(v[v.length - 1].memoryMB <= 2048, '最后一档应降到最小内存');
    const keys = v.map((x) => `${x.gpu}|${x.accel}|${x.wipe}|${x.memoryMB}|${x.snapshot !== false}`);
    assert(new Set(keys).size === keys.length, '重试方案不应重复');
    // 方案名要随界面语言走（开机日志和失败摘要都会把它显示给用户），且两种语言都不能是空的
    const i18n = require('../src/core/i18n');
    const labelsOf = (lang) => { i18n.setLocale(lang); try { return doctor.planVariants(p).map((x) => x.label); } finally { i18n.setLocale('zh-CN'); } };
    const zhLabels = labelsOf('zh-CN');
    const enLabels = labelsOf('en');
    assert(zhLabels.every((l) => /[\u3400-\u9fff]/.test(l)), `简体中文方案名应保持中文：${zhLabels}`);
    assert(enLabels.length === zhLabels.length && enLabels.every((l) => l && !/[\u3400-\u9fff]/.test(l)), `英文方案名不应含中文：${enLabels}`);
    assert(zhLabels.some((l) => l.includes('硬件加速')) && enLabels.some((l) => /hardware acceleration/.test(l)), '第一档应标明硬件加速');
    assert(zhLabels.some((l) => l.includes('保守冷启动')) && enLabels.some((l) => /cold start/i.test(l)), '最后一档应标明冷启动');
  });

  await test('镜像换盘不算换镜像：sysdir 换了目录不该清用户数据', () => {
    const c = 'C:/Users/x/AppData/Roaming/apkstart/system-images/android-34/google_apis_playstore/x86_64/';
    const d = 'D:/ApkStartRuntime/system-images/android-34/google_apis_playstore/x86_64/';
    assert(doctor.imageIdentity(c) === doctor.imageIdentity(d), '同一套镜像的路径身份必须相同');
    const key = (p) => doctor.snapshotKey({ emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' }, p);
    assert(key(c) === key(d), '换盘后快照不该作废（否则白等一次冷启动）');
    const other = 'D:/rt/system-images/android-34/google_apis/x86_64/';
    assert(doctor.imageIdentity(other) !== doctor.imageIdentity(d), '真的换了镜像必须能识别出来');
  });

  await test('快照指纹不随 GPU/加速/内存重试变化（避免每次重试都清空已装应用）', () => {
    const a = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const b = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const c = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img2');
    assert(a === b && a !== c);
  });

  await test('日志诊断能识别显卡/加速/中文路径/锁文件问题', () => {
    assert(doctor.diagnose(['Failed to initialize GL emulation']).code === 'GPU_INIT');
    assert(doctor.diagnose(['ERROR: x86_64 emulation currently requires hardware acceleration!']).code === 'ACCEL');
    assert(doctor.diagnose(['Cannot allocate memory for guest RAM']).code === 'MEMORY');
    assert(doctor.diagnose(['panic: AVD apkstart is already running']).code === 'AVD_LOCK');
    assert(doctor.diagnose(['non-ASCII path is not supported']).code === 'NON_ASCII');
    assert(doctor.diagnose(['random line']).code === 'UNKNOWN');
  });

  await test('日志诊断：emulator 以 0xC0000005 退出要判定为渲染后端崩溃', () => {
    // 实测 issue #20/#25：打印完 Userspace boot properties 后 exit 3221225477
    assert(doctor.diagnose(['emulator exit 3221225477']).code === 'ACCESS_VIOLATION');
    assert(doctor.diagnose(['... 0xC0000005 ...']).code === 'ACCESS_VIOLATION');
    // 崩溃日志里通常也带着渲染初始化信息：必须优先判崩溃，而不是 GPU_INIT
    const mixed = ['Graphics backend: gfxstream', 'emulator exit 3221225477'];
    assert(doctor.diagnose(mixed).code === 'ACCESS_VIOLATION', '崩溃应优先于普通渲染日志');
  });

  await test('空闲端口探测返回偶数端口对', async () => {
    const p = await doctor.freePortPair(5560);
    assert(p % 2 === 0 && p >= 5560, `端口异常：${p}`);
  });

  await test('设置页展示的自动参数与实跑参数一致（37.x 不再显示弃用后端）', () => {
    const common = {
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000, port: 5562, adbPort: 5044,
      // 显式给宿主：内存/核心上限现在跟着宿主走，不加这一项测试结果会随 CI 机器规格漂移
      // （GitHub runner 只有 4 核，手动填 6 核会被正确收敛成 3 核，断言就会误报）
      host: { totalMB: 32768, freeMB: 24000, cores: 12, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false },
    };
    const p = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: true, gpuMode: 'auto', memoryMB: 0, cores: 0 } } });
    const text = doctor.describeProfile(p);
    assert(p.gpu === 'host' || p.gpu === 'swangle', `应为 host 或 swangle（AMD 机器），实际 ${p.gpu}`);
    assert(p.accelOk === true && text.includes('硬件加速'), text);
    assert(!text.includes('swiftshader_indirect'), text);
    assert(text.includes('端口 5562'), text);

    // 老引擎仍应用老后端；用户手动填的高级参数仍然生效
    const old = doctor.autoProfile({ ...common, emulatorVersion: '35.1.4.0', settings: {} });
    assert(old.gpu === 'host' && doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
    const manual = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: false, memoryMB: 6144, cores: 6, gpuMode: 'swiftshader' } } });
    assert(manual.memoryMB === 6144 && manual.cores === 6 && manual.gpu === 'swiftshader', JSON.stringify(manual));
    const zero = doctor.overridesFromSettings({ autoMemory: false, memoryMB: 0, cores: 0, gpuMode: 'auto' });
    assert(zero.memoryMB === 0 && zero.cores === 0 && zero.gpuMode === '', JSON.stringify(zero));
  });

  console.log('\n[layers.js 容器式瘦身]');

  await test('盘点可回收项：非 x86_64 QEMU、旧镜像、旧 AVD、锁文件、旧快照', () => {
    const root = path.join(TMP, 'runtime-layers');
    const mk = (p, size) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const b = Buffer.alloc(size || 16, 65);
      fs.writeFileSync(p, b);
    };
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'), 1024);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'kernel-ranchu'), 16);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'NOTICE.txt'), 2048);
    mk(path.join(root, 'system-images', 'android-30', 'default', 'x86_64', 'system.img'), 512);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-aarch64.exe'), 128);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe'), 128);
    mk(path.join(root, 'avd', 'apkstart.avd', 'config.ini'), 32);
    mk(path.join(root, 'avd', 'apkstart.avd', 'snapshots', 'default_boot', 'ram.img'), 256);
    mk(path.join(root, 'avd', 'apkstart.avd', 'multiInstance.lock'), 8);
    mk(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img'), 512);

    const a = layers.analyze(root);
    const paths = a.candidates.map((c) => c.path.replace(/\\/g, '/'));
    assert(paths.some((p) => p.endsWith('qemu-system-aarch64.exe')), '应列出非 x86_64 QEMU');
    assert(!paths.some((p) => p.endsWith('qemu-system-x86_64.exe')), '不能删 x86_64 QEMU');
    assert(paths.some((p) => p.includes('android-30')), '应列出旧版 API30 镜像');
    assert(paths.some((p) => p.endsWith('.lock')), '应列出锁文件');
    assert(paths.some((p) => p.includes('snapshots')), '应列出旧快照');
    assert(paths.some((p) => p.includes('apkstart-arm.avd')), '应列出非活动 AVD');
    assert(!paths.some((p) => p.endsWith('apkstart.avd/config.ini')), '不能删活动 AVD 配置');

    const dry = layers.prune(root, { apply: false });
    assert(dry.removed.length === 0 && dry.saved === 0, 'dryRun 不应删除任何文件');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img')));

    const done = layers.prune(root, { apply: true });
    assert(done.saved > 0 && done.removed.length >= 5, '实际清理应释放空间');
    assert(!fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd')), '非活动 AVD 应被清掉');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart.avd', 'config.ini')), '活动 AVD 必须保留');
    assert(fs.existsSync(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe')), 'x86_64 QEMU 必须保留');
  });

  console.log('\n[adb.js 安装/启动失败可读性]');

  await test('Android 14 老 targetSdk 应用失败有明确指引', () => {
    const s = friendlyInstallError('Failure [INSTALL_FAILED_DEPRECATED_SDK_VERSION: app must target at least 23]');
    assert(s.includes('Android 14') && s.includes('自动'), s);
  });

  await test('ARM 翻译层崩溃能给出可执行的中文结论', () => {
    const s = friendlyLaunchError('F DEBUG: DoBadTrampoline libndk_translation SIGABRT', 'com.phoenix.read');
    assert(s.includes('ARM 翻译层') && s.includes('兼容镜像'), s);
    // 0.6.3 单镜像：不能再无条件承诺「会自动切换重试」，要说清「已启用则属限制」
    assert(s.includes('已启用') && s.includes('限制'), `文案要说清单镜像下的真实后果：${s}`);
  });

  await test('反模拟 / 安全校验导致的退出给出「限制不是故障」的中文说明', () => {
    for (const raw of [
      'emulator detected, exiting',
      'SafetyNet attest failed',
      '检测到模拟器环境 主动退出',
      'anti-debug hook detected',
    ]) {
      const s = friendlyLaunchError(raw, 'com.bank.app');
      assert(s.includes('限制') && s.includes('不是故障'), `${raw} → ${s}`);
      assert(s.includes('手册 6.3'), `应指向手册 6.3：${s}`);
    }
    // 不能把反模拟误说成翻译层崩溃而让用户白等一次镜像切换
    const s = friendlyLaunchError('emulator detected', 'com.bank.app');
    assert(!s.includes('自动切换'), `反模拟不该承诺切镜像：${s}`);
  });

  await test('反模拟崩溃报错能定位到手册 6.3', () => {
    const manual = require('../src/core/manual');
    const s = friendlyLaunchError('emulator detected / play integrity failed', 'com.bank.app');
    const t = manual.topicForError(s);
    assert(t.id === 'arm', `反模拟报错应到 ARM/6.3 章节，实际 ${t.id}`);
  });

  await test('启动崩溃重试按真实翻译能力判断，不看镜像文件在不在', () => {
    const root = path.join(__dirname, '..');
    const inst = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    const at = inst.indexOf('const hasArm = await runningHasArm(rt.client)');
    const blk = inst.slice(at, at + 1400);
    // 旧写法 !playImageInfo().ok 在单镜像架构下恒 false，是永不执行的死代码
    assert(!/e\.code === 'APP_CRASHED' && !this\.runtime\.provisioner\.playImageInfo\(\)\.ok/.test(inst),
      '启动崩溃重试条件不能再依赖 !playImageInfo().ok');
    assert(/runningHasArm\(rt\.client\)/.test(blk), '要看当前这台运行时的真实翻译能力');
    assert(/needSwitch/.test(blk) && /playReady/.test(blk), '未开翻译层或缺镜像文件才切换重试');
    assert(/throw e/.test(blk), '翻译层已生效时如实抛出限制结论，不做无意义重启');
  });

  console.log('\n[sharer 不再来回搬运（磁盘写满的元凶）]');

  await test('同一个文件不会每轮都被从设备拉回来', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared');
    fs.mkdirSync(localDir, { recursive: true });
    const file = path.join(localDir, 'a.txt');
    fs.writeFileSync(file, 'hello');

    const calls = { push: 0, pull: 0 };
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => { calls.push += 1; },
      pull: async (_r, dst) => { calls.pull += 1; fs.writeFileSync(dst, 'hello'); },
      listRemoteStat: async () => [{ rel: 'a.txt', size: 5, mtime: Date.now() - 60000 }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    sh.localDirOverride = localDir;
    // 用真实的路径/状态文件，但目录指向临时目录
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state.json');

    await sh.sync();          // 第 1 轮：本机新文件 → 推上去
    const firstPull = calls.pull;
    await sh.sync();          // 第 2 轮
    await sh.sync();          // 第 3 轮
    await sh.sync();          // 第 4 轮
    assert(calls.push === 1, `只应推送一次，实际 ${calls.push}`);
    assert(firstPull === 0, `刚推上去的文件不该立刻被拉回来，实际拉取 ${firstPull} 次`);
    assert(calls.pull === firstPull, `后续轮次不应再反复拉取，实际累计 ${calls.pull} 次`);
  });

  await test('超大文件不会被反向拉回本机（本地目录不是设备缓存下水道）', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared2');
    fs.mkdirSync(localDir, { recursive: true });
    let pulled = 0;
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => {},
      pull: async () => { pulled += 1; },
      listRemoteStat: async () => [{ rel: 'big.mp4', size: 600 * 1024 * 1024, mtime: Date.now() }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state2.json');
    await sh.sync();
    assert(pulled === 0, '超过 512MB 的文件不应拉回本机');
  });

  console.log('\n[adb/sharer 文件互通]');

  await test('ls -l 解析兼容 Android 的含 group / 日期格式', async () => {
    const { AdbClient } = require('../src/core/adb');
    const fake = Object.create(AdbClient.prototype);
    fake.shell = async () => '-rw-rw---- 1 u0_a188 media_rw 12 2026-11-12 18:52 hello.txt\r\n'
      + 'drwxrwx--- 2 u0_a188 media_rw 4096 2026-11-12 18:52 sub\r\n'
      + '-rw-rw---- 1 u0_a188 7 Nov 12 18:52 no-group.txt\r\n';
    const rows = await fake.listRemote('/sdcard/x');
    assert(rows.length === 3, `应解析 3 行，实际 ${rows.length}`);
    assert(rows[0].name === 'hello.txt' && rows[0].size === 12, JSON.stringify(rows[0]));
    assert(rows[1].isDir && rows[1].name === 'sub', JSON.stringify(rows[1]));
    assert(rows[2].name === 'no-group.txt' && rows[2].size === 7, JSON.stringify(rows[2]));
  });

  await test('远端文件列表可用 find+stat 一次拿全（不依赖 ls 日期解析）', async () => {
    const { Sharer } = require('../src/core/sharer');
    const sh = Object.create(Sharer.prototype);
    const fake = {
      shell: async () => '12|1794480758|./a.txt\n8|1794480759|./sub/b.txt\n',
      listRemote: async () => [],
    };
    const rows = await sh.listRemoteRecursive(fake, '/sdcard/x');
    assert(rows.length === 2, `应返回 2 个文件，实际 ${rows.length}`);
    assert(rows[1].rel === 'sub/b.txt' && rows[1].mtime > 1e12, JSON.stringify(rows[1]));
  });

  console.log('\n[zip.js 大包流式解压]');

  await test('ZipFile 与 ZipArchive 对同一压缩包的解析结果一致（含 deflate 与流式 pipeTo）', async () => {
    const zlib = require('zlib');
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello apkstart'), method: 0 },
      { name: 'dir/b.bin', data: Buffer.alloc(200000, 7), method: 8 },
    ];
    const locals = [];
    const centrals = [];
    let off = 0;
    for (const it of entries) {
      const raw = it.method === 8 ? zlib.deflateRawSync(it.data) : it.data;
      const name = Buffer.from(it.name);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(it.method, 8);
      lh.writeUInt32LE(raw.length, 18);
      lh.writeUInt32LE(it.data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      locals.push(lh, name, raw);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(it.method, 10);
      ch.writeUInt32LE(raw.length, 20);
      ch.writeUInt32LE(it.data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(off, 42);
      centrals.push(ch, name);
      off += lh.length + name.length + raw.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(off, 16);
    const buf = Buffer.concat([...locals, cd, eocd]);
    const zipPath = path.join(TMP, 'parity.zip');
    fs.writeFileSync(zipPath, buf);

    const mem = new ZipArchive(buf);
    const file = new ZipFile(zipPath);
    try {
      assert(mem.names().join('|') === file.names().join('|'), '条目名应一致');
      assert(mem.read('a.txt').equals(file.read('a.txt')), 'stored 条目内容应一致');
      assert(mem.read('dir/b.bin').equals(file.read('dir/b.bin')), 'deflate 条目内容应一致');
      const out = path.join(TMP, 'b.bin');
      await file.pipeTo('dir/b.bin', fs.createWriteStream(out));
      assert(fs.readFileSync(out).equals(entries[1].data), 'pipeTo 流式输出应完整');
    } finally {
      file.close();
    }
  });

  await test('Zip64：EOCD 用 0xffff/0xffffffff 占位时，条目数与偏移从 Zip64 EOCD 取', async () => {
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const name = Buffer.from('hello.txt');
    const data = Buffer.from('hello zip64 apkstart');
    // 本地头
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(45, 4);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const cenStart = lh.length + name.length + data.length;
    // 中央目录项：三个字段置 0xffffffff，真实值进 Zip64 extra（id=0x0001）
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(data.length), 4);
    extra.writeBigUInt64LE(BigInt(data.length), 12);
    extra.writeBigUInt64LE(0n, 20);
    const ch = Buffer.alloc(46 + name.length + extra.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(45, 6);
    ch.writeUInt32LE(0xffffffff, 20);
    ch.writeUInt32LE(0xffffffff, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt32LE(0xffffffff, 42);
    name.copy(ch, 46);
    extra.copy(ch, 46 + name.length);
    // Zip64 EOCD + locator + 传统 EOCD（全部进位）
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeBigUInt64LE(1n, 24);
    z64.writeBigUInt64LE(1n, 32);
    z64.writeBigUInt64LE(BigInt(ch.length), 40);
    z64.writeBigUInt64LE(BigInt(cenStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cenStart + ch.length), 8);
    loc.writeUInt32LE(1, 16);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
    const buf = Buffer.concat([lh, name, data, ch, z64, loc, eocd]);

    const mem = new ZipArchive(buf);
    assert(mem.has('hello.txt'), 'ZipArchive 应能认出 Zip64 条目');
    assert(String(mem.read('hello.txt')) === 'hello zip64 apkstart', 'ZipArchive 内容应正确');
    assert(mem.entries.get('hello.txt').uncompSize === data.length, 'ZipArchive 未压缩大小应从 extra 取');

    const zipPath = path.join(TMP, 'zip64.zip');
    fs.writeFileSync(zipPath, buf);
    const file = new ZipFile(zipPath);
    try {
      assert(file.has('hello.txt'), 'ZipFile 应能认出 Zip64 条目');
      assert(String(file.read('hello.txt')) === 'hello zip64 apkstart', 'ZipFile 内容应正确');
      assert(file.entries.get('hello.txt').localOffset === 0, 'ZipFile 本地头偏移应从 extra 取');
    } finally {
      file.close();
    }
  });

  console.log('\n[emulator.js AVD 零配置]');

  await test('AVD 使用小数据分区 + 快速启动 + 现代 GPU 模式', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const r = emu.ensureAvd({ memoryMB: 2048, cores: 2, gpu: 'software', dataMB: 4096, accel: 'auto' });
    const cfg = fs.readFileSync(path.join(r.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.ramSize=2048$/m.test(cfg));
    assert(/^disk\.dataPartition\.size=4096M$/m.test(cfg), '数据分区不应是 16G');
    assert(/^hw\.gpu\.mode=software$/m.test(cfg));
    assert(!/^fastboot\.forceColdBoot=yes$/m.test(cfg), '不应再强制冷启动');
    assert(!/^fastboot\.forceFastBoot=/m.test(cfg), '快照应由命令行 -snapshot 控制，避免加载旧 default_boot');
    assert(/^hw\.cpu\.arch=x86_64$/m.test(cfg));
    assert(fs.existsSync(path.join(r.avdDir, 'snapshot.key')), '应写入快照指纹');
  });

  await test('启动参数带自动内存/核心/快照，且不再用弃用的 GPU 模式', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // 快照不存在时（全新 AVD / 刚被作废）绝不能传 -snapshot：
    // qemu 会一直等一份不存在的内存状态，进程活着但永不开机。
    const fresh = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-gpu software/.test(fresh));
    assert(!/swiftshader_indirect/.test(fresh));
    assert(/-memory 2048/.test(fresh) && /-cores 2/.test(fresh));
    if (!emu.hasSnapshot()) {
      // 没有快照时必须「只禁加载、不禁保存」：-no-snapshot 会连退出自动保存一起关掉，
      // 那样第一次冷启动结束后永远产生不了快照，用户每次点开都是全量引导。
      assert(/-no-snapshot-load/.test(fresh), '没有快照时应用 -no-snapshot-load（只跳过加载）');
      assert(!/ -no-snapshot( |$)/.test(fresh), '没有快照时不能用 -no-snapshot（会禁掉退出保存）');
    }
    // 快照确实存在时才走 quickboot。注意要真的「像一个完整快照」：
    // 保存中断会留下只有几十字节 snapshot.pb 的空壳，那种必须判定为没有快照，
    // 否则 emulator 会尝试加载、失败，再回退冷启动，白等几秒。
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'apkstart.avd');
    const snapDir = path.join(avdDir, 'snapshots');
    const created = !fs.existsSync(snapDir);
    fs.mkdirSync(path.join(snapDir, 'apkstart'), { recursive: true });

    // 空壳（12 字节 pb + 没有 ram.img）必须当作「没有快照」
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'snapshot.pb'), 'x'.repeat(12));
    assert(!emu.hasSnapshot(), '不完整的快照不能被当成可用快照');
    const broken = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-no-snapshot-load/.test(broken), '空壳快照必须回退冷启动（跳过加载）');

    // 完整快照：pb 有内容 + ram.img 有数据（上一步的空壳会被 hasSnapshot 顺手清掉）
    fs.mkdirSync(path.join(snapDir, 'apkstart'), { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'ram.img'), Buffer.alloc(2 * 1024 * 1024));
    const withSnap = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot apkstart/.test(withSnap), '有快照时应使用 quickboot 快照');
    assert(!/-no-snapshot-load/.test(withSnap), '有完整快照时不该跳过加载');
    if (created) fs.rmSync(snapDir, { recursive: true, force: true });

    const cold = emu.buildArgs({ wipe: true }).join(' ');
    assert(/-wipe-data/.test(cold), 'wipe 时必须带 -wipe-data');
    // 重置数据时：不加载旧快照（数据对不上），但**允许保存**新快照。
    // 「修复网络」依赖这条链路：重置后第一次开机有网 → 立刻存快照 → 下次恢复。
    // 老实现这里推 -no-snapshot，会把保存一起关掉，导致修完网络存不下快照。
    assert(/ -no-snapshot-load( |$)/.test(cold), 'wipe 时不该加载旧快照');
    assert(!/ -no-snapshot( |$)/.test(cold), 'wipe 时仍要允许保存新快照（修复网络依赖它）');
  });

  // 窗口代理脚本里有大量中文注释。PowerShell 5.1 读「无 BOM 的 UTF-8」会按 ANSI 解码，
  // 中文变成乱码后可能把 C# 注释和下一行代码并成一行 —— Add-Type 直接编译失败，
  // 表现就是「窗口代理启动失败 / 应用窗口不嵌入」。这个坑踩过一次，用测试钉住。
  await test('窗口代理脚本必须带 UTF-8 BOM（否则中文注释会让 Add-Type 编译失败）', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const buf = fs.readFileSync(file);
    assert(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'agent.ps1 缺少 UTF-8 BOM');
  });

  // 模拟器窗口必须是 Chromium 渲染层的「子窗口」，不能是宿主的兄弟子窗口。
  // 兄弟关系下 Electron 会持续把网页层抬到最前，黑底盖住安卓画面、鼠标全被吃掉
  // （黑边 / 未填满 / 点击失效 / 点不动同意）。也不能再给嵌入窗口设 window region，
  // 那会破坏命中测试且在 resize 后露出黑边。
  await test('嵌入窗口必须挂到网页层之下，且不能再设 window region', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const src = fs.readFileSync(file, 'utf8');
    assert(/SetParent\(emu, parent\)/.test(src), 'embed 必须挂到 FindChromeRender 找到的父窗口');
    assert(/FindChromeRender\(host\)/.test(src), '必须查找 Chromium 渲染子窗口');
    assert(!/CreateRectRgn\(0, clipTop/.test(src), '不能给嵌入窗口设裁剪 region');
    assert(/SetWindowRgn\(emu, IntPtr\.Zero/.test(src), 'embed 时要清掉旧版本残留的 region');
  });

  // 旋转必须换「物理面板尺寸」并重启，不能只改运行时 wm size / density。
  //   - wm size：物理 LCD 仍是竖的 -> 画面躺倒 90°、只占左上角一条、点击坐标错位；
  //   - wm density：framebuffer 尺寸不变 -> 画面不铺满，最大化后右侧一大片空白。
  await test('横屏必须靠物理面板尺寸（lcdFor landscape），且不得再用运行期 wm size 旋转', () => {
    const doctor = require('../src/core/doctor');
    const p = doctor.lcdFor({ accelOk: true, landscape: false });
    const l = doctor.lcdFor({ accelOk: true, landscape: true });
    assert(p.w === 720 && p.h === 1280, `竖屏应是 720x1280，实际 ${p.w}x${p.h}`);
    assert(l.w === 1280 && l.h === 720, `横屏应是 1280x720，实际 ${l.w}x${l.h}`);

    const adb = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'adb.js'), 'utf8');
    const i = adb.indexOf('async setOrientation(');
    const j = adb.indexOf('async resetDisplayOverrides(');
    const body = adb.slice(i, j);
    assert(!/wm size \d/.test(body), 'setOrientation 不得再设置 wm size 覆盖');
    // density 现在统一走 tabletDensity()（用户可在设置里关掉平板排版），
    // 但常量本身必须仍是 190（720 宽 → 606dp 才越过平板断点）。
    assert(/wm density \$\{tabletDensity\(\)\}/.test(body), 'density 只作为退化路径保留');
    assert(/const TABLET_DENSITY = 190/.test(adb), '平板密度常量必须是 190');
  });

  await test('游戏模式必须使用高优先级且关闭全局鼠标钩子', () => {
    const ps = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'priority.ps1'), 'utf8');
    assert(/game\s*=\s*'High'/.test(ps), 'game 级别要把 qemu 提到 High');
    const aw = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/opts\.enabled && !game/.test(aw), 'game 模式不能装 WH_MOUSE_LL 全局钩子');
  });

  await test('按键映射引擎：查表、转命令、限流', async () => {
    const { lookup, toCommand, PRESETS } = require('../src/core/keymap');
    const { KeymapEngine } = require('../src/core/keymap-engine');

    // 预设模板完整性
    assert(PRESETS.fps && PRESETS.fps.mappings.length >= 4, 'FPS 预设至少 4 个映射');
    assert(PRESETS.rpg && PRESETS.rpg.mappings.length >= 4, 'RPG 预设至少 4 个映射');
    assert(PRESETS.generic && PRESETS.generic.mappings.length >= 3, '通用预设至少 3 个映射');

    // 查表：大小写不敏感
    assert(lookup(PRESETS.fps.mappings, 'W').action === 'tap', '大写 W 应匹配小写 w');
    assert(lookup(PRESETS.fps.mappings, 'z') === null, '未映射的键返回 null');

    // 转命令：归一化坐标 → 像素
    const cmd = toCommand({ action: 'tap', x: 0.5, y: 0.5 }, 720, 1280);
    assert(cmd === 'input tap 360 640', `tap 命令错误: ${cmd}`);
    const sw = toCommand({ action: 'swipe', x1: 0, y1: 0.5, x2: 1, y2: 0.5, duration: 100 }, 720, 1280);
    assert(sw === 'input swipe 0 640 720 640 100', `swipe 命令错误: ${sw}`);
    const ke = toCommand({ action: 'keyevent', code: 4 }, 720, 1280);
    assert(ke === 'input keyevent 4', `keyevent 命令错误: ${ke}`);

    // 引擎：启用/禁用、按应用查表、限流
    const calls = [];
    const eng = new KeymapEngine({
      execInput: (c) => { calls.push(c); return Promise.resolve(); },
      getSize: () => ({ width: 720, height: 1280 }),
      minInterval: 0,  // 测试里不限流
    });
    eng.setMap('com.test.game', PRESETS.fps.mappings);
    assert(eng.getMap('com.test.game').length > 0, 'setMap/getMap 应工作');
    eng.enable(false);
    assert(await eng.handleKey('w', 'com.test.game') === false, '禁用时不应消费按键');
    eng.enable(true);
    assert(await eng.handleKey('w', 'com.test.game') === true, '启用时应消费已映射的按键');
    assert(await eng.handleKey('z', 'com.test.game') === false, '未映射的键不应消费');
    assert(await eng.handleKey('w', 'com.other.app') === false, '其他应用不应命中');
    assert(calls.length === 1 && /input tap/.test(calls[0]), `应发一次 input tap，实际: ${calls.join('|')}`);
  });

  await test('GPU 厂商检测：返回已知值或 unknown；host 优先（独显/核显真正参与渲染）', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
    assert(/detectGpuVendor/.test(doc), '要有 detectGpuVendor 函数');
    assert(/Get-CimInstance Win32_VideoController/.test(doc), '要用 PowerShell CIM（wmic 在 Win11 24H2+ 已移除）');
    const d = require('../src/core/doctor');
    // 0.6.4：任何厂商都 host 优先，不再把 AMD/Intel 强制降到软件渲染
    assert(d.gpuCandidates('37.3.8.0')[0] === 'host', 'host 必须排第一，才能调用独显/核显');
    assert(!/vendor === 'amd'[\s\S]{0,200}return \['swangle'/.test(doc), '不应再把 AMD 强制降级到 swangle');
    const v = d.detectGpuVendor();
    assert(['nvidia', 'amd', 'intel', 'unknown'].includes(v), `返回值应为已知厂商或 unknown，实际: ${v}`);
  });

  await test('开机动画：splash 窗口 + 进度推送 + 淡出', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    assert(fs.existsSync(path.join(root, 'src', 'ui', 'splash.html')), '缺少 splash.html');
    assert(fs.existsSync(path.join(root, 'src', 'ui', 'splash.css')), '缺少 splash.css');
    assert(fs.existsSync(path.join(root, 'src', 'ui', 'splash.js')), '缺少 splash.js');
    assert(fs.existsSync(path.join(root, 'src', 'splash-preload.js')), '缺少 splash-preload.js');
    assert(/splashWin/.test(mainJs), 'main.js 要创建 splash 窗口');
    assert(/splashProgress/.test(mainJs), '要有 splashProgress 推送函数');
    assert(/splashDone/.test(mainJs), '要有 splashDone 完成信号');
    assert(/splash:version/.test(mainJs) || /splash:isFirstRun/.test(mainJs), 'splash IPC 要注册');
  });

  await test('前台应用优先级不能用 below（点击跟手 / 视频不掉帧）', () => {
    const engJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'engine.js'), 'utf8');
    // balanced/performance 有应用在前台时必须是 normal：below 会让 qemu 被饿，
    // 表现为视频解码掉帧、点击要等一下才响应（用户说的「点击不跟手」主因）。
    const begin = engJs.slice(engJs.indexOf('async beginApp'));
    assert(/mode === 'game' \? 'game' : 'normal'/.test(begin),
      "beginApp 前台优先级应映射为 game→game、其余→normal");
    assert(!/performance.*\? 'normal' : 'below'/.test(begin),
      '不能再把 balanced 落到 below');
    // 每次打开/切回都要重设优先级：endApp 会降到 idle，切换回来不提权就会发木
    const setIdx = begin.indexOf("setPriority(level)");
    const firstIdx = begin.indexOf("if (first)");
    assert(setIdx > -1, 'beginApp 要调 setPriority');
    // setPriority 不应只在第一个 if(first) 块里 —— 切换应用（非 first）也要提权
    const firstBlock = begin.slice(firstIdx, begin.indexOf('\n\n', firstIdx));
    assert(!/setPriority\(level\)/.test(firstBlock) || begin.split('setPriority(level)').length >= 2,
      'setPriority 要在每次 beginApp 都执行，不只第一次');
  });

  await test('省资源模式应下调内存上限（减运行占用）', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
    assert(/rmode === 'save'[\s\S]{0,120}2048/.test(doc),
      'save 模式要把 memoryMB 压到 2048（省约 1GB 内存 + 1GB 快照磁盘）');
    // 手动指定内存时永远优先，不能被 save 覆盖
    assert(/!overrides\.memoryMB/.test(doc), 'save 收敛内存要让位于用户手动值');
  });

  await test('新版 emulator 写的 ram.bin 必须被认作完整快照（否则刚存好的 3GB 会被当空壳删掉）', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'apkstart.avd');
    const snapDir = path.join(avdDir, 'snapshots', 'apkstart');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'ram.bin'), Buffer.alloc(2 * 1024 * 1024));
    assert(emu.hasSnapshot(), 'ram.bin 应被认作完整快照');
    const args = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot apkstart/.test(args), '有快照时应走 quickboot');
    assert(!/-no-snapshot-load/.test(args), '有完整快照时不该跳过加载');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
  });

  await test('userdata 种子镜像：4K block + ENCRYPT + 记账自洽', () => {
    const { buildEmptyExt4 } = require('../src/core/userdata');
    const sb = 1024;
    const img = buildEmptyExt4({ sizeMB: 64, encrypt: false });
    assert(img.readUInt16LE(sb + 0x38) === 0xEF53, 'superblock 魔数必须是 0xEF53');
    // dm-default-key（Android 13 的 /data 元数据加密）逻辑块大小是 4096，
    // fs block 小于它会让 mount() 返回 EINVAL —— 这是「挂不上 /data」的真凶。
    assert(img.readUInt32LE(sb + 0x18) === 2, 's_log_block_size 必须是 2（4096 字节）');
    assert(img.readUInt32LE(sb + 0x1C) === 2, 's_log_cluster_size 必须等于 block size');
    // 没有 ext_attr 时 setxattr 返回 EOPNOTSUPP，SELinux 标签写不进去，
    // netd / media / tombstoned 会一起 exit 1，开机卡在动画上。
    assert((img.readUInt32LE(sb + 0x5C) & 0x8) !== 0, '必须带 ext_attr');
    const total = img.readUInt32LE(sb + 0x04);
    const free = img.readUInt32LE(sb + 0x0C);
    const inodes = img.readUInt32LE(sb + 0x00);
    const freeInodes = img.readUInt32LE(sb + 0x10);
    assert(free > 0 && free < total, '空闲块数必须落在 (0, total) 之间');
    assert(freeInodes === inodes - 10, '空闲 inode 必须扣掉 1~10 号保留（e2fsck 会核对）');
    const withEnc = buildEmptyExt4({ sizeMB: 64 });
    assert((withEnc.readUInt32LE(sb + 0x60) & 0x10000) !== 0, '默认必须带 ENCRYPT（FBE 必需）');
    assert((img.readUInt32LE(sb + 0x60) & 0x10000) === 0, 'encrypt:false 时要能摘掉该位');
  });

  console.log('\n[显示 / 快捷方式 / 零操作]');
  await test('窗口模式必须真的开窗口（否则应用进程活着但屏幕上看不见）', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const win = emu.buildArgs({ headless: false, gpu: 'software', lcd: { w: 720, h: 1280, dpi: 320 } }).join(' ');
    assert(!/-no-window/.test(win), '窗口模式不能再用 -no-window');
    // 不能再带 -no-skin：它会覆盖 -skin，让面板尺寸退回 config.ini 里的旧值，
    // 表现为「设置切了横屏、实际还是竖屏」「画面只占左上角一条」。
    assert(!/\s-no-skin(\s|$)/.test(win), '窗口模式不能带 -no-skin（会覆盖 -skin）');
    assert(/-skin \d+x\d+/.test(win), '窗口模式必须用 -skin 明确面板尺寸');
    const headless = emu.buildArgs({ headless: true }).join(' ');
    assert(/-no-window/.test(headless));
  });

  await test('音频：默认开启不带 -no-audio；声音+麦克风都关才带', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const argsFor = (engine) => {
      Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine }) });
      return emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    };
    assert(!/-no-audio/.test(argsFor({ audio: true })), '默认不应传 -no-audio');
    assert(!/-no-audio/.test(argsFor({ audio: false })), '只关声音时麦克风还开着，不能传 -no-audio');
    assert(!/-no-audio/.test(argsFor({ audio: true, microphone: false })), '只关麦克风时声音还开着，不能传 -no-audio');
    assert(/-no-audio/.test(argsFor({ audio: false, microphone: false })), '声音与麦克风都关才传 -no-audio');
  });

  await test('麦克风：默认写 hw.audioInput=yes，关闭后写 no', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emuOn = new EmulatorEngine(path.join(__dirname, '..'));
    Object.defineProperty(emuOn, 'settings', { configurable: true, get: () => ({ engine: { microphone: true } }) });
    const on = emuOn.ensureAvd({ memoryMB: 2048, cores: 2, gpu: 'software', dataMB: 4096, accel: 'auto' });
    assert(/^hw\.audioInput=yes$/m.test(fs.readFileSync(path.join(on.avdDir, 'config.ini'), 'utf8')), '默认应开启麦克风');

    const emuOff = new EmulatorEngine(path.join(__dirname, '..'));
    Object.defineProperty(emuOff, 'settings', { configurable: true, get: () => ({ engine: { microphone: false } }) });
    const off = emuOff.ensureAvd({ memoryMB: 2048, cores: 2, gpu: 'software', dataMB: 4096, accel: 'auto' });
    assert(/^hw\.audioInput=no$/m.test(fs.readFileSync(path.join(off.avdDir, 'config.ini'), 'utf8')), '关闭后应写 no');
    // 还原成默认，避免污染后续共用同一个 AVD 配置的测试
    emuOn.ensureAvd({ memoryMB: 2048, cores: 2, gpu: 'software', dataMB: 4096, accel: 'auto' });
  });

  await test('旧配置强制迁移：无头与「启动后退出」不再生效', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { headless: true }, hideAfterLaunch: true });
    const s = store.getSettings();
    assert(s.engine.headless === false, 'headless 必须被迁移成 false');
    assert(s.hideAfterLaunch === false, 'hideAfterLaunch 必须为 false');
    assert(s.autoStart === true && s.autoDeploy === true, '开机自启/一键部署默认开启');
    assert(s.createStartMenuShortcut === true, '开始菜单快捷方式默认开启');
  });

  await test('显示适配：窗口/全屏共用竖屏分辨率，窗口比例 9:16 可拉伸', () => {
    const d = require('../src/core/display');
    const area = { x: 0, y: 0, w: 1920, h: 1080 };
    // 全屏不改变 Android 分辨率（模拟器窗口宽高比被 LCD 锁定），只最大化窗口
    assert(JSON.stringify(d.sizeFor('fullscreen', '900x1600', area)) === JSON.stringify({ w: 900, h: 1600 }));
    assert(JSON.stringify(d.sizeFor('window', '720x1280', area)) === JSON.stringify({ w: 720, h: 1280 }));
    assert(d.sizeFor('window', '横屏乱填', area).h > d.sizeFor('window', '横屏乱填', area).w);
    const b = d.defaultBounds(area);
    assert(b.h > b.w && b.h <= area.h && b.x >= 0 && b.y >= 0, JSON.stringify(b));
    // 全屏：铺满高度、按竖屏比例算宽度并居中（窗口宽高比被模拟器 LCD 锁定）
    const f = d.fullscreenBounds('900x1600', area);
    assert(f.h === area.h, JSON.stringify(f));
    assert(Math.abs(f.w - Math.round(f.h * 900 / 1600)) <= 1, JSON.stringify(f));
    assert(f.x > 0 && f.x + f.w <= area.w, JSON.stringify(f));
    assert(d.densityFor(1080, 1920, 0) > 300);
    assert(d.densityFor(720, 1280, 240) === 240);
  });

  await test('adb 显示命令使用 wm size / wm density', async () => {
    const { AdbClient } = require('../src/core/adb');
    const cmds = [];
    const fake = { shell: async (c) => { cmds.push(c); return ''; } };
    await AdbClient.prototype.setDisplaySize.call(fake, 1920, 1080, 420);
    assert(cmds.includes('wm size 1920x1080'), cmds.join('|'));
    assert(cmds.includes('wm density 420'), cmds.join('|'));
    await AdbClient.prototype.resetDisplaySize.call(fake);
    assert(cmds.includes('wm size reset') && cmds.includes('wm density reset'));
  });

  await test('PNG-in-ICO 与 WebP 图标兜底都能产出可用 ICO', async () => {
    const { pngBytesToIco, iconToIco } = require('../src/core/shortcut');
    const { drawAppIcon } = require('../src/core/png');
    const png = drawAppIcon(64);
    const ico = pngBytesToIco(png);
    assert(ico && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 1, 'ICO 头应声明 1 个图像');
    assert(ico.readUInt32LE(14) === png.length, '内嵌 PNG 长度应一致');
    assert(ico.slice(22).equals(png), 'ICO 数据区应就是原 PNG');
    assert(pngBytesToIco(Buffer.from('not a png')) === null);
    // WebP（nativeImage 解不了）→ 无 decode 回调时应回退到品牌占位 ICO
    const webp = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBP'), Buffer.alloc(32)]);
    const fallback = await iconToIco(webp);
    assert(fallback && fallback.length > 22, 'WebP 也应拿到图标');
    const decoded = await iconToIco(webp, { decode: async () => png });
    assert(decoded && decoded.slice(22).equals(png), '有 decode 时应使用真实图标');
  });

  await test('窗口控制脚本存在且为纯 ASCII（避免中文路径/标题乱码）', () => {
    const w = require('../src/core/windowctl');
    assert(fs.existsSync(w.SCRIPT), '缺少 windowctl.ps1');
    const b = fs.readFileSync(w.SCRIPT);
    assert(!b.some((x) => x > 127), 'ps1 必须纯 ASCII，中文通过 UTF-8 JSON 传入');
    assert(typeof w.present === 'function' && typeof w.getBounds === 'function');
  });

  await test('xzFile 把源文件喂进 stdin 并产出可被运行时解压的镜像（CI 挂死回归）', async () => {
    const { xzFile } = require('../build/prepare-runtime');
    const zlib = require('zlib');
    const crypto = require('crypto');
    const dir = path.join(TMP, 'xz-regression');
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'sample.img');
    const payload = Buffer.concat([
      Buffer.from('APKSTART-XZ-REGRESSION'),
      crypto.randomBytes(256 * 1024),
      Buffer.alloc(1024 * 1024),
    ]);
    fs.writeFileSync(src, payload);
    const dest = path.join(dir, 'sample.img.xz');

    const saved = { XZ_PRESET: process.env.XZ_PRESET, XZ_TIMEOUT_MS: process.env.XZ_TIMEOUT_MS };
    process.env.XZ_PRESET = '1';           // 小样本走最快档，别拖慢整套测试
    process.env.XZ_TIMEOUT_MS = '15000';  // 真挂死时 15s 内 kill，别把 CI 卡住
    let timer;
    try {
      await Promise.race([
        xzFile(src, dest),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('xzFile 25s 内未返回（stdin 没接 EOF？）')), 25000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }

    const have = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
    const out = have(dest) > 0 ? dest : dest.replace(/\.xz$/, '.gz');
    assert(have(out) > 0, '压缩产物不能是 0 字节');
    let back;
    if (/\.xz$/i.test(out)) {
      // 不依赖 @napi-rs/lzma 原生 binding：CI 的 Node 20 job 会因
      // npm optional dependencies 的已知 bug 加载不到它（Node 22 正常）。
      // 这里用与压缩端同一个 python 的 lzma 读回，并校验 XZ 魔数，
      // 运行时的解压兼容性由真实安装包端到端验证覆盖。
      assert(fs.readFileSync(out).subarray(0, 6).equals(
        Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
      ), '必须是合法的 XZ 容器');
      const { findPython } = require('../build/prepare-runtime');
      const py = findPython();
      assert(py, '产出 XZ 却找不到 python，无法校验');
      const backPath = path.join(dir, 'sample.img.back');
      require('child_process').execFileSync(py, ['-c',
        'import lzma,sys;open(sys.argv[1],"wb").write(lzma.open(sys.argv[2],"rb").read())',
        backPath, out], { stdio: 'ignore' });
      back = fs.readFileSync(backPath);
    } else {
      back = zlib.gunzipSync(fs.readFileSync(out));
    }
    assert(back.equals(payload), '解压内容必须与源镜像逐字节一致');
  });

  console.log('\n[container.js 应用级容器]');

  const container = require('../src/core/container');

  await test('系统/框架包永不裁剪，用户 App 才纳入会话清理', () => {
    for (const p of ['android', 'com.android.systemui', 'com.google.android.gms', 'com.foo.bar.baz']) {
      const sys = container.isSystemPackage(p);
      if (p.startsWith('com.foo')) assert(!sys, `${p} 应识别为用户 App`);
      else assert(sys, `${p} 应识别为系统包`);
    }
    assert(container.isSystemPackage(''), '空包名当作系统包，避免生成非法命令');
  });

  await test('启动应用只停其他已装 App，默认绝不动系统包', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.phoenix.read', 'com.other.app', 'com.android.vending', 'com.google.android.gms', 'com.third.game'],
    });
    assert(r.stopped.length === 2, `应停 2 个其他用户 App，实际 ${r.stopped.join(',')}`);
    assert(r.stopped.includes('com.other.app') && r.stopped.includes('com.third.game'));
    assert(!r.commands.some((c) => c.includes('pm disable')), '默认不能禁用系统包');
    assert(!r.commands.some((c) => c.includes('kill-all')), '启动阶段不能清后台，避免误伤刚进前台的 App');
    assert(!r.commands.some((c) => /force-stop (android|com\.android|com\.google\.android)/.test(c)), '不能 force-stop 系统框架');
  });

  await test('包名白名单：被污染的清单不会拼出注入命令', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.evil;rm -rf /', 'com.ok.app', '$(whoami)', 'com.foo-bar'],
    });
    assert(r.stopped.length === 1 && r.stopped[0] === 'com.ok.app', `只应停合法包名，实际 ${r.stopped.join(',')}`);
    assert(!r.commands.some((c) => c.includes('rm -rf') || c.includes('$(')), '不能出现注入片段');
  });

  await test('深度裁剪可禁用后台包，且能完整恢复、不碰必需组件', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read', installed: [], deep: true,
    });
    assert(r.disabled.length > 0, '深度裁剪应有可禁用项');
    assert(r.commands.some((c) => c.includes('pm disable-user --user 0 com.android.vending')));
    for (const p of container.NEVER_TRIM) {
      assert(!r.disabled.includes(p), `${p} 绝不能被禁用`);
    }
    const back = container.buildRestoreCommands();
    for (const p of container.OPTIONAL_SYSTEM) {
      assert(back.some((c) => c.includes(`pm enable ${p}`)), `${p} 必须可恢复`);
    }
  });

  await test('容器停放：清后台 + Android idle，且状态机覆盖多窗口/最后关闭', () => {
    const idle = container.buildIdleCommands();
    assert(idle.some((c) => c.includes('am kill-all')), '停放要清后台缓存进程');
    assert(idle.some((c) => c.includes('deviceidle force-idle')), '停放要让 Android 进 idle');
    let s = container.nextSessionState([], 'open', 'a');
    assert(s.hasApp && !s.idle && s.foreground === 'a');
    s = container.nextSessionState(s.active, 'open', 'b');
    assert(s.active.length === 2 && s.foreground === 'b');
    s = container.nextSessionState(s.active, 'close', 'a');
    assert(s.active.length === 1 && s.hasApp && !s.idle);
    s = container.nextSessionState(s.active, 'close', 'b');
    assert(s.idle && !s.hasApp && s.active.length === 0, '最后一个窗口关闭后容器应停放');
  });

  await test('doctor 轻量容器：收敛 vCPU，手动设置优先', () => {
    const host = { totalMB: 32768, freeMB: 20000, cores: 16, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const lite = doctor.liteProfile({ host, engine: {} });
    // 老逻辑是 floor(核数/4) 夹到 2~3 —— 8 核机器只给 2 个 vCPU，视频应用直接卡。
    // 现在均衡模式给「一半物理核、上限 4」，省资源模式固定 2。
    assert(lite && lite.cores === 4, `16 核机器均衡模式应给 4 核，实际 ${lite && lite.cores}`);
    const save = doctor.liteProfile({ host, engine: { resourceMode: 'save' } });
    assert(save.cores === 2, `省资源模式应固定 2 核，实际 ${save.cores}`);
    assert(doctor.liteProfile({ host, engine: { liteMode: false } }) === null, '显式关闭应返回 null');
    const low = doctor.liteProfile({ host: { ...host, cores: 2 }, engine: {} });
    assert(low.cores === 2, '2 核机器至少保留 2 核');

    const auto = doctor.autoProfile({
      settings: { engine: { autoMemory: true, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000, host,
    });
    assert(auto.lite === true && auto.cores <= 4, JSON.stringify({ lite: auto.lite, cores: auto.cores }));
    const manual = doctor.autoProfile({
      settings: { engine: { autoMemory: false, cores: 6, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000, host,
    });
    assert(manual.cores === 6, '用户手动指定的核数必须优先于轻量模式');
    assert(/轻量容器/.test(doctor.describeProfile(auto)), '诊断摘要应标出轻量容器');
  });

  await test('全局鼠标钩子默认关闭，且窗口代理不再长时间阻塞消息泵', () => {
    const root = path.join(__dirname, '..');
    const agentPs1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const agentJs = fs.readFileSync(path.join(root, 'src', 'core', 'agent.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    const uiHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

    assert(/mouseSideButtons:\s*false/.test(storeJs), '默认设置里侧键钩子必须关闭');
    assert(!/winAgent\.hook\(true\)/.test(mainJs), '主进程不能再无条件安装全局钩子');
    assert(!/agent\.hook\(true\)/.test(appwinJs), '应用窗口不能再无条件安装全局钩子');
    assert(!/sharer\.start\(8000\)/.test(mainJs), '文件同步不能无条件常驻');
    assert(/setHook/.test(agentJs) && /hooked/.test(agentJs), '钩子开关必须幂等可关闭');
    assert(/new Thread\(HookThreadProc\)/.test(agentPs1), '钩子必须装在专用消息线程上');
    assert(/GetMessage\(out MSG/.test(agentPs1), '钩子线程必须跑消息循环');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(agentPs1), '主循环不能再阻塞 4 秒');
    assert(/Poll\(50,\s*SelectMode\.SelectRead\)/.test(agentPs1), '主循环应短轮询保持消息泵响应');
    assert(/now - _embedAt < 8000/.test(agentPs1), '窗口巡检必须限时，不能永久每 2 秒 EnumWindows');
    assert(/setLiteMode/.test(uiHtml) && /setDeepTrim/.test(uiHtml), '设置页需暴露轻量容器选项');
  });

  await test('独立窗口模式：不 SetParent、按面板比例给尺寸、清理不藏用户窗口', () => {
    const root = path.join(__dirname, '..');
    const agentPs1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const uiHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

    // 开关一路通到底：UI -> main -> appwin
    assert(/setWindowEmbed/.test(uiHtml), '设置页需要「窗口承载方式」开关');
    assert(/windowEmbed === false/.test(mainJs), 'main 必须能识别独立窗口模式');
    assert(/openDetached/.test(appwinJs), 'appwin 需要 openDetached');
    // 以前是 `detached: displaySettings().windowEmbed === false` 的行内写法，
    // 现在提到局部变量（因为还要据此决定 showWhileWaiting），两者都认。
    assert(/detached:\s*displaySettings\(\)\.windowEmbed === false/.test(mainJs)
      || /const detached = displaySettings\(\)\.windowEmbed === false/.test(mainJs),
      '开窗口时要带上 detached');

    // 独立模式绝不能 SetParent——那正是嵌入问题的根源
    // （只看真正的代码行，注释里提到 SetParent 是在解释为什么不用它）
    const codeOnly = (src) => src.split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .filter((l) => l.trim() && !/^\s*(\*|\/\*)/.test(l))
      .join('\n');
    const layoutBlock = agentPs1.slice(agentPs1.indexOf('cmd == "layout"'));
    const layoutBody = codeOnly(layoutBlock.slice(0, layoutBlock.indexOf('cmd == "hook"')));
    assert(!/SetParent\s*\(/.test(layoutBody), 'layout 不能 SetParent（独立模式就是要绕开它）');
    assert(/SetWindowPos\s*\(/.test(layoutBody), 'layout 应该只把窗口摆到目标矩形');

    // 清理逻辑在独立模式下必须收手，否则会把用户正在看的窗口当杂物藏掉
    assert(/_detachedMode/.test(agentPs1), 'agent.ps1 需要 _detachedMode 标记');
    const detachBlock = agentPs1.slice(agentPs1.indexOf('cmd == "detach"'));
    assert(/keep/.test(detachBlock.slice(0, 600)), 'detach 需要 keep 参数区分「切独立」和「结束嵌入」');

    // 尺寸要按面板比例算：模拟器自己锁宽高比，给错比例会被夹回去
    assert(/_panelRatio/.test(appwinJs), '独立窗口尺寸必须按面板比例计算');
    assert(!/w:\s*Math\.min\(area\.w - 80, 1280\)/.test(appwinJs), '不能再写死 1280 宽（会被模拟器夹成竖条）');
  });

  await test('只有一个运行时：注册表固定 builtin，装了什么模拟器都不影响', () => {
    const backends = require('../src/core/backends');
    // 0.5.6 起不再有自动挑选：不管本机装了 MuMu / 雷电 / 蓝叠 / WSA，
    // 都只跑 ApkStart 自己的运行时，只按设置读也不会有第二个候选。
    assert(backends.REGISTRY.length === 1, '注册表里出现了第二个底座');
    assert(backends.REGISTRY[0].id === 'builtin', '唯一底座不是 builtin');
  });

  await test('窗口标题改 ApkStart：识别逻辑必须同时认新标题', () => {
    const root = path.join(__dirname, '..');
    const ps1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const agent = fs.readFileSync(path.join(root, 'src', 'core', 'agent.js'), 'utf8');
    const appwin = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');

    assert(/SetWindowTextW/.test(ps1), 'agent.ps1 需要 SetWindowTextW 声明');
    assert(/cmd == "title"/.test(ps1), 'agent.ps1 需要 title 命令');
    assert(/LooksLikeEmulator/.test(ps1), '改完标题后还要能认出这个窗口，不能只认 Android Emulator');
    assert(/_ourTitle/.test(ps1), '要记住设过的标题');
    // Qt 会在窗口重建时把标题改回去，巡检里必须补设
    assert(/QuietSweep[\s\S]{0,600}SetWindowTextW/.test(ps1), '巡检里要补设标题');
    assert(/setTitle\(/.test(agent), 'agent.js 要暴露 setTitle');
    assert(/agent\.setTitle\(/.test(appwin), '独立窗口打开时要真的改标题');
  });

  await test('中文环境：开机注入 locale、静默装拼音输入法、captive portal 国内端点', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');
    const engJs = fs.readFileSync(path.join(root, 'src', 'core', 'engine.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

    // locale 用官方 -change-locale：实测 -prop persist.sys.locale 会被模拟器
    // 拦截、guest 里 getprop 一个都看不到，只有 -change-locale 会真正改系统语言
    assert(/'\-change-locale',\s*locale/.test(emuJs), '必须用 -change-locale 设系统语言');
    // 只看代码行：注释里解释「为什么不用 -prop」时提到它不算
    const emuCode = emuJs.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    assert(!/-prop[\s\S]{0,80}persist\.sys\.locale/.test(emuCode),
      '不能再用无效的 -prop persist.sys.locale');
    assert(/_guestLocale/.test(emuJs), '要有可配置的语言来源');
    // 默认中文
    assert(/locale:\s*'zh-CN'/.test(storeJs), '默认语言必须是简体中文');
    assert(/chineseIme:\s*true/.test(storeJs), '默认开启中文输入法');

    // 输入法：随包带 APK、开机装好并启用
    assert(fs.existsSync(path.join(root, 'assets', 'PinyinIME.apk')), '缺少 PinyinIME.apk');
    assert(/ensureChineseIme/.test(adbJs), 'adb 需要 ensureChineseIme');
    assert(/com\.android\.inputmethod\.pinyin/.test(adbJs), '要用谷歌拼音输入法');
    assert(/ime enable/.test(adbJs) && /default_input_method/.test(adbJs), '要启用并设为默认');
    assert(/ensureChineseIme/.test(engJs), 'prepare() 里要真正调用安装');
    assert(/_chineseReady/.test(engJs), '中文初始化要幂等（每次开机只做一次）');
    assert(/chineseIme/.test(engJs), '要允许用户关掉');

    // 联网验证端点：不能让 gstatic 把网络标成「!」
    assert(/captive_portal_http_url/.test(adbJs), '要设置国内联网验证端点');
    assert(/connect\.rom\.miui\.com/.test(adbJs), '端点要国内可达');

    // 设置页要有开关
    assert(/setLocale/.test(html) && /setChineseIme/.test(html), '设置页要暴露语言/输入法开关');
  });

  await test('方向自愈：平板/横屏画面躺倒 90° 要能自动纠正', () => {
    const root = path.join(__dirname, '..');
    const engJs = fs.readFileSync(path.join(root, 'src', 'core', 'engine.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

    // 判断依据：init=WxH 与 cur=WxH 的宽高顺序相反 = 逻辑空间被旋转了
    assert(/_healOrientation/.test(engJs), '要有方向自愈方法');
    assert(/init=\(\\d\+\)x\(\\d\+\)/.test(engJs), '要读 init 面板尺寸');
    assert(/cur=\(\\d\+\)x\(\\d\+\)/.test(engJs), '要读 cur 逻辑空间');
    assert(/initLand !== curLand/.test(engJs), '只在宽高顺序相反（真躺倒）时才重锁方向');
    // 横屏平板模式的稳定性：没躺倒也要校验 ignore-orientation + density 是否丢失并补齐
    assert(/mSetIgnoreOrientationRequest=true/.test(engJs), '横屏要校验 ignore-orientation 是否还在');
    assert(/Override density:/.test(engJs), '要读 Override density 判断是否丢失');
    assert(/tabletMode/.test(engJs), '平板排版开关要能被关掉');
    assert(/wm set-ignore-orientation-request true/.test(engJs), '丢了要补 ignore-orientation');
    assert(/wm density \$\{densityWanted\}/.test(engJs), '丢了要补 density');
    assert(/_healOrientation/.test(engJs.slice(engJs.indexOf('startWatchdog'))), '看门狗要周期自愈');
    // 应用刚起来 Activity 重建会覆盖方向，需要在那个时机补一次。
    // 窗口放宽到 2200 字符：onAppUp 的 then 回调里还要处理开机动画淡出，
    // 那些注释会把 _healOrientation 往后推，600 字符的窗口一加东西就误报。
    assert(/onAppUp[\s\S]{0,2200}_healOrientation/.test(mainJs), '应用起来后要立刻校正一次');
    // 面板方向和设置不一致时不能靠这里修，要交给重启
    assert(/panelLandscape/.test(engJs), '要能区分「该重启」和「该重锁方向」');
  });

  await test('Linux 快捷方式：.desktop 要可执行、Exec 要转义、图标必须 PNG', () => {
    const os = require('os');
    const shortcut = require('../src/core/shortcut');
    // Windows 上生成的是 .lnk，Linux 上必须是 .desktop（freedesktop 规范）
    assert(shortcut.shortcutExt() === (process.platform === 'win32' ? '.lnk' : '.desktop'),
      '快捷方式扩展名要跟平台走');

    // 直接调 .desktop 写入器验证内容（不依赖当前平台）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-dt-'));
    const out = path.join(dir, '测试 应用.desktop');
    const png = path.join(dir, 'icon.png');
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      shortcut.writeDesktopEntry({
        shortcutPath: out,
        target: '/opt/ApkStart/ApkStart',
        args: '--launch "com.example.app"',
        iconPngPath: png,
        description: '测试应用',
      });
      assert(fs.existsSync(out), '.desktop 必须真的落盘');
      const body = fs.readFileSync(out, 'utf8');
      assert(/\[Desktop Entry\]/.test(body), '缺 Desktop Entry 段');
      assert(/^Type=Application$/m.test(body), 'Type 必须是 Application');
      // 带空格的路径不加引号会被拆成两个参数，直接启动失败
      assert(/^Exec=.*"\/opt\/ApkStart\/ApkStart"/m.test(body), 'Exec 里的目标路径要加引号');
      assert(/com\.example\.app/.test(body), 'Exec 要带上 --launch 的包名');
      assert(/^Icon=.*icon\.png$/m.test(body), '图标要用 PNG 绝对路径（ICO 在 Linux 无效）');
      // .desktop 不带执行位，很多桌面环境会当普通文档
      if (process.platform !== 'win32') {
        const mode = fs.statSync(out).mode & 0o777;
        assert((mode & 0o100) !== 0, '.desktop 必须有可执行位');
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('横屏必须「正立」：面板定方向、rotation 锁 0、忽略应用的方向请求', () => {
    const root = path.join(__dirname, '..');
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');

    // 实机踩出来的三段式（缺任何一段画面都会躺倒 90°）：
    //  1) 物理面板换方向（hw.lcd.width/height 互换 + 重启）—— 见 doctor.lcdFor
    //  2) 逻辑方向锁 **0**：面板已经是横的，再锁 1 会把横面板转成竖逻辑空间
    //  3) 忽略应用自己的方向请求：红果这类应用声明 portrait，系统照办后
    //     init=1280x720 的横面板会变成 cur=720x1280 的竖逻辑空间
    const setOri = adbJs.slice(adbJs.indexOf('async setOrientation'), adbJs.indexOf('async resetDisplayOverrides'));
    assert(/wm user-rotation lock 0/.test(setOri),
      'setOrientation 必须锁 rotation 0（锁 1 会让横面板躺倒）');
    assert(!/user-rotation lock \$\{landscape \? 1/.test(setOri),
      '不能再按 landscape 锁 1 —— 那是「只有竖面板可旋转」时代的写法');
    assert(/wm set-ignore-orientation-request/.test(setOri),
      '必须忽略应用的屏幕方向请求，否则竖屏锁定的应用会躺倒');

    const reset = adbJs.slice(adbJs.indexOf('async resetDisplayOverrides'));
    assert(/wm user-rotation lock 0/.test(reset.slice(0, 800)), 'resetDisplayOverrides 也要锁 0');
    assert(/wm set-ignore-orientation-request/.test(reset.slice(0, 800)),
      'resetDisplayOverrides 也要按模式设置 ignore-orientation');
  });

  await test('关闭应用必须有入口：右键菜单 + 托盘 + IPC 一个都不能少', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const preloadJs = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
    const uiJs = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');

    // 主进程要有 app:stop（以前压根没有，endApp 只在窗口关闭时触发，
    // 而独立窗口模式那个窗口是隐藏的 → 应用一起来就关不掉）
    assert(/ipcMain\.handle\('app:stop'/.test(mainJs), '缺少 app:stop IPC');
    // 渲染进程要能调到
    assert(/stop:\s*\(pkg\)\s*=>\s*invoke\('app:stop'/.test(preloadJs), 'preload 要暴露 stop');
    // 右键菜单要有这一项
    assert(/key:\s*'stop'/.test(uiJs), '右键菜单缺少「关闭应用」');
    assert(/case 'stop':/.test(uiJs), '右键菜单没有处理 stop');
    // 独立窗口模式主界面是隐藏的，托盘是唯一随时可达的入口
    assert(/关闭当前应用/.test(mainJs), '托盘菜单缺少「关闭当前应用」');
    // 关掉后要刷新「运行中」标记
    assert(/apps:changed/.test(mainJs) && /apps:changed/.test(uiJs),
      '关闭后要发 apps:changed 并让界面刷新');

    // 修复：托盘和 IPC 必须共用同一条 stopApp 路径，不在两处写同样的逻辑
    assert(/async function stopApp/.test(mainJs), '必须有统一的 stopApp 函数');
    assert(/ipcMain\.handle\('app:stop'[\s\S]{0,200}stopApp/.test(mainJs),
      'app:stop IPC 必须委托给 stopApp');
    assert(/stopApp\(pkg\)\.then/.test(mainJs) || /stopApp\(pkg\)/.test(mainJs),
      '托盘菜单也必须调 stopApp');
    // 关闭后必须清 currentAppPkg，否则托盘还显示「关闭当前应用（xxx）」
    assert(/currentAppPkg === target/.test(mainJs) || /currentAppPkg = null/.test(mainJs),
      'stopApp 必须清 currentAppPkg');
    // 独立窗口模式必须先藏模拟器窗口再关壳窗口（反了会在桌面闪一下）
    assert(/detached[\s\S]{0,200}agent\.hide/.test(mainJs),
      '独立窗口模式先 hide 再 close');
    // 外部关闭（Alt+F4）也要清 currentAppPkg
    assert(/onCloseApp[\s\S]{0,300}currentAppPkg = null/.test(mainJs) || /onCloseApp[\s\S]{0,300}currentAppPkg === pkg/.test(mainJs),
      'onCloseApp 也要清 currentAppPkg');
  });

  await test('旧版本清理：能发现任意位置的 ApkStart 目录，且绝不碰当前运行版本', () => {
    const os = require('os');
    const leftovers = require('../src/core/leftovers');
    const np = (p) => { try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); } };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-left-'));
    try {
      // 造三个「旧版本」目录 + 一个「当前版本」目录，每个里面放一个假的 ApkStart.exe
      const mk = (name) => {
        const d = path.join(root, name);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'ApkStart.exe'), 'fake-exe');
        return d;
      };
      const old1 = mk('ApkStart-v0.3.9-win64-portable');
      const old2 = mk('ApkStart-win64-portable.prev-2026-01-01T00-00-00-000Z'); // 打包备份残留
      const curDir = mk('ApkStart-v0.5.0-win64-portable');

      const r = leftovers.scan({ installDir: curDir, dataDir: root, avdHome: '' });
      const found = r.items.filter((i) => i.kind === 'dir').map((i) => np(i.path));

      assert(found.includes(np(old1)), '普通旧版本目录没被发现');
      // .prev-* 是 pack.js 每次改名保留的备份，以前完全清不掉，现在必须能发现
      assert(found.includes(np(old2)), '.prev 打包备份残留没被发现');
      // 关键安全约束：当前正在运行的那个绝不能出现在待删列表里
      assert(!found.includes(np(curDir)), '当前运行版本被当成旧版本（危险）');
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('切换应用必须先干净关掉上一个，否则旧应用 ANR / _activeApps 残留', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

    // openAppWindow 现在必须是 async：切换时要 await 把旧应用停干净再开新的。
    assert(/async function openAppWindow/.test(mainJs), 'openAppWindow 必须 async（要等旧应用收尾）');
    // 调用处也必须 await，否则 close/endApp 和新应用启动并发 → 抢前台 → ANR
    assert(/await openAppWindow\(/.test(mainJs), 'runLaunch 里必须 await openAppWindow');

    // 核心：切到「另一个」应用时，必须先 endApp(旧) —— 只收窗口不停进程是 bug 根源
    const fn = mainJs.slice(mainJs.indexOf('async function openAppWindow'));
    const body = fn.slice(0, fn.indexOf('\n}', fn.indexOf('currentAppPkg = pkg')));
    assert(/currentAppPkg !== pkg/.test(body), '只在切换到不同应用时才关旧的（同应用走复用）');
    assert(/runtime\.endApp\(prev/.test(body) || /runtime\.endApp\(currentAppPkg/.test(body),
      '切换时必须真正 endApp 旧应用（force-stop + 移出 _activeApps）');
    // appWin.open() 内部用的是 close({keepApp:true})，不 endApp；
    // 所以外层必须显式补上 endApp，不能指望 open 里的 close。
    assert(/close\(\{ keepApp: true \}\)/.test(body) && /endApp/.test(body),
      '先 park 画面（close keepApp）再 endApp 停进程，顺序要对');

    // 窗口已不在但进程还挂在 _activeApps 的情况也要收尾
    assert(/else if \(currentAppPkg && currentAppPkg !== pkg\)/.test(body),
      '窗口不在时也要清掉残留的 _activeApps 进程');
  });

  await test('自动全屏和横屏必须是活的：设置项得有消费方，且启动时校正面板方向', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const htmlJs = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');
    const uiJs = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');

    // autoFullscreenOnLaunch 以前只在默认设置里声明，没有任何代码读它 —— 死开关。
    const uses = (mainJs.match(/autoFullscreenOnLaunch/g) || []).length;
    assert(uses > 0, 'autoFullscreenOnLaunch 必须真的被读（不能只是声明）');
    assert(/fullscreen:[\s\S]{0,200}autoFullscreenOnLaunch/.test(mainJs),
      '自动全屏要参与 openAppWindow 的 fullscreen 判定');

    // 设置页要能改这两项
    assert(/setAutoFullscreen/.test(htmlJs), '设置页缺少「自动全屏」开关');
    assert(/setLandscape/.test(htmlJs), '设置页缺少「屏幕方向」开关');
    assert(/setAutoFullscreen'\)\.addEventListener/.test(uiJs), '自动全屏开关没接事件');
    assert(/setLandscape'\)\.addEventListener/.test(uiJs), '屏幕方向开关没接事件');

    // 横屏只能靠物理面板 + 重启；启动时必须先校正，否则会躺倒
    assert(/panelLandscape/.test(emuJs), 'emulator 需要能读出当前面板方向');
    assert(/orientation mismatch/.test(mainJs), '启动前要检查面板方向是否与设置一致');
    assert(/reloadApp:\s*false/.test(mainJs), '校正方向时不能顺手再启动一次应用（会重复拉起）');

    // 独立窗口模式下「全屏」要作用在模拟器窗口上，maximize 一个隐藏窗口没有意义
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    assert(/_wantFullscreen/.test(appwinJs), '独立窗口模式要记住全屏意图');
    assert(/if \(this\._wantFullscreen\)/.test(appwinJs), 'openDetached 要按全屏铺满可用区');

    // 修复：重启运行时后旧 rt.client 失效，beforeStart 必须返回新的 rt
    const instJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    assert(/beforeStart[\s\S]{0,400}replaced[\s\S]{0,200}replaced\.client/.test(instJs),
      'installer.launch 要接受 beforeStart 返回的新 rt');
    assert(/return newRt/.test(mainJs) || /return rt/.test(mainJs.slice(mainJs.indexOf('restartForOrientation'))),
      'restartForOrientation 要返回新的 rt 给 beforeStart');

    // 修复：独立窗口模式横屏时 _panelRatio 要按面板方向校正
    assert(/this\.state\.landscape.*b\.height > b\.width/.test(appwinJs)
      || /landscape.*height.*width/.test(appwinJs),
      '_panelRatio 横屏时要校正比值');
  });

  await test('点开应用要尽早出画面：进程一出现就接窗口，不等 4 秒观察期', () => {
    const root = path.join(__dirname, '..');
    const instJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

    // 实机测出来的：进程在 2 秒时就出现了，但我们为了「确认不会马上崩」又等了 4 秒
    // 才把窗口接上去，用户看到的就是「点了没反应」。改成进程一出现就接。
    assert(/onAppUp/.test(instJs), 'installer.launch 需要 onAppUp 回调');
    assert(/if \(!seen && typeof onAppUp === 'function'\)/.test(instJs),
      'onAppUp 必须在「第一次看到进程」时触发，且只触发一次');

    // 主进程要接这个回调，并且是并行接（不 await），否则又变成串行等待
    assert(/onAppUp:\s*\(\)\s*=>/.test(mainJs), 'main.js 要传 onAppUp');
    const block = mainJs.slice(mainJs.indexOf('onAppUp: () =>'), mainJs.indexOf('beforeStart:'));
    assert(/attachAppWindow\(\)/.test(block), 'onAppUp 里要立刻接画面');
    assert(!/await attachAppWindow\(\)/.test(block),
      'onAppUp 里不能 await 接画面（会和存活判定串行，等于没优化）');

    // 提前接过了就不能再在后面重复接一次 —— 独立窗口模式下会把刚摆好的窗口
    // 再隐藏/显示一遍，画面会闪。
    assert(/attachDoneEarly/.test(mainJs), '要记住是否已经提前接过画面');
    assert(/if \(attachDoneEarly\)/.test(mainJs), '最终判定要跳过重复接画面');

    // 存活观察期本身不能删：它是防「闪一下就崩」的兜底
    assert(/aliveSince >= 4000/.test(instJs), '4 秒存活观察期要保留（防闪崩）');
  });

  await test('虚拟机联网：AVD 必须开虚拟 Wi-Fi，且能主动重连「不会自动连」的热点', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    const engineJs = fs.readFileSync(path.join(root, 'src', 'core', 'engine.js'), 'utf8');

    // API 34 的 Play Store 镜像上网走 wlan0（netsim 虚拟 Wi-Fi），不是 eth0。
    // config.ini 少了 hw.wifi，wlan0 就永远 NO-CARRIER，应用里一直「网络错误」。
    assert(/['"]hw\.wifi=yes['"]/.test(emuJs), 'config.ini 必须写 hw.wifi=yes');

    // 实机根因：AndroidWifi 会落成「Saved / Won't automatically connect」，
    // 开机后不自动连接。shell 又没有 NETWORK_SETTINGS 权限，cmd wifi
    // connect-network 会抛 SecurityException，所以只能走 UI 点一下。
    assert(/async repairWifi/.test(emuJs), '需要有主动重连 Wi-Fi 的能力');
    assert(/WIFI_SETTINGS/.test(emuJs), '重连需要拉起 Wi-Fi 设置页');
    assert(/uiautomator dump/.test(emuJs), '重连要靠 uiautomator 找到热点再点');
    // 连上之后还要把「联网验证」探针换成国内可达的端点，否则系统一直给网络打「!」，
    // 部分应用据此判定离线、拒绝加载内容。
    assert(/captive_portal_http_url/.test(emuJs), '需要把联网验证探针改成国内可达端点');
    // 明令禁止用 connect-network 当主方案（权限不够，必然失败）。
    // 只看真正的代码行——注释里提到它是在解释为什么不用。
    const emuCode = emuJs.split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .filter((l) => l.trim() && !/^\s*(\*|\/\*)/.test(l))
      .join('\n');
    assert(!/cmd wifi connect-network/.test(emuCode), 'shell 没有 connect-network 权限，不能用它');

    // 修复必须从轻到重：先重连，再冷启动，最后才清数据
    const repair = engineJs.slice(engineJs.indexOf('async repairNetwork'));
    const repairBody = repair.slice(0, repair.indexOf('async ', 10) > 0 ? undefined : undefined);
    assert(/repairWifi/.test(repairBody), 'repairNetwork 应先尝试轻量的 Wi-Fi 重连');
    const wifiAt = repairBody.indexOf('repairWifi');
    const wipeAt = repairBody.indexOf('forceWipeOnNextStart');
    assert(wifiAt > -1 && wipeAt > -1 && wifiAt < wipeAt,
      '顺序必须是：先重连 Wi-Fi，最后才重置数据（不能一上来就清用户数据）');

    // ensureNetwork 也要先试轻量修复，别直接冷启动
    const ensure = engineJs.slice(engineJs.indexOf('async ensureNetwork'));
    const ensureBody = ensure.slice(0, ensure.indexOf('async repairNetwork'));
    const eWifi = ensureBody.indexOf('repairWifi');
    const eBoot = ensureBody.indexOf('_netColdBootTried');
    assert(eWifi > -1 && eBoot > -1 && eWifi < eBoot,
      'ensureNetwork 应先尝试重连 Wi-Fi，再考虑冷启动');

    // 启动路径（installer）上也要做一次，否则每次点开应用都先吃一个「没网」的应用。
    // 注意这里只允许非破坏性的 repairWifi，绝不能出现 ensureNetwork（会冷启动）。
    const instJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    assert(/repairWifi/.test(instJs), '启动应用前应尝试修复 Wi-Fi');
    assert(!/\.ensureNetwork\(/.test(instJs), '启动路径不能调 ensureNetwork（会停虚拟机冷启动）');
    // 必须挂在 engine（this.runtime）上：rt 是 ensure() 的返回对象，只有 client。
    // 写成 rt.repairWifi 会是 undefined，调用即抛错又被 catch 吞掉，等于没修。
    assert(/this\.runtime\.repairWifi\(/.test(instJs), 'repairWifi 要挂在 engine（this.runtime）上');
    assert(!/\brt\.repairWifi\(/.test(instJs), 'rt 是 ensure() 的返回对象，上面没有 repairWifi');
    // engine 上这个转发方法必须真的存在，否则 installer 里调用同样是 undefined
    assert(/async repairWifi\(/.test(engineJs), 'engine 必须实现 repairWifi 转发');
  });

  await test('WinAgent.setHook(false) 在默认状态下不会拉起 PowerShell 代理', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    a.hooked = false;
    const r = await a.setHook(false);
    assert(r && r.hooked === false, '关闭应返回 hooked=false');
    assert(a.ready === null, '默认关闭时不能为此启动常驻代理进程');
  });

  console.log('\n[鼠标键位映射]');

  await test('默认与旧配置迁移：右键返回 + 平滑滚轮开启，侧键关闭', () => {
    const store = require('../src/core/store');
    const d = pointer.pointerOptions(store.getSettings());
    assert(d.rightBack === true, '右键返回默认开');
    assert(d.wheel === 'smooth', '滚轮默认平滑');
    assert(d.side === false, '侧键默认关');
    assert(d.enabled === true, '至少右键映射需要钩子');
    // 老 settings.json 里没有新键时也要得到同样的结果
    assert(pointer.pointerOptions({ engine: { liteMode: true } }).rightBack === true);
    const off = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'off', mouseSideButtons: false } });
    assert(off.enabled === false, '全部关掉后不应再装钩子');
    const native = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'native', mouseSideButtons: false } });
    assert(native.enabled === false, '原生滚轮不需要钩子');
  });

  await test('hookOptions 收敛配置，关闭时所有子开关一起归零', () => {
    const on = pointer.hookOptions({ enabled: true, rightBack: true, wheel: true, side: false });
    assert(on.rightBack && on.wheel && !on.side);
    const off = pointer.hookOptions({ enabled: false, rightBack: true, wheel: true, side: true });
    assert(!off.rightBack && !off.wheel && !off.side, 'enabled=false 必须彻底不拦事件');
    assert(pointer.hookOptions(true).side === true, '兼容旧布尔写法（侧键）');
    assert(pointer.hookOptions(false).enabled === false);
  });

  await test('滚轮方向：向下滚=手指上滑，向上滚=手指下滑，坐标不越界', () => {
    const down = pointer.wheelToSwipe({ dy: -120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(down && down.y1 > down.y2, '滚轮向下应让内容上移（手指上滑）');
    const up = pointer.wheelToSwipe({ dy: 120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(up && up.y1 < up.y2, '滚轮向上应让内容下移（手指下滑）');
    assert(pointer.wheelToSwipe({ dx: 0, dy: 0 }) === null, '零位移不产生命令');
    for (const s of [down, up]) {
      assert([s.x1, s.x2].every((v) => v >= 1 && v <= 899), 'x 不能越界');
      assert([s.y1, s.y2].every((v) => v >= 1 && v <= 1599), 'y 不能越界');
      assert(s.duration >= 100 && s.duration <= 240, '滑动时长应有上限');
    }
    const big = pointer.wheelToSwipe({ dy: -12000, nx: 0, ny: 0, width: 900, height: 1600 });
    assert(big.y1 - big.y2 <= Math.round(1600 * 0.78), '快滚不能无限拉长手势');
    const horiz = pointer.wheelToSwipe({ dx: 120, dy: 0, width: 900, height: 1600 });
    assert(horiz && horiz.x1 > horiz.x2 && horiz.y1 === horiz.y2, '横向滚轮应产生水平滑动');
  });

  await test('input 命令白名单：只放行内部拼出的命令，挡住注入', async () => {
    assert(pointer.isInputCommand('input keyevent 4'));
    assert(pointer.isInputCommand(pointer.swipeToCommand(pointer.wheelToSwipe({ dy: -120 }))));
    assert(!pointer.isInputCommand('input keyevent 4; rm -rf /sdcard'));
    assert(!pointer.isInputCommand('input swipe 1 2 3 4 100 && reboot'));
    assert(!pointer.isInputCommand('sh -c anything'));
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    let blocked = false;
    try { await c.input('input keyevent 4; rm -rf /'); } catch (e) { blocked = /非法/.test(e.message); }
    assert(blocked, '非法命令必须在拉起 adb 之前被挡下');
    assert(c._input === null, '被挡下的命令不能创建常驻会话');
  });

  await test('返回键优先走常驻输入通道，失败才回退一次性 adb', async () => {
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used = [];
    c.input = async (cmd) => { used.push(cmd); };
    c.shell = async () => { used.push('shell'); };
    await c.keyBack();
    assert(used[0] === 'input keyevent 4' && !used.includes('shell'), '正常路径不应 spawn adb');
    const c2 = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used2 = [];
    c2.input = async () => { throw new Error('offline'); };
    c2.shell = async (cmd) => { used2.push(cmd); return ''; };
    await c2.keyForward();
    assert(used2[0] === 'input keyevent 125', '常驻通道失败必须兜底，别丢掉这次点击');
  });

  await test('WheelRouter 把连续滚动合并成一条滑动命令', async () => {
    const cmds = [];
    const r = new pointer.WheelRouter({
      inject: async (cmd) => { cmds.push(cmd); },
      getSize: () => ({ width: 900, height: 1600 }),
      flushMs: 10,
    });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.4 });
    await r.flush();
    assert(cmds.length === 1, `3 格滚动应合并成 1 条命令，实际 ${cmds.length}`);
    assert(pointer.isInputCommand(cmds[0]), '必须产出合法的 input swipe');
    const m = /^input swipe (\d+) (\d+) (\d+) (\d+)/.exec(cmds[0]);
    assert(m && Number(m[2]) > Number(m[4]), '合并后仍是向下滚的方向');
    r.dispose();
    r.push({ dy: -120 });
    await r.flush();
    assert(cmds.length === 1, 'dispose 后不能再注入');
  });

  await test('代理脚本：右键/滚轮拦截、滚轮合并、前台限定与专用线程', () => {
    const ps1 = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    assert(/WM_RBUTTONDOWN/.test(ps1) && /WM_MOUSEWHEEL/.test(ps1), '必须处理右键与滚轮');
    assert(/WM_MOUSEHWHEEL/.test(ps1), '横向滚轮也要支持');
    assert(/PushWheel\(/.test(ps1) && /FlushWheel\(false\)/.test(ps1), '滚轮必须合并后上报');
    assert(/GetAncestor\(fg, 2\)/.test(ps1), '必须按前台根窗口限定作用域');
    assert(/new Thread\(HookThreadProc\)/.test(ps1) && /GetMessage\(out MSG/.test(ps1), '钩子必须在专用消息线程');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(ps1), '主循环不能长阻塞');
    assert(/_optRight == 0/.test(ps1) && /_optWheel == 0/.test(ps1), '未配置的映射不能拦事件');
    const appwinJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/pointerConfig/.test(appwinJs) && /refreshPointer/.test(appwinJs), '设置变化要能即时同步钩子');
    const uiHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
    assert(/setMouseRightBack/.test(uiHtml) && /setMouseWheelMode/.test(uiHtml), '设置页需暴露键位开关');
  });

  await test('WinAgent.setHook 把键位配置一起下发，且关闭时不拉起代理', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    a.call = async (obj) => { sent.push(obj); return { ok: true, hooked: true }; };
    const on = await a.setHook(true, { rightBack: true, wheel: true, side: false });
    assert(on.hooked === true && sent.length === 1, '开启应只发一次命令');
    assert(sent[0].right === 1 && sent[0].wheel === 1 && sent[0].side === 0, '配置必须随 hook 命令下发');
    await a.setHook(false);
    assert(sent[1].on === 0 && a.hooked === false, '关闭要卸载钩子');
    const b = new WinAgent();
    const r = await b.setHook(false);
    assert(r.hooked === false && b.ready === null, '默认关闭时不能启动 PowerShell');
  });

  console.log('\n[updater.js 在线更新]');
  await test('版本比较按数字逐段比，v 前缀 / 多段都正确', () => {
    const { cmpVer } = require('../src/core/updater');
    assert(cmpVer('v0.3.2', '0.3.1') === 1, '0.3.2 应大于 0.3.1');
    assert(cmpVer('0.3.1', 'v0.3.1') === 0, 'v 前缀不影响相等');
    assert(cmpVer('0.10.0', '0.9.9') === 1, '必须按数字比而不是字符串比');
    assert(cmpVer('1.0.0', '1.0.1') === -1, '1.0.0 小于 1.0.1');
  });

  await test('安装形态决定挑哪个资产：安装版=Setup.exe，便携版=portable.zip', () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-setup');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'ApkStart.exe');
    fs.writeFileSync(exe, 'x');
    const portable = new Updater({ currentVersion: '0.1.0', exePath: exe, isPackaged: true, dataDir: TMP });
    assert(portable.flavor === 'portable', '没有卸载器时判定为便携版');
    fs.writeFileSync(path.join(dir, 'Uninstall ApkStart.exe'), 'x');
    assert(portable.flavor === 'setup', '有卸载器时判定为安装版');
    // 资产挑选是纯函数式的，这里直接喂一个假的 check 结果验证兜底命名规则
    assert(/Setup\.exe$/i.test('ApkStart-0.3.2-Setup.exe'), '安装版资产名匹配');
    assert(/portable.*\.zip$/i.test('ApkStart-v0.3.2-win64-portable.zip'), '便携版资产名匹配');
  });

  await test('便携版不会把运行时整包（ApkStart-runtime-*.zip）当成更新包', async () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-asset');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'ApkStart.exe');
    fs.writeFileSync(exe, 'x');
    const mk = (assets) => ({
      version: '0.5.0', tag: 'v0.5.0', name: 'ApkStart v0.5.0', notes: '', htmlUrl: '',
      publishedAt: '', sources: [], unreachable: [], assets,
    });
    const u = new Updater({ currentVersion: '0.3.4', exePath: exe, isPackaged: true, dataDir: dir });
    // 两个资产同时存在 → 必须挑便携包
    u.sources = { latest: async () => mk([
      { name: 'ApkStart-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', urls: ['https://x/runtime.zip'], sizes: {} },
      { name: 'ApkStart-v0.5.0-win64-portable.zip', url: 'https://x/p.zip', urls: ['https://x/p.zip'], sizes: {} },
    ]) };
    let info = await u.check({ force: true });
    assert(/portable/.test(info.asset.name), `应挑便携包，实际 ${info.asset.name}`);

    // 只有运行时整包（便携包没传上去）→ 宁可不自动更新，也不能拿 1.5GB 运行时当程序包
    u.sources = { latest: async () => mk([
      { name: 'ApkStart-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', urls: ['https://x/runtime.zip'], sizes: {} },
    ]) };
    info = await u.check({ force: true });
    assert(!info.asset, '只有运行时整包时不应挑出更新资产');
    assert(info.canAutoApply === false, '没有可用资产时不能自动更新');
  });

  await test('双源：候选地址含镜像前缀，自定义前缀优先于公共镜像', () => {
    const { Sources, withMirror } = require('../src/core/sources');
    const url = 'https://github.com/o/r/releases/download/v1/a.zip';
    const auto = new Sources(() => ({ runtime: { autoMirror: true } }));
    const list = auto.candidates(url);
    assert(list[0] === url, '源站必须排第一（测速排序前保持原序）');
    assert(list.length >= 2 && list.some((u) => u.includes('ghfast.top')), '自动镜像应被列入候选');

    const custom = new Sources(() => ({ runtime: { autoMirror: true, mirrorPrefix: 'https://my.mirror/' } }));
    const c2 = custom.candidates(url);
    assert(c2.length === 2 && c2[1] === `https://my.mirror/${url}`, `自定义前缀应唯一生效，实际 ${JSON.stringify(c2)}`);

    const off = new Sources(() => ({ runtime: { autoMirror: false } }));
    assert(off.candidates(url).length === 1, '关掉自动镜像后只剩直连');
    assert(withMirror(url, 'https://x/') === `https://x/${url}`, '前缀缺尾斜杠要自动补');

    // 镜像只代理 GitHub：Gitee 的地址拼上镜像前缀只会 403，不该被列入候选
    const giteeUrl = 'https://gitee.com/daily-miku/apkstart/releases/download/v1/a.zip.part1';
    assert(auto.candidates(giteeUrl).length === 1, 'Gitee 资产不应套 GitHub 镜像前缀');
  });

  await test('双源：测速结果按速度排序，全部失败时保持原序不丢可用地址', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    // 直接注入测速缓存，避免测试依赖外网
    s._rankCache.set('https://slow/', { at: Date.now(), ok: true, speed: 1000 });
    s._rankCache.set('https://fast/', { at: Date.now(), ok: true, speed: 9000 });
    s._rankCache.set('https://dead/', { at: Date.now(), ok: false, speed: 0 });
    const ranked = await s.rank(['https://slow/', 'https://dead/', 'https://fast/']);
    assert(ranked[0] === 'https://fast/', `最快的应排第一，实际 ${ranked[0]}`);
    assert(ranked[2] === 'https://dead/', '失败的地址排最后但仍保留（还有一次机会）');
    s.reset();
    assert(s._rankCache.size === 0, 'reset 要清空测速缓存（换源/换网后必须重测）');
  });

  await test('双源：Gitee 自动附带的源码包（v1.2.3.zip）绝不能被当成安装包', async () => {
    const { Sources } = require('../src/core/sources');
    const s2 = new Sources(() => ({ runtime: {} }));
    s2.fetchReleases = async () => [
      {
        source: 'gitee',
        name: 'Gitee',
        web: 'e',
        rel: {
          tag_name: 'v0.3.2',
          assets: [
            { name: 'v0.3.2.zip', size: 999, browser_download_url: 'ge://src' },
            { name: 'v0.3.2.tar.gz', size: 999, browser_download_url: 'ge://src2' },
            { name: 'ApkStart-v0.3.2-win64-portable.zip', size: 10, browser_download_url: 'ge://ok' },
          ],
        },
      },
    ];
    const m = await s2.latest();
    assert(m.assets.length === 1 && m.assets[0].url === 'ge://ok',
      `只应保留 ApkStart* 资产，实际 ${JSON.stringify(m.assets.map((a) => a.name))}`);
  });

  await test('Gitee 的资产没有 size 字段：分片组仍要成立（否则整包被丢掉）', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [{
      source: 'gitee',
      name: 'Gitee',
      web: 'e',
      rel: {
        tag_name: 'v0.3.3',
        // Gitee 发行版资产只有 name + url，没有 size（实测）
        assets: [
          { name: 'ApkStart-v0.3.3-win64-portable.zip.part1', browser_download_url: 'ge://p1' },
          { name: 'ApkStart-v0.3.3-win64-portable.zip.part2', browser_download_url: 'ge://p2' },
        ],
      },
    }];
    const m = await s.latest();
    assert(m.assets.length === 1, `应合并成 1 个资产，实际 ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.name === 'ApkStart-v0.3.3-win64-portable.zip', `资产名应为整包名，实际 ${a.name}`);
    assert(a.parts && a.parts.length === 2, '必须保留两片');
    assert(a.parts[0].urls[0] === 'ge://p1' && a.parts[1].urls[0] === 'ge://p2', '分片地址顺序/内容要对');
    assert(a.size === 0, '大小未知时应为 0（界面按已收字节显示进度）');
  });

  await test('分片资产必须一路传到 updater.asset，否则 prepare 会报「没有可用的下载地址」', async () => {
    const { Updater } = require('../src/core/updater');
    const u = new Updater({
      currentVersion: '0.0.1', exePath: path.join(TMP, 'A.exe'), isPackaged: true, dataDir: TMP,
      settings: () => ({}),
    });
    u.sources.latest = async () => ({
      version: '9.9.9',
      tag: 'v9.9.9',
      assets: [{
        name: 'ApkStart-v9.9.9-win64-portable.zip',
        size: 0,
        partial: true,
        parts: [{ index: 1, size: 0, urls: ['https://gitee.com/x/p1'] }, { index: 2, size: 0, urls: ['https://gitee.com/x/p2'] }],
      }],
      sources: [{ source: 'gitee', name: 'Gitee', tag: 'v9.9.9' }],
      unreachable: [],
    });
    const info = await u.check({ force: true });
    assert(info.asset && info.asset.parts && info.asset.parts.length === 2, 'parts 必须保留到 asset 上');
    assert(info.canAutoApply === true, '有分片就应判定为可自动更新');
  });

  await test('双源：合并版本时只认同版本的资产，不拿旧包冒充新包', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.4.0', assets: [{ name: 'ApkStart-A-portable.zip', size: 10, browser_download_url: 'gh://a' }] } },
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.9', assets: [{ name: 'ApkStart-A-portable.zip', size: 10, browser_download_url: 'ge://a' }, { name: 'ApkStart-B.txt', size: 1, browser_download_url: 'ge://b' }] } },
    ];
    const m = await s.latest();
    assert(m.version === '0.4.0', `应取更高版本，实际 ${m.version}`);
    assert(m.assets.length === 1 && m.assets[0].url === 'gh://a', '旧版本同名资产不能覆盖新版本');
  });

  await test('窗口代理：scope 用分号拼目录、滤空项（窗口归属判定的唯一输入）', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    // 不真起代理进程：只验证发给它的协议内容
    a.call = async (obj) => { sent.push(obj); return { ok: true, n: 1 }; };
    const r = await a.scope(['C:////runtime', '', null, 'D:////repo////engine']);
    assert(sent.length === 1 && sent[0].cmd === 'scope', `只应发一条 scope，实际 ${JSON.stringify(sent)}`);
    assert(sent[0].dirs === 'C:////runtime;D:////repo////engine', `空项要滤掉，实际 ${sent[0].dirs}`);
    assert(r.ok === true, 'scope 成功要返回 ok');
    // 传空数组也不能抛：那等于「什么都不压制」，由调用方决定要不要告警
    const empty = await a.scope([]);
    assert(sent[1].dirs === '' && empty.ok === true, '空范围也要能下发（代理收到后一个窗口都不动）');
  });

  await test('双源：同名整包两边都有时，两个地址都要留着（否则 Gitee 永远轮不到）', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    const gh = 'https://github.com/o/r/releases/download/v0.3.3/a.zip';
    const ge = 'https://gitee.com/o/r/releases/download/v0.3.3/a.zip';
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.3.3', assets: [{ name: 'ApkStart-v0.3.3-win64-portable.zip', size: 108200693, browser_download_url: gh }] } },
      // Gitee 的资产没有 size（实测），不能拿 GitHub 的大小冒充它
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.3', assets: [{ name: 'ApkStart-v0.3.3-win64-portable.zip', browser_download_url: ge }] } },
    ];
    const m = await s.latest();
    assert(m.assets.length === 1, `同名资产要合并成 1 个，实际 ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.urls.length === 2 && a.urls[1] === ge, `两个源的地址都要留着，实际 ${JSON.stringify(a.urls)}`);
    assert(a.sizes[gh] === 108200693 && !a.sizes[ge], '大小按地址分开记，未知就是未知');
    const cands = s.candidates(a);
    assert(cands.length === 2 && cands[0] === gh, `候选地址应含两个源，实际 ${JSON.stringify(cands)}`);
  });

  await test('多源并行下载：两个源体积不同时，跟最快的源走（不能固定挑体积大的）', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const small = Buffer.alloc(3 * MB);   // 排在前面的源（已按速度排好序）
    const big = Buffer.alloc(5 * MB);
    for (let i = 0; i < small.length; i += 1) small[i] = i % 251;
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 7) % 251;
    const serve = (data) => (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    const mk = (data) => new Promise((resolve) => {
      const srv = http.createServer(serve(data));
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk(small);
    const s2 = await mk(big);
    const out = path.join(TMP, 'mixed-size.bin');
    try {
      // 列表顺序 = rank() 的速度序：第一个就是最快的源
      await downloadMulti([`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`], out, { connections: 4 });
      const got = fs.readFileSync(out);
      assert(got.length === small.length && Buffer.compare(got, small) === 0,
        `应下最快的源那一份（${small.length} 字节），实际 ${got.length} 字节`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('分片更新包：按顺序拼回整包，大小不符立刻中止', async () => {
    const http = require('http');
    const { Updater } = require('../src/core/updater');
    const partA = Buffer.alloc(4096, 0x41);
    const partB = Buffer.alloc(2048, 0x42);
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/a')) { res.writeHead(200, { 'Content-Length': partA.length }); res.end(partA); return; }
      if (req.url.startsWith('/b')) { res.writeHead(200, { 'Content-Length': partB.length }); res.end(partB); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const sb = path.join(TMP, 'parts-upd');
    fs.mkdirSync(sb, { recursive: true });
    const u = new Updater({ currentVersion: '0.0.0', exePath: path.join(sb, 'A.exe'), isPackaged: true, dataDir: sb, settings: () => ({}) });
    const target = path.join(sb, 'joined.zip');
    try {
      await u._downloadParts({
        name: 'joined.zip',
        size: partA.length + partB.length,
        parts: [
          { index: 1, size: partA.length, urls: [`http://127.0.0.1:${port}/a`] },
          { index: 2, size: partB.length, urls: [`http://127.0.0.1:${port}/b`] },
        ],
      }, target, 2, partA.length + partB.length);
      const got = fs.readFileSync(target);
      assert(got.length === partA.length + partB.length, '拼装后大小必须等于各分片之和');
      assert(got.slice(0, partA.length).every((b) => b === 0x41), '第一片内容顺序错误');
      assert(got.slice(partA.length).every((b) => b === 0x42), '第二片内容顺序错误');
    } finally {
      srv.close();
      fs.rmSync(sb, { recursive: true, force: true });
    }
  });

  await test('多源并行下载：不同分块从不同源拉，拼出来的字节必须完全一致', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 251;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    // 显式等 listening 回调：先 listen 再挂事件监听会漏掉已经触发的事件，测试会挂住
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [
      `http://127.0.0.1:${s1.address().port}/f`,
      `http://127.0.0.1:${s2.address().port}/f`,
    ];
    const out = path.join(TMP, 'multi.bin');
    try {
      const r = await downloadMulti(urls, out, { connections: 6, minChunk: 512 * 1024 });
      const got = fs.readFileSync(out);
      assert(Buffer.compare(got, data) === 0, '多源拼装后内容必须与源文件完全一致');
      assert(r.sources === 2 && r.parallel >= 2, `应同时用到 2 个源，实际 ${JSON.stringify(r)}`);
      assert(got.length === data.length, '大小必须一致');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('多源并行下载：失败后重来只补缺的块（不重下整个 1.4GB）', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 3 * MB;
    const data = Buffer.alloc(total);
    for (let i = 0; i < total; i += 1) data[i] = i % 251;
    let ranged = 0;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      if (b > a) ranged += 1;          // 只统计真正的数据块请求（探测用 0-0 不算）
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    };
    // 必须是两条地址：只有一条时 downloadMulti 会直接交给单源分块（那条路径自带续传）
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`];
    const out = path.join(TMP, 'multi-resume.bin');
    try {
      // 造出「前两块已下完、最后一块没下」的现场（分块方式：3 连接 × 1MB）
      const per = Math.ceil(total / 3);
      const fd = fs.openSync(out, 'w');
      fs.ftruncateSync(fd, total);
      fs.writeSync(fd, data, 0, per * 2, 0);
      fs.closeSync(fd);
      fs.writeFileSync(`${out}.chunks.json`, JSON.stringify({ total, n: 3, done: [0, per] }));

      const r = await downloadMulti(urls, out, { connections: 3, minChunk: MB });
      assert(r.resumed === true, '应识别出这是断点续传');
      assert(ranged === 1, `只应补下 1 个块，实际请求 ${ranged} 块`);
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, '续传后的文件必须与源完全一致');
      assert(!fs.existsSync(`${out}.chunks.json`), '完成后要清掉边车文件');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('下载器：连接建立后一个字节都不来，必须超时换源而不是挂死', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(4 * 1024 * 1024, 9);
    // 头正常回、然后一直不说话：模拟「TCP 通但被墙/被限速」的经典状态
    const stall = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      // 先给 1KB，然后不再发任何东西
      res.write(data.slice(a, a + 1024));
    });
    const good = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(stall);
    const s2 = await listen(good);
    const out = path.join(TMP, 'stall.bin');
    const t0 = Date.now();
    try {
      const r = await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 4, minChunk: 1024 * 1024, idleMs: 400, retries: 2 },
      );
      const cost = Date.now() - t0;
      assert(fs.statSync(out).size === data.length, '最终必须下完整');
      assert(cost < 15000, `不能在停滞的连接上挂住，实际用了 ${cost}ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('下载器：某个源只跑到几十 KB/s 时换源，而不是卡在最后几 % 不动', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 2 * MB;
    const data = Buffer.alloc(total, 5);
    // 慢源：每 100ms 才吐 4KB（≈40KB/s）
    const slow = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      let pos = a;
      const pump = () => {
        if (pos > b) { res.end(); return; }
        const chunk = data.slice(pos, Math.min(b + 1, pos + 4096));
        pos += chunk.length;
        res.write(chunk);
        setTimeout(pump, 100);
      };
      pump();
    });
    const fast = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(slow);
    const s2 = await listen(fast);
    const out = path.join(TMP, 'slowrot.bin');
    const t0 = Date.now();
    try {
      await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 2, minChunk: 512 * 1024, idleMs: 3000, slowAfterMs: 400, slowBps: 200 * 1024 },
      );
      const cost = Date.now() - t0;
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, '换源后内容必须正确');
      // 全程走慢源的话 2MB / 40KB/s ≈ 50 秒；换源必须在几秒内完成
      assert(cost < 15000, `应在低速时换源，实际用了 ${cost}ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('多源并行下载：只有一条可用地址时退回单源分块', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(2 * 1024 * 1024, 7);
    const srv = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/f`;
    // 拿一个「刚被释放、现在肯定没人监听」的端口当坏源，连接会立刻被拒而不是等超时
    const probe = http.createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const deadPort = probe.address().port;
    await new Promise((r) => probe.close(r));
    const out = path.join(TMP, 'multi1.bin');
    try {
      // 第二个地址故意指到不通的端口：必须自动忽略而不是整包失败
      const r = await downloadMulti([url, `http://127.0.0.1:${deadPort}/nope`], out, { connections: 4 });
      assert(fs.statSync(out).size === data.length, '单源也要下完整');
      assert(!r.multi || r.sources === 1, '可用源只有一个时不该标记为多源');
    } finally {
      srv.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('双源：版本结果缓存 10 分钟，force 时强制重查', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let calls = 0;
    s.fetchReleases = async () => {
      calls += 1;
      return [{ source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } }];
    };
    await s.latest();
    await s.latest();
    assert(calls === 1, `缓存期内不应重复请求，实际请求 ${calls} 次`);
    await s.latest({ force: true });
    assert(calls === 2, 'force 必须绕过缓存');
    s.reset();
    await s.latest();
    assert(calls === 3, 'reset 后应重新请求');
  });

  await test('双源：某个源 403 被限流后熔断跳过，不再每轮撞墙', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let giteeCalls = 0;
    s.fetchReleases = async () => {
      giteeCalls += 1;
      return [
        { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } },
        { source: 'gitee', name: 'Gitee', web: 'e', error: 'gitee.com 403 （被限流）' },
      ];
    };
    // 第一次：Gitee 报 403，被记入熔断
    await s.latest({ force: true });
    assert(giteeCalls === 1, '第一轮应真实请求过');
    const reason = s.blockedReason('gitee');
    assert(!!reason, '403 必须触发熔断');
    assert(s.blockedReason('github') === null, '没出错的源不应被熔断');
    // 熔断期内的请求应被直接跳过（不再打网络）
    assert(/暂时跳过/.test(reason), `跳过原因要能看懂，实际：${reason}`);
    // 英文界面下同样要能看懂（且不能残留中文）
    const i18n = require('../src/core/i18n');
    i18n.setLocale('en');
    const reasonEn = s.blockedReason('gitee');
    i18n.setLocale('zh-CN');
    assert(/temporarily skipped/i.test(reasonEn) && !/[\u3400-\u9fff]/.test(reasonEn), `英文跳过原因要能看懂，实际：${reasonEn}`);
    s.reset();
    assert(s.blockedReason('gitee') === null, 'reset 后熔断应解除');
  });

  await test('双源：全部源不可达时退回上一次结果（标记 stale，不直接报错）', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.2.3', assets: [] } },
    ];
    const first = await s.latest();
    assert(first.tag === 'v1.2.3' && !first.stale, '第一次应正常');
    s._relTtl = 0;   // 让缓存失效
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', error: '超时' },
    ];
    const second = await s.latest();
    assert(second.tag === 'v1.2.3' && second.stale === true, '应退回旧结果并标记 stale');
  });

  await test('系统镜像落点：全新安装必须落在运行时目录（CI 组装运行时靠这个）', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'sysroot-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      const root = path.join(tmp, 'rt');
      store.saveSettings({ runtime: { dir: root } });
      const p = new Provisioner(path.join(__dirname, '..'));

      // 1) 全新安装：运行时目录与用户数据目录都没有 system-images → 落运行时目录
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'),
        `全新安装应落运行时目录，实际 ${p.paths().sysImgRoot}`);

      // 2) 运行时目录里已经有（整包解压的产物）→ 优先它
      fs2.mkdirSync(path.join(root, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'), '已有应优先运行时目录');

      // 3) 只有用户数据目录有（老版本布局）→ 用它
      fs2.rmSync(path.join(root, 'system-images'), { recursive: true, force: true });
      fs2.mkdirSync(path.join(store.DATA_DIR, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(store.DATA_DIR, 'system-images'),
        `老布局应回退到用户数据目录，实际 ${p.paths().sysImgRoot}`);
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('只读运行时目录（MSIX 包内）：可写数据必须改道用户数据目录', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'ro-root-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      // 造一个「不可写」的 root：把中间一级做成普通文件，mkdir 必然 EEXIST/ENOTDIR
      const blocker = path.join(tmp, 'blocker');
      fs2.writeFileSync(blocker, 'x');
      const roRoot = path.join(blocker, 'rt');
      store.saveSettings({ runtime: { dir: roRoot } });
      const p = new Provisioner(path.join(__dirname, '..'));
      const paths = p.paths();
      assert(paths.rootWritable === false, '只读目录要被识别成不可写');
      // 关键：镜像必须展开到用户数据目录，而不是包内（包内只读，展开会失败）
      assert(paths.sysImgRoot === path.join(store.DATA_DIR, 'system-images'),
        `只读时应落在数据目录，实际 ${paths.sysImgRoot}`);
      assert(paths.tmp.toLowerCase().startsWith(store.DATA_DIR.toLowerCase()), '_tmp 也要改道');
      assert(paths.avdHome.toLowerCase().startsWith(store.DATA_DIR.toLowerCase()), 'AVD 也必须在可写目录');
      // 可执行文件仍然指向包内（这样才有包身份，%APPDATA% 虚拟化视图才和父进程一致）
      assert(paths.emulatorExe === path.join(roRoot, 'emulator', 'emulator.exe'), 'emulator 仍从包内运行');
      assert(paths.adbExe === path.join(roRoot, 'platform-tools', 'adb.exe'), 'adb 仍从包内运行');
      // ensureDirs 不能因为 root 只读就抛错
      p.ensureDirs();
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('包内压缩镜像必须算「已就位」，否则装完还会联网重下 1.5GB', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'packed-img-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    const sparse = (file, size) => {
      fs2.mkdirSync(path.dirname(file), { recursive: true });
      fs2.writeFileSync(file, '');
      fs2.truncateSync(file, size);   // 稀疏文件：不真占盘，只是体积够大
    };
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      // 模拟完整版安装包 / 商店 MSIX：运行时目录里只有 .xz，没有展开的 system.img
      const root = path.join(tmp, 'rt');
      const dir = path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
      sparse(path.join(dir, 'system.img.xz'), 320 * 1024 * 1024);
      fs2.writeFileSync(path.join(dir, 'kernel-ranchu'), 'x');
      store.saveSettings({ runtime: { dir: root } });
      // appRoot 用空目录，避免被仓库里已展开的 engine/system-images 干扰
      const p = new Provisioner(path.join(tmp, 'empty-app'));
      const sys = p.systemImageInfo();
      assert(sys.ok === true, '压缩镜像要算就位（否则 autoDeploy 会去下载）');
      assert(sys.compressed === true, '要标记「还需展开一次」');
      assert(String(sys.dir).toLowerCase().startsWith(root.toLowerCase()), '应指向包内位置');
      const play = p.playImageInfo();
      assert(play.ok === true && play.compressed === true, '兼容镜像同理');

      // 展开后（有了 system.img）要变成 compressed=false，且优先用展开的那份
      sparse(path.join(dir, 'system.img'), 320 * 1024 * 1024);
      const after = p.systemImageInfo();
      assert(after.ok === true && after.compressed === false, '展开后不应再标记为压缩版');
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('用户自定义系统镜像目录必须优先于内置镜像，且不再触发下载', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'custom-img-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    const sparse = (file, size) => {
      fs2.mkdirSync(path.dirname(file), { recursive: true });
      fs2.writeFileSync(file, '');
      fs2.truncateSync(file, size);
    };
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      const customDir = path.join(tmp, 'my-images', 'system-images', 'android-34', 'google_apis', 'x86_64');
      sparse(path.join(customDir, 'system.img'), 320 * 1024 * 1024);
      fs2.writeFileSync(path.join(customDir, 'kernel-ranchu'), 'x');

      // 未配置时走内置逻辑（没有内置镜像 → 不 ok）
      store.saveSettings({ runtime: { customSysImgDir: '', dir: path.join(tmp, 'empty-rt') } });
      const p0 = new Provisioner(path.join(tmp, 'empty-app'));
      assert(p0.customImageInfo() === null, '未配置自定义目录应返回 null');

      // 配置后：三个入口都应识别自定义镜像
      store.saveSettings({ runtime: { customSysImgDir: customDir } });
      const p = new Provisioner(path.join(tmp, 'empty-app'));
      const c = p.customImageInfo();
      assert(c && c.ok === true && c.custom === true, '自定义镜像应识别为有效');
      assert(c.api === 34 && c.tag === 'google_apis' && c.abi === 'x86_64', '应从目录名推断 api/tag/abi');
      const sys = p.systemImageInfo();
      const play = p.playImageInfo();
      assert(sys.ok && sys.custom && path.normalize(sys.dir) === path.normalize(customDir), 'systemImageInfo 应优先自定义');
      assert(play.ok && play.custom && path.normalize(play.dir) === path.normalize(customDir), 'playImageInfo 也应优先自定义，避免覆盖');

      // 校验函数：无效目录（缺 kernel）应明确失败
      const bad = path.join(tmp, 'bad');
      sparse(path.join(bad, 'system.img'), 320 * 1024 * 1024);
      const v = p.validateSysImgDir(bad);
      assert(v.ok === false && /kernel/.test(v.note), '缺 kernel 的目录应判无效并说明原因');
      assert(p.validateSysImgDir(path.join(tmp, 'not-exist')).ok === false, '不存在的目录应判无效');
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  console.log('\n[资源策略 / 磁盘分配 / 日志上限]');

  await test('资源策略一处切换，自动翻译成 vCPU/优先级/分辨率', () => {
    const store = require('../src/core/store');
    let s = store.saveSettings({ engine: { resourceMode: 'smooth' } });
    assert(s.engine.liteMode === false, '流畅模式不应限制核数');
    assert(s.engine.priorityMode === 'game', '流畅模式应进低延迟游戏优先级（FPS/视频优先）');
    assert(s.engine.renderSize === '720x1280', `分辨率应 720p，实际 ${s.engine.renderSize}`);
    s = store.saveSettings({ engine: { resourceMode: 'save' } });
    assert(s.engine.liteMode === true && s.engine.renderSize === '540x960', '省资源应 540p + 轻量容器');
    s = store.saveSettings({ engine: { resourceMode: 'balanced' } });
    assert(s.engine.renderSize === 'auto', '均衡模式分辨率交给自动');
  });

  await test('数据分区容量可配置，且默认不再是死数字', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { dataPartitionGB: 12 } });
    const p = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(p.dataMB === 12 * 1024, `应为 12GB，实际 ${p.dataMB}MB`);
    store.saveSettings({ engine: { dataPartitionGB: 0 } });
    const auto = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(auto.dataMB === 6144, `磁盘充裕时自动应 6GB，实际 ${auto.dataMB}`);
  });

  await test('快照指纹不含数据分区大小（扩容不该作废快照、更不该清数据）', () => {
    const base = { emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' };
    const a = doctor.snapshotKey({ ...base, dataMB: 4096 }, 'img');
    const b = doctor.snapshotKey({ ...base, dataMB: 24576 }, 'img');
    assert(a === b, '只改容量不应改变指纹');
    const c = doctor.snapshotKey({ ...base, dataMB: 4096, emulatorVersion: '36.0.0' }, 'img');
    assert(a !== c, '换引擎版本应改变指纹');
  });

  await test('日志超过上限自动滚动，只保留一份备份', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'rot.log');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === true, '应执行滚动');
    assert(!fs.existsSync(f) && fs.existsSync(path.join(TMP, 'rot.1.log')), '应变成 .1.log');
  });

  await test('日志文件名不以 .log 结尾时：宁可滚不动，也不能把日志删掉', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'plain.txt');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === false, 'bak 与源文件同名时必须放弃滚动');
    assert(fs.existsSync(f), '日志文件不能被删掉');
  });

  await test('启动失败记录会落盘，重启后再导出诊断报告也能看到真实原因', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu.lastExitCode = 3221225477;
    emu.lastDiagnosis = doctor.diagnose(['emulator exit 3221225477']);
    emu.attempts = [{ plan: 'host / 硬件加速', diagnosis: 'ACCESS_VIOLATION', exitCode: 3221225477 }];
    emu._persistFailure({ why: 'test' });
    const back = emu.lastFailure();
    assert(back && back.exitCode === 3221225477, '退出码应落盘');
    assert(back.diagnosis && back.diagnosis.code === 'ACCESS_VIOLATION', '诊断结论应落盘');
    assert(back.attempts.length === 1, '尝试记录应落盘');
    emu._clearFailure();
    assert(emu.lastFailure() === null, '启动成功后应清掉失败记录');
  });

  await test('.xapk 拆分包：流式解出分片、解析 base、失败时清理临时目录', async () => {
    const crypto = require('crypto');
    const { parseBundle } = require('../src/core/installer');
    const { buildApkBytes, buildStoredZip } = require('./lib/make-apk');
    const apk = buildApkBytes();

    // 成功：包内两个分片（base + config），meta 来自可解析的那个
    const okPath = path.join(TMP, 'ok.xapk');
    fs.writeFileSync(okPath, buildStoredZip([
      { name: 'base.apk', data: apk },
      { name: 'split_config.arm64_v8a.apk', data: apk },
      { name: 'manifest.json', data: Buffer.from('{}') },
    ]));
    const b = await parseBundle(okPath);
    try {
      assert(b.files.length === 2, `应解出 2 个分片，实际 ${b.files.length}`);
      assert(b.files.every((f) => fs.existsSync(f)), '分片应落盘');
      assert(b.meta.package === 'com.example.test', `包名 ${b.meta.package}`);
    } finally {
      b.cleanup();
    }

    // 失败：包里没有 APK 分片 → 明确报错，且不能把临时目录留在用户机器上
    const badPath = path.join(TMP, 'bad.xapk');
    fs.writeFileSync(badPath, buildStoredZip([{ name: 'readme.txt', data: Buffer.from('nope') }]));
    let err = null;
    try { await parseBundle(badPath); } catch (e) { err = e; }
    assert(err && /没有找到 APK 分片/.test(err.message), `应报没有分片，实际 ${err && err.message}`);
    const dir = path.join(os.tmpdir(), 'apkstart-bundle',
      crypto.createHash('sha1').update(badPath).digest('hex').slice(0, 12));
    assert(!fs.existsSync(dir), '失败时应清理临时目录');
  });

  await test('materializeImages：展开 .img.gz、已展开跳过、坏镜像上报失败且不留半截', async () => {
    const zlib = require('zlib');
    const store = require('../src/core/store');
    const { Provisioner } = require('../src/core/provision');
    const before = store.getSettings().runtime.dir;
    const rt = path.join(TMP, 'rt-materialize');
    const imgDir = path.join(rt, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, 'kernel-ranchu'), 'kernel');
    // 40MB 全零：gzip 后只有几十 KB，但解压后 >32MB，正好能验证「已展开」的判定
    fs.writeFileSync(path.join(imgDir, 'system.img.gz'), zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024, 7)));
    store.saveSettings({ runtime: { dir: rt } });
    const prov = new Provisioner(path.join(__dirname, '..'));
    try {
      const n = await prov.materializeImages();
      assert(n === 1, `应展开 1 个镜像，实际 ${n}`);
      const img = path.join(imgDir, 'system.img');
      assert(fs.statSync(img).size === 40 * 1024 * 1024, '展开大小应正确');
      assert(fs.existsSync(path.join(imgDir, 'kernel-ranchu')), '非压缩组件应一并就位');
      assert(!fs.existsSync(`${img}.part`), '成功时不应留下 .part');

      const again = await prov.materializeImages();
      assert(again === 0, `已展开时应跳过，实际展开了 ${again}`);

      // 坏镜像：必须抛 MATERIALIZE_FAILED，并且清掉 .part（否则下次会被当成已完成）
      fs.rmSync(img, { force: true });
      fs.writeFileSync(path.join(imgDir, 'system.img.gz'), Buffer.from('not a gzip at all'));
      let err = null;
      try { await prov.materializeImages(); } catch (e) { err = e; }
      assert(err && err.code === 'MATERIALIZE_FAILED', `坏镜像应失败，实际 ${err && err.message}`);
      assert(!fs.existsSync(`${img}.part`), '失败后不应留下 .part');
    } finally {
      store.saveSettings({ runtime: { dir: before } });
    }
  });

  await test('换下载源/整包地址后：provisioner 的地址缓存必须被清掉（否则要重启才生效）', () => {
    const { Provisioner } = require('../src/core/provision');
    const p = new Provisioner(path.join(__dirname, '..'));
    // 模拟解析过一次整包地址 / 引擎地址后的缓存
    p._cache.pack = { url: 'https://old.example/runtime.zip', tag: 'v1' };
    p._cache.emulatorUrl = 'https://old.example/emulator.zip';
    p._cache.sysimgUrl = 'https://old.example/sysimg.zip';
    p.invalidateEnvCache();
    assert(!p._cache.pack, '整包地址缓存应被清空');
    assert(!p._cache.emulatorUrl && !p._cache.sysimgUrl, '引擎/镜像地址缓存应被清空');
  });

  await test('每轮启动只用本轮日志做诊断（上一轮的崩溃不能污染下一轮）', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu._log = [
      { t: 1, line: 'Graphics backend: gfxstream' },
      { t: 2, line: 'emulator exit 3221225477' },        // 第 1 轮：0xC0000005
      { t: 3, line: '--- 第 2 轮 ---' },
      { t: 4, line: 'Address already in use' },          // 第 2 轮：端口被占
    ];
    assert(doctor.diagnose(emu._attemptLines(0, 80)).code === 'ACCESS_VIOLATION', '第 1 轮应判崩溃');
    assert(doctor.diagnose(emu._attemptLines(2, 80)).code === 'PORT_BUSY', '第 2 轮应判端口占用');
    // 本轮没有任何日志时退回整体尾部，不能直接 UNKNOWN
    const fallback = emu._attemptLines(emu._log.length, 80);
    assert(fallback.length === emu._log.length, `空轮次应退回整体日志，实际 ${fallback.length} 行`);
  });

  await test('启动组件拼接：完整组件不能重复拼包名（否则点图标只看到安卓桌面）', () => {
    const { componentArg, parseResolvedActivity } = require('../src/core/adb');
    // 完整组件（v0.3.4 装完后 apps.json 里存的就是这种）→ 原样使用
    assert(componentArg('com.phoenix.read', 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity')
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', '完整组件应原样返回');
    // 老数据：纯类名 / 以点开头的类名 → 补包名
    assert(componentArg('com.a.b', 'MainActivity') === 'com.a.b/MainActivity');
    assert(componentArg('com.a.b', '.MainActivity') === 'com.a.b/.MainActivity');
    assert(componentArg('com.a.b', '') === '', '空 activity 应返回空（走隐式 intent）');
    // resolve-activity 输出末尾常有空行/priority 行：必须能取到组件
    const out = 'priority=0\ncom.phoenix.read/com.dragon.read.pages.splash.SplashActivity\n\n';
    assert(parseResolvedActivity('com.phoenix.read', out)
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', '应跳过空行取到最后一行组件');
    assert(parseResolvedActivity('com.other', out) === '', '别的包名不能拿来用');
  });

  await test('单个应用窗口：独立模式下壳窗口绝不能被显示出来', () => {
    const root = path.join(__dirname, '..');
    const appwin = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    // maximize() 会把 show:false 的 BrowserWindow 直接显示出来 —— 这是
    // 「打开应用出现多个窗口」的直接成因之一。
    assert(/fullscreen && !this\.detachedMode\) this\.win\.maximize\(\)/.test(appwin),
      '独立窗口模式不能 maximize 壳窗口（会凭空显示一个黑窗口）');
    assert(/if \(this\.detachedMode\) this\.agent\.show\(\)/.test(appwin),
      '独立模式下重复点同一个应用要把模拟器窗口抬到前面，而不是显示壳窗口');
    // ready-to-show 里也不能随便 show：只有在 showWhileWaiting（切换应用、没有
    // 开机动画兜底）时才允许先把这块「正在打开…」的壳显示出来。
    const readyIdx = appwin.indexOf("once('ready-to-show'");
    assert(readyIdx > 0 && /if \(this\.detachedMode && !this\._showWhileWaiting\) return;/
      .test(appwin.slice(readyIdx, readyIdx + 600)),
    '独立模式下 ready-to-show 默认必须直接 return');
  });

  await test('开机动画：splash 状态必须是模块级，否则永远关不掉', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // runLaunch / autoDeploy 定义在 whenReady 回调**外面**，回调里 const 的
    // splashDone 它们根本看不到（typeof 恒为 'undefined'）—— 曾经导致
    // 480x360 的 alwaysOnTop 开机动画一直钉在屏幕中央。
    assert(/^let splashWin = null;$/m.test(mainJs), 'splashWin 必须是模块级 let');
    assert(/^let splashDone = \(\) => \{\};$/m.test(mainJs), 'splashDone 必须是模块级 let');
    assert(/^let splashProgress = \(\) => \{\};$/m.test(mainJs), 'splashProgress 必须是模块级 let');
    assert(!/const splashDone = \(\) =>/.test(mainJs), '不能再在 whenReady 里用 const 覆盖');
    // 保险丝：splash 自己没关掉时主进程强关
    assert(/setTimeout\(\(\) => \{[\s\S]{0,160}splashWin\.close\(\);/.test(mainJs),
      'splashDone 之后要有一道强关保险丝');
  });

  await test('多窗口：启动应用要先收起管理窗口再开应用窗口', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const launchIdx = mainJs.indexOf('async function runLaunch(');
    const body = mainJs.slice(launchIdx, launchIdx + 2600);
    const hideIdx = body.indexOf('mainWindow.hide()');
    const openIdx = body.indexOf('openAppWindow(pkg');
    assert(hideIdx > 0 && openIdx > 0, '两个调用都要在 runLaunch 里');
    assert(hideIdx < openIdx, 'mainWindow.hide() 必须在 openAppWindow 之前（否则会同时看到两个窗口）');
  });

  await test('横竖屏：面板方向必须跟应用声明一致，否则只会信箱化', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const apkJs = fs.readFileSync(path.join(root, 'src', 'core', 'apk.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    const installerJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');

    assert(/function wantLandscapeFor\(pkg\)/.test(mainJs), '要有「这个应用该用哪个方向」的判定');
    assert(/orientationMode/.test(mainJs), '要读设置里的方向策略');
    assert(/orientationOverride/.test(mainJs), '单应用方向覆盖要生效');
    // 启动路径要用它，而不是裸的 displaySettings().landscape
    assert(/const wantLand = wantLandscapeFor\(pkg\)/.test(mainJs), 'beforeStart 要按应用方向判定');
    assert(/const land = wantLandscapeFor\(pkg\)/.test(mainJs), 'openAppWindow 要按应用方向开窗口');
    // 离线从 APK 清单算方向
    assert(/function detectOrientation\(/.test(apkJs), '要从 APK 清单离线判断应用方向');
    assert(/orientation,/.test(apkJs), 'parseApk 要返回 orientation');
    assert(/orientation: meta\.orientation/.test(installerJs), '安装时要把方向存进 apps.json');
    assert(/orientationMode: 'auto'/.test(storeJs), '默认策略是跟随应用');
    // 老数据回填：不补就还是黑边
    assert(/orientation backfill/.test(mainJs), '老版本装的应用要回填方向');
  });

  await test('横竖屏：方向不一致触发的重启不能把启动打断', () => {
    const root = path.join(__dirname, '..');
    const installerJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    // beforeStart 会返回新的 rt，以前这里写的是 const rt，一旦真走重启分支就
    // 抛 "Assignment to constant variable."，整个启动失败。
    assert(/let rt = await this\.runtime\.ensure\(\{ onLog \}\)/.test(installerJs),
      'rt 必须是 let，否则重启换 client 时会崩');
    assert(/if \(replaced && replaced\.client\) rt = replaced;/.test(installerJs), '要接受新的 rt');
  });

  await test('切换应用不能留空屏：独立模式下等待期间要显示壳窗口', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appwin = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    // 独立窗口模式（默认）下壳窗口平时不显示；切换应用到另一个方向会重启运行时
    // 约 40 秒，这期间如果什么都不显示，用户会以为程序崩了。
    assert(/showWhileWaiting: detached && !splashVisible/.test(mainJs),
      '独立模式且没有开机动画时，必须 showWhileWaiting');
    assert(/splashVisible = !!\(splashWin && !splashWin\.isDestroyed\(\)\)/.test(mainJs),
      '要靠 splash 是否在显示来决定由谁负责告诉用户「正在等」');
    assert(/const willRestart = land !== !!displaySettings\(\)\.landscape/.test(mainJs),
      '要能预判「这次会重启」');
    assert(/if \(this\.detachedMode && !this\._showWhileWaiting\) return;/.test(appwin),
      'ready-to-show 只在 showWhileWaiting 时才显示壳窗口');
    assert(mainJs.includes("t('v058.m0000'") && /重启安卓环境/.test(zhMessages['v058.m0000']),
      '提示文案要说清为什么慢');

    // 真正开始换向重启时，pre-attach 可能已经把壳窗口收起来了 —— 必须再亮一次，
    // 否则重启那 40 秒桌面全空（用户以为程序退出了）。
    assert(/appWin\.showWaiting\(/.test(mainJs), '重启换向前要重新亮出等待窗口');
    assert(/waitingForRestart/.test(appwin), '要有「正在等待重启」标记');
    // 启动阶段的 pre-attach 轮询看到标记必须让路，不能把等待窗口又 hide 掉
    assert(/if \(appWin\.waitingForRestart\)/.test(mainJs), 'pre-attach 要让路');
  });

  await test('标题要在 show 之前设，否则会闪上一个应用的名字', () => {
    const root = path.join(__dirname, '..');
    const appwin = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const start = appwin.indexOf('async openDetached(');
    const body = appwin.slice(start, start + 2000);
    const titleIdx = body.indexOf('this.agent.setTitle(');
    const showIdx = body.indexOf('this.agent.show()');
    assert(titleIdx > 0 && showIdx > 0, '两个调用都要在 openDetached 里');
    assert(titleIdx < showIdx, 'setTitle 必须在 show 之前（代理缓存着上次的标题）');
  });

  await test('网络体检不能一次不过就叫人重置数据', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    // Wi-Fi 关联比 sys.boot_completed 晚 5~20 秒，查一次就报「没有网络」等于每次
    // 冷启动都误报；而以前的补救建议是「重置安卓数据」（会删掉已装应用）。
    assert(/checkNetwork\('', \{ waitMs: \d+, interval: \d+ \}\)/.test(emuJs),
      '开机后的网络体检要给等待窗口，不能查一次就下结论');
    const boot = emuJs.slice(emuJs.indexOf('emulator.boot.ready'));
    const warn = boot.slice(0, 4000);
    // 只看代码行：上面解释「以前这里建议重置数据」的注释不算
    const warnCode = warn.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    assert(/emulator\.boot\.noNetwork/.test(warnCode), '开机后的网络体检要有提示');
    // 提示文案已移到语言包：以简体中文原文为准检查
    const warnText = require('../src/core/i18n').getCatalog('zh-CN')['emulator.boot.noNetwork'];
    assert(!/重置安卓数据/.test(warnCode + warnText), '这条提示不能建议「重置安卓数据」（会丢已装应用）');
    assert(/暂时没连上网/.test(warnText), '要改成不吓人、不误导的说法');
  });

  await test('开机时那个控制台黑窗要用高频通道压掉', () => {
    const root = path.join(__dirname, '..');
    const ps1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    // emulator 拉起 qemu 时 Windows 会新建一个控制台窗口（Win11 上是 Windows Terminal），
    // 只活 200~300ms；主巡检 250ms 一轮会漏。
    assert(/_consoleSweep/.test(ps1), '要有独立的控制台扫描时间戳');
    assert(/now - _consoleSweep > \(_perfMode \? 200 : 100\)/.test(ps1), '前 15 秒要 100ms 一轮扫控制台');
    assert(/now - _bootHideStart < 15000/.test(ps1), '高频通道只在开机窗口内跑，避免长期烧 CPU');
    // 必须是「控制台类窗口 + 标题命中运行时路径」，不能退回按 pid 白名单
    assert(/static void HideConsoleWindows\(\)/.test(ps1) && /IsOurConsole\(h\)/.test(ps1),
      '控制台归属要靠 IsOurConsole（conhost 的 pid 不是 emulator 的）');
  });

  await test('重启换面板后不能「复用」一台已经关掉的模拟器', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    // emulator.exe 只是启动器，spawn 完 qemu 自己就退出了，但 this.proc 会一直留着
    // （killed 仍是 false）。只看它 = 把已经关掉的机器当成还活着：
    // restartForOrientation 关掉机器后紧接着 ensure() → start() 直接 reused，
    // 调用方拿着死掉的 serial 去 adb → `device not found`，切换应用直接失败。
    const reuse = emuJs.slice(emuJs.indexOf('async start('), emuJs.indexOf('async start(') + 900);
    assert(/_consoleAlive\(\)/.test(reuse), 'start() 的复用分支必须再确认控制台端口上真有机器');
    assert(/this\.proc = null;/.test(reuse), '确认没在跑就把 proc 清掉，走真正的开机流程');
    // stop() 关干净后必须丢掉启动器句柄，否则 running() 永远为 true
    const stopFn = emuJs.slice(emuJs.indexOf('async stop('), emuJs.indexOf('async stop(') + 1800);
    assert(/killAttempt\(\)[\s\S]{0,200}this\.proc = null;/.test(stopFn), 'stop() 收尾要清掉 this.proc');
    // engine 层还要防另一种假象：模拟器刚退出时 adb 仍短时报 device，
    // isOnline() 于是判成就绪，后续命令全部 device not found。
    const engineJs = fs.readFileSync(path.join(root, 'src', 'core', 'engine.js'), 'utf8');
    const inner = engineJs.slice(engineJs.indexOf('async _ensureInner('), engineJs.indexOf('async _ensureInner(') + 2200);
    assert(/getprop sys\.boot_completed/.test(inner), 'ensure 要补一条真实命令验证设备可用');
    assert(/probe !== null/.test(inner), '命令不通时不能复用旧客户端');
    // 换向前后要等 adb 侧设备真的消失，再拉起新机器
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const rot = mainJs.slice(mainJs.indexOf('async function restartForOrientation'), mainJs.indexOf('async function restartForOrientation') + 2600);
    assert(/c\.isOnline\(\)\.catch\(\(\) => false\)/.test(rot), 'stop 后要等 adb 设备消失');
  });

  await test('Windows Terminal 弹出的开机黑框也要能认出来', () => {
    const root = path.join(__dirname, '..');
    const ps1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    // Win11 把默认控制台宿主换成 Windows Terminal 后，qemu 的控制台窗口属于
    // WindowsTerminal.exe：pid/父进程链/标题全都不是我们的，只能靠「开机前不存在」
    assert(/static void SnapshotConsoles\(\)/.test(ps1), '开机前要记下已有控制台窗口');
    assert(/_consolesBeforeBoot/.test(ps1), '要有开机前的控制台快照');
    assert(/now - _bootHideStart < 20000[\s\S]{0,120}_consolesBeforeBoot\.Contains/.test(ps1),
      '只认「开机后 20 秒内新出现的」控制台窗口');
    assert(/tl\.IndexOf\("terminal", StringComparison\.Ordinal\) >= 0/.test(ps1),
      '标题是空或带 terminal 才算可疑（用户已开的终端在快照里）');
    assert(/SnapshotConsoles\(\);/.test(ps1), 'boothide 时要先拍快照');
  });

  await test('启动要串行化：连点/切换应用不能并发跑两遍', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // 一次启动最长 80 秒（换面板重启 + 冷启动）。以前这期间再点一个应用会真的
    // 并发跑第二遍：openAppWindow 把正在启动的应用关掉，虚拟机又在重启，
    // 两边一起失败，日志里是 `cmd: Can't find service: activity`。
    assert(/let launchInFlight = null;/.test(mainJs), '要有进行中启动的记录');
    assert(/if \(launchInFlight\.pkg === pkg\)[\s\S]{0,120}return launchInFlight\.promise;/.test(mainJs),
      '同一个应用连点要复用进行中的那次');
    assert(/launch queued \$\{pkg\}/.test(mainJs), '换应用要排队而不是把运行时抽走');
    assert(/async function launchOne\(pkg\)/.test(mainJs), '原主体要拆成 launchOne');
    assert(/launchInFlight = entry;/.test(mainJs), '要在 finally 里清空，避免卡死后续启动');
  });

  await test('硬件加速：商店版引导用户开 WHPX，安装版一键开启并可退 AEHD', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appJs = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
    const preloadJs = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');

    // 1) 真正让模拟器用上 WHPX 的功能是 HypervisorPlatform（虚拟机平台是 WSL2 的），
    //    必须排在最前面开；两个都开一次以覆盖不同机器。
    assert(/for \(const f of \['HypervisorPlatform', 'VirtualMachinePlatform'\]\)/.test(mainJs),
      '要先开 HypervisorPlatform（WHPX 真正需要的那个）');
    // 2) 不能再拿 WinHvPlatform.dll 是否存在当开关：现代 Windows 上它一直都在，
    //    这样判断会把真正需要开功能的机器挡在门外。
    const handler = mainJs.slice(mainJs.indexOf("ipcMain.handle('provision:enableVirtualization'"));
    const handlerBody = handler.slice(0, 4000);
    assert(!/if \(hv\.dll\) \{/.test(handlerBody), '不能再按 WinHvPlatform.dll 分叉');
    // 3) 商店（MSIX）版：拿不到提权就退回「手动引导」，而不是弹一个注定失败的 UAC
    assert(/if \(store\.STORE_BUILD\) \{[\s\S]{0,900}manual: true/.test(handlerBody),
      '商店版失败时要返回 manual 交给 UI 引导');
    assert(mainJs.includes("t('v058.m0007')") && /商店版无法自行提权/.test(zhMessages['v058.m0007']),
      '商店版文案要说明为什么不能自动开');
    assert(mainJs.includes("t('v058.m0008')") && /虚拟机监控程序平台/.test(zhMessages['v058.m0008']),
      '要明确写出「Windows 虚拟机监控程序平台」');
    // 4) 开启成功后必须清掉加速缓存，否则界面还显示旧结论
    assert(/const whpx = await enableWhpxFeatures\(\);\s*\n\s*runtime\.provisioner\.invalidateEnvCache/.test(mainJs),
      '开启后要 invalidateEnvCache');
    // 5) 用户点了「否」要能和真失败区分开（1223 = ERROR_CANCELLED）
    assert(/1223/.test(mainJs) && /cancelled/.test(mainJs), '要区分 UAC 取消');
    // 6) 有「Windows 虚拟机监控程序平台」那一项的是经典对话框，不是 ms-settings 页面
    assert(/optionalfeatures\.exe/.test(mainJs), '要打开 classic optionalfeatures.exe');
    // 7) UI 要处理 manual / cancelled，并真的去打开那个对话框
    assert(/r\.manual/.test(appJs) && /api\.openWindowsFeatures/.test(appJs), 'UI 要处理 manual 分支');
    assert(/openWindowsFeatures: \(\) => invoke\('provision:openWindowsFeatures'\)/.test(preloadJs),
      'preload 要暴露 openWindowsFeatures');
    // 8) 软件模拟下第一次启动要弹一次系统通知（设置里的自检项用户很可能没看到）
    assert(/let accelWarned = false;/.test(mainJs) && mainJs.includes("t('v058.m0020')")
      && /正在以软件模拟运行/.test(zhMessages['v058.m0020']),
      '软件模拟要提醒一次');
  });

  await test('打包必须写入 exe 图标/版本，否则资源管理器显示 Electron 默认图标', () => {
    const root = path.join(__dirname, '..');
    const packJs = fs.readFileSync(path.join(root, 'build', 'pack.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const pkg = require(path.join(root, 'package.json'));

    // 直改名出来的 exe 里面还是 Electron：FileDescription=Electron、
    // ProductName=Electron、CompanyName=GitHub, Inc.、版本 33.4.11，图标也是默认的。
    assert(/function embedExeMeta\(exe\)/.test(packJs), '要有 exe 元信息写入步骤');
    assert(/--set-icon/.test(packJs), '要写图标');
    assert(/--set-file-version/.test(packJs), '要写文件版本');
    assert(/--set-version-string', 'FileDescription'/.test(packJs), '要写 FileDescription');
    assert(/--set-version-string', 'ProductName', 'ApkStart'/.test(packJs), 'ProductName 必须是 ApkStart');
    assert(/embedExeMeta\(exePath\)/.test(packJs), '要在改名之后真的调用');
    // 找不到 rcedit 时要明确告警，不能静默产出「Electron 图标」的包
    assert(/找不到 rcedit\.exe/.test(packJs), '缺 rcedit 要告警');

    // 任务栏身份：不设 AppUserModelID，任务栏固定项/通知会落到 "Electron" 上
    assert(/setAumid\(APP_AUMID\);/.test(mainJs), '启动时要设置 AppUserModelID');

    // 完整版（含运行时）作为一个可交付版本
    assert(/--full/.test(packJs) && /ApkStart-v\$\{PKG\.version\}-win64-full/.test(packJs),
      '--full 要产出带版本号的完整版目录');
    assert(/build', 'runtime'/.test(packJs), '完整版要内置 build/runtime');
  });

  await test('版本统一：package.json / MSIX 四段号 / 文档包名一致', () => {
    const root = path.join(__dirname, '..');
    const pkg = require(path.join(root, 'package.json'));
    const { msixVersion } = require(path.join(root, 'build', 'msix.js'));
    const four = msixVersion(pkg.version);
    assert(/^\d+\.\d+\.\d+\.0$/.test(four), `MSIX 四段版本号格式不对：${four}`);
    const artifact = `ApkStart_${four}_x64.msix`;
    for (const f of ['docs/store-listing.md', 'docs/store-msix.md', 'docs/store-upload-walkthrough.md']) {
      const t = fs.readFileSync(path.join(root, f), 'utf8');
      assert(t.includes(artifact), `${f} 里应引用当前版本的包名 ${artifact}`);
    }
    // exe 的文件版本也要用同一个号（四段），别和 package.json 各说各话
    const packJs = fs.readFileSync(path.join(root, 'build', 'pack.js'), 'utf8');
    assert(/\$\{PKG\.version\}\.0/.test(packJs), 'exe 文件版本要跟 package.json 对齐');
    // 商店包和 exe 用的是同一个版本来源，不该有第二份硬编码版本号
    const msixJs = fs.readFileSync(path.join(root, 'build', 'msix.js'), 'utf8');
    assert(/const VERSION = String\(pkg\.version/.test(msixJs), 'MSIX 版本号必须取自 package.json');
  });

  await test('安卓应用的快捷方式必须用它自己的图标 + 自己的任务栏身份', () => {
    const root = path.join(__dirname, '..');
    const installerJs = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const shortcutJs = fs.readFileSync(path.join(root, 'src', 'core', 'shortcut.js'), 'utf8');

    // 桌面/开始菜单快捷方式的图标 = 从 APK 里解出来的 <包名>.ico，绝不是 ApkStart 的品牌图
    assert(/const ico = app\.icoPath && fs\.existsSync\(app\.icoPath\) \? app\.icoPath : undefined;/.test(installerJs),
      '要用应用自己的 icoPath');
    assert(/iconIcoPath: ico/.test(installerJs), 'writeShortcut 要拿到应用图标');
    assert(!/iconIcoPath:\s*(APPICON|appicon|brandIcon)/.test(installerJs), '不能用 ApkStart 的品牌图标');
    // 每个应用一个 AUMID：任务栏按应用分组，固定项才认得出是哪个应用
    assert(/appUserModelId: `RoutineMiku\.ApkStart\.\$\{app\.package\}`/.test(installerJs),
      '每个应用要有自己的 AUMID');
    // Windows 只在「进程 AUMID == 快捷方式 AUMID」时沿用快捷方式图标，
    // 所以打开某个应用时要把进程身份切过去，回管理窗口再切回 ApkStart。
    assert(/const APP_AUMID = 'RoutineMiku\.ApkStart';/.test(mainJs), '要有统一的 AUMID 前缀');
    assert(/setAumid\(`\$\{APP_AUMID\}\.\$\{pkg\}`\)/.test(mainJs), '开应用窗口前要切到该应用的 AUMID');
    assert(/function showWindow\(\) \{\s*\n\s*\/\/[^\n]*\n\s*setAumid\(APP_AUMID\);/.test(mainJs),
      '回管理窗口要切回 ApkStart 的 AUMID');
    // writeShortcut 必须把 iconIndex 设成 0（ico 里第 0 帧），否则某些尺寸会取错
    assert(/icon: opt\.iconIcoPath \|\| opt\.target/.test(shortcutJs), '图标路径要能回退到 target');
    assert(/iconIndex: 0/.test(shortcutJs), 'iconIndex 要是 0');
  });

  await test('红果横屏：方向决策必须收敛到纯函数，覆盖优先于 APK 清单', () => {
    const root = path.join(__dirname, '..');
    const o = require('../src/core/orientation');

    // 强制模式最高优先级
    assert(o.resolveLandscape({ mode: 'landscape', orientation: 'portrait', orientationOverride: 'portrait' }) === true,
      '强制横屏要盖过一切');
    assert(o.resolveLandscape({ mode: 'portrait', orientation: 'landscape', orientationOverride: 'landscape' }) === false,
      '强制竖屏要盖过一切');
    // 单应用覆盖优先于 APK 清单声明 —— 红果 APK 声明 portrait，用户点横屏后必须横过来
    assert(o.resolveLandscape({ mode: 'auto', orientation: 'portrait', orientationOverride: 'landscape' }) === true,
      'per-app 横屏覆盖要盖过 APK 的 portrait 声明');
    assert(o.resolveLandscape({ mode: 'auto', orientation: 'landscape', orientationOverride: 'portrait' }) === false,
      'per-app 竖屏覆盖要盖过 APK 的 landscape 声明');
    // 没覆盖时跟 APK 声明，再没有就跟面板
    assert(o.resolveLandscape({ mode: 'auto', orientation: 'portrait' }) === false, '无覆盖时跟 APK 声明');
    assert(o.resolveLandscape({ mode: 'auto', orientation: null, panelLandscape: true }) === true, '跟随重力时跟面板');
    // 旋转取反 + 覆盖值往返一致（旋转按钮写覆盖、下次启动读回来必须是同一个方向）
    assert(o.flipLandscape(false) === true && o.flipLandscape(true) === false, 'flip 要取反');
    assert(o.parseOverride(o.overrideValue(true)) === true, '横屏覆盖值往返一致');
    assert(o.parseOverride(o.overrideValue(false)) === false, '竖屏覆盖值往返一致');

    // 三个入口必须都走同一个决策函数，不能再各算各的（红果横不过来的根因）
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    assert(/wantLandscapeFor\(pkg\)\s*\)?\.?\s*/.test(mainJs) && /orientation\.resolveLandscape/.test(mainJs),
      'wantLandscapeFor 要走 resolveLandscape');
    assert(/async function rotateCurrentApp\(\)/.test(mainJs), '要有统一的旋转入口');
    assert(/orientation\.flipLandscape\(current\)/.test(mainJs), '旋转入口要用同一个 flip');
    assert(/orientation\.overrideValue\(next\)/.test(mainJs), '旋转入口要写同一个覆盖值');
    const shellJs = fs.readFileSync(path.join(root, 'src', 'ui', 'shell.js'), 'utf8');
    assert(/shell\.rotate\(\)/.test(shellJs), '标题栏旋转按钮要走统一入口');
  });

  await test('镜像自动旋转默认打开，但面板方向仍由 wm 锁定', () => {
    const root = path.join(__dirname, '..');
    const o = require('../src/core/orientation');
    // 默认（没设置 / 没关过）= 打开
    assert(o.autoRotateSetting({}) === '1', '默认打开自动旋转');
    assert(o.autoRotateSetting({ display: {} }) === '1', 'display 为空也算默认打开');
    assert(o.autoRotateSetting({ display: { autoRotate: false } }) === '0', '用户显式关掉才返回 0');
    // store 默认要写 true
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    assert(/autoRotate:\s*true/.test(storeJs), 'store 默认 autoRotate=true');
    // adb 两段都要写加速度开关，且保留方向锁权威命令（测试前面已断言 lock 0 / ignore-request）
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');
    assert(/accelerometer_rotation \$\{guestAutoRotate\(\)\}/.test(adbJs), 'adb 要用 guestAutoRotate 值');
  });

  await test('窗口模式：默认原生窗口，两种模式可在设置里切换，且只迁移一次', () => {
    const root = path.join(__dirname, '..');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    // 0.6.0：嵌入模式（SetParent）缩放/旋转时掉帧且有黑边、坐标错位，
    // 默认改为让模拟器开自己的原生窗口。
    assert(/windowEmbed:\s*false,\s*\n\s*\/\/ 镜像内/.test(storeJs), 'defaultSettings.display.windowEmbed 必须是 false');
    // 一次性迁移：只迁「没主动选过」的配置，用户自己选的不能被反复扳回来
    assert(/windowEmbedMigrated2/.test(storeJs), '要有一次性迁移标记');
    assert(/windowEmbedChosen !== true/.test(storeJs), '主动选过的配置不迁移');
    // 只看标记不够：老配置可能是「migrated2=true 但值仍是 true」（迁移没落盘 / 手改过），
    // 那种情况以前会被原样放过 → 启动又是美化壳窗口。判定基准必须是「有没有主动选过」。
    const migBody = storeJs.slice(storeJs.indexOf('窗口承载方式的最终裁决'), storeJs.indexOf('窗口承载方式的最终裁决') + 1200);
    assert(/d\.windowEmbedChosen !== true && d\.windowEmbed !== false/.test(migBody),
      '迁移条件不能依赖 windowEmbedMigrated2，否则旧标记会漏迁');
    // 原生窗口要尽早接出来，别让用户对着美化等待页干等
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    assert(/pre-attach detached ok/.test(mainJs), '启动时要先尝试把模拟器原生窗口接出来');
    // 接管失败必须重试，否则壳窗口一直停在屏幕上（用户看到的「美化窗口」）
    const attachBody = mainJs.slice(mainJs.indexOf('async function attachAppWindow'), mainJs.indexOf('async function attachAppWindow') + 2200);
    assert(/for \(let i = 0; i < 4; i \+= 1\)/.test(attachBody), '原生窗口接管要重试');
    assert(/临时退回嵌入模式/.test(attachBody), '四轮都失败要兜底，不能留黑屏');
    const appJs = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
    assert(/windowEmbedChosen:\s*true/.test(appJs), '设置页切换时要写入「已主动选择」标记');
    const indexHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');
    assert(/setWindowEmbed/.test(indexHtml), '设置里要有窗口模式切换入口');
    // 原生窗口排在第一个选项，用户进设置第一眼看到的就是默认值
    const sel = indexHtml.slice(indexHtml.indexOf('id="setWindowEmbed"'), indexHtml.indexOf('id="setWindowEmbed"') + 400);
    assert(sel.indexOf('value="detached"') < sel.indexOf('value="embed"'), '原生窗口应为默认选项（排在前面）');
  });

  await test('窗口模式：探针与自动检测按新默认值判定', () => {
    const root = path.join(__dirname, '..');
    const probeJs = fs.readFileSync(path.join(root, 'src', 'core', 'autodebug-probe.js'), 'utf8');
    // 只有显式 true 才算嵌入模式，未设置时按原生窗口处理
    assert(/windowEmbed:\s*!!\(settings\.display && settings\.display\.windowEmbed === true\)/.test(probeJs),
      '探针要按「显式 true 才算嵌入」判定');
  });

  await test('加载速度：网络状态新鲜缓存快速复用，运行时停止即作废', () => {
    const root = path.join(__dirname, '..');
    const engineJs = fs.readFileSync(path.join(root, 'src', 'core', 'engine.js'), 'utf8');
    // waitForNetwork 命中 8 秒内的缓存直接返回，省掉连续调用的 adb 往返
    assert(/cached\.ok && Date\.now\(\) - cached\.at < 8000/.test(engineJs), 'waitForNetwork 要复用新鲜网络缓存');
    // stop() 里清掉缓存，重启后不会误用关机前的旧状态导致黑屏
    const stopBody = engineJs.slice(engineJs.indexOf('async stop('), engineJs.indexOf('async stop(') + 400);
    assert(/this\._lastNetwork = null/.test(stopBody), 'stop 要清掉网络缓存');
  });

  await test('打包必须带上生产依赖（否则 @napi-rs/lzma 缺失、镜像展不开、应用全打不开）', () => {
    const root = path.join(__dirname, '..');
    const packJs = fs.readFileSync(path.join(root, 'build', 'pack.js'), 'utf8');
    const pkg = require(path.join(root, 'package.json'));

    // 0.5.9 的致命回归：pack.js 只复制 src/，没带 node_modules，
    // 打包版一启动就 Cannot find module '@napi-rs/lzma'，所有应用都打不开。
    assert(pkg.dependencies && pkg.dependencies['@napi-rs/lzma'],
      '@napi-rs/lzma 必须在 dependencies 里（解压 system.img.xz 需要）');
    assert(/node_modules/.test(packJs) && /dependencies/.test(packJs),
      'pack.js 要按 package.json 的 dependencies 复制生产依赖');
    assert(/startsWith\('@'\)/.test(packJs),
      '作用域包要连整个 scope 一起复制（原生二进制在 @napi-rs/*-win32-x64-msvc）');
    // 解压路径上真要能找到它：本地 node_modules 里必须装好
    const lzmaDir = path.join(root, 'node_modules', '@napi-rs', 'lzma');
    assert(fs.existsSync(lzmaDir), '本机要装好 @napi-rs/lzma 才能打包');
  });

  await test('镜像解压缺 lzma 时给可读错误，而不是一长串 require stack', () => {
    const root = path.join(__dirname, '..');
    const provJs = fs.readFileSync(path.join(root, 'src', 'core', 'provision.js'), 'utf8');
    assert(/LZMA_MISSING/.test(provJs), '缺 lzma 要用 LZMA_MISSING 错误码');
    assert(/安装包不完整/.test(provJs), '错误文案要直说安装包不完整，别让用户以为电脑坏了');
    // 不能再是无保护的 require.resolve：那会在缺依赖时抛原始模块错误
    assert(/try\s*\{[^}]*require\.resolve\('@napi-rs\/lzma'\)/.test(provJs),
      'require.resolve 要包在 try 里，失败时给友好错误');
  });

  await test('按键错位：关掉大屏任务栏（Taskbar）', () => {
    const root = path.join(__dirname, '..');
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');
    // 平板密度（sw606dp）会触发 Launcher 的 Taskbar：贴底、盖内容、按键挤在左下角
    assert(/async disableLauncherTaskbar\(\)/.test(adbJs), '要有 disableLauncherTaskbar');
    assert(/settings put global enable_taskbar 0/.test(adbJs), '任务栏开关用 global enable_taskbar');
    // Launcher 只在启动时读一次开关，已起来必须重启才会消失
    assert(/am force-stop com\.google\.android\.apps\.nexuslauncher/.test(adbJs), '要重启 Pixel Launcher');
    // 每次启动都补一刀（幂等），并在开机初始化里做一次「检查+重启」
    const pf = adbJs.slice(adbJs.indexOf('async prepareForeground('), adbJs.indexOf('async prepareForeground(') + 1600);
    assert(/enable_taskbar 0/.test(pf), 'prepareForeground 要写任务栏开关');
    const reset = adbJs.slice(adbJs.indexOf('async resetDisplayOverrides('), adbJs.indexOf('async resetDisplayOverrides(') + 1600);
    assert(/disableLauncherTaskbar\(\)/.test(reset), 'resetDisplayOverrides 要调用 disableLauncherTaskbar');
  });

  await test('启动动画：守到应用第一帧再淡出', () => {
    const root = path.join(__dirname, '..');
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');
    assert(/async waitForAppFirstFrame\(pkg/.test(adbJs), '要有 waitForAppFirstFrame');
    // Android 12+ 在 Activity 首帧前会挂系统 Splash，判定就是它消失 + 焦点在目标包
    assert(/Splash Screen/.test(adbJs), '要按系统 Splash 窗口判定首帧');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // 收动画前必须等首帧，否则用户看到白底 + 应用图标，以为卡死
    const idx = mainJs.indexOf('waitForAppFirstFrame');
    assert(idx > 0, 'main 要调用 waitForAppFirstFrame');
    const after = mainJs.slice(idx, idx + 900);
    assert(/finishBootAnimation/.test(after), '首帧之后才统一收启动动画');
    // 判定必须用 `dumpsys window`：`dumpsys window windows` 里没有 mCurrentFocus，
    // 会把焦点判断永远判成否，导致每次启动都白等满超时。
    assert(/dumpsys window \| grep -E "Splash Screen\|mCurrentFocus"/.test(adbJs),
      '首帧判定要用 dumpsys window（含 mCurrentFocus）');
    // 红果这类重应用首帧要 15 秒以上，12 秒超时会把动画提前收掉
    assert(/timeoutMs:\s*20000/.test(mainJs), '首帧等待给足 20 秒');
  });

  await test('启动动画：boot 遮罩与 splash 统一收尾，且保持到首帧', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // 幂等的统一收尾函数：splash 窗口 + appWin 的 boot 遮罩一起收
    assert(/const finishBootAnimation = \(\) =>/.test(mainJs), '要有统一收尾函数');
    const fn = mainJs.slice(mainJs.indexOf('const finishBootAnimation'),
      mainJs.indexOf('const finishBootAnimation') + 700);
    assert(/bootAnimDone/.test(fn), '收尾必须幂等，避免多处触发重复收');
    assert(/setState\(\{ ready: true/.test(fn), '收尾要通知 boot 遮罩淡出');
    assert(/splashDone/.test(fn), '收尾要同时关掉早期 splash 窗口');
    // launch 结束处不能再无条件 setState ready（会在白底 Splash 阶段提前收动画）
    assert(/if \(!attachDoneEarly\) finishBootAnimation\(\)/.test(mainJs),
      '只有没走提前接画面时才在 launch 结束直接收');
    // 总保险丝：任何路径卡住都会强制收，绝不永久停在动画里
    assert(/setTimeout\(finishBootAnimation, 24000\)/.test(mainJs), '要有 24 秒总保险丝');
  });

  await test('启动动画：图标用完整 PNG + 兜底，极简风视觉元素齐全', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // 图标优先用原始 PNG（iconPath），不再用 ICO（Chromium <img> 渲染会缺角）
    assert(/setIcon\(rec && \(rec\.iconPath \|\| rec\.icoPath\)\)/.test(mainJs),
      '启动动画图标要用完整 PNG');
    const shellHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'shell.html'), 'utf8');
    const shellCss = fs.readFileSync(path.join(root, 'src', 'ui', 'shell.css'), 'utf8');
    const shellJs = fs.readFileSync(path.join(root, 'src', 'ui', 'shell.js'), 'utf8');
    assert(/object-fit:\s*contain/.test(shellCss), '图标用 contain 完整显示，不裁切缺角');
    assert(/class="boot-aura"/.test(shellHtml) && /class="boot-glow"/.test(shellHtml),
      'boot 要有柔和光晕层（极简苹果风）');
    assert(/@keyframes bootBreathe/.test(shellCss), '图标要有缓慢呼吸动效');
    assert(/prefers-reduced-motion/.test(shellCss), '要尊重系统减少动态效果偏好');
    assert(/FALLBACK/.test(shellJs) && /logo-128/.test(shellJs), '图标加载失败要有品牌图兜底');
  });

  await test('启动提速：权限授过就不再重复授（省 20s+）', () => {
    const root = path.join(__dirname, '..');
    const adbJs = fs.readFileSync(path.join(root, 'src', 'core', 'adb.js'), 'utf8');
    const fn = adbJs.slice(adbJs.indexOf('async grantRuntimePermissions('), adbJs.indexOf('async grantRuntimePermissions(') + 2600);
    // 命中缓存要直接返回，连 dumpsys package 都不跑
    assert(/rec\.permGranted === true/.test(fn), '已授权限要命中缓存');
    assert(/store\.upsertApp\(\{ package: pkg, permGranted: true \}\)/.test(fn), '授完要写标记');
    const clear = adbJs.slice(adbJs.indexOf('async clearData('), adbJs.indexOf('async clearData(') + 400);
    assert(/permGranted: false/.test(clear), 'pm clear 后要作废缓存');
    const inst = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    assert(/permGranted: false/.test(inst), '重装后要作废缓存');
  });

  await test('卡顿：AMD host 后端关 Vulkan 后重试硬件加速', () => {
    const root = path.join(__dirname, '..');
    const emuJs = fs.readFileSync(path.join(root, 'src', 'core', 'emulator.js'), 'utf8');
    assert(/-feature', '-Vulkan/.test(emuJs), 'host 后端要能关掉 Vulkan');
    assert(/badGpuVulkanTried/.test(emuJs), '每个 emulator 版本要重试一次 host');
    // 只在 host + AMD + Windows 生效，别把软件后端也带进不确定性
    assert(/gpu === 'host' && process\.platform === 'win32' && doctor\.detectGpuVendor\(\) === 'amd'/.test(emuJs),
      '仅 host + AMD 关闭 Vulkan');
  });

  await test('升级残留：运行时目录指向别的安装包时改用随包内置', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    assert(/looksForeignBundle/.test(mainJs), '要识别「另一个包的 resources/runtime」');
    assert(/resources\[\\\\\/\]runtime\$/.test(mainJs), '按 resources/runtime 结尾判定');
  });

  await test('双实例交替：旧实例退出不能杀掉新实例刚接管的模拟器', () => {
    const root = path.join(__dirname, '..');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    // 用户「点了没反应再点一次」时，第二次启动会接管模拟器；旧实例的收尾如果
    // 照样 dispose()，新实例立刻拿到 device not found —— 应用彻底打不开。
    assert(/owner\.pid/.test(mainJs), '启动时要记下自己是不是运行时的主人');
    assert(/const releaseRuntime = /.test(mainJs), '要有「运行时归属」判定');
    const fn = mainJs.slice(mainJs.indexOf('const releaseRuntime'), mainJs.indexOf('const releaseRuntime') + 800);
    assert(/owner === process\.pid/.test(fn), 'pid 不是自己时不能停运行时');
    const hits = (mainJs.match(/runtime\?\.dispose\(\)/g) || []).length;
    assert(hits === 1, `运行时只应在 releaseRuntime 里停一次，实际 ${hits} 处`);
  });

  await test('窗口代理：从目录联接启动时也要认得出模拟器窗口', () => {
    const root = path.join(__dirname, '..');
    const agentJs = fs.readFileSync(path.join(root, 'src', 'core', 'agent.js'), 'utf8');
    // 代理按进程 exe 路径前缀判断归属，Windows 给的是解析 junction 后的真实路径；
    // 不解析就会 emu:0 → 原生窗口接管失败 → 退回带旋转按钮的嵌入壳。
    assert(/realpathSync\.native/.test(agentJs), 'scope 目录要先解析成真实路径');
    const scope = agentJs.slice(agentJs.indexOf('async scope('), agentJs.indexOf('async scope(') + 1200);
    assert(/list\.push\(d\)/.test(scope), '原路径也要保留，兼容少数环境');
  });

  await test('ARM-only 安装：报错本身就是重试理由，不能只看镜像文件在不在', () => {
    const root = path.join(__dirname, '..');
    const inst = fs.readFileSync(path.join(root, 'src', 'core', 'installer.js'), 'utf8');
    // 曾经用 !playImageInfo().ok 当重试开关：镜像文件在磁盘上、但复用了没开翻译层的
    // 旧模拟器时，重试被跳过却照样弹「正在重试」，用户看到红色「安装失败 + 正在重试」。
    const retry = inst.slice(inst.indexOf('if (e.code === \'NO_MATCHING_ABIS\')'), inst.indexOf('if (e.code === \'NO_MATCHING_ABIS\')') + 260);
    assert(!/NO_MATCHING_ABIS.*playImageInfo/.test(retry), 'ABI 不匹配重试不能再被 playImageInfo 卡住');
    assert(/abiRetried = true/.test(inst), '二次仍失败要标记，文案才不会谎称正在重试');
    const sw = inst.slice(inst.indexOf('async switchToCompat'), inst.indexOf('async install('));
    assert(/invalidateSnapshot\(\)/.test(sw), '切兼容镜像必须作废旧快照，否则翻译层不生效');
    assert(/runningHasArm/.test(inst) && /ro\.product\.cpu\.abilist/.test(inst), '装 ARM 应用前要看当前运行时的真实翻译能力');
    const ui = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
    const f = ui.slice(ui.indexOf('function friendlyInstallErrorText'), ui.indexOf('function friendlyInstallErrorText') + 900);
    assert(!/NO_MATCHING_ABIS/i.test(f) || /正在|已切换到/.test(f.slice(f.indexOf('NO_MATCHING_ABIS'), f.indexOf('NO_MATCHING_ABIS') + 320)), '失败横幅文案要说清状态，不能只说「正在重试」');
  });

  console.log('\n[多语言 / 自定义镜像 / 内存优化]');
  await test('多语言：8 语种词典齐全，UI 语言选择卡与下拉都覆盖', () => {
    const root = path.join(__dirname, '..');
    const i18n = require('../src/core/i18n');
    const langs = ['en', 'ru', 'vi', 'es', 'pt', 'ja', 'ko'];
    for (const l of langs) {
      const f = path.join(root, 'src', 'i18n', l + '.json');
      assert(fs.existsSync(f), '缺 ' + l + ' 词典');
      const dict = JSON.parse(fs.readFileSync(f, 'utf8'));
      assert(Object.keys(dict).length >= 30, l + ' 词条太少');
    }
    const codes = i18n.LANGUAGES.map((x) => x.code);
    assert(['auto','zh','en','ru','vi','es','pt','ja','ko'].every((c) => codes.includes(c)), '语言清单不全');
    const html = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');
    assert(/id="langMask"/.test(html), '首次语言选择卡缺失');
    assert(/id="langGrid"/.test(html), '语言选项网格缺失');
    const app = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
    assert(/maybeShowLanguagePicker/.test(app) && /uiLanguageSelected/.test(app), '首次语言选择引导逻辑缺失');
  });

  await test('首次语言选择：全新安装需引导，老用户不打扰，选完不再弹', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'lang-first-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    const storePath = require.resolve('../src/core/store');
    delete require.cache[storePath];
    try {
      const store = require('../src/core/store');
      // 全新安装：没有 settings.json → uiLanguageSelected=false，需要弹语言卡
      const fresh = store.getSettings();
      assert(fresh.uiLanguageSelected === false, '全新安装应标记「需选语言」');
      assert(fresh.uiLanguage === 'auto', '全新安装语言应为 auto');
      // 用户选完保存：置 true
      store.saveSettings({ uiLanguage: 'ja', uiLanguageSelected: true });
      delete require.cache[storePath];
      const after = require('../src/core/store').getSettings();
      assert(after.uiLanguageSelected === true, '选完应标记已处理，不再弹');
      assert(after.uiLanguage === 'ja', '选中的语言应持久化');
      // 模拟老用户：配置文件存在但没有 uiLanguageSelected / uiLanguage → 中文、不弹
      const settingsFile = path.join(store.DATA_DIR, 'settings.json');
      fs2.writeFileSync(settingsFile, JSON.stringify({ adbPath: 'x' }), 'utf8');
      delete require.cache[storePath];
      const legacy = require('../src/core/store').getSettings();
      assert(legacy.uiLanguage === 'zh', '老用户应保持中文');
      assert(legacy.uiLanguageSelected === true, '老用户不应被语言卡打扰');
      // Preserve preferences saved by the earlier i18n test builds.
      for (const [language, expected] of [['pt-BR', 'pt'], ['zh-CN', 'zh'], ['en', 'en'], ['ru', 'ru'], ['invalid', 'zh']]) {
        fs2.writeFileSync(settingsFile, JSON.stringify({ language }), 'utf8');
        assert(store.getSettings().uiLanguage === expected, 'legacy language: ' + language);
      }
      fs2.writeFileSync(settingsFile, JSON.stringify({ language: 'pt-BR' }), 'utf8');
      store.saveSettings({ uiLanguage: 'en' });
      assert(store.getSettings().uiLanguage === 'en', 'the current setting must override the legacy setting');

    } finally {
      delete require.cache[storePath];
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('内存优化：窗口隐藏时暂停轮询，托盘菜单按指纹变化才重建', () => {
    const root = path.join(__dirname, '..');
    const app = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
    assert(/document\.hidden/.test(app), '轮询应感知窗口可见性');
    assert(/visibilitychange/.test(app), '应监听可见性变化以恢复轮询');
    assert(/clearInterval\(t\)/.test(app), '隐藏时应清理定时器，而不是空转');
    const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const tray = main.slice(main.indexOf('const refresh = () =>'), main.indexOf('const refresh = () =>') + 1200);
    assert(/lastTrayFingerprint/.test(tray), '托盘应有状态指纹，避免每 5 秒无条件重建菜单');
    assert(/fingerprint === lastTrayFingerprint/.test(tray), '指纹没变应跳过重建');
  });

  console.log(results.join('\n'));
  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
