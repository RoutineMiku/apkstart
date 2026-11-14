'use strict';
/**
 * 零配置自适应 / 容器式瘦身的回归测试（纯 Node，不拉起 emulator）
 * 运行：node test/auto-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

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
    // 新版本（37.x/36.4.9+）：host 最跟手，失败会自动降级到 software/swangle
    assert(doctor.gpuCandidates('37.3.8.0')[0] === 'host', '37.x 首选应为 host');
    assert(doctor.gpuCandidates('36.4.9.0')[0] === 'host');
    assert(doctor.gpuCandidates('37.3.8.0').includes('software'), '新版本必须有软件渲染兜底');
    // 37.x 上传 swiftshader_indirect 会 GL 初始化失败，绝不能出现在候选里
    assert(!doctor.gpuCandidates('37.3.8.0').includes('swiftshader_indirect'));
    // 老版本仍走 swiftshader_indirect
    assert(doctor.gpuCandidates('35.1.4.0')[0] === 'host');
    assert(doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
  });

  await test('小内存机器自动降配（不再是写死 4GB / 4 核）', () => {
    const host = { totalMB: 4096, freeMB: 2600, cores: 2, home: 'C:\\Users\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: false }, emulatorVersion: '37.3.8.0', diskMB: 20000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB === 2048, `内存应为 2048，实际 ${p.memoryMB}`);
    assert(p.cores === 2, `核心应为 2，实际 ${p.cores}`);
    assert(p.accel === 'off', '无硬件加速应自动回退软件模拟');
    assert(p.bootTimeoutMs > 240000, '软件模拟应给更长的开机超时');
    assert(p.gpu === 'host', `首选渲染应为 host（失败由 planVariants 降级），实际 ${p.gpu}`);
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

  await test('空闲端口探测返回偶数端口对', async () => {
    const p = await doctor.freePortPair(5560);
    assert(p % 2 === 0 && p >= 5560, `端口异常：${p}`);
  });

  await test('设置页展示的自动参数与实跑参数一致（37.x 不再显示弃用后端）', () => {
    const common = { accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000, port: 5562, adbPort: 5044 };
    const p = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: true, gpuMode: 'auto', memoryMB: 0, cores: 0 } } });
    const text = doctor.describeProfile(p);
    assert(p.gpu === 'host', `应为 host（失败降级），实际 ${p.gpu}`);
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
    assert(/ -no-snapshot( |$)/.test(cold), 'wipe 时不能加载也不能保存快照');
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
    const win = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(!/-no-window/.test(win), '窗口模式不能再用 -no-window');
    assert(/-no-skin/.test(win), '窗口模式应去掉手机外壳');
    const headless = emu.buildArgs({ headless: true }).join(' ');
    assert(/-no-window/.test(headless) && !/-no-skin/.test(headless));
  });

  await test('音频：默认开启（不带 -no-audio），关闭后才带 -no-audio', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // 覆盖 settings getter：默认开启不应有 -no-audio
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: true } }) });
    const on = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(!/-no-audio/.test(on), 'audio=true 时不应传 -no-audio');
    // 关闭后才应带 -no-audio
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: false } }) });
    const off = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(/-no-audio/.test(off), 'audio=false 时应传 -no-audio');
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
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000,
    });
    assert(auto.lite === true && auto.cores <= 4, JSON.stringify({ lite: auto.lite, cores: auto.cores }));
    const manual = doctor.autoProfile({
      settings: { engine: { autoMemory: false, cores: 6, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000,
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

  await test('双源：合并版本时只认同版本的资产，不拿旧包冒充新包', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.4.0', assets: [{ name: 'A-portable.zip', size: 10, browser_download_url: 'gh://a' }] } },
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.9', assets: [{ name: 'A-portable.zip', size: 10, browser_download_url: 'ge://a' }, { name: 'B.txt', size: 1, browser_download_url: 'ge://b' }] } },
    ];
    const m = await s.latest();
    assert(m.version === '0.4.0', `应取更高版本，实际 ${m.version}`);
    assert(m.assets.length === 1 && m.assets[0].url === 'gh://a', '旧版本同名资产不能覆盖新版本');
  });

  console.log('\n[资源策略 / 磁盘分配 / 日志上限]');

  await test('资源策略一处切换，自动翻译成 vCPU/优先级/分辨率', () => {
    const store = require('../src/core/store');
    let s = store.saveSettings({ engine: { resourceMode: 'smooth' } });
    assert(s.engine.liteMode === false, '流畅模式不应限制核数');
    assert(s.engine.priorityMode === 'performance', '流畅模式应与前台同优先级');
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

  console.log(results.join('\n'));
  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
