'use strict';
/**
 * 引擎与自举链路测试（不依赖真实 QEMU / adb / Android）
 * 覆盖：下载器（含断点续传）、ZIP 解压、环境检查、QEMU 启动参数、monitor 协议
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

// 隔离测试数据目录，避免污染真实用户配置
const TMP = path.join(os.tmpdir(), `apkstart-test-${Date.now()}`);
process.env.APPDATA = TMP;
fs.mkdirSync(path.join(TMP, 'apkstart'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed++; results.push(`  ✗ ${name}\n    ${e.message}`); });
}

function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

(async () => {
  console.log('\n[download.js]');
  const { download, downloadParallel, head, sha256File } = require('../src/core/download');

  // 本地 HTTP 服务模拟下载源（含 Range 续传）
  const payload = Buffer.alloc(300 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

  const server = http.createServer((req, res) => {
    if (req.url === '/big.bin') {
      const range = req.headers.range;
      if (range) {
        const start = Number(/bytes=(\d+)-/.exec(range)[1]);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
          'Content-Length': payload.length - start,
        });
        return res.end(payload.subarray(start));
      }
      res.writeHead(200, { 'Content-Length': payload.length });
      return res.end(payload);
    }
    // 完整支持 start-end 的 Range（用于并行分块测试）
    if (req.url === '/ranged.bin') {
      server.rangeHits = (server.rangeHits || 0) + 1;
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (!range) {
        res.writeHead(200, { 'Content-Length': payload.length, 'Accept-Ranges': 'bytes' });
        return res.end(payload);
      }
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), payload.length - 1);
      res.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Content-Length': end - start + 1,
      });
      return res.end(payload.subarray(start, end + 1));
    }
    // 明确不支持 Range
    if (req.url === '/norange.bin') {
      res.writeHead(200, { 'Content-Length': payload.length, 'Accept-Ranges': 'none' });
      return res.end(payload);
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/big.bin' });
      return res.end();
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await test('完整下载 + 跟随重定向', async () => {
    const dest = path.join(TMP, 'dl1.bin');
    await download(`http://127.0.0.1:${port}/redirect`, dest);
    assert(fs.statSync(dest).size === payload.length, '大小不符');
  });

  await test('断点续传（已有半截文件）', async () => {
    const dest = path.join(TMP, 'dl2.bin');
    fs.writeFileSync(dest, payload.subarray(0, 100000));
    let lastPercent = 0;
    await download(`http://127.0.0.1:${port}/big.bin`, dest, {
      onProgress: (p) => { lastPercent = p.percent; },
    });
    assert(fs.statSync(dest).size === payload.length, `续传后大小 ${fs.statSync(dest).size}`);
    assert(fs.readFileSync(dest).equals(payload), '续传内容不一致');
    assert(lastPercent > 50, '未上报进度');
  });

  await test('HEAD 探测 + SHA256', async () => {
    const h = await head(`http://127.0.0.1:${port}/big.bin`);
    assert(h.size === payload.length, 'HEAD 大小不符');
    const sum = await sha256File(path.join(TMP, 'dl1.bin'));
    assert(/^[0-9a-f]{64}$/.test(sum), 'sha256 格式异常');
  });

  await test('SHA256 校验失败会清理文件', async () => {
    const dest = path.join(TMP, 'dl3.bin');
    let threw = false;
    try {
      await download(`http://127.0.0.1:${port}/big.bin`, dest, { expectSha256: 'deadbeef'.repeat(8) });
    } catch (_) { threw = true; }
    assert(threw, '应当抛错');
    assert(!fs.existsSync(dest), '校验失败应删除文件');
  });

  await test('并行分块下载：多连接拼接内容一致', async () => {
    const dest = path.join(TMP, 'dl4.bin');
    server.rangeHits = 0;
    let maxPercent = 0;
    const r = await downloadParallel(`http://127.0.0.1:${port}/ranged.bin`, dest, {
      connections: 8,
      minChunk: 32 * 1024,
      onProgress: (p) => { maxPercent = Math.max(maxPercent, p.percent); },
    });
    assert(fs.readFileSync(dest).equals(payload), '分块拼接后内容不一致');
    assert(r.parallel > 1, `未启用并行：${r.parallel}`);
    assert(server.rangeHits >= r.parallel, `分块请求数偏少：${server.rangeHits}`);
    assert(maxPercent > 0, '未上报进度');
  });

  await test('源不支持 Range 时自动回退单流', async () => {
    const dest = path.join(TMP, 'dl5.bin');
    const r = await downloadParallel(`http://127.0.0.1:${port}/norange.bin`, dest, {
      connections: 8,
      minChunk: 32 * 1024,
    });
    assert(fs.readFileSync(dest).equals(payload), '回退后内容不一致');
    assert(!r.parallel, '不应走并行');
  });

  server.close();

  console.log('\n[provision.js]');
  const { Provisioner } = require('../src/core/provision');
  const store = require('../src/core/store');

  await test('默认运行时目录位于数据目录下', async () => {
    const p = new Provisioner('C:/fake/app');
    assert(p.paths().root.startsWith(store.DATA_DIR), `路径异常: ${p.paths().root}`);
    assert(p.paths().qemuExe.endsWith('qemu-system-x86_64.exe'), 'qemu 路径异常');
    assert(p.paths().adbExe.endsWith('adb.exe'), 'adb 路径异常');
  });

  await test('空环境检查：adb 未就绪，组件结构完整', async () => {
    const p = new Provisioner(path.join(TMP, 'nonexistent'));
    const env = await p.checkEnv();
    assert(env.adb.ok === false, 'adb 不应就绪');
    // QEMU 可能已被系统级安装（如 winget 到 Program Files），此时应当被发现
    if (env.qemu.ok) assert(env.qemu.version, 'qemu 就绪时必须带版本号');
    assert(env.ready === false, '不应就绪');
    assert(typeof env.hypervisor.whpx === 'boolean', '缺少超管信息');
  });

  await test('内置 ZIP 解压可用', async () => {
    const { ZipArchive } = require('../src/core/zip');
    // 构造一个 stored 模式的最小 zip
    const name = Buffer.from('platform-tools/adb.exe');
    const data = Buffer.from('fake-adb-binary');
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(0, 8);
    loc.writeUInt32LE(data.length, 18);
    loc.writeUInt32LE(data.length, 14);
    loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt32LE(data.length, 20);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + name.length, 12);
    eocd.writeUInt32LE(30 + name.length + data.length, 16);
    const zipPath = path.join(TMP, 'pt.zip');
    fs.writeFileSync(zipPath, Buffer.concat([loc, name, data, cen, name, eocd]));

    const out = path.join(TMP, 'unzip');
    const p = new Provisioner(TMP);
    await p.extractZip(zipPath, out);
    assert(fs.readFileSync(path.join(out, 'platform-tools', 'adb.exe')).toString() === 'fake-adb-binary', '解压内容不符');
    assert(new ZipArchive(fs.readFileSync(zipPath)).has('platform-tools/adb.exe'), 'zip 读取异常');
  });

  await test('SDK 索引里的相对 url 会被补全成绝对地址', async () => {
    const { absUrl, baseOf, SOURCES } = require('../src/core/provision');
    // repository2-3.xml（emulator）相对仓库根
    assert(absUrl('emulator-windows_x64-16847572.zip') === `${baseOf(SOURCES.sdkIndex)}emulator-windows_x64-16847572.zip`,
      'emulator 相对路径未补全');
    // sys-img 索引相对 sys-img/android/，不能错拼到仓库根
    const sysBase = baseOf(SOURCES.sysImgIndexes[0]);
    assert(sysBase.endsWith('/sys-img/android/'), `sys-img 基准目录异常: ${sysBase}`);
    assert(absUrl('x86_64-30_r11.zip', sysBase) === 'https://dl.google.com/android/repository/sys-img/android/x86_64-30_r11.zip',
      'sys-img 相对路径补全错误');
    // 绝对地址原样返回
    assert(absUrl('https://example.com/a.zip') === 'https://example.com/a.zip', '绝对地址被改写');
  });

  await test('解析出的 emulator / 系统镜像地址都是可下载的绝对 URL', async () => {
    const p = new Provisioner(TMP);
    const emuUrl = await p.resolveEmulatorUrl();
    const imgUrl = await p.resolveSysimgUrl();
    for (const u of [emuUrl, imgUrl]) {
      assert(/^https?:\/\//i.test(u), `不是绝对 URL: ${u}`);
      assert(/\.zip$/i.test(u), `不是 zip 包: ${u}`);
    }
    assert(/windows_x64/i.test(emuUrl), `emulator 包平台不对: ${emuUrl}`);
  });

  await test('AVD 配置使用 64 位架构（x86_64 不能被截成 x86）', async () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(TMP);
    const r = emu.ensureAvd({ memoryMB: 2048, cores: 2 });
    const cfg = fs.readFileSync(path.join(r.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.cpu\.arch=x86_64$/m.test(cfg), `hw.cpu.arch 应为 x86_64，实际：${cfg.match(/^hw\.cpu\.arch=.*$/m)}`);
    assert(/^abi\.type=x86_64$/m.test(cfg), 'abi.type 应为 x86_64');
    assert(/^image\.sysdir\.1=system-images\//m.test(cfg), 'image.sysdir.1 缺失');
  });

  await test('安装失败原因翻译：NO_MATCHING_ABIS 给出中文指引', async () => {
    const { friendlyInstallError } = require('../src/core/adb');
    const out = friendlyInstallError(
      'Performing Streamed Install\nadb.exe: failed to install x.apk: '
      + 'Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]',
    );
    assert(out.includes('ARM 原生库'), `应解释 ARM 原生库问题：${out}`);
    assert(out.includes('INSTALL_FAILED_NO_MATCHING_ABIS'), '应保留原始错误码');
    const other = friendlyInstallError('Failure [INSTALL_FAILED_INVALID_APK: x]');
    assert(other.includes('损坏') || other.includes('不完整'), `未知错误也应可读：${other}`);
  });

  await test('镜像校验：区分有效 ISO9660 / 损坏 / 未下完', async () => {
    const p = new Provisioner(TMP);
    const mk = (file, size, writeMagic) => {
      const fd = fs.openSync(file, 'w');
      fs.ftruncateSync(fd, size);
      if (writeMagic) {
        fs.writeSync(fd, Buffer.from([1]), 0, 1, 0x8000);
        fs.writeSync(fd, Buffer.from('CD001', 'latin1'), 0, 5, 0x8001);
      }
      fs.closeSync(fd);
      return file;
    };

    const good = mk(path.join(TMP, 'good.iso'), 450 * 1024 * 1024, true);
    const a = p.inspectIso(good);
    assert(a.ok && a.iso9660, `有效 ISO 被判无效：${a.reason}`);

    const broken = mk(path.join(TMP, 'broken.iso'), 450 * 1024 * 1024, false);
    const b = p.inspectIso(broken);
    assert(!b.ok && /ISO9660/.test(b.reason), `损坏镜像未被拦截：${JSON.stringify(b)}`);

    const partial = mk(path.join(TMP, 'partial.iso'), 2 * 1024 * 1024, true);
    const c = p.inspectIso(partial);
    assert(!c.ok && /未完成/.test(c.reason), `未下完的镜像未被拦截：${JSON.stringify(c)}`);

    for (const f of [good, broken, partial]) fs.rmSync(f, { force: true });
  });

  await test('远端 stat 列表解析（真实 mtime，避免无限重传）', async () => {
    const { parseStatList } = require('../src/core/adb');
    const rows = parseStatList('1794309868|1234|./a.txt\n1794309900|99|./sub/b.png');
    assert(rows && rows.length === 2, `解析数量异常：${JSON.stringify(rows)}`);
    assert(rows[0].rel === 'a.txt' && rows[0].size === 1234, '首行字段错误');
    assert(rows[1].rel === 'sub/b.png', '子目录相对路径错误');
    assert(rows[1].mtime === 1794309900000, 'mtime 未换算为毫秒');
    assert(parseStatList('ls: /nope: No such file') === null, '非 stat 输出应返回 null 以便回退');
    assert(Array.isArray(parseStatList('')) && parseStatList('').length === 0, '空目录应返回空数组');
  });

  console.log('\n[engine.js]');
  const { Runtime } = require('../src/core/engine');

  await test('QEMU 启动参数：安装模式挂载 ISO 并从光驱启动', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: true };
    store.saveSettings({
      runtime: { isoPath: 'C:/img/android.iso', diskPath: 'C:/img/disk.qcow2' },
      engine: { memoryMB: 4096, cores: 4 },
    });
    const args = rt.buildArgs({ install: true }).join(' ');
    assert(args.includes('-cdrom C:/img/android.iso'), '缺少 -cdrom');
    assert(/order=d/.test(args), '应从光驱启动');
    assert(/accel=whpx/.test(args), '应使用 WHPX');
    assert(/-cpu host/.test(args), 'WHPX 应使用 host CPU');
    assert(/hostfwd=tcp:127\.0\.0\.1:5555-:5555/.test(args), '缺少 adb 端口转发');
    assert(args.includes('-monitor tcp:127.0.0.1:5556'), '缺少 monitor');
    assert(/-m 4096/.test(args), '内存参数错误');
  });

  await test('QEMU 启动参数：正常启动从磁盘引导', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: false };
    const args = rt.buildArgs({ install: false }).join(' ');
    assert(!args.includes('-cdrom'), '不应挂载 ISO');
    assert(/order=c/.test(args), '应从硬盘启动');
    assert(/accel=tcg/.test(args), '无 WHPX 应回退 TCG');
    assert(/-cpu max/.test(args), 'TCG 应使用 max CPU');
    assert(args.includes('if=virtio,format=qcow2'), '磁盘参数错误');
  });

  await test('headless 模式隐藏虚拟机窗口', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: false };
    const args = rt.buildArgs({ headless: true }).join(' ');
    assert(args.includes('-display none'), '应无窗口');
  });

  await test('QEMU monitor 协议：握手并下发命令', async () => {
    // 模拟 QEMU monitor：连上后回 "(qemu) "，收到命令后回 ok
    const srv = net.createServer((sock) => {
      sock.write('QEMU 8.2.0 monitor - type \'help\' for more information\r\n(qemu) ');
      sock.on('data', (d) => {
        srv.lastCmd = d.toString().trim();
        sock.write('ok\r\n(qemu) ');
      });
    });
    await new Promise((r) => srv.listen(5556, '127.0.0.1', r));

    const rt = new Runtime(TMP);
    await rt.monitorCmd('system_powerdown');
    assert(srv.lastCmd === 'system_powerdown', `实际收到: ${srv.lastCmd}`);
    await new Promise((r) => srv.close(r));
  });

  await test('未安装系统时 ensure 返回 needsSetup', async () => {
    store.saveSettings({ runtime: { installed: false }, engine: { mode: 'builtin' } });
    const rt = new Runtime(TMP);
    // 用假 adb 保证 isOnline 快速失败
    const r = await rt.ensure({ onLog: () => {} });
    assert(r.ok === false, '不应就绪');
    assert(['provision', 'install'].includes(r.needsSetup), `needsSetup=${r.needsSetup}`);
  });

  await test('启动就绪判定：必须等到 boot_completed + 包管理器', async () => {
    const rt = new Runtime(TMP);
    const calls = [];
    const fake = {
      isOnline: async () => true,
      connect: async () => true,
      shell: async (cmd) => {
        calls.push(cmd);
        if (cmd.includes('sys.boot_completed')) return '1';
        if (cmd.includes('pm path android')) return 'package:/system/framework/framework-res.apk';
        return '';
      },
    };
    const r = await rt.waitAndroidReady(fake, 5000, () => {});
    assert(r.ok, '应当判定为已就绪');
    assert(calls.some((c) => c.includes('sys.boot_completed')), '未检查 boot_completed');
    assert(calls.some((c) => c.includes('pm path android')), '未检查包管理器');
  });

  await test('系统未启动完成时返回阶段（kernel）', async () => {
    const rt = new Runtime(TMP);
    const fake = { isOnline: async () => true, connect: async () => true, shell: async () => '0' };
    const r = await rt.waitAndroidReady(fake, 1200, () => {});
    assert(!r.ok && r.stage === 'kernel', `应停在 kernel 阶段：${JSON.stringify(r)}`);
  });

  console.log('\n[provision.js 兼容镜像 / 完整版]');

  await test('playImageInfo 校验 API 34 兼容镜像完整性', async () => {
    const dir = path.join(TMP, 'apkstart', 'runtime', 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'kernel-ranchu'), 'k');
    const prov = new Provisioner(path.join(__dirname, '..'));
    fs.writeFileSync(path.join(dir, 'system.img'), Buffer.alloc(64));
    assert(!prov.playImageInfo().ok, '过小的镜像不应判定为就绪');
    fs.writeFileSync(path.join(dir, 'system.img'), Buffer.alloc(301 * 1024 * 1024));
    const info = prov.playImageInfo();
    assert(info.ok && info.api === '34' && info.tag === 'google_apis_playstore', `应判定 API 34 兼容镜像就绪：${JSON.stringify(info)}`);
  });

  await test('完整版品牌资产与抖音联系入口就位', async () => {
    const root = path.join(__dirname, '..');
    assert(fs.existsSync(path.join(root, 'src', 'ui', 'assets', 'douyin-qr.jpg')), '缺少抖音二维码图片');
    assert(fs.existsSync(path.join(root, 'build', 'fetch-runtime.js')), '缺少完整版运行时组装脚本');
    const html = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');
    assert(html.includes('douyin-qr.jpg'), '关于区未引用抖音二维码');
    assert(html.includes('https://v.douyin.com/9TIIxVCANig/'), '缺少抖音主页链接');
  });

  console.log(results.join('\n'));
  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
