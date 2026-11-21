'use strict';
/**
 * 增量更新测试：清单校验、模式选择、逐文件哈希校验、apply 脚本、续做。
 * 全部离线，不访问 GitHub / Gitee。
 *
 * 用例全部注册后由 runAll() 顺序执行，每个用例都被 await（同步抛错与
 * Promise 拒收同等计入失败）。旧实现的 `test()` 只调用 fn() 就立刻记 ✓，
 * 异步用例的晚到断言失败会被随后的 process.exit() 吞掉、退出码仍是 0
 * （T-WEB-002 缺陷 3，证据见 evidence/incremental-test-baseline-latefail.log）。
 *
 * 反向自检：`APKSTART_TEST_LATE_FAIL=1 node test/incremental-test.js` 会追加
 * 一个延迟 25ms 后必然失败的用例 —— 正常跑必须 exit 0，设了必须 exit 1。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Updater } = require('../src/core/updater');
const inc = require('../src/core/incremental');
const { ZipFile } = require('../src/core/zip');

let passed = 0;
let failed = 0;

/** 已注册用例 / 段落标题，按注册顺序执行（注册顺序 == 源码顺序）。 */
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }
function section(title) { cases.push({ section: title }); }

async function runAll() {
  for (const c of cases) {
    if (c.section) { console.log(c.section); continue; }
    try {
      // 关键：await 用例返回值。藏在 Promise 里的断言失败必须记在案、且等它落地。
      await c.fn();
      passed++;
      console.log(`  ✓ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${c.name}\n    ${e && e.message ? e.message : e}`);
    }
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// 未 await 的游离 Promise 拒收也要让退出码非零（防回归安全网）。
process.on('unhandledRejection', (e) => {
  failed++;
  console.error(`  ✗ 未处理的异步失败\n    ${e && e.message ? e.message : e}`);
});

/** 最小 STORED zip 构造器（R4 身份测试用）：只装 entries（{name,data}），无压缩。 */
function buildAppZip(entries) {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = (table[(c ^ b) & 0xFF] ^ (c >>> 8)) >>> 0;
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const locals = []; const cds = []; let off = 0;
  for (const { name: n, data: content } of entries) {
    const name = Buffer.from(n, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(off, 42);
    name.copy(central, 46);
    locals.push(local, data);
    cds.push(central);
    off += local.length + data.length;
  }
  const cd = Buffer.concat(cds);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const TMP = path.join(__dirname, 'out', 'incremental');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const sampleFiles = {
  'resources/app/package.json': { sha256: 'AAA', size: 3 },
  'resources/app/src/main.js': { sha256: 'BBB', size: 9 },
};

section('\n[增量 · 清单与模式选择]');
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

section('\n[增量 · 哈希校验]');
{
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

  test('inspectLocal 找出缺失与变更', async () => {
    const r = await inc.inspectLocal({ installDir: dir, files, hash });
    assert(r.missing.length === 1 && r.missing[0] === 'resources/app/src/gone.js', `missing=${r.missing}`);
    assert(r.changed.length === 0, `changed=${r.changed}`);
    assert(!r.ok);
  });

  test('verifyExtracted 全对才通过，篡改即拦下', async () => {
    const ok = { 'resources/app/package.json': files['resources/app/package.json'] };
    assert((await inc.verifyExtracted({ payload: dir, files: ok, hash })).length === 0);
    const bad = { 'resources/app/package.json': { sha256: '0'.repeat(64) } };
    assert((await inc.verifyExtracted({ payload: dir, files: bad, hash })).length === 1);
  });
}

section('\n[增量 · check 暴露增量入口]');
test('check() 同时认出清单与代码包，完整包仍在', async () => {
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

section('\n[增量 · apply 脚本与续做]');
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

section('\n[增量 · apply 脚本与续做（R4 身份闭环）]');
test('增量应用失败标记强制完整包，脚本写标记且不再续做坏载荷', async () => {
  const dataDir = path.join(TMP, 'forcefull');
  const exe = path.join(dataDir, 'ApkStart.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, 'x');
  const u = new Updater({ currentVersion: '0.6.2', exePath: exe, isPackaged: true, dataDir });
  u._metadataTimeoutMs = 300;
  const payload = path.join(dataDir, 'update', '0.6.3', 'app-payload');
  fs.mkdirSync(path.join(payload, 'resources', 'app'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'resources', 'app', 'package.json'), '{}');
  u._markPayloadReady(payload, '0.6.3', undefined, 'app');
  // [R4] marker 单独不再授权启动续做：拿不到官方身份（离线/无 digest）必须 null。
  u.sources.latest = async () => ({ version: '0.6.3', tag: 'v0.6.3', stale: false, assets: [] });
  assert(await u.findResumableJob() === null, 'marker 单独不得授权增量续做');

  // 官方身份在场时（anchored app.zip），强制完整包标记是唯一的禁做开关。
  // 归档必须是真 app.zip（只含 resources/app/**，没有 exe）：
  // 续做会从它重建载荷，缺 package.json / 塞 exe 的假包都会在重建时被拒。
  const APP_ZIP = 'ApkStart-v0.6.3-app.zip';
  const appZip = buildAppZip([
    { name: 'resources/app/package.json', data: Buffer.from('{"version":"0.6.3"}') },
  ]);
  const appArchive = path.join(dataDir, 'update', '0.6.3', APP_ZIP);
  fs.writeFileSync(appArchive, appZip);
  u.sources.latest = async () => ({
    version: '0.6.3', tag: 'v0.6.3', stale: false,
    assets: [{ name: APP_ZIP, size: appZip.length, url: 'https://x/a', urls: ['https://x/a'], sizes: {}, source: 'github', digest: sha(appZip), digestUrl: 'https://x/a' }],
  });
  const job1 = await u.findResumableJob();
  assert(job1 && job1.mode === 'app', '官方身份 + 已验证归档应可续做');
  fs.writeFileSync(path.join(dataDir, 'update', '0.6.3', '.apkstart-force-full'), '');
  assert(await u.findResumableJob() === null, '强制完整包标记后不能再续做增量');
  const script = u.apply({ mode: 'app', payload, version: '0.6.3' }, { spawn: false });
  assert(/\.apkstart-force-full/.test(script), 'apply 失败分支要写强制完整包标记');
});

test('增量载荷经官方身份校验后可被 findResumableJob 找回，完整载荷仍兼容', async () => {
  const dataDir = path.join(TMP, 'resume');
  const exe = path.join(dataDir, 'ApkStart.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, 'x');
  const u = new Updater({ currentVersion: '0.6.2', exePath: exe, isPackaged: true, dataDir });
  u._metadataTimeoutMs = 300;
  const APP_ZIP = 'ApkStart-v0.6.3-app.zip';
  // 官方增量代码包夹具：resources/app/package.json（0.6.3）
  const APP_PKG = Buffer.from('{"version":"0.6.3"}');
  const appZip = buildAppZip([
    { name: 'resources/app/package.json', data: APP_PKG },
    { name: 'resources/app/src/main.js', data: Buffer.from('console.log("9.9.9")') },
  ]);
  const appArchive = path.join(dataDir, 'update', '0.6.3', APP_ZIP);
  fs.mkdirSync(path.dirname(appArchive), { recursive: true });
  fs.writeFileSync(appArchive, appZip);
  // prepare() 成功落盘后会留下 app-payload + mode:app marker；续做入口用它判断
  // 「上次准备过」。字节是否可信与它无关 —— 重建只认官方 digest + 归档 SHA-256。
  const appPayload = path.join(dataDir, 'update', '0.6.3', 'app-payload');
  fs.mkdirSync(path.join(appPayload, 'resources', 'app'), { recursive: true });
  fs.writeFileSync(path.join(appPayload, 'resources', 'app', 'package.json'), '{"version":"0.6.2"}');
  u._markPayloadReady(appPayload, '0.6.3', undefined, 'app');
  u.sources.latest = async () => ({
    version: '0.6.3', tag: 'v0.6.3', stale: false,
    assets: [{ name: APP_ZIP, size: appZip.length, url: 'https://x/a', urls: ['https://x/a'], sizes: {}, source: 'github', digest: sha(appZip), digestUrl: 'https://x/a' }],
  });
  const job = await u.findResumableJob();
  assert(job && job.mode === 'app' && job.version === '0.6.3', `应找回 app 续做，实际 ${JSON.stringify(job)}`);
  // 重建后的载荷来自已验证归档（旧载荷的 0.6.2 字节不得留下）
  assert(fs.readFileSync(path.join(job.payload, 'resources', 'app', 'package.json')).equals(APP_PKG), '载荷应来自已验证归档');
  const m = JSON.parse(fs.readFileSync(path.join(job.payload, '.apkstart-ready'), 'utf8'));
  assert(m.digest === sha(appZip) && m.assetName === APP_ZIP, 'marker 应记录官方身份');
  assert(m.mode === 'app', 'marker 应标记 app 模式');

  // 完整载荷（无锚遗留形态，仅 marker + exe，且归档缺失 → 拿不到官方身份 → 不动它）
  const zipPayload = path.join(dataDir, 'update', '0.6.4', 'payload');
  fs.mkdirSync(zipPayload, { recursive: true });
  fs.writeFileSync(path.join(zipPayload, 'ApkStart.exe'), 'new');
  u._markPayloadReady(zipPayload, '0.6.4', 'zip');
  // 0.6.4 不等于官方最新版本（0.6.3）→ 交回查新流程，不该被续做
  const job2 = await u.findResumableJob();
  assert(job2 === null || job2.version === '0.6.3', '过期版本目录不得抢在官方版本前续做');
});

section('\n[增量 · 构建产物]');
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

// 受控反向验证：延迟后必然失败的用例只能通过「await + 完成后才 tally/exit」
// 才可能影响退出码。未设该变量时正常 GREEN 必须 exit 0。
if (process.env.APKSTART_TEST_LATE_FAIL === '1') {
  test('CONTROLLED late async failure (must make exit nonzero)', async () => {
    await new Promise((r) => setTimeout(r, 25));
    assert(false, 'controlled late assertion failure');
  });
}

(async () => {
  await runAll();
  console.log(`\n增量更新测试：${passed} 通过，${failed} 失败\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试崩溃：', e);
  process.exit(1);
});
