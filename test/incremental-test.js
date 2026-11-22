'use strict';
/**
 * 增量更新测试：清单校验、模式选择、逐文件哈希校验、apply 脚本、续做。
 * 全部离线，不访问 GitHub / Gitee。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Updater } = require('../src/core/updater');
const inc = require('../src/core/incremental');
const { ZipFile } = require('../src/core/zip');

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
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const TMP = path.join(__dirname, 'out', 'incremental');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const sampleFiles = {
  'resources/app/package.json': { sha256: 'AAA', size: 3 },
  'resources/app/src/main.js': { sha256: 'BBB', size: 9 },
};

console.log('\n[增量 · 清单与模式选择]');
test('parseManifest 拒绝残缺清单', () => {
  for (const bad of ['not json', '{}', JSON.stringify({ schema: 2 }), JSON.stringify({ schema: 1, version: '1' })]) {
    let threw = false;
    try { inc.parseManifest(bad); } catch (_) { threw = true; }
    assert(threw, `应拒绝：${bad.slice(0, 30)}`);
  }
});

test('parseManifest 接受合法清单', () => {
  const m = inc.parseManifest(JSON.stringify({
    schema: 1, version: '0.6.3', electronVersion: '33.4.11',
    app: { asset: 'ApkStart-v0.6.3-app.zip', sha256: 'x', files: sampleFiles },
  }));
  assert(m.version === '0.6.3' && m.app.files['resources/app/package.json'], '解析结果不对');
});

test('辅助资产（清单 / 代码包 / 运行时整包）不能当完整包', () => {
  assert(inc.isAuxAsset('ApkStart-v0.6.3-manifest.json'));
  assert(inc.isAuxAsset('ApkStart-v0.6.3-app.zip'));
  assert(inc.isAuxAsset('ApkStart-runtime-v0.6.3.zip'));
  assert(!inc.isAuxAsset('ApkStart-v0.6.3-win64-portable.zip'));
});

test('Electron 版本不一致 / 安装版 → 退回完整包', () => {
  const manifest = { app: { asset: 'a.zip', sha256: 'x', files: {} }, electronVersion: '33.4.11' };
  const assets = [{ name: 'a.zip' }];
  assert(inc.chooseMode({ flavor: 'portable', electronVersion: '33.4.11', manifest, assets }).mode === 'app');
  assert(inc.chooseMode({ flavor: 'portable', electronVersion: '22.0.0', manifest, assets }).mode === 'full');
  assert(inc.chooseMode({ flavor: 'setup', electronVersion: '33.4.11', manifest, assets }).mode === 'full');
  assert(inc.chooseMode({ flavor: 'portable', electronVersion: '33.4.11', manifest, assets: [] }).mode === 'full');
});

console.log('\n[增量 · 哈希校验]');
(async () => {
  const dir = path.join(TMP, 'hash');
  fs.mkdirSync(path.join(dir, 'resources', 'app', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'resources', 'app', 'package.json'), '{"version":"0.6.3"}');
  fs.writeFileSync(path.join(dir, 'resources', 'app', 'src', 'main.js'), 'console.log(1)');
  const files = {
    'resources/app/package.json': { sha256: sha(fs.readFileSync(path.join(dir, 'resources/app/package.json'))) },
    'resources/app/src/main.js': { sha256: sha(fs.readFileSync(path.join(dir, 'resources/app/src/main.js'))) },
    'resources/app/src/gone.js': { sha256: 'deadbeef' },
  };
  const hash = (f) => fs.existsSync(f) ? sha(fs.readFileSync(f)) : null;

  await atest('inspectLocal 找出缺失与变更', async () => {
    const r = await inc.inspectLocal({ installDir: dir, files, hash });
    assert(r.missing.length === 1 && r.missing[0] === 'resources/app/src/gone.js', `missing=${r.missing}`);
    assert(r.changed.length === 0, `changed=${r.changed}`);
    assert(!r.ok);
  });

  await atest('verifyExtracted 全对才通过，篡改即拦下', async () => {
    const ok = { 'resources/app/package.json': files['resources/app/package.json'] };
    assert((await inc.verifyExtracted({ payload: dir, files: ok, hash })).length === 0);
    const bad = { 'resources/app/package.json': { sha256: '0'.repeat(64) } };
    assert((await inc.verifyExtracted({ payload: dir, files: bad, hash })).length === 1);
  });

  console.log('\n[增量 · check 暴露增量入口]');
  await atest('check() 同时认出清单与代码包，完整包仍在', async () => {
    const exe = path.join(TMP, 'check', 'ApkStart.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'x');
    const u = new Updater({ currentVersion: '0.6.2', exePath: exe, isPackaged: true, dataDir: path.join(TMP, 'check-data'), electronVersion: '33.4.11' });
    u.sources.latest = async () => ({
      version: '0.6.3', tag: 'v0.6.3', notes: '', htmlUrl: '', publishedAt: '',
      assets: [
        { name: 'ApkStart-v0.6.3-manifest.json', size: 1, url: 'https://x/m', urls: ['https://x/m'], sizes: {} },
        { name: 'ApkStart-v0.6.3-app.zip', size: 2, url: 'https://x/a', urls: ['https://x/a'], sizes: {} },
        { name: 'ApkStart-v0.6.3-win64-portable.zip', size: 3, url: 'https://x/f', urls: ['https://x/f'], sizes: {} },
      ],
      sources: [], unreachable: [],
    });
    const info = await u.check();
    assert(info.incremental && info.incremental.manifest.name.endsWith('manifest.json'), '没认出清单');
    assert(info.incremental.app.name.endsWith('app.zip'), '没认出代码包');
    assert(info.asset && info.asset.name.endsWith('portable.zip'), '完整包兜底丢了');
    assert(info.hasUpdate);
  });

  console.log('\n[增量 · apply 脚本与续做]');
  test('app 模式脚本只替换 resources/app、失败回滚并双路径重启', () => {
    const dataDir = path.join(TMP, 'apply');
    const exe = path.join(dataDir, 'ApkStart.exe');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(exe, 'old');
    const u = new Updater({ currentVersion: '0.6.2', exePath: exe, isPackaged: true, dataDir });
    const payload = path.join(dataDir, 'update', '0.6.3', 'app-payload');
    fs.mkdirSync(path.join(payload, 'resources', 'app'), { recursive: true });
    fs.writeFileSync(path.join(payload, 'resources', 'app', 'package.json'), '{"version":"0.6.3"}');
    const script = u.apply({ mode: 'app', payload, version: '0.6.3' }, { spawn: false });
    assert(/Join-Path \$appDst 'package\.json'/.test(script) || /'package\.json'/.test(script), '没校验 package.json');
    assert(/Move-Item -LiteralPath \$appDst -Destination \$backup/.test(script), '没备份 app 目录');
    assert(/app copy FAILED - rollback and keep payload/.test(script), '失败没回滚/保留载荷');
    assert(/Start-Process -FilePath/.test(script) && /cmd\.exe/.test(script), '重启没兜底');
    assert(!/Join-Path \$src '\*'\) -Destination \$dst -Recurse/.test(script), '不应整目录覆盖外壳');
  });

  test('增量应用失败标记强制完整包，脚本写标记且不再续做坏载荷', () => {
    const dataDir = path.join(TMP, 'forcefull');
    const exe = path.join(dataDir, 'ApkStart.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'x');
    const u = new Updater({ currentVersion: '0.6.2', exePath: exe, isPackaged: true, dataDir });
    const payload = path.join(dataDir, 'update', '0.6.3', 'app-payload');
    fs.mkdirSync(path.join(payload, 'resources', 'app'), { recursive: true });
    fs.writeFileSync(path.join(payload, 'resources', 'app', 'package.json'), '{}');
    u._markPayloadReady(payload, '0.6.3', 'app');
    assert(u.findResumableJob().mode === 'app', '标记前可续做');
    fs.writeFileSync(path.join(dataDir, 'update', '0.6.3', '.apkstart-force-full'), '');
    assert(u.findResumableJob() === null, '标记后不能再续做增量');
    const script = u.apply({ mode: 'app', payload, version: '0.6.3' }, { spawn: false });
    assert(/\.apkstart-force-full/.test(script), 'apply 失败分支要写强制完整包标记');
  });

  test('增量载荷可被 findResumableJob 找回，完整载荷仍兼容', () => {
    const dataDir = path.join(TMP, 'resume');
    const exe = path.join(dataDir, 'ApkStart.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'x');
    const u = new Updater({ currentVersion: '0.6.2', exePath: exe, isPackaged: true, dataDir });
    const appPayload = path.join(dataDir, 'update', '0.6.3', 'app-payload');
    fs.mkdirSync(path.join(appPayload, 'resources', 'app'), { recursive: true });
    fs.writeFileSync(path.join(appPayload, 'resources', 'app', 'package.json'), '{}');
    u._markPayloadReady(appPayload, '0.6.3', 'app');
    const job = u.findResumableJob();
    assert(job && job.mode === 'app' && job.version === '0.6.3', `应找回 app 续做，实际 ${JSON.stringify(job)}`);

    const zipPayload = path.join(dataDir, 'update', '0.6.4', 'payload');
    fs.mkdirSync(zipPayload, { recursive: true });
    fs.writeFileSync(path.join(zipPayload, 'ApkStart.exe'), 'new');
    u._markPayloadReady(zipPayload, '0.6.4', 'zip');
    // 0.6.4 排在 0.6.3 前面
    const job2 = u.findResumableJob();
    assert(job2 && job2.mode === 'zip' && job2.version === '0.6.4', '完整载荷续做回归');
  });

  console.log('\n[增量 · 构建产物]');
  test('build/incremental.js 生成合法清单与代码包', async () => {
    const fixture = path.join(TMP, 'portable');
    fs.mkdirSync(path.join(fixture, 'resources', 'app', 'src'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'ApkStart.exe'), 'shell-bytes-not-in-app-pack');
    fs.writeFileSync(path.join(fixture, 'resources', 'app', 'package.json'), '{"version":"0.6.3","name":"apkstart"}');
    fs.writeFileSync(path.join(fixture, 'resources', 'app', 'src', 'main.js'), 'console.log("incremental")');
    const out = path.join(TMP, 'assets');
    const { build } = require('../build/incremental');
    const r = await build(fixture, 'v0.6.3', out);
    assert(fs.existsSync(r.manifestPath) && fs.existsSync(r.appZip), '没生成两个资产');
    const m = inc.parseManifest(fs.readFileSync(r.manifestPath, 'utf8'));
    assert(m.version === '0.6.3' && m.electronVersion, '清单版本 / Electron 版本不对');
    assert(m.app.files['resources/app/src/main.js'], '清单没列出 app 文件');
    assert(!m.app.files['ApkStart.exe'], '外壳不能进增量清单');
    const zf = new ZipFile(r.appZip);
    const names = zf.names();
    assert(names.some((n) => /resources\/app\/package\.json/.test(n)), `代码包缺 package.json：${names}`);
    assert(!names.some((n) => /ApkStart\.exe/.test(n)), '代码包不该含外壳 exe');
    zf.close();
  });

  console.log(`\n增量更新测试：${passed} 通过，${failed} 失败\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试崩溃：', e);
  process.exit(1);
});
