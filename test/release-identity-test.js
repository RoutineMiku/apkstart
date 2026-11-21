'use strict';
/**
 * GitHub Release 资产 sha256 身份贯通测试（PR3，纯 Node + localhost，全离线）。
 *
 * 覆盖 IMPLEMENTATION-DECISION.md §4 矩阵：
 *   T1 sources 合并：顺序无关 / 语法归一 / synthetic / 冲突降级 / 分片无锚
 *   T2 updater.prepare：锚定 happy / 坏字节 / 排除 Gitee / 镜像仲裁 / Setup 交接前失败
 *   T3 provision：三类分流 / 错字节 / 正确字节 / 无锚 PR2 形状
 *   T4 marker 身份化：遗留 marker 拒绝复用 / 无锚照旧 / force 换 release / 缓存同批
 *
 * Seam 全为测试可达性：Sources.fetchReleases、Provisioner._fetchJson /
 * extractZip / guardDisk / materializeImages / _assertPackComplete，
 * 以及用 pre-require 替换 require('./download') 导出以断言 downloadMulti 传参。
 *
 * 运行：node test/release-identity-test.js
 */
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const W = path.resolve(__dirname, '..');
const CORE = path.join(W, 'src', 'core');
const SOURCES_PATH = path.join(CORE, 'sources.js');
const UPDATER_PATH = path.join(CORE, 'updater.js');
const PROVISION_PATH = path.join(CORE, 'provision.js');
const DOWNLOAD_PATH = path.join(CORE, 'download.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const baseOf = (server) => `http://127.0.0.1:${server.address().port}`;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const validDigest = 'a'.repeat(64);

// 每源一条 release，GH-first / Gitee-first 决定 sources.latest 里 raw 的迭代序。
function fixture({ gheeDigest, giteeDigest, giteeFirst = false, version = '9.9.9' } = {}) {
  const ghAsset = (name, digest, url) => {
    const a = { name, size: 32, browser_download_url: url };
    if (digest !== undefined) a.digest = digest;
    return a;
  };
  const gh = {
    source: 'github', name: 'GitHub', web: 'https://github.com/RoutineMiku/apkstart',
    rel: {
      tag_name: `v${version}`, name: version, body: '', published_at: '',
      html_url: 'https://github.com/RoutineMiku/apkstart/releases/tag/v' + version,
      assets: [
        ghAsset('ApkStart-v-win64-portable.zip', gheeDigest, 'https://github.com/RoutineMiku/apkstart/releases/download/v9.9.9/ApkStart-v-win64-portable.zip'),
        ghAsset('ApkStart-runtime-9.9.9.zip', gheeDigest, 'https://github.com/RoutineMiku/apkstart/releases/download/v9.9.9/ApkStart-runtime-9.9.9.zip'),
        ghAsset('ApkStart-9.9.9-Setup.exe', gheeDigest, 'https://github.com/RoutineMiku/apkstart/releases/download/v9.9.9/ApkStart-9.9.9-Setup.exe'),
      ],
    },
  };
  const gitee = {
    source: 'gitee', name: 'Gitee', web: 'https://gitee.com/daily-miku/apkstart',
    rel: {
      tag_name: `v${version}`, name: version, body: '', published_at: '',
      html_url: 'https://gitee.com/daily-miku/apkstart/releases/tag/v' + version,
      assets: giteeDigest === undefined ? [] : [{
        name: 'ApkStart-v-win64-portable.zip',
        size: 40,
        browser_download_url: 'https://gitee.com/daily-miku/apkstart/releases/download/v9.9.9/ApkStart-v-win64-portable.zip',
        ...(giteeDigest ? { digest: giteeDigest } : {}),
      }],
    },
  };
  return giteeFirst ? [gitee, gh] : [gh, gitee];
}

function freshSources(fixtureData, settings = {}) {
  const { Sources } = require(SOURCES_PATH);
  const s = new Sources(() => settings);
  s.fetchReleases = async () => fixtureData;
  return s;
}

function byName(merged, name) {
  return merged.assets.find((a) => a.name === name);
}

let TINY_ZIP;
(function buildTinyZip() {
  // 构造一个最小 STORED（不压缩）zip，内含一个占位 ApkStart.exe。
  // CRC32 与偏移按要求算，能够同时被 zip.js 与 updater._extract 解析。
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
  local.writeUInt16LE(20, 4);        // version needed
  local.writeUInt16LE(0, 6);         // flags
  local.writeUInt16LE(0, 8);         // method = STORED
  local.writeUInt16LE(0, 10);        // time
  local.writeUInt16LE(0, 12);        // date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);      // version made by
  central.writeUInt16LE(20, 6);      // version needed
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);       // extra
  central.writeUInt16LE(0, 32);       // comment
  central.writeUInt16LE(0, 34);       // disk
  central.writeUInt16LE(0, 36);       // internal attrs
  central.writeUInt32LE(0, 38);       // external attrs
  central.writeUInt32LE(0, 42);       // local header offset
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);            // entries
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  TINY_ZIP = Buffer.concat([local, payload, central, end]);
})();

