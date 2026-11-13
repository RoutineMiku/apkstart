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
const { friendlyInstallError, friendlyLaunchError } = require('../src/core/adb');

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
    assert(p.dataMB <= 4096, '数据分区不应再是 16G');
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
    assert(v[v.length - 1].wipe === true, '最后一档应强制冷启动清快照');
    assert(v[v.length - 1].memoryMB <= 2048, '最后一档应降到最小内存');
    const keys = v.map((x) => `${x.gpu}|${x.accel}|${x.wipe}|${x.memoryMB}`);
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
      assert(/-no-snapshot/.test(fresh), '没有快照时必须是 -no-snapshot');
      assert(!/-snapshot apkstart/.test(fresh), '没有快照时不能传 -snapshot');
    }
    // 快照确实存在时才走 quickboot
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'apkstart.avd');
    const snapDir = path.join(avdDir, 'snapshots');
    const created = !fs.existsSync(snapDir);
    fs.mkdirSync(path.join(snapDir, 'apkstart'), { recursive: true });
    const withSnap = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot apkstart/.test(withSnap), '有快照时应使用 quickboot 快照');
    if (created) fs.rmSync(snapDir, { recursive: true, force: true });

    const cold = emu.buildArgs({ wipe: true }).join(' ');
    assert(/-wipe-data/.test(cold) && /-no-snapshot/.test(cold), 'wipe 时不能同时加载快照');
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
      // 用与 src/core/provision.js 相同的解压器读回，保证构建产物与运行时兼容
      const lzmaDir = path.dirname(require.resolve('@napi-rs/lzma'));
      const { xz } = require(path.join(lzmaDir, 'index.js'));
      const { Readable } = require('stream');
      const webOut = xz.decompressStream(Readable.toWeb(fs.createReadStream(out)));
      const chunks = [];
      // eslint-disable-next-line no-restricted-syntax
      for await (const c of Readable.fromWeb(webOut)) chunks.push(Buffer.from(c));
      back = Buffer.concat(chunks);
    } else {
      back = zlib.gunzipSync(fs.readFileSync(out));
    }
    assert(back.equals(payload), '解压内容必须与源镜像逐字节一致');
  });

  console.log(results.join('\n'));
  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
