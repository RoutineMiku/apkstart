'use strict';
/**
 * 下载器：支持重定向、断点续传、进度回调、SHA-256 校验
 * 只依赖 http/https，主进程与纯 Node 测试都可使用。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const UA = 'ApkStart/0.2 (Windows; +https://github.com/apkstart)';

function openStream(url, { method = 'GET', headers = {}, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('重定向次数过多'));
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method,
      timeout: 30000,
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...headers },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(openStream(next, { method, headers, redirects: redirects + 1 }));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('连接超时')); });
    req.end();
  });
}

async function head(url) {
  try {
    const res = await openStream(url, { method: 'HEAD' });
    res.resume();
    return {
      status: res.statusCode,
      size: Number(res.headers['content-length']) || 0,
      type: res.headers['content-type'] || '',
    };
  } catch (e) {
    return { status: 0, size: 0, error: e.message };
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * 下载到本地文件（自动续传）。
 * @param {string} url
 * @param {string} dest
 * @param {object} opt { onProgress({got,total,percent,speed}), signal, expectSha256, timeoutMs }
 */
async function download(url, dest, opt = {}) {
  const { onProgress = () => {}, signal, expectSha256, retries = 2 } = opt;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let attempt = 0;
  for (;;) {
    attempt++;
    const existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const headers = {};
    if (existing > 0) headers.Range = `bytes=${existing}-`;

    // eslint-disable-next-line no-await-in-loop
    const res = await openStream(url, { headers });

    if (res.statusCode === 416) {
      res.resume();
      // 已下载完整
      break;
    }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      if (attempt <= retries) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      throw new Error(`下载失败 HTTP ${res.statusCode}: ${url}`);
    }

    const total = res.statusCode === 206
      ? existing + (Number(res.headers['content-length']) || 0)
      : Number(res.headers['content-length']) || 0;

    if (res.statusCode === 200 && existing > 0) {
      // 服务器不支持续传，重头写
      fs.rmSync(dest, { force: true });
    }

    await new Promise((resolve, reject) => {
      const startSize = res.statusCode === 206 ? existing : 0;
      let got = startSize;
      let lastTick = Date.now();
      let lastBytes = got;
      const ws = fs.createWriteStream(dest, { flags: startSize > 0 ? 'a' : 'w' });

      const onAbort = () => { res.destroy(new Error('已取消')); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      res.on('data', (c) => {
        got += c.length;
        const now = Date.now();
        if (now - lastTick > 400) {
          const speed = (got - lastBytes) / ((now - lastTick) / 1000);
          lastTick = now;
          lastBytes = got;
          onProgress({
            got, total,
            percent: total ? Math.min(100, (got / total) * 100) : 0,
            speed,
            eta: total && speed > 0 ? Math.max(0, (total - got) / speed) : null,
          });
        }
      });
      res.pipe(ws);
      ws.on('finish', () => resolve());
      ws.on('error', reject);
      res.on('error', reject);
    });

    break;
  }

  // 收尾：确保进度条走到 100%
  const finalSize = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  onProgress({ got: finalSize, total: finalSize, percent: 100, speed: 0, eta: 0 });

  if (expectSha256) {
    const actual = await sha256File(dest);
    if (actual.toLowerCase() !== expectSha256.toLowerCase()) {
      fs.rmSync(dest, { force: true });
      throw new Error(`校验失败：期望 ${expectSha256.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…`);
    }
  }
  return { file: dest, size: fs.statSync(dest).size };
}

/** 依次尝试多个源，任一成功即返回 */
async function downloadAny(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await download(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      errors.push(`${u} → ${e.message}`);
    }
  }
  throw new Error(`所有下载源均失败：\n${errors.join('\n')}`);
}

module.exports = { download, downloadAny, head, sha256File, openStream };
