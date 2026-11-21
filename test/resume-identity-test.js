'use strict';
/**
 * 启动续做（boot resume）身份闭环回归测试（R4，纯 Node + OS TEMP，全离线）。
 *
 * 背景（GPT6-PR3-POSTREVIEW-HOLD.md）：PR3 的 `_payloadReady(payload,v,expectIdentity)`
 * 有身份校验，但 `findResumableJob()` 以两参调用绕过了它；main.js 启动时拿到 job
 * 直接 `updater.apply(job)` —— 遗留/伪造 marker 就能自动执行未验证载荷。
 *
 * R4 契约（本测试断言的目标行为）：
 *   C1 findResumableJob 变为 async；期望身份只来自官方 release 元数据
 *      （sources.latest 的 digest/digestUrl，即 TLS 到 api.github.com 的锚），
 *      marker 字段只是本地声明，永不作为信任根；
 *   C2 只有「目录版本 == 官方最新版本 && 留存归档 SHA256 == 官方 digest」
 *      的载荷才允许自动续做；归档缺失/字节不符/无锚元数据/离线 → 返回 null
 *      （fail closed），且保留可恢复数据、绝不拖垮启动；
 *   C3 通过校验的续做一律从已验证归档重建载荷（旧载荷字节永不直接信任），
 *      不发生第二次整包下载；
 *   C4 畸形/投毒 marker、穿越资产名/版本目录一律拒绝；
 *   C5 prepare() 锚定路径不再按 marker 复用旧载荷（一律重解压刚验证的归档）；
 *      无锚手动路径保持 PR2 复用语义（身份 UNVERIFIED，如实标注）；
 *   C6 main.js 启动编排抽到 core/boot-resume.js（可测）：await 之后的 job
 *      才交给 apply，命中续做不并行发起新一轮 check，错误不拖垮启动。
 *
 * 运行：node test/resume-identity-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const W = path.resolve(__dirname, '..');
const { Updater } = require(path.join(W, 'src', 'core', 'updater.js'));
const { bootResume } = require(path.join(W, 'src', 'core', 'boot-resume.js'));
const { UpdateGate } = require(path.join(W, 'src', 'core', 'update-orchestrator.js'));

let passed = 0;
let failed = 0;
async function atest(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 最小 STORED zip 夹具（与 release-identity-test 同构）----
const TINY_ZIP = (() => {
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
    for (const b of buf) c = table[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const payload = Buffer.from('MZ-placeholder-ApkStart-exe');
  const name = Buffer.from('ApkStart.exe', 'utf8');
  const crc = crc32(payload);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8); // STORED
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  // 中央目录偏移 = 本地头 + 条目数据之后（PR3 遗留夹具错写成 local.length，
  // 导致 zip.js 解析出 0 条目、_extract 空转 —— T-R 系列要真解压，必须修正）
  end.writeUInt32LE(local.length + payload.length, 16);
  return Buffer.concat([local, payload, central, end]);
})();

const EXE_CONTENT = 'MZ-placeholder-ApkStart-exe';
const ASSET_NAME = 'ApkStart-v9.9.9-win64-portable.zip';
const GOOD_SHA = sha(TINY_ZIP);

/** 官方 release 元数据夹具（sources.latest 返回形状的子集）。 */
function officialMeta({ version = '9.9.9', name = ASSET_NAME, digest = GOOD_SHA, digestUrl = 'https://github.com/RoutineMiku/apkstart/releases/download/v9.9.9/' + ASSET_NAME } = {}) {
  return {
    version,
    tag: `v${version}`,
    assets: [{
      name, size: TINY_ZIP.length, url: digestUrl, urls: [digestUrl],
      sizes: { [digestUrl]: TINY_ZIP.length }, source: 'github',
      parts: undefined, partial: false, digest, digestUrl,
    }],
    sources: [{ source: 'github', name: 'GitHub', tag: `v${version}` }],
    unreachable: [], bySource: 'github',
  };
}

/**
 * 造一个 OS TEMP 假安装：
 *   <root>/install/ApkStart.exe          当前「已安装」程序
 *   <root>/data/update/<v>/payload/      旧载荷（marker + exe）
 *   <root>/data/update/<v>/<archive>     留存归档（prepare 下载产物）
 */
