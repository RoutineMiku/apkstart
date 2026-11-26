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
const { t } = require('./i18n');

const UA = 'ApkStart/0.2 (Windows; +https://github.com/apkstart)';

/**
 * 校验服务器返回的 Content-Range 是否与本次请求一致。
 * 断点续传/分块下载最怕「服务器不认 Range、从头发整包」或「返回了别的文件的分块」——
 * 直接写进目标文件会拼出看似完整、实则损坏的包。这里逐项比对起止位、总大小和
 * Content-Length，有任何不符就拒绝，交给上层换源/重来。
 */
function validRange(res, start, end, total) {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(res.headers['content-range'] || ''));
  if (!m) return false;
  const [a, b, size] = m.slice(1).map(Number);
  const length = res.headers['content-length'];
  return Number.isSafeInteger(size) && a === start && b === end && size === total &&
    (length == null || Number(length) === end - start + 1);
}

function openStream(url, { method = 'GET', headers = {}, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error(t('download.tooManyRedirects')));
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
    req.on('timeout', () => { req.destroy(new Error(t('download.timeout'))); });
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
 * 丢弃一次失败下载留下的所有残余。
 *
 * 这是「一直重复下载」的根因：以前所有失败路径都只抛异常、不删文件，
 * 于是 tmp 里永远躺着一个半截 zip + 一份 .chunks.json 边车。下次进来
 * downloadParallel/download 看到已有文件就带 Range 续传，可服务器给的
 * 总大小/分块方式只要和上次不一样，就会继续失败 → 又留下半截文件 →
 * 无限循环。用户看到的是「每次打开都在重新下载同一个包」。
 *
 * 保留断点续传的价值没错，但必须限定在「确认能续」的场景；一旦这次
 * 下载判定失败，就整包作废，下次干净重来。
 */
function discardPartial(dest) {
  for (const p of [dest, `${dest}.chunks.json`, `${dest}.part`]) {
    try { fs.rmSync(p, { force: true }); } catch (_) { /* 被占用就算了 */ }
  }
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
  try {
  for (;;) {
    attempt++;
    const existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const headers = {};
    if (existing > 0) headers.Range = `bytes=${existing}-`;

    // eslint-disable-next-line no-await-in-loop
    const res = await openStream(url, { headers });

    if (res.statusCode === 416) {
      res.resume();
      // 416 有两种可能：文件真的下完了，或本地残片与目标对不上（服务器认为这个
      // Range 不合法）。以前无条件当成功，会把坏残片留成"已下载"。这里只要带过
      // Range 且还能重试，就清掉残片重新完整拉一遍；重试用尽仍未成功则报错。
      if (existing > 0 && attempt <= retries + 1) {
        discardPartial(dest);
        continue;
      }
      throw new Error(t('download.resume416'));
    }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      if (attempt <= retries) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      discardPartial(dest);   // 重试耗尽：别把坏文件留给下次续传
      throw new Error(t('download.httpFailed', [res.statusCode, url]));
    }

    if (res.statusCode === 206) {
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(res.headers['content-range'] || ''));
      if (!m || !validRange(res, existing, Number(m[2]), Number(m[3])) || Number(m[2]) !== Number(m[3]) - 1) {
        res.resume();
        discardPartial(dest);
        throw new Error(t('download.resumeRangeMismatch'));
      }
    }

    const total = res.statusCode === 206
      ? existing + (Number(res.headers['content-length']) || 0)
      : Number(res.headers['content-length']) || 0;

    if (res.statusCode === 200 && existing > 0) {
      // 服务器不支持续传，重头写
      fs.rmSync(dest, { force: true });
    }

    try {
      await new Promise((resolve, reject) => {
        const startSize = res.statusCode === 206 ? existing : 0;
        let got = startSize;
        let lastTick = Date.now();
        let lastBytes = got;
        const ws = fs.createWriteStream(dest, { flags: startSize > 0 ? 'a' : 'w' });

        // 和分块下载一样：必须保证 promise 一定会 settle。
        // 连接静默（被墙/被限速）时 res 既不 end 也不 error，pipe 永远不 finish，
        // 整个下载就卡死在这里，用户看到的是进度条不动、也没有报错。
        const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 30000;
        let settled = false;
        let idle = null;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          if (idle) clearTimeout(idle);
          try { ws.destroy(); } catch (_) { /* ignore */ }
          if (err) reject(err); else resolve();
        };
        const kick = () => {
          if (settled) return;
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => {
            res.destroy();
            finish(new Error(t('download.stalled')));
          }, idleMs);
        };
        kick();

        const onAbort = () => { res.destroy(new Error(t('download.cancelled'))); };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        res.on('data', (c) => {
          got += c.length;
          kick();
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
        ws.on('finish', () => finish());
        ws.on('error', (e) => finish(e));
        res.on('error', (e) => finish(e));
        res.on('close', () => { if (!res.complete) finish(new Error(t('download.interrupted'))); });
      });
    } catch (e) {
      // 中断 / 超时 / 写盘失败：半截文件留着只会让下次续传继续失败
      discardPartial(dest);
      throw e;
    }

    break;
  }

  // 收尾：确保进度条走到 100%
  const finalSize = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  onProgress({ got: finalSize, total: finalSize, percent: 100, speed: 0, eta: 0 });

  if (expectSha256) {
    const actual = await sha256File(dest);
    if (actual.toLowerCase() !== expectSha256.toLowerCase()) {
      discardPartial(dest);
      throw new Error(t('download.checksumMismatch', [expectSha256.slice(0, 12), actual.slice(0, 12)]));
    }
  }
  return { file: dest, size: fs.statSync(dest).size };
  } catch (e) {
    // openStream 直接 reject（连接被拒 / DNS 失败 / 超时）时不会进入写流那段
    // try/catch —— 以前这里什么都不清，半截文件留着让下次续传继续失败。
    // 统一在最外层兜住：任何抛出都先丢弃残余。
    discardPartial(dest);
    throw e;
  }
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
  const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 20000;
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
      throw new Error(t('download.chunkRequestRejected', [res.statusCode]));
    }
    if (!validRange(res, c.pos, c.end, total)) {
      res.resume();
      throw new Error(t('download.chunkRangeMismatch'));
    }
    await new Promise((resolve, reject) => {
      // 必须自己兜住「promise 永远不 settle」：res.destroy(err) 在某些情况下只发
      // close 不发 error，没有这个 guard 的话一整块会挂死，整个下载停在那里不动。
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        if (err) reject(err); else resolve();
      };
      let idle = setTimeout(() => { res.destroy(); finish(new Error(t('download.stalled'))); }, idleMs);
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { res.destroy(); finish(new Error(t('download.stalled'))); }, idleMs);
      };
      res.on('data', (buf) => {
        // 服务器可能返回超出请求分块范围的数据，多出来的字节会写穿到别的分块，
        // 拼出一个静默损坏的包。宁可判失败换源，不能让它落盘。
        if (buf.length > c.end - c.pos + 1) {
          res.destroy();
          return finish(new Error(t('download.chunkOverflow')));
        }
        try {
          fs.writeSync(fd, buf, 0, buf.length, c.pos);
        } catch (e) {
          res.destroy();
          return finish(e);
        }
        c.pos += buf.length;
        got += buf.length;
        kick();
        tick();
      });
      res.on('end', () => finish());
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(new Error(t('download.interrupted'))));
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
          throw new Error(t('download.chunkIncomplete'));
        } catch (e) {
          c.tries += 1;
          if (c.tries >= retries) throw new Error(t('download.chunkDownloadFailed', [c.start, c.end, e.message]));
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 800 * c.tries));
        }
      }
    }));
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    discardPartial(dest);   // 整包作废，别留半截文件给下次续传
    throw e;
  }
  fs.closeSync(fd);

  const size = fs.statSync(dest).size;
  onProgress({ got: size, total: size, percent: 100, speed: 0, eta: 0 });
  if (size !== total) {
    discardPartial(dest);
    throw new Error(t('download.incomplete', [size, total]));
  }
  return { file: dest, size, parallel: n };
}