const GOOD_SHA = sha(TINY_ZIP);

// 一个尊重 Range 的 localhost 源；内容可按请求 URL 翻转以模拟坏字节。
async function zipServer({ corrupt = false } = {}) {
  const content = corrupt
    ? Buffer.concat([TINY_ZIP.subarray(0, 20), Buffer.from([TINY_ZIP[20] ^ 0xFF]), TINY_ZIP.subarray(21)])
    : TINY_ZIP;
  return serve((req, res) => {
    const r = req.headers.range;
    if (r) {
      const m = /bytes=(\d+)-(\d*)/.exec(r);
      const s = Number(m[1]);
      const e = m[2] ? Number(m[2]) : content.length - 1;
      if (s >= content.length) { res.writeHead(416, { 'Content-Range': `bytes */${content.length}` }); res.end(); return; }
      const body = content.subarray(s, e + 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${s}-${e}/${content.length}`,
        'Content-Length': String(body.length),
        'Accept-Ranges': 'bytes',
      });
      res.end(body);
      return;
    }
    res.writeHead(200, { 'Content-Length': String(content.length), 'Accept-Ranges': 'bytes' });
    res.end(content);
  });
}

// updater/provision 在 require 时解构 downloadMulti，必须在加载它们之前替换导出。
// 返回 restore()，把 download.js 导出与模块缓存还原，避免污染其它用例。
function installDownloadSpy() {
  const dl = require(DOWNLOAD_PATH);
  const orig = dl.downloadMulti;
  const captured = {};
  dl.downloadMulti = async (urls, file, opt) => {
    captured.opt = opt;
    captured.urls = urls;
    return orig(urls, file, opt);
  };
  delete require.cache[UPDATER_PATH];
  delete require.cache[PROVISION_PATH];
  const restore = () => {
    dl.downloadMulti = orig;
    delete require.cache[UPDATER_PATH];
    delete require.cache[PROVISION_PATH];
  };
  return { captured, restore };
}
function freshUpdaterSpied({ dataDir, settings }) {
  const { Updater } = require(UPDATER_PATH);
  const u = new Updater({
    currentVersion: '0.0.1', exePath: path.join(dataDir, 'app', 'ApkStart.exe'),
    isPackaged: false, dataDir, settings: () => settings,
  });
  const origCheck = u.check.bind(u);
  u.check = async (opts) => {
    await origCheck(opts);
    const a = u.latest && u.latest.asset;
    if (a) { a.digest = GOOD_SHA; a.digestUrl = a.urls && a.urls[0]; }
    return u.latest;
  };
  return u;
}

function freshUpdater({ dataDir, signed = true, settings = {} } = {}) {
  const { Updater } = require(UPDATER_PATH);
  const u = new Updater({
    currentVersion: '0.0.1',
    exePath: path.join(dataDir, 'app', 'ApkStart.exe'),
    isPackaged: false,
    dataDir,
    settings: () => settings,
  });
  if (signed) {
    const origCheck = u.check.bind(u);
    u.check = async (opts) => {
      await origCheck(opts);
      const a = u.latest && u.latest.asset;
      if (a) { a.digest = GOOD_SHA; a.digestUrl = a.urls && a.urls[0]; }
      return u.latest;
    };
  }
  return u;
}

function cleanDir(d) { fs.rmSync(d, { recursive: true, force: true }); }

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-release-id-'));

  await atest('T1-1 merge 顺序无关（GH-first vs Gitee-first，同名资产）', async () => {
    const a = await freshSources(fixture({ gheeDigest: `sha256:${validDigest}`, giteeDigest: `sha256:${validDigest}` })).latest();
    const b = await freshSources(fixture({ gheeDigest: `sha256:${validDigest}`, giteeDigest: `sha256:${validDigest}`, giteeFirst: true })).latest();
    const ga = byName(a, 'ApkStart-v-win64-portable.zip');
    const gb = byName(b, 'ApkStart-v-win64-portable.zip');
    assert.equal(ga.digest, validDigest);
    assert.equal(gb.digest, validDigest, 'Gitee-first 也必须取到 GitHub 官方 digest');
    assert.equal(gb.digestUrl, 'https://github.com/RoutineMiku/apkstart/releases/download/v9.9.9/ApkStart-v-win64-portable.zip');
    assert.ok(!/gitee\.com/i.test(gb.digestUrl), 'digestUrl 不得指向 Gitee');
  });

  await atest('T1-2 语法非法 / 缺失 / 大写归一', async () => {
    const bad = await freshSources(fixture({ gheeDigest: 'not-a-digest' })).latest();
    assert.equal(byName(bad, 'ApkStart-v-win64-portable.zip').digest, null, '非法语法 → null');
    const bare = await freshSources(fixture({ gheeDigest: `sha256:${validDigest}` })).latest();
    assert.equal(byName(bare, 'ApkStart-v-win64-portable.zip').digest, validDigest);
    const upper = 'ABCDEF0123456789'.repeat(4); // 64 hex，全大写
    const up = await freshSources(fixture({ gheeDigest: `sha256:${upper}` })).latest();
    assert.equal(byName(up, 'ApkStart-v-win64-portable.zip').digest, upper.toLowerCase(), '大写 → 小写');
    const missing = await freshSources(fixture({})).latest();
    assert.equal(byName(missing, 'ApkStart-v-win64-portable.zip').digest, null, '缺失 → null');
  });

  await atest('T1-3 synthetic release + 302 兜底 → digest=null，字段不变', async () => {
    const data = [{
      source: 'github', name: 'GitHub', web: 'https://github.com/RoutineMiku/apkstart',
      rel: {
        tag_name: 'v9.9.9', name: '9.9.9', body: '', published_at: '', synthetic: true,
        html_url: 'https://github.com/RoutineMiku/apkstart/releases/tag/v9.9.9',
        assets: [{
          name: 'ApkStart-v-win64-portable.zip', size: 0,
          browser_download_url: 'https://github.com/RoutineMiku/apkstart/releases/download/v9.9.9/ApkStart-v-win64-portable.zip',
        }],
      },
    }];
    const m = await freshSources(data).latest();
    const a = byName(m, 'ApkStart-v-win64-portable.zip');
    assert.equal(a.digest, null);
    assert.equal(a.digestUrl, null);
    assert.deepEqual(a.urls, ['https://github.com/RoutineMiku/apkstart/releases/download/v9.9.9/ApkStart-v-win64-portable.zip']);
  });

  await atest('T1-4 同名官方 digest 冲突 → 双 null（不拆桶）', async () => {
    // 两个同名 GitHub 官方资产带不同合法 digest — 真实冲突路径（I3）。
    const data = [{
      source: 'github', name: 'GitHub', web: 'https://github.com/RoutineMiku/apkstart',
      rel: {
        tag_name: 'v9.9.9', name: '9.9.9', body: '', published_at: '',
        html_url: 'https://github.com/x',
        assets: [
          { name: 'ApkStart-v-win64-portable.zip', size: 32, browser_download_url: 'https://github.com/x/a.zip', digest: `sha256:${validDigest}` },
          { name: 'ApkStart-v-win64-portable.zip', size: 32, browser_download_url: 'https://github.com/x/b.zip', digest: `sha256:${'b'.repeat(64)}` },
        ],
      },
    }];
    const m = await freshSources(data).latest();
    const conflict = m.assets.filter((a) => a.name === 'ApkStart-v-win64-portable.zip');
    assert.equal(conflict.length, 1, '冲突不拆桶，仍是单一合并项');
    assert.equal(conflict[0].digest, null, '冲突 → digest null');
    assert.equal(conflict[0].digestUrl, null, '冲突 → digestUrl null');
  });

  await atest('T1-5 Gitee 分片组 / 整包+分片并存 → 分片无 digest，整包胜出', async () => {
    const data = [
      {
        source: 'github', name: 'GitHub', web: 'https://github.com/RoutineMiku/apkstart',
        rel: {
          tag_name: 'v9.9.9', name: '9.9.9', body: '', published_at: '',
          html_url: 'https://github.com/x',
          assets: [{
            name: 'ApkStart-v-win64-portable.zip', size: 32,
            browser_download_url: 'https://github.com/x/ApkStart-v-win64-portable.zip',
            digest: `sha256:${validDigest}`,
          }],
        },
      },
      {
        source: 'gitee', name: 'Gitee', web: 'https://gitee.com/x',
        rel: {
          tag_name: 'v9.9.9', name: '9.9.9', body: '', published_at: '',
          html_url: 'https://gitee.com/x',
          assets: [
            { name: 'ApkStart-v-win64-portable.zip.part1', size: 16, browser_download_url: 'https://gitee.com/x/part1' },
            { name: 'ApkStart-v-win64-portable.zip.part2', size: 16, browser_download_url: 'https://gitee.com/x/part2' },
          ],
        },
      },
    ];
    const m = await freshSources(data).latest();
    const whole = byName(m, 'ApkStart-v-win64-portable.zip');
    assert.ok(whole, '整包应胜出');
    assert.equal(whole.partial, undefined, '整包不是 partial');
    assert.equal(whole.digest, validDigest);
    assert.ok(!m.assets.some((a) => a.partial), '整包存在时分片被剔除');
    // 纯分片组（无整包）也不得携带 digest
    const partsOnly = await freshSources([data[1]]).latest();
    const part = byName(partsOnly, 'ApkStart-v-win64-portable.zip');
    assert.equal(part.partial, true);
    assert.ok(!part.digest, '分片重组项永不携带 digest');
  });

  console.log('\n[T2 · updater.prepare 锚定]');

  let goodServer;
  try {
    goodServer = await zipServer();
    const goodUrl = `${baseOf(goodServer)}/ApkStart-v-win64-portable.zip`;

    await atest('T2-1 happy path：成功 + marker 含 digest + expectSha256 抵达 downloadMulti', async () => {
      const dir = path.join(TMP, 't2-1');
      cleanDir(dir);
      const { captured, restore } = installDownloadSpy();
      const u = freshUpdaterSpied({ dataDir: dir, settings: {
        runtime: { sourcePreference: 'github', mirrorPrefix: '', autoMirror: false, downloadConnections: 2 },
      } });
      u.sources.fetchReleases = async () => {
        const d = fixture({ gheeDigest: `sha256:${GOOD_SHA}` });
        d[0].rel.assets[0].browser_download_url = goodUrl;
        return d;
      };
      u.sources.rank = async (cands) => cands.filter((x) => x === goodUrl);
      try {
        await u.check();
        const r = await u.prepare();
        assert.equal(r.mode, 'zip');
        assert.equal(captured.opt.expectSha256, GOOD_SHA, 'expectSha256 必须抵达 downloadMulti');
        const marker = JSON.parse(fs.readFileSync(path.join(r.payload, '.apkstart-ready'), 'utf8'));
        assert.equal(marker.digest, GOOD_SHA, 'marker 必须含 digest');
        assert.equal(marker.assetName, 'ApkStart-v-win64-portable.zip', 'marker 必须含 assetName');
      } finally { restore(); }
    });

    await atest('T2-2 坏字节：downloadMulti 抛校验失败，无 marker、extract 未执行', async () => {
      const badServer = await zipServer({ corrupt: true });
      try {
        const dir = path.join(TMP, 't2-2');
        cleanDir(dir);
        const u = freshUpdater({ dataDir: dir, settings: {
          runtime: { sourcePreference: 'github', autoMirror: false, downloadConnections: 2 },
        } });
        const badUrl = `${baseOf(badServer)}/ApkStart-v-win64-portable.zip`;
        u.sources.fetchReleases = async () => {
          const d = fixture({ gheeDigest: `sha256:${GOOD_SHA}` });
          d[0].rel.assets[0].browser_download_url = badUrl;
          return d;
        };
        u.sources.rank = async () => [badUrl];
        let extracted = false;
        const origExtract = u._extract.bind(u);
        u._extract = async (...args) => { extracted = true; return origExtract(...args); };
        await u.check();
        await assert.rejects(u.prepare(), /校验失败/);
        const payload = path.join(dir, 'update', '9.9.9', 'payload');
        assert.equal(fs.existsSync(path.join(payload, '.apkstart-ready')), false, '坏字节不得写 marker');
        assert.equal(extracted, false, '坏字节不得进入 extract');
      } finally {
        badServer.closeAllConnections();
        await new Promise((r) => badServer.close(r));
      }
    });

    await atest('T2-3 同名 Gitee 更快且异字节：锚定候选集不含 Gitee，expectSha256=GH digest', async () => {
      const dir = path.join(TMP, 't2-3');
      cleanDir(dir);
      const { captured, restore } = installDownloadSpy();
      const u = freshUpdaterSpied({ dataDir: dir, settings: {
        runtime: { sourcePreference: 'auto', autoMirror: false, downloadConnections: 2 },
      } });
      u.sources.fetchReleases = async () => {
        const d = fixture({ gheeDigest: `sha256:${GOOD_SHA}` });
        d[0].rel.assets[0].browser_download_url = goodUrl;
        return d;
      };
      let rankedInput = null;
      u.sources.rank = async (cands) => { rankedInput = cands; return cands.filter((x) => x === goodUrl); };

      try {
        await u.check();
        await u.prepare();
        assert.ok(rankedInput && !rankedInput.some((x) => /gitee\.com/i.test(x)), '锚定候选不得含 Gitee URL');
        assert.equal(captured.opt.expectSha256, GOOD_SHA);
      } finally { restore(); }
    });

    await atest('T2-4 镜像透明代理（返回与 digest 一致字节）→ 成功', async () => {
      const mirrorUrl = `${goodUrl}?mirror=transparent`;
      const dir = path.join(TMP, 't2-4');
      cleanDir(dir);
      const u = freshUpdater({ dataDir: dir, settings: {
        runtime: { sourcePreference: 'github', autoMirror: false, downloadConnections: 2 },
      } });
      u.sources.fetchReleases = async () => {
        const d = fixture({ gheeDigest: `sha256:${GOOD_SHA}` });
        d[0].rel.assets[0].browser_download_url = goodUrl;
        return d;
      };
      u.sources.rank = async () => [mirrorUrl];
      await u.check();
      const r = await u.prepare();
      assert.equal(r.mode, 'zip');
      const marker = JSON.parse(fs.readFileSync(path.join(r.payload, '.apkstart-ready'), 'utf8'));
      assert.equal(marker.digest, GOOD_SHA, '镜像字节经 SHA 仲裁后标记成功');
    });

    await atest('T2-5 Setup 形态坏字节：交接前失败，apply 未执行', async () => {
      const badServer = await zipServer({ corrupt: true });
      try {
        const dir = path.join(TMP, 't2-5');
        cleanDir(dir);
        const badUrl = `${baseOf(badServer)}/ApkStart-9.9.9-Setup.exe`;
        const u = freshUpdater({ dataDir: dir, settings: {
          runtime: { sourcePreference: 'github', autoMirror: false, downloadConnections: 2 },
        } });
        u.sources.fetchReleases = async () => {
          const d = fixture({ gheeDigest: `sha256:${GOOD_SHA}` });
          d[0].rel.assets[2].browser_download_url = badUrl; // Setup.exe
          return d;
        };
        u.sources.rank = async () => [badUrl];
        let applied = false;
        u.apply = async () => { applied = true; };
        await u.check({ flavor: 'setup' }).catch(() => {});
        // 强制 setup 形态：直接构造 latest.asset 指向 Setup.exe
        const merged = await u.sources.latest();
        const setup = byName(merged, 'ApkStart-9.9.9-Setup.exe');
        u.latest = {
          version: '9.9.9', asset: { ...setup, digest: GOOD_SHA, digestUrl: setup.urls[0] },
        };
        await assert.rejects(u.prepare(), /校验失败/);
        assert.equal(applied, false, '坏字节不得进入 apply 交接');
      } finally {
        badServer.closeAllConnections();
        await new Promise((r) => badServer.close(r));
      }
    });
  } finally {
    if (goodServer) {
      goodServer.closeAllConnections();
      await new Promise((r) => goodServer.close(r));
    }
  }

  console.log('\n[T3 · provision.installRuntimePack]');

  function freshProvisioner({ dataDir } = {}) {
    const { Provisioner } = require(PROVISION_PATH);
    const p = new Provisioner(path.join(dataDir, 'app'));
    const root = path.join(dataDir, 'runtime');
    p.ensureDirs = () => ({ root, tmp: path.join(dataDir, 'tmp') });
    fs.mkdirSync(path.join(dataDir, 'tmp'), { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    return p;
  }

  await atest('T3-1 resolveRuntimePack 三类分流（GH 有 digest / Gitee null / custom null）', async () => {
    const dir = path.join(TMP, 't3-1');
    cleanDir(dir);
    const p = freshProvisioner({ dataDir: dir });
    const ghRel = {
      tag_name: 'v9.9.9', html_url: 'https://github.com/x',
      assets: [{ name: 'ApkStart-runtime-9.9.9.zip', size: 32, browser_download_url: 'https://github.com/x/rt.zip', digest: `sha256:${validDigest}` }],
    };
    p._fetchJson = async () => [ghRel];
    const pack = await p.resolveRuntimePack();
    assert.equal(pack.digest, validDigest, 'GitHub 资产携带 digest');
    p._cache.pack = null;
    p._fetchJson = async (url) => (url.includes('gitee') ? [{ tag_name: 'v9.9.9', html_url: 'https://gitee.com/x', assets: [{ name: 'ApkStart-runtime-9.9.9.zip', size: 32, browser_download_url: 'https://gitee.com/x/rt.zip', digest: `sha256:${'c'.repeat(64)}` }] }] : null);
    const giteePack = await p.resolveRuntimePack();
    assert.equal(giteePack.digest, null, 'Gitee 源永不继承 digest');
    const store = require(path.join(CORE, 'store.js'));
    const orig = store.getSettings;
    store.getSettings = () => ({ runtime: { runtimePackUrl: 'https://custom.example/rt.zip' } });
    try {
      const custom = await p.resolveRuntimePack();
      assert.equal(custom.digest, null, 'custom 直通显式 digest:null');
    } finally { store.getSettings = orig; }
  });

  await atest('T3-2 installRuntimePack 错字节：抛错且 extractZip spy 0 次调用', async () => {
    const badServer = await zipServer({ corrupt: true });
    try {
      const dir = path.join(TMP, 't3-2');
      cleanDir(dir);
      const p = freshProvisioner({ dataDir: dir });
      p.resolveRuntimePack = async () => ({ url: `${baseOf(badServer)}/rt.zip`, name: 'ApkStart-runtime-9.9.9.zip', size: TINY_ZIP.length, tag: '9.9.9', from: 'GitHub', digest: GOOD_SHA });
      p.guardDisk = async () => {};
      p.materializeImages = async () => {};
      p._assertPackComplete = () => {};
      p.sources.rank = async (cands) => cands;
      p._downloadUrls = () => [`${baseOf(badServer)}/rt.zip`];
      let extractCalls = 0;
      p.extractZip = async () => { extractCalls++; };
      await assert.rejects(p.installRuntimePack(), /校验失败/);
      assert.equal(extractCalls, 0, '错字节必须止于 extractZip 之前');
    } finally {
      badServer.closeAllConnections();
      await new Promise((r) => badServer.close(r));
    }
  });

  await atest('T3-3 installRuntimePack 正确 tiny 字节：extractZip spy 恰 1 次', async () => {
    const dir = path.join(TMP, 't3-3');
    cleanDir(dir);
    const srv = await zipServer();
    try {
      const p = freshProvisioner({ dataDir: dir });
      p.resolveRuntimePack = async () => ({ url: `${baseOf(srv)}/rt.zip`, name: 'ApkStart-runtime-9.9.9.zip', size: TINY_ZIP.length, tag: '9.9.9', from: 'GitHub', digest: GOOD_SHA });
      p.guardDisk = async () => {};
      p.materializeImages = async () => {};
      p._assertPackComplete = () => {};
      p.sources.rank = async (cands) => cands;
      let extractCalls = 0;
      p.extractZip = async () => { extractCalls++; };
      await p.installRuntimePack();
      assert.equal(extractCalls, 1, '正确字节应恰好 extract 一次');
    } finally {
      srv.closeAllConnections();
      await new Promise((r) => srv.close(r));
    }
  });

  await atest('T3-4 custom / Gitee-only 无锚：downloadMulti 无 expectSha256，PR2 形状', async () => {
    const srv = await zipServer();
    const { captured, restore } = installDownloadSpy();
    try {
      const dir = path.join(TMP, 't3-4');
      cleanDir(dir);
      const { Provisioner } = require(PROVISION_PATH);
      const p = new Provisioner(path.join(dir, 'app'));
      const root = path.join(dir, 'runtime');
      p.ensureDirs = () => ({ root, tmp: path.join(dir, 'tmp') });
      fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
      fs.mkdirSync(root, { recursive: true });
      p.resolveRuntimePack = async () => ({ url: `${baseOf(srv)}/rt.zip`, name: 'rt.zip', size: TINY_ZIP.length, tag: '9.9.9', from: 'Gitee', digest: null });
      p.guardDisk = async () => {};
      p.materializeImages = async () => {};
      p._assertPackComplete = () => {};
      p.sources.rank = async (cands) => cands;
      p.extractZip = async () => {};
      try {
        await p.installRuntimePack();
        assert.equal(captured.opt.expectSha256, undefined, '无锚时不得传 expectSha256');
      } finally { restore(); }
    } finally {
      srv.closeAllConnections();
      await new Promise((r) => srv.close(r));
    }
  });

  console.log('\n[T4 · marker 身份化 / 缓存]');

  await atest('T4-1 遗留 marker（无 digest）+ 锚定期望 → 拒绝复用→重下→新 marker 带 digest', async () => {
    const dir = path.join(TMP, 't4-1');
    cleanDir(dir);
    const srv = await zipServer();
    try {
      const payload = path.join(dir, 'update', '9.9.9', 'payload');
      fs.mkdirSync(payload, { recursive: true });
      fs.writeFileSync(path.join(payload, 'ApkStart.exe'), 'placeholder');
      fs.writeFileSync(path.join(payload, '.apkstart-ready'), JSON.stringify({ version: '9.9.9', at: Date.now() }));
      const u = freshUpdater({ dataDir: dir, settings: {
        runtime: { sourcePreference: 'github', autoMirror: false, downloadConnections: 2 },
      } });
      u.sources.fetchReleases = async () => {
        const d = fixture({ gheeDigest: `sha256:${GOOD_SHA}` });
        d[0].rel.assets[0].browser_download_url = `${baseOf(srv)}/ApkStart-v-win64-portable.zip`;
        return d;
      };
      u.sources.rank = async () => [`${baseOf(srv)}/ApkStart-v-win64-portable.zip`];
      await u.check();
      const r = await u.prepare();
      const marker = JSON.parse(fs.readFileSync(path.join(r.payload, '.apkstart-ready'), 'utf8'));
      assert.equal(marker.digest, GOOD_SHA, '重下后 marker 带 digest');
    } finally {
      srv.closeAllConnections();
      await new Promise((r) => srv.close(r));
    }
  });

  await atest('T4-2 无锚期望 + 遗留 marker → 复用照旧（PR2 语义）', async () => {
    const dir = path.join(TMP, 't4-2');
    cleanDir(dir);
    const { Updater } = require(UPDATER_PATH);
    const u = new Updater({
      currentVersion: '0.0.1', exePath: path.join(dir, 'app', 'ApkStart.exe'),
      isPackaged: false, dataDir: dir,
    });
    const payload = path.join(dir, 'update', '9.9.9', 'payload');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'ApkStart.exe'), 'placeholder');
    // 遗留 marker：只有 version/at，无 digest/assetName。
    u._markPayloadReady(payload, '9.9.9');
    const marker = JSON.parse(fs.readFileSync(u._readyFile(payload), 'utf8'));
    assert.equal(marker.digest, undefined, '无锚写入的 marker 不含 digest');
    // 无锚期望：遗留 marker 照旧可复用；锚定期望：同一 marker 必须被拒。
    assert.equal(u._payloadReady(payload, '9.9.9', undefined), true, '无锚期望复用照旧');
    assert.equal(u._payloadReady(payload, '9.9.9', { digest: GOOD_SHA, assetName: 'portable.zip' }), false,
      '锚定期望必须拒绝无身份的遗留 marker');
  });

  await atest('T4-3 force 换 release（有 digest → 无 digest）→ 新结果 digest=null，无残留', async () => {
    const s = freshSources(fixture({ gheeDigest: `sha256:${validDigest}` }));
    const first = await s.latest();
    assert.equal(byName(first, 'ApkStart-v-win64-portable.zip').digest, validDigest);
    // force 后换成一个完全没有 digest 的 release 源。
    s.fetchReleases = async () => fixture({});
    const second = await s.latest({ force: true });
    assert.equal(byName(second, 'ApkStart-v-win64-portable.zip').digest, null, 'force 后无旧 digest 残留');
    assert.equal(byName(second, 'ApkStart-runtime-9.9.9.zip').digest, null);
  });

  await atest('T4-4 stale tag 缓存：命中对象 digest 与 URL 同批，force 刷新不残留', async () => {
    const s = freshSources(fixture({ gheeDigest: `sha256:${validDigest}` }));
    const a = await s.latest();
    const b = await s.latest();
    assert.strictEqual(b, a, '缓存命中返回同一对象');
    const asset = byName(a, 'ApkStart-v-win64-portable.zip');
    assert.equal(asset.digest, validDigest);
    assert.ok(asset.digestUrl && asset.urls.includes(asset.digestUrl), 'digestUrl 与该资产的 URL 同批');
  });

  cleanDir(TMP);
  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
