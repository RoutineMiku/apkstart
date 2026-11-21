'use strict';
/**
 * [T-WEB-002] 增量（app-payload）续做与「代码包字节来源」回归测试。
 *
 * 覆盖 e18977b 的真实缺陷：
 *   R1 findResumableJob 只取便携整包锚（portable-first），双资产发布里官方
 *      app.zip 被忽略 → 增量续做永远 null；
 *   R2 只有 app.zip 的发布（没有 portable）→ 连锚都取不到；
 *   R3 _rebuildPayloadFromArchive 无条件要求 ApkStart.exe，而官方 app.zip 只含
 *      resources/app/** → app 续做/准备必然失败；
 *   R4 _prepareApp 在归档刚校验通过后只凭 marker 复用旧 app-payload → 被篡改
 *      的载荷字节可被原样复用。
 *
 * 夹具是**真 ZIP 字节**（STORED，无 exe），全程走真实代码路径：不 stub
 * _rebuildPayloadFromArchive、不改身份链。`_prepareApp` 用 127.0.0.1 本地
 * HTTP 服务器提供清单与代码包，完全离线。
 *
 * 用例注册后统一 await 执行（与 test/incremental-test.js 同一套契约：
 * 晚到的断言失败必须让退出码非零）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { Updater } = require('../src/core/updater');
const inc = require('../src/core/incremental');

const VERSION = '0.6.3';
const CURRENT = '0.6.2';
const APP_NAME = `ApkStart-v${VERSION}-app.zip`;
const PORTABLE_NAME = `ApkStart-v${VERSION}-win64-portable.zip`;
const MANIFEST_NAME = `ApkStart-v${VERSION}-manifest.json`;

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const APP_PKG = Buffer.from('{"version":"0.6.3","name":"apkstart"}');
const APP_JS = Buffer.from('console.log("tiny app fixture");');

/** 最小 STORED zip 构造器：entries = [{name, data}]，不压缩。 */
function buildZip(entries) {
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

/** 官方 app.zip 形状：只有 resources/app/**，没有 exe。 */
const appZip = buildZip([
  { name: 'resources/app/package.json', data: APP_PKG },
  { name: 'resources/app/src/main.js', data: APP_JS },
]);
const portableZip = buildZip([
  { name: 'ApkStart.exe', data: Buffer.from('portable-shell') },
  { name: 'resources/app/package.json', data: APP_PKG },
]);
const manifestBody = Buffer.from(JSON.stringify({
  schema: 1, version: VERSION, electronVersion: '33.4.11',
  app: {
    asset: APP_NAME,
    sha256: sha(appZip),
    files: {
      'resources/app/package.json': { sha256: sha(APP_PKG), size: APP_PKG.length },
      'resources/app/src/main.js': { sha256: sha(APP_JS), size: APP_JS.length },
    },
  },
}));

// ---------------------------------------------------------------- 用例运行器
let passed = 0;
let failed = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }
function section(title) { cases.push({ section: title }); }
async function runAll() {
  for (const c of cases) {
    if (c.section) { console.log(c.section); continue; }
    try { await c.fn(); passed++; console.log(`  ✓ ${c.name}`); }
    catch (e) { failed++; console.error(`  ✗ ${c.name}\n    ${e && e.message ? e.message : e}`); }
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function assertRejects(fn, re) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert(err && re.test(String(err.message)), `应抛错匹配 ${re}，实际 ${err ? err.message : '未抛错'}`);
}
process.on('unhandledRejection', (e) => {
  failed++;
  console.error(`  ✗ 未处理的异步失败\n    ${e && e.message ? e.message : e}`);
});

// ---------------------------------------------------------------- 夹具
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-tweb002-app-'));

function asset(name, buf, base) {
  const url = base ? `${base}${name}` : `https://example.invalid/${name}`;
  return {
    name, size: buf.length, url, urls: [url], sizes: { [url]: buf.length },
    source: 'github', digest: sha(buf), digestUrl: `https://api.github.invalid/${name}`,
  };
}

/** 每个用例独立的 Updater + 更新根。 */
function makeUpdater(root, latest) {
  const dataDir = path.join(root, 'data');
  const exe = path.join(root, 'install', 'ApkStart.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, 'current-shell');
  const u = new Updater({
    currentVersion: CURRENT, exePath: exe, isPackaged: true, dataDir, electronVersion: '33.4.11',
  });
  u._metadataTimeoutMs = 500;
  if (latest) u.sources.latest = latest;
  return u;
}

/** 造出「prepare 已完成、apply 未成功」的现场：归档 + app-payload + mode:app marker。 */
function seedAppJob(u, { archiveBytes = appZip, archiveName = APP_NAME, stale = true } = {}) {
  const dir = path.join(u.updateDir, VERSION);
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, archiveName);
  fs.writeFileSync(archive, archiveBytes);
  const payload = path.join(dir, 'app-payload');
  fs.mkdirSync(path.join(payload, 'resources', 'app'), { recursive: true });
  if (stale) {
    // 旧载荷故意与归档不同：续做必须从已验证归档重建，不能复用这些字节。
    fs.writeFileSync(path.join(payload, 'resources', 'app', 'package.json'), '{"version":"0.6.2"}');
    fs.writeFileSync(path.join(payload, 'resources', 'app', 'extra.js'), 'stale-local-byte');
  } else {
    fs.writeFileSync(path.join(payload, 'resources', 'app', 'package.json'), APP_PKG);
  }
  u._markPayloadReady(payload, VERSION, undefined, 'app');
  return { dir, archive, payload };
}

const dualMeta = () => ({
  version: VERSION, tag: `v${VERSION}`, stale: false,
  assets: [asset(MANIFEST_NAME, manifestBody), asset(APP_NAME, appZip), asset(PORTABLE_NAME, portableZip)],
});
const appOnlyMeta = () => ({
  version: VERSION, tag: `v${VERSION}`, stale: false,
  assets: [asset(MANIFEST_NAME, manifestBody), asset(APP_NAME, appZip)],
});

/** 断言 app 续做得到的载荷来自归档、marker 记官方身份。 */
function assertHonestAppJob(job, sealed) {
  assert(job && job.mode === 'app', `应得到 app 续做，实际 ${JSON.stringify(job)}`);
  assert(job.version === VERSION, '版本应为官方发布版本');
  assert(job.payload === sealed.payload, 'payload 应是 app-payload 目录');
  const pkg = fs.readFileSync(path.join(job.payload, 'resources', 'app', 'package.json'));
  assert(pkg.equals(APP_PKG), `载荷 package.json 必须来自已验证归档，实际 ${pkg.toString()}`);
  assert(!fs.existsSync(path.join(job.payload, 'resources', 'app', 'extra.js')), '旧载荷的 stale extra.js 必须消失');
  assert(!fs.existsSync(path.join(job.payload, 'ApkStart.exe')), 'app 载荷不得包含/伪造 exe');
  const m = JSON.parse(fs.readFileSync(path.join(sealed.payload, '.apkstart-ready'), 'utf8'));
  assert(m.mode === 'app', 'marker 必须标记 mode:app');
  assert(m.digest === sha(appZip), 'marker 必须记录官方 app.zip digest');
  assert(m.assetName === APP_NAME, 'marker 必须记录官方资产名');
}

// ---------------------------------------------------------------- 用例
section('\n[T-WEB-002 · 增量续做：一次元数据取双锚]');

test('R1 双资产发布：双 metadata（app.zip + portable.zip）→ mode app，字节来自已验证归档', async () => {
  const u = makeUpdater(path.join(TMP, 'dual'));
  const sealed = seedAppJob(u);
  let fetches = 0;
  u.sources.latest = async (o) => { fetches++; assert(o && o.force === true, '续做必须 force:true'); return dualMeta(); };
  const job = await u.findResumableJob();
  assertHonestAppJob(job, sealed);
  assert(fetches === 1, `每次 findResumableJob 只允许一次元数据拉取，实际 ${fetches}`);
});

test('R2 只有 app.zip 的发布：app 续做可用，且 app.zip 不得被当成便携整包锚', async () => {
  const u = makeUpdater(path.join(TMP, 'apponly'));
  const sealed = seedAppJob(u);
  let fetches = 0;
  const meta = appOnlyMeta();
  u.sources.latest = async (o) => { fetches++; assert(o.force === true, '续做必须 force:true'); return meta; };
  // 便携整包锚必须为空（app.zip 是辅助资产）；增量锚必须命中。
  assert(await u._officialUpdateAsset(meta) === null, 'app.zip 不得当便携整包锚');
  assert(await u._officialIncrementalAsset(meta) !== null, 'app.zip 必须有增量锚');
  const job = await u.findResumableJob();
  assertHonestAppJob(job, sealed);
  assert(fetches === 1, `每次 findResumableJob 只允许一次元数据拉取，实际 ${fetches}`);
});

test('R3 便携整包续做仍返回 mode zip（P34/身份门不变）', async () => {
  const u = makeUpdater(path.join(TMP, 'portable'), async () => dualMeta());
  const dir = path.join(u.updateDir, VERSION);
  fs.mkdirSync(path.join(dir, 'payload'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'payload', 'ApkStart.exe'), 'portable-shell');
  fs.writeFileSync(path.join(dir, PORTABLE_NAME), portableZip);
  u._markPayloadReady(path.join(dir, 'payload'), VERSION, { digest: sha(portableZip), assetName: PORTABLE_NAME });
  const job = await u.findResumableJob();
  assert(job && job.mode === 'zip' && job.version === VERSION, `应得到 zip 续做，实际 ${JSON.stringify(job)}`);
  const m = JSON.parse(fs.readFileSync(path.join(job.payload, '.apkstart-ready'), 'utf8'));
  assert(m.digest === sha(portableZip) && m.assetName === PORTABLE_NAME, 'zip marker 身份不变');
});

section('\n[T-WEB-002 · 失败必须 fail closed 且保留数据]');

/** 「拒绝续做且数据一字未动」的公共断言。 */
async function assertRejectedKeepsData(mutate, label) {
  const u = makeUpdater(path.join(TMP, label), async () => dualMeta());
  const sealed = seedAppJob(u);
  const before = {
    archive: sha(fs.readFileSync(sealed.archive)),
    payload: sha(fs.readFileSync(path.join(sealed.payload, 'resources', 'app', 'package.json'))),
    extra: sha(fs.readFileSync(path.join(sealed.payload, 'resources', 'app', 'extra.js'))),
    marker: sha(fs.readFileSync(path.join(sealed.payload, '.apkstart-ready'))),
  };
  await mutate(u, sealed);
  const job = await u.findResumableJob();
  assert(job === null, `${label}：应拒绝续做，实际 ${JSON.stringify(job)}`);
  assert(fs.existsSync(sealed.archive), `${label}：归档不得被删除`);
  const after = {
    archive: sha(fs.readFileSync(sealed.archive)),
    payload: sha(fs.readFileSync(path.join(sealed.payload, 'resources', 'app', 'package.json'))),
    extra: sha(fs.readFileSync(path.join(sealed.payload, 'resources', 'app', 'extra.js'))),
    marker: sha(fs.readFileSync(path.join(sealed.payload, '.apkstart-ready'))),
  };
  for (const k of Object.keys(before)) assert(before[k] === after[k], `${label}：${k} 必须字节不变`);
}

test('R4 官方 digest 与归档字节不符 → null，归档/载荷/marker 原样保留', async () => {
  await assertRejectedKeepsData((u) => {
    const bad = dualMeta();
    bad.assets = bad.assets.map((a) => (a.name === APP_NAME ? { ...a, digest: 'b'.repeat(64) } : a));
    u.sources.latest = async () => bad;
  }, 'wrong-digest');
});

test('R5 归档缺失 → null，载荷/marker 原样保留', async () => {
  const u = makeUpdater(path.join(TMP, 'missing-archive'), async () => dualMeta());
  const sealed = seedAppJob(u);
  const before = {
    payload: sha(fs.readFileSync(path.join(sealed.payload, 'resources', 'app', 'package.json'))),
    marker: sha(fs.readFileSync(path.join(sealed.payload, '.apkstart-ready'))),
  };
  fs.rmSync(sealed.archive);
  const job = await u.findResumableJob();
  assert(job === null, `归档缺失应拒绝续做，实际 ${JSON.stringify(job)}`);
  assert(!fs.existsSync(sealed.archive), '缺失的归档不得被重建');
  const after = {
    payload: sha(fs.readFileSync(path.join(sealed.payload, 'resources', 'app', 'package.json'))),
    marker: sha(fs.readFileSync(path.join(sealed.payload, '.apkstart-ready'))),
  };
  assert(before.payload === after.payload && before.marker === after.marker, '载荷与 marker 必须字节不变');
});

test('R6 归档被篡改（同名字节不同）→ null，数据全部原样保留', async () => {
  const u = makeUpdater(path.join(TMP, 'tampered-archive'), async () => dualMeta());
  const sealed = seedAppJob(u);
  const tampered = buildZip([
    { name: 'resources/app/package.json', data: Buffer.from('{"version":"6.6.6"}') },
  ]);
  fs.writeFileSync(sealed.archive, tampered);
  const snap = () => ({
    archive: sha(fs.readFileSync(sealed.archive)),
    payload: sha(fs.readFileSync(path.join(sealed.payload, 'resources', 'app', 'package.json'))),
    extra: sha(fs.readFileSync(path.join(sealed.payload, 'resources', 'app', 'extra.js'))),
    marker: sha(fs.readFileSync(path.join(sealed.payload, '.apkstart-ready'))),
  });
  const before = snap();
  const job = await u.findResumableJob();
  assert(job === null, `篡改的归档应拒绝续做，实际 ${JSON.stringify(job)}`);
  const after = snap();
  for (const k of Object.keys(before)) assert(before[k] === after[k], `${k} 必须字节不变（不得修复/删除篡改证据）`);
});

test('R7 官方资产名与留存归档不一致 → null，载荷保留', async () => {
  const u = makeUpdater(path.join(TMP, 'renamed'), async () => dualMeta());
  const sealed = seedAppJob(u, { archiveName: `ApkStart-v${VERSION}-app-other.zip` });
  const before = sha(fs.readFileSync(path.join(sealed.payload, 'resources', 'app', 'package.json')));
  const job = await u.findResumableJob();
  assert(job === null, '资产名不一致不得续做');
  assert(sha(fs.readFileSync(path.join(sealed.payload, 'resources', 'app', 'package.json'))) === before, '载荷保留');
});

test('R8 .apkstart-force-full 阻断 app 续做（身份齐全也不做）', async () => {
  const u = makeUpdater(path.join(TMP, 'forcefull'), async () => dualMeta());
  const sealed = seedAppJob(u);
  fs.writeFileSync(path.join(sealed.dir, '.apkstart-force-full'), '');
  assert(await u.findResumableJob() === null, '强制完整包标记必须阻断增量续做');
  assert(fs.existsSync(sealed.archive) && fs.existsSync(sealed.payload), '阻断时数据保留');
});

section('\n[T-WEB-002 · _prepareApp：归档是唯一字节来源]');

function startServer(routes) {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(String(req.url || '/').split('?')[0].replace(/^\/+/, ''));
    const body = routes[name];
    if (!body) { res.writeHead(404, { 'Content-Length': 0 }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function prepareInfo(base) {
  const manifest = inc.parseManifest(manifestBody.toString('utf8'));
  return {
    version: VERSION, hasUpdate: true,
    incremental: {
      manifest: asset(MANIFEST_NAME, manifestBody, base),
      app: asset(APP_NAME, appZip, base),
    },
    assets: [asset(APP_NAME, appZip, base), asset(MANIFEST_NAME, manifestBody, base)],
    manifest,
  };
}

test('R9 本地 HTTP：首次 prepare 得到 mode app；被篡改的旧载荷从刚校验的归档重建', async () => {
  const routes = { [MANIFEST_NAME]: manifestBody, [APP_NAME]: appZip };
  const server = await startServer(routes);
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
    const u = makeUpdater(path.join(TMP, 'prepare'));
    const info = prepareInfo(base);
    const dir = path.join(u.updateDir, VERSION);

    const first = await u._prepareApp(info, dir);
    assert(first && first.mode === 'app', `首次应走增量，实际 ${JSON.stringify(first)}`);
    assert(fs.readFileSync(path.join(first.payload, 'resources', 'app', 'package.json')).equals(APP_PKG), '载荷来自代码包');
    assert(!fs.existsSync(path.join(first.payload, 'ApkStart.exe')), '代码包不含也不伪造 exe');
    const m1 = JSON.parse(fs.readFileSync(path.join(first.payload, '.apkstart-ready'), 'utf8'));
    assert(m1.mode === 'app' && m1.version === VERSION, `首次 marker 应为 mode:app，实际 ${JSON.stringify(m1)}`);

    // 模拟「替换失败 + 载荷被改」：marker 还在、字节已不可信。
    fs.writeFileSync(path.join(first.payload, 'resources', 'app', 'package.json'), '{"version":"0.0.1"}');
    fs.writeFileSync(path.join(first.payload, 'resources', 'app', 'extra.js'), 'stale-local-byte');

    const second = await u._prepareApp(info, dir);
    assert(second && second.mode === 'app', '第二次仍应走增量');
    const pkg = fs.readFileSync(path.join(second.payload, 'resources', 'app', 'package.json'));
    assert(pkg.equals(APP_PKG), `必须从刚校验的归档重建，实际 ${pkg.toString()}`);
    assert(!fs.existsSync(path.join(second.payload, 'resources', 'app', 'extra.js')), '被篡改的 stale 文件必须消失');
    const m2 = JSON.parse(fs.readFileSync(path.join(second.payload, '.apkstart-ready'), 'utf8'));
    assert(m2.mode === 'app', '复用后 marker 仍是 mode:app');

    // 归档与准备产物能直接支撑续做（同一条身份链）。
    u.sources.latest = async () => dualMeta();
    const job = await u.findResumableJob();
    assertHonestAppJob(job, { payload: second.payload });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('R10 清单 sha256 与下载到的代码包不符 → 抛错且旧载荷字节不变（不复用）', async () => {
  const corrupted = Buffer.concat([appZip, Buffer.from('tampered-tail')]);
  const routes = { [MANIFEST_NAME]: manifestBody, [APP_NAME]: corrupted };
  const server = await startServer(routes);
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
    const u = makeUpdater(path.join(TMP, 'prepare-badhash'));
    const info = prepareInfo(base);
    const dir = path.join(u.updateDir, VERSION);
    fs.mkdirSync(path.join(dir, 'app-payload', 'resources', 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app-payload', 'resources', 'app', 'package.json'), '{"version":"0.6.2"}');
    u._markPayloadReady(path.join(dir, 'app-payload'), VERSION, undefined, 'app');
    const before = sha(fs.readFileSync(path.join(dir, 'app-payload', 'resources', 'app', 'package.json')));

    await assertRejects(() => u._prepareApp(info, dir), /校验失败/);
    assert(sha(fs.readFileSync(path.join(dir, 'app-payload', 'resources', 'app', 'package.json'))) === before, '旧载荷保留');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('R11 代码包缺 resources/app/package.json → 重建拒绝且旧载荷字节不变', async () => {
  const noPkg = buildZip([{ name: 'resources/app/src/main.js', data: APP_JS }]);
  const manifestNoPkg = Buffer.from(JSON.stringify({
    schema: 1, version: VERSION, electronVersion: '33.4.11',
    app: {
      asset: APP_NAME,
      sha256: sha(noPkg),
      files: { 'resources/app/src/main.js': { sha256: sha(APP_JS), size: APP_JS.length } },
    },
  }));
  const routes = { [MANIFEST_NAME]: manifestNoPkg, [APP_NAME]: noPkg };
  const server = await startServer(routes);
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
    const u = makeUpdater(path.join(TMP, 'prepare-nopkg'));
    const info = {
      version: VERSION, hasUpdate: true,
      incremental: { manifest: asset(MANIFEST_NAME, manifestNoPkg, base), app: asset(APP_NAME, noPkg, base) },
      assets: [asset(APP_NAME, noPkg, base)],
    };
    const dir = path.join(u.updateDir, VERSION);
    fs.mkdirSync(path.join(dir, 'app-payload', 'resources', 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app-payload', 'resources', 'app', 'package.json'), '{"version":"0.6.2"}');
    u._markPayloadReady(path.join(dir, 'app-payload'), VERSION, undefined, 'app');
    const before = sha(fs.readFileSync(path.join(dir, 'app-payload', 'resources', 'app', 'package.json')));

    await assertRejects(() => u._prepareApp(info, dir), /package\.json/);
    assert(sha(fs.readFileSync(path.join(dir, 'app-payload', 'resources', 'app', 'package.json'))) === before, '旧载荷保留');
    assert(fs.readdirSync(dir).filter((n) => n.startsWith('payload.staging-')).length === 0, 'staging 已清理');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

(async () => {
  await runAll();
  console.log(`\nT-WEB-002 增量续做测试：${passed} 通过，${failed} 失败\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试崩溃：', e);
  process.exit(1);
});
