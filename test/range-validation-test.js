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
      } else if (req.url === '/ok') {
        if (r === 'bytes=0-0') { res.writeHead(206, { 'Content-Range': 'bytes 0-0/8', 'Content-Length': '1' }); res.end('a'); }
        else if (r) {
          const m = /bytes=(\d+)-(\d+)/.exec(r);
          const s = Number(m[1]); const e = Number(m[2]); const body = 'abcdefgh'.slice(s, e + 1);
          res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/8`, 'Content-Length': String(body.length) });
          res.end(body);
        } else { res.writeHead(200, { 'Content-Length': '8' }); res.end('abcdefgh'); }
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
        await assert.rejects(download(`${base}/bad`, out), /range/i);
      });

      await atest('downloadParallel 范围不符时拒绝，不留半截文件', async () => {
        const out = path.join(dir, 'two');
        await assert.rejects(
          downloadParallel(`${base}/bad`, out, { connections: 2, minChunk: 2, retries: 1 }),
          /range/i,
        );
        assert.equal(fs.existsSync(out), false, '失败后目标文件应被清理');
      });

      await atest('downloadMulti 范围不符时拒绝', async () => {
        const out = path.join(dir, 'three');
        await assert.rejects(
          downloadMulti([`${base}/bad1`, `${base}/bad2`], out, { connections: 2, minChunk: 2, retries: 1 }),
          /range/i,
        );
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

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