function fakeInstall({ version = '9.9.9', current = '0.5.7', marker, archive = TINY_ZIP, exe = EXE_CONTENT, extraPayload = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-r4-resume-'));
  const dataDir = path.join(root, 'data');
  const installDir = path.join(root, 'install');
  const exePath = path.join(installDir, 'ApkStart.exe');
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(exePath, 'FAKE OLD APP - NO EXECUTION');
  const verDir = path.join(dataDir, 'update', version);
  const payload = path.join(verDir, 'payload');
  fs.mkdirSync(payload, { recursive: true });
  fs.writeFileSync(path.join(payload, 'ApkStart.exe'), exe);
  for (const [rel, content] of extraPayload) fs.writeFileSync(path.join(payload, rel), content);
  if (marker !== null) {
    fs.writeFileSync(path.join(payload, '.apkstart-ready'),
      JSON.stringify(marker === undefined ? { version, at: Date.now() } : marker), 'utf8');
  }
  if (archive !== null) {
    fs.writeFileSync(path.join(verDir, ASSET_NAME), archive);
  }
  const updater = new Updater({ currentVersion: current, exePath, isPackaged: true, dataDir });
  return { root, dataDir, exePath, verDir, payload, updater, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const readMarker = (payload) => JSON.parse(fs.readFileSync(path.join(payload, '.apkstart-ready'), 'utf8'));

// 追踪测试里开过的 server：断言失败也要关闭，否则进程挂着不退出。
const OPEN_SERVERS = new Set();
async function listen(handler) {
  const server = http.createServer(handler);
  OPEN_SERVERS.add(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}
function closeAllServers() {
  for (const s of OPEN_SERVERS) { try { s.close(); } catch (_) { /* ignore */ } }
  OPEN_SERVERS.clear();
}

/** prepare(info) 吃的是 check() 产出的 latest 形状（含单数 asset 字段）。 */
const prepareInfo = (meta) => ({ ...meta, asset: meta.assets[0] });

/** [R4-fix] 通用 STORED zip 构造器（多条目），用于「缺主 exe」等定制夹具。 */
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
  for (const [n, content] of entries) {
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

/** [R4-fix] junction/dir-symlink 创建（Windows junction 不需要特权；POSIX 用 dir symlink）。 */
function linkDir(target, linkPath) {
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

async function main() {
  console.log('\n[R4 · findResumableJob 身份闭环]');

  await atest('T-R1 遗留 marker + 归档字节与官方 digest 不符 → null（旧代码返回 job：RED 主反例）', async () => {
    const f = fakeInstall({ archive: Buffer.concat([TINY_ZIP, Buffer.from('X')] ) });
    try {
      f.updater.sources.latest = async () => officialMeta();
      assert.equal(await f.updater.findResumableJob(), null, '归档不是官方字节不得自动续做');
    } finally { f.cleanup(); }
  });

  await atest('T-R2 遗留 marker + 已验证归档 → 续做成功，marker 补写身份（无第二次整包下载）', async () => {
    const f = fakeInstall({});
    try {
      f.updater.sources.latest = async () => officialMeta();
      const job = await f.updater.findResumableJob();
      assert.ok(job && job.mode === 'zip' && job.version === '9.9.9', `应续做 9.9.9，得到 ${JSON.stringify(job)}`);
      assert.equal(job.payload, f.payload);
      const m = readMarker(f.payload);
      assert.equal(m.digest, GOOD_SHA, '续做后 marker 应携带官方身份');
      assert.equal(m.assetName, ASSET_NAME);
    } finally { f.cleanup(); }
  });

  await atest('T-R3 伪造身份 marker（digest 000…0 / assetName wrong.zip）+ 诚实归档 → null', async () => {
    const f = fakeInstall({ marker: { version: '9.9.9', at: Date.now(), digest: '0'.repeat(64), assetName: 'wrong.zip' } });
    try {
      f.updater.sources.latest = async () => officialMeta();
      assert.equal(await f.updater.findResumableJob(), null, 'marker 身份与官方元数据冲突不得自动续做');
    } finally { f.cleanup(); }
  });

  await atest('T-R4 投毒/畸形 marker（坏 JSON / 非 hex digest / 穿越 assetName / 超大 / 版本不符）→ null', async () => {
    const cases = [
      ['坏 JSON', (f) => { fs.writeFileSync(path.join(f.payload, '.apkstart-ready'), '{"version":', 'utf8'); }],
      ['非 hex digest', (f) => { fs.writeFileSync(path.join(f.payload, '.apkstart-ready'), JSON.stringify({ version: '9.9.9', digest: 'ZZ'.repeat(32) }), 'utf8'); }],
      ['穿越 assetName', (f) => { fs.writeFileSync(path.join(f.payload, '.apkstart-ready'), JSON.stringify({ version: '9.9.9', assetName: '..\\..\\evil.zip' }), 'utf8'); }],
      ['超大 marker', (f) => { fs.writeFileSync(path.join(f.payload, '.apkstart-ready'), JSON.stringify({ version: '9.9.9', junk: 'A'.repeat(8192) }), 'utf8'); }],
      ['版本不符', (f) => { fs.writeFileSync(path.join(f.payload, '.apkstart-ready'), JSON.stringify({ version: '9.9.8' }), 'utf8'); }],
    ];
    for (const [label, poison] of cases) {
      const f = fakeInstall({});
      try {
        poison(f);
        f.updater.sources.latest = async () => officialMeta();
        assert.equal(await f.updater.findResumableJob(), null, `${label} 不得续做`);
      } finally { f.cleanup(); }
    }
  });

  await atest('T-R5 留存归档缺失 → null（数据保留）', async () => {
    const f = fakeInstall({ archive: null });
    try {
      f.updater.sources.latest = async () => officialMeta();
      assert.equal(await f.updater.findResumableJob(), null);
      assert.ok(fs.existsSync(path.join(f.payload, 'ApkStart.exe')), '载荷保留可恢复');
    } finally { f.cleanup(); }
  });

  await atest('T-R6 归档在 prepare 后被篡改（字节 ≠ 官方 digest）→ null', async () => {
    const f = fakeInstall({ archive: Buffer.from('TAMPERED-ARCHIVE-BYTES-NOT-A-ZIP') });
    try {
      f.updater.sources.latest = async () => officialMeta();
      assert.equal(await f.updater.findResumableJob(), null);
    } finally { f.cleanup(); }
  });

  await atest('T-R7 staged 版本 ≠ 官方最新版本（官方已发 9.9.8）→ null', async () => {
    const f = fakeInstall({});
    try {
      f.updater.sources.latest = async () => officialMeta({ version: '9.9.8', digestUrl: 'https://github.com/RoutineMiku/apkstart/releases/download/v9.9.8/' + ASSET_NAME.replace('9.9.9', '9.9.8') });
      assert.equal(await f.updater.findResumableJob(), null, '过期 staged 版本不自动续做（由静默查新接管）');
    } finally { f.cleanup(); }
  });

  await atest('T-R8 staged 版本比官方最新还新（伪造/回滚的 release）→ null', async () => {
    const f = fakeInstall({ version: '9.9.10' });
    try {
      f.updater.sources.latest = async () => officialMeta();
      assert.equal(await f.updater.findResumableJob(), null);
    } finally { f.cleanup(); }
  });

  await atest('T-R9 官方元数据无锚（Gitee-only / synthetic，digest 缺失）→ null', async () => {
    const f = fakeInstall({});
    try {
      const meta = officialMeta();
      delete meta.assets[0].digest;
      meta.assets[0].digestUrl = null;
      f.updater.sources.latest = async () => meta;
      assert.equal(await f.updater.findResumableJob(), null, '无锚元数据不能给身份，不得自动执行');
    } finally { f.cleanup(); }
  });

  await atest('T-R10 元数据离线（latest 抛错）→ null，载荷/归档/marker 原样保留', async () => {
    const f = fakeInstall({});
    try {
      const exeBefore = fs.readFileSync(path.join(f.payload, 'ApkStart.exe'));
      const markerBefore = fs.readFileSync(path.join(f.payload, '.apkstart-ready'));
      f.updater.sources.latest = async () => { throw new Error('连不上更新服务器'); };
      assert.equal(await f.updater.findResumableJob(), null);
      assert.ok(Buffer.compare(exeBefore, fs.readFileSync(path.join(f.payload, 'ApkStart.exe'))) === 0);
      assert.ok(Buffer.compare(markerBefore, fs.readFileSync(path.join(f.payload, '.apkstart-ready'))) === 0);
    } finally { f.cleanup(); }
  });

  await atest('T-R11 元数据挂起不返回 → 有界超时返回 null（不拖垮启动）', async () => {
    const f = fakeInstall({});
    try {
      f.updater.sources.latest = () => new Promise(() => {});
      f.updater._metadataTimeoutMs = 300; // 测试 seam：默认 15000
      // 裸 Node 进程里 deadline 定时器是 unref 的（生产里 Electron 循环常驻），
      // 必须给一个 ref 句柄撑住事件循环，否则 race 未决进程就先退出了。
      const keepAlive = setInterval(() => {}, 1000);
      try {
        const t0 = Date.now();
        assert.equal(await f.updater.findResumableJob(), null);
        assert.ok(Date.now() - t0 < 10000, `应在超时后返回（耗时 ${Date.now() - t0}ms）`);
      } finally { clearInterval(keepAlive); }
    } finally { f.cleanup(); }
  });

  await atest('T-R12 元数据资产名穿越（..\\evil.zip / sub/evil.zip）→ null 且不落盘越界文件', async () => {
    for (const bad of ['..\\evil.zip', 'sub/evil.zip', 'evil.zip ']) {
      const f = fakeInstall({});
      try {
        f.updater.sources.latest = async () => officialMeta({ name: bad, digestUrl: 'https://github.com/RoutineMiku/apkstart/releases/download/v9.9.9/x' });
        assert.equal(await f.updater.findResumableJob(), null, `资产名 ${JSON.stringify(bad)} 不得续做`);
        const stray = fs.readdirSync(path.dirname(f.verDir)).filter((n) => n.includes('evil'));
        assert.equal(stray.length, 0, '不得在版本目录外落盘');
      } finally { f.cleanup(); }
    }
  });

  await atest('T-R13 prepare 后载荷被篡改（exe 换字节 + 注入文件）+ 诚实归档 → 续做并从归档重建', async () => {
    const f = fakeInstall({ exe: 'TAMPERED-STAGED-EXE', extraPayload: [['EVIL.dll', 'payload-injection']] });
    try {
      f.updater.sources.latest = async () => officialMeta();
      const job = await f.updater.findResumableJob();
      assert.ok(job, '归档已验证，应续做');
      assert.equal(fs.readFileSync(path.join(f.payload, 'ApkStart.exe'), 'utf8'), EXE_CONTENT, '载荷 exe 必须等于归档内容');
      assert.equal(fs.existsSync(path.join(f.payload, 'EVIL.dll')), false, '注入文件不得残留');
    } finally { f.cleanup(); }
  });

  await atest('T-R14 诚实归档续做零整包下载（digestUrl 指向计数服务器，请求数=0）', async () => {
    let hits = 0;
    const server = await listen((req, res) => { hits += 1; res.writeHead(200); res.end(TINY_ZIP); });
    const f = fakeInstall({});
    try {
      const url = `http://127.0.0.1:${server.address().port}/${ASSET_NAME}`;
      f.updater.sources.latest = async () => officialMeta({ digestUrl: url });
      const job = await f.updater.findResumableJob();
      assert.ok(job, '应续做');
      assert.equal(hits, 0, `不得发起整包下载（实际请求数 ${hits}）`);
    } finally { f.cleanup(); }
  });

  await atest('T-R15 上次重建中断（payload.rebuild 残留）→ 清理后照常续做', async () => {
    const f = fakeInstall({});
    try {
      const tmp = path.join(f.verDir, 'payload.rebuild');
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, 'partial junk'), 'x');
      f.updater.sources.latest = async () => officialMeta();
      const job = await f.updater.findResumableJob();
      assert.ok(job, '残留重建目录不得阻断续做');
      assert.equal(fs.existsSync(tmp), false, '重建临时目录应被清理');
      assert.equal(fs.readFileSync(path.join(f.payload, 'ApkStart.exe'), 'utf8'), EXE_CONTENT);
    } finally { f.cleanup(); }
  });

  await atest('T-R16 rm→rename 崩溃窗口（载荷+marker 丢失，归档还在）→ null 且归档保留（诚实降级）', async () => {
    const f = fakeInstall({});
    try {
      fs.rmSync(f.payload, { recursive: true, force: true });
      f.updater.sources.latest = async () => officialMeta();
      assert.equal(await f.updater.findResumableJob(), null);
      assert.ok(fs.existsSync(path.join(f.verDir, ASSET_NAME)), '归档保留，下次查新/续做可恢复');
    } finally { f.cleanup(); }
  });

  console.log('\n[R4 · prepare() 锚定复用收口]');

  await atest('T-R17 锚定期望 + marker 身份匹配 + 载荷被篡改 + 归档完好 → 缓存重建（零传输；RED：e6db0e2 会整包重下）', async () => {
    const f = fakeInstall({ marker: { version: '9.9.9', at: Date.now(), digest: GOOD_SHA, assetName: ASSET_NAME }, exe: 'TAMPERED-STAGED-EXE' });
    try {
      let downloads = 0;
      const server = await listen((req, res) => {
        downloads += 1;
        const r = req.headers.range;
        if (r) {
          const m = /bytes=(\d+)-(\d*)/.exec(r);
          const s = Number(m[1]);
          const e = m[2] ? Number(m[2]) : TINY_ZIP.length - 1;
          res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/${TINY_ZIP.length}`, 'Content-Length': e - s + 1 });
          res.end(TINY_ZIP.subarray(s, e + 1));
        } else { res.writeHead(200, { 'Content-Length': TINY_ZIP.length }); res.end(TINY_ZIP); }
      });
      const url = `http://127.0.0.1:${server.address().port}/${ASSET_NAME}`;
      f.updater.sources.latest = async () => officialMeta({ digestUrl: url });
      const info = prepareInfo(await f.updater.sources.latest());
      const job = await f.updater.prepare(info);
      assert.ok(job && job.mode === 'zip');
      assert.equal(downloads, 0, '留存归档 SHA-256 与官方一致 ⇒ 不得发起任何传输（issue98 重试效率门）');
      assert.equal(fs.readFileSync(path.join(f.payload, 'ApkStart.exe'), 'utf8'), EXE_CONTENT, '载荷必须来自已验证归档，旧载荷篡改被覆盖');
    } finally { f.cleanup(); }
  });

  await atest('T-R18 无锚手动路径保持 PR2 复用语义（第二次 prepare 复用既有载荷）', async () => {
    const f = fakeInstall({ version: '9.9.9', marker: undefined, archive: null });
    try {
      const server = await listen((req, res) => { res.writeHead(200, { 'Content-Length': TINY_ZIP.length }); res.end(TINY_ZIP); });
      const url = `http://127.0.0.1:${server.address().port}/${ASSET_NAME}`;
      const meta = officialMeta({ digestUrl: url });
      delete meta.assets[0].digest;
      meta.assets[0].digestUrl = null;
      f.updater.sources.latest = async () => meta;
      const first = await f.updater.prepare(prepareInfo(meta));
      assert.ok(first && first.mode === 'zip');
      const marks = [];
      f.updater.onProgress = (p) => marks.push(p.message || '');
      const second = await f.updater.prepare(prepareInfo(meta));
      assert.ok(second && second.payload === first.payload, '无锚复用语义保持');
      assert.ok(marks.some((m) => m.includes('直接复用')), `应有复用进度提示，得到 ${JSON.stringify(marks)}`);
    } finally { f.cleanup(); }
  });

  console.log('\n[R4 · main.js 启动编排（core/boot-resume.js）]');

  function fakeUpdater(jobImpl, applyImpl) {
    return { findResumableJob: jobImpl, apply: applyImpl };
  }

  await atest('T-R19 await 之后的 job 才交给 apply（Promise 不被误当任务）', async () => {
    const applied = [];
    let resolveJob;
    const u = fakeUpdater(() => new Promise((r) => { resolveJob = () => r({ mode: 'zip', version: '9.9.9', payload: 'P' }); }), (j) => applied.push(j));
    const sent = [];
    const p = bootResume(u, { send: (ch, s) => sent.push([ch, s]), quit: () => {}, applyDelayMs: 5 });
    assert.ok(p instanceof Promise, 'bootResume 返回 Promise');
    await sleep(20);
    assert.equal(applied.length, 0, 'findResumableJob 未决时绝不 apply');
    resolveJob();
    const resumed = await p;
    assert.equal(resumed, true);
    assert.equal(applied.length, 1, 'apply 恰一次');
    assert.ok(applied[0] && typeof applied[0] === 'object' && !(applied[0] instanceof Promise), 'apply 收到的是已决任务对象');
    assert.equal(applied[0].version, '9.9.9');
    assert.ok(sent.some(([ch]) => ch === 'update:progress'));
    await sleep(20);
  });

  await atest('T-R20 命中续做 → 不安排并行 check；未命中 → 恰安排一次', async () => {
    const applied = [];
    let checks = 0;
    const hit = fakeUpdater(async () => ({ mode: 'zip', version: '9.9.9', payload: 'P' }), () => applied.push(1));
    assert.equal(await bootResume(hit, { quit: () => {}, applyDelayMs: 1, scheduleCheck: () => { checks += 1; } }), true);
    assert.equal(checks, 0, '续做命中不得并行查新');
    assert.equal(applied.length, 1);
    await sleep(10);

    checks = 0;
    const miss = fakeUpdater(async () => null, () => { throw new Error('未命中不应 apply'); });
    assert.equal(await bootResume(miss, { quit: () => {}, scheduleCheck: () => { checks += 1; } }), false);
    assert.equal(checks, 1, '未命中应安排静默查新');
  });

  await atest('T-R21 findResumableJob 抛错 → 编排吞掉并照常安排查新（启动不被拖垮）', async () => {
    let checks = 0;
    const logs = [];
    const u = fakeUpdater(async () => { throw new Error('resume exploded'); }, () => { throw new Error('不应 apply'); });
    const resumed = await bootResume(u, { log: (m) => logs.push(m), quit: () => {}, scheduleCheck: () => { checks += 1; } });
    assert.equal(resumed, false);
    assert.equal(checks, 1);
    assert.ok(logs.some((m) => m.includes('resume exploded')));
  });

  await atest('T-R22 apply 同步抛错 → 不声称续做成功：resumed=false、释放门闩、错误进度、安排查新、不退出', async () => {
    let checks = 0;
    let quits = 0;
    const sent = [];
    const gate = new UpdateGate();
    const u = fakeUpdater(async () => ({ mode: 'zip', version: '9.9.9', payload: 'P' }), () => { throw new Error('apply boom'); });
    const resumed = await bootResume(u, {
      gate, send: (ch, s) => sent.push([ch, s]), quit: () => { quits += 1; }, applyDelayMs: 1,
      scheduleCheck: () => { checks += 1; },
    });
    assert.equal(resumed, false, 'apply 失败不得把「已续做」当真');
    assert.equal(checks, 1, 'apply 失败应转入常规静默查新');
    assert.equal(quits, 0, 'apply 失败绝不能计划退出');
    assert.equal(gate.heldBy(), null, '失败路径必须释放门闩');
    assert.ok(sent.some(([ch, s]) => ch === 'update:progress' && s && s.stage === 'error'), '应如实广播错误进度');
    await sleep(10);
  });

  console.log('\n[R4-fix · 路径边界围堵（root R4-B01/B02/B03 反例）]');

  await atest('T-F1 版本目录被换成 junction（指向更新根外）→ 续做 null 且不删外部载荷（B01）', async () => {
    const f = fakeInstall({ marker: { version: '9.9.9', at: Date.now(), digest: GOOD_SHA, assetName: ASSET_NAME } });
    try {
      f.updater.sources.latest = async () => officialMeta();
      const outside = path.join(f.root, 'outside-update-root');
      fs.renameSync(f.verDir, outside);
      linkDir(outside, f.verDir);
      const sentinel = path.join(outside, 'payload', 'outside-sentinel.txt');
      fs.writeFileSync(sentinel, 'MUST NOT DELETE OUTSIDE UPDATE ROOT');
      assert.equal(await f.updater.findResumableJob(), null, 'junction 版本目录不得被跟随');
      assert.ok(fs.existsSync(sentinel), '续做不得删除更新根之外的文件');
      assert.ok(fs.existsSync(path.join(outside, 'payload', 'ApkStart.exe')), '外部载荷原样保留');
    } finally { f.cleanup(); }
  });

  await atest('T-F2 prepare 版本号穿越（../../escaped-version）→ 在 mkdir/测速/下载之前拒绝（B02）', async () => {
    const f = fakeInstall({});
    try {
      let rankCalls = 0;
      f.updater.sources.rank = async () => { rankCalls += 1; throw new Error('RANK_SHOULD_NOT_RUN'); };
      const info = prepareInfo(officialMeta());
      info.version = '../../escaped-version';
      await assert.rejects(() => f.updater.prepare(info), /版本号非法/, '非法版本号必须拒绝');
      assert.equal(rankCalls, 0, '拒绝必须发生在测速/下载之前');
      assert.equal(fs.existsSync(path.join(f.root, 'escaped-version')), false, '不得写出更新根之外的目录');
      assert.equal(fs.existsSync(path.join(f.dataDir, 'update', 'escaped-version')), false, '版本目录名必须是字面版本号');
    } finally { f.cleanup(); }
  });

  await atest('T-F3 prepare 资产名穿越（../escaped-setup.exe）→ 在传输之前拒绝（B03）', async () => {
    const f = fakeInstall({});
    try {
      let rankCalls = 0;
      f.updater.sources.rank = async () => { rankCalls += 1; throw new Error('RANK_SHOULD_NOT_RUN'); };
      const info = prepareInfo(officialMeta());
      info.asset.name = '../escaped-setup.exe';
      await assert.rejects(() => f.updater.prepare(info), /文件名非法/, '非法资产名必须拒绝');
      assert.equal(rankCalls, 0);
      assert.equal(fs.existsSync(path.join(f.dataDir, 'update', 'escaped-setup.exe')), false, '不得写出版本目录之外的文件');
    } finally { f.cleanup(); }
  });

  await atest('T-F4 update/<v> 是预置 junction → prepare 拒绝且不动链接目标', async () => {
    const f = fakeInstall({});
    try {
      let rankCalls = 0;
      f.updater.sources.rank = async () => { rankCalls += 1; throw new Error('RANK_SHOULD_NOT_RUN'); };
      const outsideDir = path.join(f.root, 'outside-verbatim');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, 'keep.txt'), 'KEEP');
      fs.rmSync(f.verDir, { recursive: true, force: true });
      linkDir(outsideDir, f.verDir);
      const info = prepareInfo(officialMeta());
      await assert.rejects(() => f.updater.prepare(info), /更新目录/, 'junction 版本目录不得被跟随写入');
      assert.equal(rankCalls, 0, '拒绝必须发生在测速/下载之前');
      assert.ok(fs.existsSync(path.join(outsideDir, 'keep.txt')), '链接目标目录不得被触碰/清理');
      assert.equal(fs.readdirSync(outsideDir).length, 1, '外部目录不得被写入更新内容');
    } finally { f.cleanup(); }
  });

  await atest('T-F5 payload 目录被换成 junction → 摘链接本身、从已验证归档原地重建（外部目录不被 rm/写入；P34 合同）', async () => {
    const f = fakeInstall({ marker: { version: '9.9.9', at: Date.now(), digest: GOOD_SHA, assetName: ASSET_NAME } });
    try {
      f.updater.sources.latest = async () => officialMeta();
      const outside = path.join(f.root, 'outside-payload');
      fs.renameSync(f.payload, outside);
      linkDir(outside, f.payload);
      fs.writeFileSync(path.join(outside, 'outside-sentinel.txt'), 'MUST NOT BE TOUCHED');
      const job = await f.updater.findResumableJob();
      // [P34] 冻结探针合同：junction 载荷 → 摘链接、原地重建真实目录，续做照常；
      // 外部目录只被读过（marker），绝不被 rm/写入/替换。
      assert.ok(job && job.mode === 'zip' && job.version === '9.9.9', `应从已验证归档原地重建续做，得到 ${JSON.stringify(job)}`);
      const pst = fs.lstatSync(f.payload);
      assert.ok(pst.isDirectory() && !pst.isSymbolicLink(), '载荷落点必须是真实目录');
      assert.ok(fs.existsSync(path.join(outside, 'ApkStart.exe')), '外部载荷原样保留');
      assert.ok(fs.existsSync(path.join(outside, 'outside-sentinel.txt')), '外部目录内容原样保留');
      assert.equal(fs.readdirSync(outside).length, 3, '外部目录不得被写入更新内容（原 marker+exe+sentinel）');
    } finally { f.cleanup(); }
  });

  await atest('T-F6 marker/归档被换成目录（目录假扮文件）→ 续做 null', async () => {
    const f = fakeInstall({});
    try {
      f.updater.sources.latest = async () => officialMeta();
      fs.rmSync(path.join(f.payload, '.apkstart-ready'), { force: true });
      fs.mkdirSync(path.join(f.payload, '.apkstart-ready'));
      assert.equal(await f.updater.findResumableJob(), null, '目录假扮 marker 必须拒绝');
      const f2 = fakeInstall({});
      try {
        f2.updater.sources.latest = async () => officialMeta();
        fs.rmSync(path.join(f2.verDir, ASSET_NAME), { force: true });
        fs.mkdirSync(path.join(f2.verDir, ASSET_NAME));
        assert.equal(await f2.updater.findResumableJob(), null, '目录假扮归档必须拒绝（lstat，不跟随）');
      } finally { f2.cleanup(); }
    } finally { f.cleanup(); }
  });

  console.log('\n[R4-fix · issue98 缓存重试（root P03 门）]');

  await atest('T-F7 二次锚定 prepare：归档校验通过 ⇒ 零 rank/零传输/零 latest（P03 等价）', async () => {
    const f = fakeInstall({});
    try {
      let hits = 0; let rankCalls = 0; let latestCalls = 0;
      const server = await listen((req, res) => { hits += 1; res.writeHead(200, { 'Content-Length': TINY_ZIP.length }); res.end(TINY_ZIP); });
      const url = `http://127.0.0.1:${server.address().port}/${ASSET_NAME}`;
      const meta = officialMeta({ digestUrl: url });
      f.updater.sources.latest = async () => { latestCalls += 1; return meta; };
      const realRank = f.updater.sources.rank.bind(f.updater.sources);
      f.updater.sources.rank = async (...a) => { rankCalls += 1; return realRank(...a); };
      const info = prepareInfo(meta);
      const first = await f.updater.prepare(info);
      assert.ok(first && first.mode === 'zip');
      const snapshot = { hits, rankCalls, latestCalls };
      const second = await f.updater.prepare(info);
      assert.ok(second && second.payload === first.payload);
      assert.equal(hits - snapshot.hits, 0, '有效留存归档重试不得发起任何下载');
      assert.equal(rankCalls - snapshot.rankCalls, 0, '缓存重试不得进入测速');
      assert.equal(latestCalls - snapshot.latestCalls, 0, 'prepare 不依赖 latest（digest 由调用方独立提供）');
      assert.equal(fs.readFileSync(path.join(f.payload, 'ApkStart.exe'), 'utf8'), EXE_CONTENT);
    } finally { f.cleanup(); }
  });

  await atest('T-F8 旧载荷被篡改/注入 + 归档完好 → 缓存重试直接重建正确载荷（P03 probe 形状）', async () => {
    const f = fakeInstall({ marker: { version: '9.9.9', at: Date.now(), digest: GOOD_SHA, assetName: ASSET_NAME }, exe: 'TAMPERED-STAGED-EXE', extraPayload: [['injected.js', 'EVIL']] });
    try {
      let hits = 0;
      const server = await listen((req, res) => { hits += 1; res.writeHead(200, { 'Content-Length': TINY_ZIP.length }); res.end(TINY_ZIP); });
      const url = `http://127.0.0.1:${server.address().port}/${ASSET_NAME}`;
      f.updater.sources.latest = async () => officialMeta({ digestUrl: url });
      const job = await f.updater.prepare(prepareInfo(officialMeta({ digestUrl: url })));
      assert.ok(job && job.mode === 'zip');
      assert.equal(hits, 0, '不得重新下载');
      assert.equal(fs.readFileSync(path.join(f.payload, 'ApkStart.exe'), 'utf8'), EXE_CONTENT, '篡改字节被归档重建覆盖');
      assert.equal(fs.existsSync(path.join(f.payload, 'injected.js')), false, '注入文件不得残留');
      const m = readMarker(f.payload);
      assert.equal(m.digest, GOOD_SHA);
      assert.equal(m.assetName, ASSET_NAME);
    } finally { f.cleanup(); }
  });

  await atest('T-F9 归档缺失 → 正常验证下载路径（传输发生，载荷来自下载）', async () => {
    const f = fakeInstall({ archive: null });
    try {
      let hits = 0;
      const server = await listen((req, res) => { hits += 1; res.writeHead(200, { 'Content-Length': TINY_ZIP.length }); res.end(TINY_ZIP); });
      const url = `http://127.0.0.1:${server.address().port}/${ASSET_NAME}`;
      f.updater.sources.latest = async () => officialMeta({ digestUrl: url });
      const job = await f.updater.prepare(prepareInfo(officialMeta({ digestUrl: url })));
      assert.ok(job && job.mode === 'zip');
      assert.ok(hits >= 1, '归档缺失必须走下载');
      assert.equal(fs.readFileSync(path.join(f.payload, 'ApkStart.exe'), 'utf8'), EXE_CONTENT);
    } finally { f.cleanup(); }
  });

  await atest('T-F10 归档字节被改（同长度翻转）→ 缓存校验不过 → 正常下载覆盖', async () => {
    const corrupt = Buffer.from(TINY_ZIP);
    corrupt[10] ^= 0xFF;
    const f = fakeInstall({ archive: corrupt });
    try {
      let hits = 0;
      const server = await listen((req, res) => {
        hits += 1;
        const r = req.headers.range;
        if (r) {
          const m = /bytes=(\d+)-(\d*)/.exec(r);
          const s = Number(m[1]);
          const e = m[2] ? Number(m[2]) : TINY_ZIP.length - 1;
          res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/${TINY_ZIP.length}`, 'Content-Length': e - s + 1 });
          res.end(TINY_ZIP.subarray(s, e + 1));
        } else { res.writeHead(200, { 'Content-Length': TINY_ZIP.length }); res.end(TINY_ZIP); }
      });
      const url = `http://127.0.0.1:${server.address().port}/${ASSET_NAME}`;
      f.updater.sources.latest = async () => officialMeta({ digestUrl: url });
      const job = await f.updater.prepare(prepareInfo(officialMeta({ digestUrl: url })));
      assert.ok(job && job.mode === 'zip');
      assert.ok(hits >= 1, '字节不符的归档必须重下');
      assert.equal(sha(fs.readFileSync(path.join(f.verDir, ASSET_NAME))), GOOD_SHA, '归档被官方字节覆盖');
      assert.equal(fs.readFileSync(path.join(f.payload, 'ApkStart.exe'), 'utf8'), EXE_CONTENT);
    } finally { f.cleanup(); }
  });

  console.log('\n[R4-fix · staging/换名与失败保留（root F）]');

  await atest('T-F11 归档里没有主 exe → prepare 抛错且旧载荷/marker/归档原样保留', async () => {
    const noExe = buildZip([['resources/app/main.js', 'no exe here']]);
    const digest = sha(noExe);
    const f = fakeInstall({ marker: { version: '9.9.9', at: Date.now(), digest, assetName: ASSET_NAME }, archive: noExe });
    try {
      let hits = 0;
      const server = await listen((req, res) => { hits += 1; res.writeHead(200, { 'Content-Length': noExe.length }); res.end(noExe); });
      const url = `http://127.0.0.1:${server.address().port}/${ASSET_NAME}`;
      const exeBefore = fs.readFileSync(path.join(f.payload, 'ApkStart.exe'));
      const markerBefore = fs.readFileSync(path.join(f.payload, '.apkstart-ready'));
      f.updater.sources.latest = async () => officialMeta({ digest, digestUrl: url });
      await assert.rejects(() => f.updater.prepare(prepareInfo(officialMeta({ digest, digestUrl: url }))), /主程序文件/, '缺主 exe 的包不得替换载荷');
      assert.equal(hits, 0, '归档 SHA-256 与官方一致 ⇒ 缓存重建，零传输');
      assert.ok(Buffer.compare(exeBefore, fs.readFileSync(path.join(f.payload, 'ApkStart.exe'))) === 0, '旧载荷保留');
      assert.ok(Buffer.compare(markerBefore, fs.readFileSync(path.join(f.payload, '.apkstart-ready'))) === 0, 'marker 保留');
      assert.equal(sha(fs.readFileSync(path.join(f.verDir, ASSET_NAME))), digest, '归档保留');
      assert.equal(fs.readdirSync(f.verDir).filter((n) => n.startsWith('payload.staging-')).length, 0, 'staging 已清理');
    } finally { f.cleanup(); }
  });

  await atest('T-F12 归档不是合法 zip（digest 匹配其字节）→ 重建失败且缓存保留', async () => {
    const junk = Buffer.from('THIS IS NOT A ZIP FILE BUT ITS DIGEST IS OFFICIAL');
    const digest = sha(junk);
    const f = fakeInstall({ marker: { version: '9.9.9', at: Date.now(), digest, assetName: ASSET_NAME }, archive: junk });
    try {
      let hits = 0;
      const server = await listen((req, res) => { hits += 1; res.writeHead(200, { 'Content-Length': junk.length }); res.end(junk); });
      const url = `http://127.0.0.1:${server.address().port}/${ASSET_NAME}`;
      const exeBefore = fs.readFileSync(path.join(f.payload, 'ApkStart.exe'));
      f.updater.sources.latest = async () => officialMeta({ digest, digestUrl: url });
      await assert.rejects(() => f.updater.prepare(prepareInfo(officialMeta({ digest, digestUrl: url }))));
      assert.ok(Buffer.compare(exeBefore, fs.readFileSync(path.join(f.payload, 'ApkStart.exe'))) === 0, '旧载荷保留（旧代码会先删载荷再解压，失败即丢缓存）');
      assert.equal(fs.readdirSync(f.verDir).filter((n) => n.startsWith('payload.staging-')).length, 0, 'staging 已清理');
    } finally { f.cleanup(); }
  });

  await atest('T-F13 staging/旧备份残留（含 payload.rebuild 旧名）→ 清扫且不误伤其他文件', async () => {
    const f = fakeInstall({ marker: { version: '9.9.9', at: Date.now(), digest: GOOD_SHA, assetName: ASSET_NAME } });
    try {
      f.updater.sources.latest = async () => officialMeta();
      for (const n of ['payload.rebuild', 'payload.staging-1-x', 'payload.old-2-y']) {
        fs.mkdirSync(path.join(f.verDir, n), { recursive: true });
        fs.writeFileSync(path.join(f.verDir, n, 'junk.txt'), 'x');
      }
      fs.mkdirSync(path.join(f.verDir, 'payload.ignored'), { recursive: true });
      fs.writeFileSync(path.join(f.verDir, 'payload.ignored', 'keep.txt'), 'keep');
      const job = await f.updater.findResumableJob();
      assert.ok(job, '残留不得阻断续做');
      for (const n of ['payload.rebuild', 'payload.staging-1-x', 'payload.old-2-y']) {
        assert.equal(fs.existsSync(path.join(f.verDir, n)), false, `残留 ${n} 应被清扫`);
      }
      assert.ok(fs.existsSync(path.join(f.verDir, 'payload.ignored', 'keep.txt')), '清扫不误伤非临时名');
      assert.equal(fs.readFileSync(path.join(f.payload, 'ApkStart.exe'), 'utf8'), EXE_CONTENT);
    } finally { f.cleanup(); }
  });

  await atest('T-F22 并发续做+缓存重试：清扫不得误删对方活跃 staging，双方都成功（R4-C01 形状）', async () => {
    const f = fakeInstall({ marker: { version: '9.9.9', at: Date.now(), digest: GOOD_SHA, assetName: ASSET_NAME } });
    try {
      f.updater.sources.latest = async () => officialMeta();
      const boot = f.updater;
      let resolveBootExtracted;
      const bootExtracted = new Promise((r) => { resolveBootExtracted = r; });
      let releaseBoot;
      const bootReleased = new Promise((r) => { releaseBoot = r; });
      const realBootExtract = boot._extract.bind(boot);
      boot._extract = async (...a) => { const r = await realBootExtract(...a); resolveBootExtracted(); await bootReleased; return r; };
      const bootPromise = boot.findResumableJob();
      await bootExtracted; // boot 已完成解压、停在换名之前

      // 并发的第二个 Updater 实例走缓存重试（与 root probe R4-C01 同形状）
      const manual = new Updater({ currentVersion: '0.5.7', exePath: f.exePath, isPackaged: true, dataDir: f.dataDir });
      manual.sources.latest = async () => officialMeta();
      const manualJob = await manual.prepare(prepareInfo(officialMeta()));
      assert.ok(manualJob && manualJob.mode === 'zip', '并发缓存重试应完成');
      releaseBoot();
      const bootJob = await bootPromise;
      assert.ok(bootJob, '清扫不得误删并发方的活跃 staging：boot 续做必须成功');
      assert.equal(fs.readFileSync(path.join(f.payload, 'ApkStart.exe'), 'utf8'), EXE_CONTENT);
    } finally { f.cleanup(); }
  });

  console.log('\n[R4-fix · 元数据权威新鲜度（root D）]');

  await atest('T-F14 续做权威元数据查询显式 force:true（跳过 10 分钟缓存）', async () => {
    const f = fakeInstall({});
    try {
      const calls = [];
      f.updater.sources.latest = async (o) => { calls.push(o && o.force === true); return officialMeta(); };
      assert.ok(await f.updater.findResumableJob());
      assert.equal(calls.length, 1);
      assert.equal(calls[0], true, '续做授权必须请求最新元数据（force）');
    } finally { f.cleanup(); }
  });

  console.log('\n[R4-fix · 更新编排门闩（root C/E）]');

  await atest('T-F15 UpdateGate：异主 end/cancel 是 no-op；重复 begin 拒绝；heldBy 如实', async () => {
    const g = new UpdateGate();
    assert.equal(g.heldBy(), null);
    assert.equal(g.begin('boot-resume'), true);
    assert.equal(g.begin('manual'), false, '已被持有时不得二次持有');
    assert.equal(g.heldBy(), 'boot-resume');
    assert.equal(g.end('manual'), false, '异主 end 不得释放');
    assert.equal(g.cancel('manual'), false, '异主 cancel 不得生效');
    assert.equal(g.isCancelled('boot-resume'), false);
    assert.equal(g.cancel('boot-resume'), true);
    assert.equal(g.isCancelled('boot-resume'), true);
    assert.equal(g.end('boot-resume'), true);
    assert.equal(g.heldBy(), null);
    assert.equal(g.isBusy(), false);
  });

  await atest('T-F16 runExclusive：busy 回应传 heldBy；fn 抛错也释放', async () => {
    const g = new UpdateGate();
    assert.equal(g.begin('boot-resume'), true);
    const busy = await g.runExclusive('manual', async () => 'should-not-run', (holder) => ({ ok: false, holder }));
    assert.deepEqual(busy, { ok: false, holder: 'boot-resume' });
    g.end('boot-resume');
    await assert.rejects(() => g.runExclusive('manual', async () => { throw new Error('boom-x'); }), /boom-x/);
    assert.equal(g.heldBy(), null, 'fn 抛错后必须释放');
    const r = await g.runExclusive('manual', async () => 42);
    assert.equal(r, 42);
    assert.equal(g.heldBy(), null, '成功后同样释放');
  });

  await atest('T-F17 续做持锁期间手动动作拿到 busy 回应；未命中释放后手动可进（C 编排）', async () => {
    const gate = new UpdateGate();
    let releaseBoot = null;
    const bootPromise = bootResume(
      fakeUpdater(() => new Promise((r) => { releaseBoot = () => r(null); }), () => { throw new Error('不应 apply'); }),
      { gate, quit: () => {}, scheduleCheck: () => {} },
    );
    await sleep(5);
    assert.equal(gate.heldBy(), 'boot-resume', '续做必须在第一个 await 前同步持锁');
    const busyDuringBoot = await gate.runExclusive('manual', async () => 'manual-ran', (holder) => ({ ok: false, holder }));
    assert.equal(busyDuringBoot.ok, false, '续做验证期间手动动作必须收到 busy');
    assert.equal(busyDuringBoot.holder, 'boot-resume');
    releaseBoot();
    assert.equal(await bootPromise, false, '未命中续做返回 false');
    assert.equal(gate.heldBy(), null, '未命中/失败必须释放');
    let checks = 0;
    const manual = await gate.runExclusive('manual', async () => { checks += 1; return 'manual-ran'; });
    assert.equal(manual, 'manual-ran', '门闩释放后手动动作可进');
    assert.equal(checks, 1);

    // 反向序：续做开始前手动已持锁 → 续做放弃持锁、只安排查新、不放倒手动锁
    const gate2 = new UpdateGate();
    assert.equal(gate2.begin('manual'), true);
    let checks2 = 0;
    const resumed2 = await bootResume(fakeUpdater(async () => { throw new Error('不应查询'); }), {
      gate: gate2, quit: () => {}, scheduleCheck: () => { checks2 += 1; },
    });
    assert.equal(resumed2, false);
    assert.equal(checks2, 1, '拿不到锁的续做只安排查新，不查询');
    assert.equal(gate2.heldBy(), 'manual', '手动持有的锁不被续做放倒');
    gate2.end('manual');
  });

  await atest('T-F18 apply 成功 → 门闩持有到退出交接（不提前释放、不并行查新）', async () => {
    const gate = new UpdateGate();
    let applied = 0; let checks = 0; let quits = 0;
    const resumed = await bootResume(
      fakeUpdater(async () => ({ mode: 'zip', version: '9.9.9', payload: 'P' }), () => { applied += 1; }),
      { gate, quit: () => { quits += 1; }, applyDelayMs: 5, scheduleCheck: () => { checks += 1; } },
    );
    assert.equal(resumed, true);
    assert.equal(applied, 1);
    assert.equal(checks, 0, '命中续做不得并行查新');
    assert.equal(gate.heldBy(), 'boot-resume', 'apply 成功后门闩保持到退出交接');
    const busy = await gate.runExclusive('manual', async () => 1, (h) => ({ ok: false, h }));
    assert.equal(busy.ok, false, '退出交接前手动动作仍是 busy');
    await sleep(10);
    assert.equal(quits, 1, 'quit 已交接');
  });

  await atest('T-F19 cancel：manual 持有可协作取消；boot-resume 持有放不倒（E/C）', async () => {
    const g = new UpdateGate();
    assert.equal(g.begin('boot-resume'), true);
    assert.equal(g.cancel('manual'), false, '取消放不倒续做');
    assert.equal(g.heldBy(), 'boot-resume');
    g.end('boot-resume');
    assert.equal(g.begin('manual'), true);
    assert.equal(g.cancel('manual'), true);
    assert.equal(g.isCancelled('manual'), true, '阶段边界应看到取消标记');
    assert.equal(g.end('manual'), true);
    assert.equal(g.isCancelled('manual'), false, '释放后取消标记清零');
  });

  await atest('T-F21 apply 助手调度失败 → 同步抛错（不返回成功）；spawn:false 语义不变', async () => {
    const f = fakeInstall({});
    try {
      const job = { mode: 'zip', payload: f.payload, version: '9.9.9' };
      assert.throws(
        () => f.updater.apply(job, { powershellPath: path.join(f.root, 'no-such-powershell.exe') }),
        /调度失败/,
        'spawn 不可用的助手必须同步抛错',
      );
      const script = f.updater.apply(job, { spawn: false });
      assert.ok(typeof script === 'string' && script.includes('updater start'), 'spawn:false 仍返回脚本（既有语义）');
    } finally { f.cleanup(); }
  });

  console.log('\n[R4-fix · 离线启动（root P02 的裁决替换）]');

  await atest('T-F20 离线启动 → 不自动续做（null）+ 数据逐字节保留 + 编排照常完成、安排查新', async () => {
    const f = fakeInstall({});
    try {
      const exeBefore = fs.readFileSync(path.join(f.payload, 'ApkStart.exe'));
      const markerBefore = fs.readFileSync(path.join(f.payload, '.apkstart-ready'));
      const archiveBefore = fs.readFileSync(path.join(f.verDir, ASSET_NAME));
      f.updater.sources.latest = async () => { throw new Error('offline'); };
      assert.equal(await f.updater.findResumableJob(), null, '离线拿不到权威元数据 ⇒ 不自动续做');
      assert.ok(Buffer.compare(exeBefore, fs.readFileSync(path.join(f.payload, 'ApkStart.exe'))) === 0, '载荷保留');
      assert.ok(Buffer.compare(markerBefore, fs.readFileSync(path.join(f.payload, '.apkstart-ready'))) === 0, 'marker 保留');
      assert.ok(Buffer.compare(archiveBefore, fs.readFileSync(path.join(f.verDir, ASSET_NAME))) === 0, '留存归档保留');
      const gate = new UpdateGate();
      let checks = 0; let quits = 0;
      const t0 = Date.now();
      const resumed = await bootResume(f.updater, {
        gate, quit: () => { quits += 1; }, applyDelayMs: 5, scheduleCheck: () => { checks += 1; },
      });
      assert.equal(resumed, false);
      assert.equal(checks, 1, '编排照常安排静默查新（启动不被拖垮）');
      assert.equal(quits, 0);
      assert.ok(Date.now() - t0 < 1000, `离线路径必须立即返回（实际 ${Date.now() - t0}ms）`);
      assert.equal(gate.heldBy(), null);
    } finally { f.cleanup(); }
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  closeAllServers();
  // 显式退出：任何残留句柄（如断言失败路径上的 server）不得让进程挂着
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); closeAllServers(); process.exit(1); });
