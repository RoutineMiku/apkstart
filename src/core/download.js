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

/**
 * 并行分块下载（大文件专用）。
 * 单条 TCP 连接在部分镜像上会被限速到几十 KB/s，分块并发能显著提升实际吞吐。
 * 仅在「目标文件不存在」时并行；已有部分文件时退回单流续传，避免分块状态丢失。
 */
async function downloadParallel(url, dest, opt = {}) {
  const {
    connections = 8,
    onProgress = () => {},
    minChunk = 1024 * 1024,
    retries = 3,
  } = opt;

  // 已有部分文件 → 交给单流续传
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return download(url, dest, opt);
  }

  // 探测是否支持 Range
  let total = 0;
  let supportsRange = false;
  try {
    const probe = await openStream(url, { headers: { Range: 'bytes=0-0' } });
    const cr = probe.headers['content-range'];
    if (probe.statusCode === 206 && cr) {
      supportsRange = true;
      total = Number(/\/(\d+)$/.exec(cr)[1]) || 0;
    } else {
      total = Number(probe.headers['content-length']) || 0;
    }
    probe.destroy();
  } catch (_) { /* 探测失败则走单流 */ }

  if (!supportsRange || !total || total < minChunk * 2) {
    return download(url, dest, opt);
  }

  const n = Math.max(1, Math.min(connections, Math.ceil(total / minChunk)));
  const per = Math.ceil(total / n);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { force: true });

  // 先建空文件并定位到末字节，避免后续 write 越界
  const fd = fs.openSync(dest, 'w');
  fs.ftruncateSync(fd, total);

  const chunks = Array.from({ length: n }, (_, i) => {
    const start = i * per;
    const end = Math.min(total - 1, start + per - 1);
    return { start, end, pos: start, done: false, tries: 0 };
  });

  let got = 0;
  let lastTick = Date.now();
  let lastBytes = 0;
  const tick = () => {
    const now = Date.now();
    if (now - lastTick < 400) return;
    const speed = (got - lastBytes) / ((now - lastTick) / 1000);
    lastTick = now;
    lastBytes = got;
    onProgress({
      got, total,
      percent: Math.min(100, (got / total) * 100),
      speed,
      eta: speed > 0 ? Math.max(0, (total - got) / speed) : null,
    });
  };

  const fetchChunk = async (c) => {
    const res = await openStream(url, { headers: { Range: `bytes=${c.pos}-${c.end}` } });
    if (res.statusCode !== 206) {
      res.resume();
      throw new Error(`分块请求被拒绝 HTTP ${res.statusCode}`);
    }
    await new Promise((resolve, reject) => {
      res.on('data', (buf) => {
        try {
          fs.writeSync(fd, buf, 0, buf.length, c.pos);
        } catch (e) {
          res.destroy();
          return reject(e);
        }
        c.pos += buf.length;
        got += buf.length;
        tick();
      });
      res.on('end', resolve);
      res.on('error', reject);
    });
    return c.pos > c.end;
  };

  try {
    await Promise.all(chunks.map(async (c) => {
      for (;;) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const ok = await fetchChunk(c);
          if (ok) return;
          throw new Error('分块未完整返回');
        } catch (e) {
          c.tries += 1;
          if (c.tries >= retries) throw new Error(`分块下载失败（${c.start}-${c.end}）：${e.message}`);
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 800 * c.tries));
        }
      }
    }));
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  fs.closeSync(fd);

  const size = fs.statSync(dest).size;
  onProgress({ got: size, total: size, percent: 100, speed: 0, eta: 0 });
  if (size !== total) throw new Error(`下载不完整：${size}/${total} 字节`);
  return { file: dest, size, parallel: n };
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

/** 依次尝试多个源（并行分块版），任一成功即返回 */
async function downloadAnyParallel(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await downloadParallel(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      errors.push(`${u} → ${e.message}`);
    }
  }
  throw new Error(`所有下载源均失败：\n${errors.join('\n')}`);
}

module.exports = {
  download, downloadAny, downloadParallel, downloadAnyParallel, head, sha256File, openStream,
};
