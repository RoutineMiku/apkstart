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
  const { download, head, sha256File } = require('../src/core/download');

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
    p.extractZip(zipPath, out);
    assert(fs.readFileSync(path.join(out, 'platform-tools', 'adb.exe')).toString() === 'fake-adb-binary', '解压内容不符');
    assert(new ZipArchive(fs.readFileSync(zipPath)).has('platform-tools/adb.exe'), 'zip 读取异常');
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

  console.log(results.join('\n'));
  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
