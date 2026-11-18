'use strict';
// 断言里比对的是中文原文：固定界面语言，不随本机系统语言变化
require('../src/i18n').setLang('zh');
/**
 * issue 反馈加固的纯 Node 测试（无需模拟器/网络/注册表）。
 *
 * 覆盖本轮从 GitHub issues 汇总后落实的 5 项：
 *  - #2 P0-1：APK 包名未校验 → 任意路径写入 / adb 命令注入
 *  - #2 P0-4：provision/updater 解压无 zip-slip 防护
 *  - #2 P1-1：_fetchText 超限后 Promise 永不 settle
 *  - #51：安装版一键卸载被误判成便携版（卸载器命名两处不一致）
 *  - #98：便携版更新下载后不重启 → 死循环（复制校验假阳性 + 载荷被删）
 *
 * 运行：node test/issue-hardening-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const { validPackageName, safeFilePart } = require('../src/core/pkgname');
const { resolveZipEntry } = require('../src/core/zip');
const store = require('../src/core/store');
const { findUninstaller, Updater } = require('../src/core/updater');
const { Provisioner } = require('../src/core/provision');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-hardening-'));

(async () => {
  console.log('\n[issue #2 P0-1 · 包名校验]');
  test('合法 Android 包名通过', () => {
    for (const p of ['com.github.tvbox.osc', 'com.tencent.mm', 'org.example.app_2']) {
      assert.equal(validPackageName(p), true, `${p} 应合法`);
    }
  });
  test('路径穿越 / 盘符 / shell 元字符 / 空格全部拒绝', () => {
    for (const p of ['../evil', 'com..x', '.com.x', 'com/x', 'com\\x', 'C:evil', 'a;rm -rf', 'a|b',
      'a b', 'a$(id)', 'a`id`', '', 'com.x.', '1com.x', 'com.x-y']) {
      assert.equal(validPackageName(p), false, `${JSON.stringify(p)} 应被拒绝`);
    }
  });
  test('非法包名改写成安全文件名', () => {
    const safe = safeFilePart('../evil');
    assert.ok(!safe.includes('/') && !safe.includes('\\') && !safe.includes('..'), `改写后必须无路径字符：${safe}`);
    assert.equal(safeFilePart('com.ok.pkg'), 'com.ok.pkg');
  });
  test('store 的图标/APK 路径无法逃出数据目录', () => {
    const icon = store.iconPath('../../Windows/System32/drivers/etc/hosts');
    const apk = store.apkPath('../../evil', '../../x');
    assert.ok(!icon.includes('..'), `图标路径不应含 ..：${icon}`);
    assert.ok(!apk.includes('..'), `APK 路径不应含 ..：${apk}`);
    assert.match(path.basename(apk), /\.apk$/);
  });

  console.log('\n[issue #2 P0-4 · zip-slip]');
  test('正常相对路径放行', () => {
    const root = path.join(TMP, 'zip-ok');
    assert.equal(resolveZipEntry(root, 'emulator/qemu.exe'), path.join(root, 'emulator', 'qemu.exe'));
    assert.equal(resolveZipEntry(root, 'a/b/c.txt'), path.join(root, 'a', 'b', 'c.txt'));
  });
  test('../ / 绝对路径 / 盘符 / 反斜杠穿越 / UNC 全部拒绝', () => {
    const root = path.join(TMP, 'zip-root');
    for (const n of ['../evil', 'a/../../evil', '/etc/passwd', 'C:\\Windows\\x', 'C:/Windows/x',
      'a\\..\\..\\evil', '\\\\server\\share\\x', 'a/../b']) {
      assert.equal(resolveZipEntry(root, n), null, `${JSON.stringify(n)} 应拒绝`);
    }
  });
  test('provision 与 updater 源码都接上了 zip-slip 守卫', () => {
    const prov = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'provision.js'), 'utf8');
    const upd = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'updater.js'), 'utf8');
    assert.ok(/resolveZipEntry\(/.test(prov), 'provision.extractZip 必须校验条目名');
    assert.ok(/resolveZipEntry\(/.test(upd), 'updater._extract 必须校验条目名');
  });

  console.log('\n[issue #2 P1-1 · _fetchText 不再挂死]');
  await atest('超上限时 Promise 能结算、不再永不 settle', async () => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(64 * 1024) });
      res.end(Buffer.alloc(64 * 1024, 0x61));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/index.xml`;
    try {
      const p = new Provisioner({});
      const out = await Promise.race([
        p._fetchText(url, 1024),
        new Promise((_, rej) => setTimeout(() => rej(new Error('_fetchText 卡死未结算')), 5000)),
      ]);
      assert.equal(out, '', '超限内容必须丢弃，不能把半截当完整');
    } finally {
      srv.close();
    }
  });
  test('_fetchText 源码含一次性 settle 门闩与硬超时', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'provision.js'), 'utf8');
    assert.ok(/let done = false/.test(src) && /const finish = \(\) =>/.test(src), '必须有一次性结算门闩');
    assert.ok(/setTimeout/.test(src), '必须有硬超时兜底');
  });

  console.log('\n[issue #51 · 卸载器识别]');
  test('electron-builder 的 Uninstall X.exe 能被识别为安装版', () => {
    const dir = path.join(TMP, 'uninst-a');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Uninstall ApkStart.exe'), 'x');
    assert.equal(findUninstaller(dir), 'Uninstall ApkStart.exe');
  });
  test('老式 uninstaller.exe 同样识别', () => {
    const dir = path.join(TMP, 'uninst-b');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'uninstaller.exe'), 'x');
    assert.equal(findUninstaller(dir), 'uninstaller.exe');
  });
  test('便携版（无卸载器）返回 null', () => {
    const dir = path.join(TMP, 'uninst-c');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(findUninstaller(dir), null);
  });

  console.log('\n[issue #98 · 更新不重启死循环]');
  await atest('已就绪的载荷可被找回续做，版本不符/缺 exe 则不可用', async () => {
    const dataDir = path.join(TMP, 'upd-resume');
    const exe = path.join(dataDir, 'ApkStart.exe');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(exe, 'x');
    const u = new Updater({ currentVersion: '0.5.3', exePath: exe, isPackaged: true, dataDir });

    const payload = path.join(dataDir, 'update', '0.5.4', 'payload');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'ApkStart.exe'), 'new');
    assert.equal(u.findResumableJob(), null, '没有就绪标记不应复用');
    u._markPayloadReady(payload, '0.5.4');
    const job = u.findResumableJob();
    assert.ok(job && job.version === '0.5.4', '应找回 0.5.4 的续做任务');

    // 版本比当前旧 → 不复用
    const cur = new Updater({ currentVersion: '0.5.4', exePath: exe, isPackaged: true, dataDir });
    assert.equal(cur.findResumableJob(), null, '不低于当前版本的载荷不能续做');
    // 标记版本不符 → 不复用
    fs.writeFileSync(u._readyFile(payload), JSON.stringify({ version: '0.5.2' }));
    assert.equal(u.findResumableJob(), null, '标记版本不符不能复用');
  });
  test('apply 脚本用字节数校验替换成功，且保留失败载荷、有双路径重启', () => {
    const dataDir = path.join(TMP, 'upd-apply');
    const exe = path.join(dataDir, 'ApkStart.exe');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(exe, 'old');
    const u = new Updater({ currentVersion: '0.5.3', exePath: exe, isPackaged: true, dataDir });
    const payload = path.join(dataDir, 'update', '0.5.4', 'payload');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'ApkStart.exe'), 'new-version-bytes');
    const script = u.apply({ mode: 'zip', payload, version: '0.5.4' }, { spawn: false });
    assert.ok(/\(Get-Item \$target\)\.Length -eq \$expected/.test(script), '必须按字节数验证新 exe');
    assert.ok(/keeping payload for next launch/.test(script), '复制失败必须保留载荷供续做');
    assert.ok(/Start-Process -FilePath/.test(script) && /cmd\.exe/.test(script), '重启必须有兜底路径');
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('  异常：', e.stack || e.message);
  process.exit(1);
});