/** 依次尝试多个源，任一成功即返回 */
async function downloadAny(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    discardPartial(dest);   // 换源前清掉上一个源的半截文件
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await download(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      errors.push(`${u} → ${e.message}`);
      discardPartial(dest);
    }
  }
  throw new Error(t('download.allSourcesFailed', [errors.join('\n')]));
}

/**
 * 多源同时下载：把文件切成若干块，**不同块同时从不同源拉**，带宽叠加。
 *
 * 为什么需要：GitHub 单连接限速很常见，而镜像站通常也各自限速；
 * 8 条连接都指向同一个地址时，天花板就是那个地址的上限。把 4 条给 GitHub、
 * 4 条给镜像，两者上限相加，实测能快一倍以上。
 *
 * 安全前提：只有「声明总大小一致」的源才会被混用，否则可能拼出坏文件；
 * 任一源中途失败，它的分块会自动换到下一条可用地址重试（不整包重来）。
 */
async function downloadMulti(urls, dest, opt = {}) {
  const {
    connections = 8,
    onProgress = () => {},
    minChunk = 2 * 1024 * 1024,
    // 每个分块的重试次数。3 次在「三个源里有两个偶尔停摆」的链路上不够用：
    // 1.4GB 的运行时包一旦有块耗尽重试，整包作废重下。给到 6 次（每源两轮）。
    // 重试是从断点继续的（c.pos 保留），不会重复下载已收到的字节。
    retries = 6,
  } = opt;
  const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 20000;

  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) throw new Error(t('download.noAddress'));
  if (list.length === 1) return downloadParallel(list[0], dest, opt);

  // 1) 并行探测：总大小 + 是否支持 Range
  const probes = await Promise.all(list.map(async (u) => {
    try {
      const res = await openStream(u, { headers: { Range: 'bytes=0-0' } });
      const cr = res.headers['content-range'];
      const total = res.statusCode === 206 && cr ? Number(/\/(\d+)$/.exec(cr)[1]) || 0 : 0;
      res.destroy();
      return { url: u, total, ranged: !!total };
    } catch (_) {
      return { url: u, total: 0, ranged: false };
    }
  }));

  const usable = probes.filter((p) => p.ranged && p.total > 0);
  if (!usable.length) {
    return downloadAnyParallel(list, dest, opt);
  }
  // 只混用「声明总大小一致」的源，否则会拼出坏文件。
  // 基准取**实测最快那个源的总大小**（usable 的顺序就是 rank() 排好的速度序，
  // 探测是 Promise.all 但结果按输入顺序返回）：
  // GitHub 与 Gitee 各自压出来的包字节数不同（差几 MB 很正常），
  // 以前固定取 Math.max，等于永远去下体积更大的那个源 —— 国内网络下
  // 反而是「更快的 Gitee 包被排除、被迫走慢的 GitHub 包」。
  const total = usable[0].total;
  const same = usable.filter((p) => p.total === total);
  if (same.length === 1 || total < minChunk * 2) {
    return downloadParallel(same[0].url, dest, opt);
  }

  // 2) 切块，轮转分配源
  const n = Math.max(2, Math.min(connections, Math.ceil(total / minChunk)));
  const per = Math.ceil(total / n);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // 分块断点续传：1.4GB 的包在「镜像偶尔停摆」的链路上很容易有块耗尽重试，
  // 一旦整包作废重下，用户要再等十几分钟。这里把「哪些块已经下完」记在
  // 边车文件里，下次（同一路径、同一分块方式）只补缺的块。
  const meta = `${dest}.chunks.json`;
  let doneSet = new Set();
  let resume = false;
  try {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (m && m.total === total && m.n === n && fs.existsSync(dest) && fs.statSync(dest).size === total) {
      doneSet = new Set(m.done || []);
      resume = true;
    }
  } catch (_) { /* 没有边车就全新下 */ }

  if (!resume) {
    fs.rmSync(dest, { force: true });
    fs.rmSync(meta, { force: true });
  }
  const fd = resume ? fs.openSync(dest, 'r+') : fs.openSync(dest, 'w');
  if (!resume) fs.ftruncateSync(fd, total);

  const chunks = Array.from({ length: n }, (_, i) => ({
    start: i * per,
    end: Math.min(total - 1, i * per + per - 1),
    pos: i * per,
    src: i % same.length,
    tries: 0,
    rotates: 0,   // 必须显式初始化：undefined < 2 是 false，换源永远不会触发
  })).filter((c) => !doneSet.has(c.start));

  const saveMeta = () => {
    try {
      fs.writeFileSync(meta, JSON.stringify({ total, n, done: [...doneSet] }));
    } catch (_) { /* 边车写不进去不影响下载 */ }
  };

  // 续传时把已完成的块算进进度，用户看到的百分比不会从 0 重来
  let got = resume ? [...doneSet].reduce((sum, start) => (
    sum + (Math.min(total - 1, start + per - 1) - start + 1)
  ), 0) : 0;
  let lastTick = Date.now();
  let lastBytes = got;
  const tick = (force) => {
    const now = Date.now();
    if (!force && now - lastTick < 400) return;
    const speed = (got - lastBytes) / Math.max(0.001, (now - lastTick) / 1000);
    lastTick = now;
    lastBytes = got;
    onProgress({
      got,
      total,
      percent: Math.min(100, (got / total) * 100),
      speed,
      eta: speed > 0 ? Math.max(0, (total - got) / speed) : null,
      sources: same.length,
    });
  };

  // 低速换源：某一块从某个源只跑到几十 KB/s 时，光等它下完会把整个下载拖成
  // 「卡在 95% 不动」。跑够 slowAfterMs 且平均速度低于 slowBps 就中断、换下一个源
  // （从断点继续，不丢数据）。每块最多换 2 次，避免在几个慢源之间来回横跳。
  const slowAfterMs = Number(opt.slowAfterMs) > 0 ? Number(opt.slowAfterMs) : 45000;
  const slowBps = Number(opt.slowBps) > 0 ? Number(opt.slowBps) : 120 * 1024;

  const fetchChunk = async (c) => {
    const url = same[c.src % same.length].url;
    const res = await openStream(url, { headers: { Range: `bytes=${c.pos}-${c.end}` } });
    if (res.statusCode !== 206) {
      res.resume();
      throw new Error(t('download.chunkRejected', [res.statusCode]));
    }
    if (!validRange(res, c.pos, c.end, total)) {
      res.resume();
      throw new Error(t('download.chunkRangeMismatch'));
    }
    const startPos = c.pos;
    const startedAt = Date.now();
    // 同一条连接 destroy 之后仍可能再收到已缓冲的包，会重复触发换源、把源跳过头，
    // 所以每次请求只允许换一次。
    let rotated = false;
    await new Promise((resolve, reject) => {
      // 空闲看门狗 + 「保证 settle」：连接建立了但一个字节都不来（常见的
      // 「TCP 通但被墙/被限」），光等 socket 超时要 30 秒；而 res.destroy(err)
      // 可能只发 close 不发 error，promise 就永远不会 reject —— 表现是一块挂死、
      // 整个下载停在那里（实测踩过）。所以看门狗自己调用 finish。
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        if (err) reject(err); else resolve();
      };
      let idle = setTimeout(() => { res.destroy(); finish(new Error(t('download.stalled'))); }, idleMs);
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { res.destroy(); finish(new Error(t('download.stalledNoData'))); }, idleMs);
      };
      res.on('data', (buf) => {
        // 同上：拒绝超出请求范围的字节，避免静默写坏分块
        if (buf.length > c.end - c.pos + 1) {
          res.destroy();
          return finish(new Error(t('download.chunkOverflow')));
        }
        try {
          fs.writeSync(fd, buf, 0, buf.length, c.pos);
        } catch (e) {
          res.destroy();
          return finish(e);
        }
        c.pos += buf.length;
        got += buf.length;
        kick();
        tick(false);
        // 还没下完就慢到不可接受 → 换源（c.pos 已前进，下次从断点继续）
        const took = Date.now() - startedAt;
        if (!rotated && took > slowAfterMs && (c.rotates || 0) < 2 && c.pos <= c.end) {
          const bps = (c.pos - startPos) / (took / 1000);
          if (bps < slowBps) {
            rotated = true;
            c.rotates = (c.rotates || 0) + 1;
            // 这里不推进 c.src：换源统一由下面的 catch 做，否则一次失败会跳两个源
            res.destroy();
            finish(new Error(t('download.slowSource', [(bps / 1024).toFixed(0)])));
          }
        }
      });
      res.on('end', () => finish());
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(new Error(t('download.interrupted'))));
    });
    return c.pos > c.end;
  };

  try {
    await Promise.all(chunks.map(async (c) => {
      for (;;) {
        try {
          // eslint-disable-next-line no-await-in-loop
          if (await fetchChunk(c)) {
            doneSet.add(c.start);
            saveMeta();
            return;
          }
          throw new Error(t('download.chunkIncomplete'));
        } catch (e) {
          c.tries += 1;
          if (c.tries >= retries) {
            // 重试耗尽：这份文件里已经混进了「从不同源拉来的块」，再续传也
            // 拼不出正确字节。整包 + 边车一起作废，下次干净重来。
            // 以前这里只 saveMeta() 保留，结果每次打开都从坏块继续 → 无限重下。
            discardPartial(dest);
            throw new Error(t('download.chunkFailed', [c.start, c.end, e.message]));
          }
          // 换一个源再试：一个镜像抽风不该拖垮整个下载
          c.src += 1;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 600 * c.tries));
        }
      }
    }));
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    discardPartial(dest);
    throw e;
  }
  fs.closeSync(fd);
  fs.rmSync(meta, { force: true });

  const size = fs.statSync(dest).size;
  tick(true);
  if (size !== total) {
    discardPartial(dest);
    throw new Error(t('download.incomplete', [size, total]));
  }
  return { file: dest, size, parallel: n, sources: same.length, multi: true, resumed: resume };
}

/** 依次尝试多个源（并行分块版），任一成功即返回 */
async function downloadAnyParallel(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    // 换源前必须清掉上一个源留下的半截文件：不同源压出来的包字节可能不同，
    // 拿 A 源的半成品去续传 B 源，拼出来一定是坏文件（校验又失败 → 再重下）。
    discardPartial(dest);
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await downloadParallel(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      errors.push(`${u} → ${e.message}`);
      discardPartial(dest);
    }
  }
  throw new Error(t('download.allSourcesFailed', [errors.join('\n')]));
}

module.exports = {
  download, downloadAny, downloadParallel, downloadAnyParallel, downloadMulti,
  head, sha256File, openStream, discardPartial, validRange,
};
