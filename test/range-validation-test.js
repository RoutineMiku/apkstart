'use strict';
/**
 * 下载器范围校验的纯 Node 测试（不需要真实网络/模拟器）。
 * 覆盖 #92 贡献的 Content-Range 校验与 416 续传修复：
 *   - validRange 逐项比对起止位、总大小、Content-Length；
 *   - 单流遇到 416 时丢弃坏残片、重新完整下载；
 *   - 分块/多源下载遇到不匹配的范围时拒绝，不把损坏字节拼进目标文件。
 * 运行：node test/range-validation-test.js
 */
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { download, downloadParallel, downloadMulti, validRange } = require('../src/core/download');

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

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const baseOf = (server) => `http://127.0.0.1:${server.address().port}`;

(async () => {
  console.log('\n[download.js Content-Range 校验]');

  test('validRange 接受完全匹配的响应', () => {
    const res = { headers: { 'content-range': 'bytes 100-199/500', 'content-length': '100' } };
    assert.equal(validRange(res, 100, 199, 500), true);
  });
  test('validRange 容忍缺失的 Content-Length', () => {
    const res = { headers: { 'content-range': 'bytes 100-199/500' } };
    assert.equal(validRange(res, 100, 199, 500), true);
  });
  test('validRange 拒绝错误起点/终点/总大小/长度', () => {
    const hdr = (cr, len) => ({ headers: { 'content-range': cr, 'content-length': len } });
    assert.equal(validRange(hdr('bytes 101-199/500', '99'), 100, 199, 500), false, '起点不符');
    assert.equal(validRange(hdr('bytes 100-198/500', '99'), 100, 199, 500), false, '终点不符');
    assert.equal(validRange(hdr('bytes 100-199/400', '100'), 100, 199, 500), false, '总大小不符');
    assert.equal(validRange(hdr('bytes 100-199/500', '99'), 100, 199, 500), false, '长度不符');
    assert.equal(validRange(hdr('', '100'), 100, 199, 500), false, '缺少 Content-Range');
    assert.equal(validRange(hdr('bytes 0-3/8', '4'), 0, 3, 8), true);
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-range-'));
  try {
    // /416: 带 Range 就回 416，不带 Range 回完整的 "good"
    // /bad: 探测 bytes=0-0 回合法头，其余请求一律回 bytes 0-3/8（与请求范围不符）
    const server = await serve((req, res) => {
      const r = req.headers.range;
      if (req.url === '/416') {
        if (r) { res.writeHead(416, { 'Content-Range': 'bytes */4' }); res.end(); }
        else { res.writeHead(200, { 'Content-Length': '4' }); res.end('good'); }
      } else if (req.url === '/ok' || req.url.startsWith('/ok?')) {
        // 同样的总长度和合法 Range 头不保证两个镜像是同一字节对象。
        const content = req.url.includes('mirror=poison') ? 'abcdWXYZ' : 'abcdefgh';
        if (r === 'bytes=0-0') { res.writeHead(206, { 'Content-Range': 'bytes 0-0/8', 'Content-Length': '1' }); res.end(content[0]); }
        else if (r) {
          const m = /bytes=(\d+)-(\d+)/.exec(r);
          const s = Number(m[1]); const e = Number(m[2]); const body = content.slice(s, e + 1);
          res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/8`, 'Content-Length': String(body.length) });
          res.end(body);
        } else { res.writeHead(200, { 'Content-Length': '8' }); res.end(content); }
      } else {
        if (r === 'bytes=0-0') { res.writeHead(206, { 'Content-Range': 'bytes 0-0/8', 'Content-Length': '1' }); res.end('a'); }
        else { res.writeHead(206, { 'Content-Range': 'bytes 0-3/8', 'Content-Length': '4' }); res.end('abcd'); }
      }
    });
    const base = baseOf(server);
    try {
      await atest('单流 416：丢弃坏残片并重新完整下载', async () => {
        const out = path.join(dir, 'one');
        fs.writeFileSync(out, 'corrupt data');
        await download(`${base}/416`, out);
        assert.equal(fs.readFileSync(out, 'utf8'), 'good');
      });

      await atest('单流 206 范围不符时拒绝', async () => {
        const out = path.join(dir, 'resume');
        fs.writeFileSync(out, 'xxxx'); // 让请求带 Range: bytes=4-
        await assert.rejects(download(`${base}/bad`, out), /范围/);
      });

      await atest('downloadParallel 范围不符时拒绝，不留半截文件', async () => {
        const out = path.join(dir, 'two');
        await assert.rejects(
          downloadParallel(`${base}/bad`, out, { connections: 2, minChunk: 2, retries: 1 }),
          /范围/,
        );
        assert.equal(fs.existsSync(out), false, '失败后目标文件应被清理');
      });

      await atest('downloadMulti 范围不符时拒绝', async () => {
        const out = path.join(dir, 'three');
        await assert.rejects(
          downloadMulti([`${base}/bad1`, `${base}/bad2`], out, { connections: 2, minChunk: 2, retries: 1 }),
          /范围/,
        );
      });

      // 负控：摘要验证必须覆盖并行/多源出口，不能只覆盖单流。
      const goodSha = crypto.createHash('sha256').update('abcdefgh').digest('hex');
      const options = { connections: 2, minChunk: 2, retries: 1 };
      await atest('downloadParallel 错误 SHA-256 必须拒绝并删除坏文件', async () => {
        const out = path.join(dir, 'parallel-bad-digest');
        await assert.rejects(
          downloadParallel(`${base}/ok`, out, { ...options, expectSha256: '0'.repeat(64) }),
          /校验失败/,
        );
        assert.equal(fs.existsSync(out), false, '摘要错误时不应留下坏成品');
      });

      await atest('downloadParallel 正确 SHA-256 保持原字节', async () => {
        const out = path.join(dir, 'parallel-good-digest');
        await downloadParallel(`${base}/ok`, out, { ...options, expectSha256: goodSha });
        assert.equal(fs.readFileSync(out, 'utf8'), 'abcdefgh');
      });

      const mirrors = [`${base}/ok?mirror=one`, `${base}/ok?mirror=two`];
      await atest('downloadMulti 错误 SHA-256 必须拒绝并删除坏文件', async () => {
        const out = path.join(dir, 'multi-bad-digest');
        await assert.rejects(
          downloadMulti(mirrors, out, { ...options, expectSha256: '0'.repeat(64) }),
          /校验失败/,
        );
        assert.equal(fs.existsSync(out), false, '摘要错误时不应留下坏成品');
      });

      await atest('downloadMulti 正确 SHA-256 保持原字节', async () => {
        const out = path.join(dir, 'multi-good-digest');
        await downloadMulti(mirrors, out, { ...options, expectSha256: goodSha });
        assert.equal(fs.readFileSync(out, 'utf8'), 'abcdefgh');
      });

      await atest('同大小但不同内容的镜像不可拼成通过校验的整包', async () => {
        const out = path.join(dir, 'multi-poisoned-mirror');
        const badMirrors = [`${base}/ok?mirror=one`, `${base}/ok?mirror=poison`];
        await assert.rejects(
          downloadMulti(badMirrors, out, { ...options, expectSha256: goodSha }),
          /校验失败/,
        );
        assert.equal(fs.existsSync(out), false, '混入污染镜像时不应保留坏文件');
        assert.equal(fs.existsSync(`${out}.chunks.json`), false, '不能留下可复用的坏边车');
      });

      await atest('合法范围下载仍然成功（无回归）', async () => {
        const out = path.join(dir, 'ok');
        const r = await download(`${base}/ok`, out, { retries: 1 });
        assert.equal(fs.readFileSync(out, 'utf8'), 'abcdefgh');
        assert.equal(r.size, 8);
      });
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ===== PR2 / BUG-NOANCHOR：无独立可信摘要时禁止跨源混块 =====
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-noanchor-'));
  let server2;
  try {
    // 16 字节、同声明总长；POISON 与 FIRST 字节完全不同（合法 206，仍是毒镜像）。
    const CONTENT16 = 'abcdefghijklmnop';
    const POISON16 = 'ABCDEFGHIJKLMNOP';
    const sha16 = crypto.createHash('sha256').update(CONTENT16).digest('hex');
    const serveBody = (content, req, res) => {
      const r = req.headers.range;
      if (r === 'bytes=0-0') {
        res.writeHead(206, { 'Content-Range': 'bytes 0-0/16', 'Content-Length': '1' });
        res.end(content[0]);
      } else if (r) {
        const m = /bytes=(\d+)-(\d+)/.exec(r);
        const s = Number(m[1]); const e = Number(m[2]);
        const body = content.slice(s, e + 1);
        res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/16`, 'Content-Length': String(body.length) });
        res.end(body);
      } else {
        res.writeHead(200, { 'Content-Length': '16' });
        res.end(content);
      }
    };
    server2 = await serve((req, res) => {
      if (req.url.startsWith('/mirror')) {
        serveBody(req.url.includes('mirror=poison') ? POISON16 : CONTENT16, req, res);
      } else if (req.url.startsWith('/only')) {
        // 不支持 Range 的整源：永远 200 整包（回退用例用，避免旧实现把 stale dest 当续传）
        res.writeHead(200, { 'Content-Length': '16' });
        res.end(CONTENT16);
      } else if (req.url.startsWith('/fail')) {
        res.writeHead(500, { 'Content-Length': '0' });
        res.end();
      } else if (req.url === '/slow') {
        // 先吐 4 字节再挂住连接，等客户端 abort
        res.writeHead(200, { 'Content-Length': '16' });
        res.write(CONTENT16.slice(0, 4));
      } else {
        serveBody(CONTENT16, req, res);
      }
    });
    const base2 = baseOf(server2);
    const options2 = { connections: 2, minChunk: 2, retries: 1 };

    await atest('PR2-1 无锚同长异容镜像退化为单源整源，不混块', async () => {
      const out = path.join(dir2, 'noanchor-mixed');
      const r = await downloadMulti(
        [`${base2}/mirror?mirror=one`, `${base2}/mirror?mirror=poison`], out, options2,
      );
      assert.equal(fs.readFileSync(out, 'utf8'), CONTENT16, '必须是排名首源的整份原始字节');
      assert.equal(r.multi, false);
      assert.equal(r.sources, 1);
      assert.equal(fs.existsSync(`${out}.chunks.json`), false, '无锚路径不应产生边车');
    });

    await atest('PR2-2 无锚首源失败整源回退次源并清理预置边车', async () => {
      const out = path.join(dir2, 'noanchor-fallback');
      fs.writeFileSync(out, 'stale');
      fs.writeFileSync(`${out}.chunks.json`, JSON.stringify({ total: 16, n: 2, done: [0] }));
      await downloadMulti([`${base2}/fail`, `${base2}/only`], out, options2);
      assert.equal(fs.readFileSync(out, 'utf8'), CONTENT16);
      assert.equal(fs.existsSync(`${out}.chunks.json`), false, 'stale 边车应被清理');
    });

    await atest('PR2-3 无锚 stale 边车不可复用，整源重下且非 resumed', async () => {
      const out = path.join(dir2, 'noanchor-stale');
      // done:[0] 指向的 0-7 段是异源毒字节；旧实现跳过它直接拼进成品。
      fs.writeFileSync(out, 'XXXXXXXXXXXXXXXX');
      fs.writeFileSync(`${out}.chunks.json`, JSON.stringify({ total: 16, n: 2, done: [0] }));
      const r = await downloadMulti(
        [`${base2}/mirror?mirror=one`, `${base2}/mirror?mirror=poison`], out, options2,
      );
      assert.equal(fs.readFileSync(out, 'utf8'), CONTENT16, '毒字节不得被当作已完成块复用');
      assert.equal(r.multi, false, '必须退化为单源，而不是续传多源拼块');
      assert.equal(r.resumed, false);
      assert.equal(fs.existsSync(`${out}.chunks.json`), false, 'stale 边车应被清除');
    });

    await atest('PR2-4 有锚同容双镜像仍走多源（能力保留）', async () => {
      const out = path.join(dir2, 'anchor-ok');
      const r = await downloadMulti(
        [`${base2}/mirror?mirror=one`, `${base2}/mirror?mirror=two`], out, { ...options2, expectSha256: sha16 },
      );
      assert.equal(fs.readFileSync(out, 'utf8'), CONTENT16);
      assert.equal(r.multi, true);
    });

    await atest('PR2-5 无锚全源失败：拒绝且不留 dest/边车', async () => {
      const out = path.join(dir2, 'noanchor-allfail');
      fs.writeFileSync(out, 'stale');
      fs.writeFileSync(`${out}.chunks.json`, JSON.stringify({ total: 16, n: 2, done: [0] }));
      await assert.rejects(
        downloadMulti([`${base2}/fail?a=1`, `${base2}/fail?a=2`], out, options2),
      );
      assert.equal(fs.existsSync(out), false, '失败后不得留目标文件');
      assert.equal(fs.existsSync(`${out}.chunks.json`), false, '失败后不得留边车');
    });

    await atest('PR2-6 单流 cancel：abort 后拒绝并清理残片', async () => {
      const out = path.join(dir2, 'cancel');
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 80);
      try {
        await assert.rejects(download(`${base2}/slow`, out, { signal: ac.signal, retries: 1 }));
      } finally {
        clearTimeout(timer);
        server2.closeAllConnections();
      }
      assert.equal(fs.existsSync(out), false, '取消后不得留下残片');
    });
  } finally {
    if (server2) {
      server2.closeAllConnections();
      await new Promise((r) => server2.close(r));
    }
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
