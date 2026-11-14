'use strict';
/**
 * 双源（GitHub / Gitee）+ 镜像前缀的统一下载来源管理。
 *
 * 国内直连 GitHub 有两个坑：
 *   1. api.github.com 经常几十秒才响应，甚至直接超时 —— 表现是「检查更新转圈」；
 *   2. 资产下载（objects.githubusercontent.com）单连接限速，常在 100KB/s 上下 ——
 *      1.5 GB 的运行时包要下 4 个小时。
 *
 * 所以这里不预设「谁是主源」，而是每次用真实字节测速：
 *   - 版本信息：GitHub / Gitee 两边**并发**问，谁先给出更高版本用谁的；
 *   - 下载地址：把「GitHub 直连 / Gitee 同名资产 / 镜像前缀拼接」全部列出来，
 *     每个地址真下 128KB，按实测速度排序，取最快的那个。
 *
 * 测速结果在内存里缓存 30 分钟（同一进程内反复检查更新/下多个组件不必重复测）。
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const OWNER_GH = 'RoutineMiku';
const OWNER_GITEE = 'daily-miku';
const REPO = 'apkstart';

const SOURCES = {
  github: {
    id: 'github',
    name: 'GitHub',
    api: `https://api.github.com/repos/${OWNER_GH}/${REPO}`,
    web: `https://github.com/${OWNER_GH}/${REPO}`,
  },
  gitee: {
    id: 'gitee',
    name: 'Gitee',
    api: `https://gitee.com/api/v5/repos/${OWNER_GITEE}/${REPO}`,
    web: `https://gitee.com/${OWNER_GITEE}/${REPO}`,
  },
};

/** 已知可用的 GitHub 加速前缀。只在用户开启 autoMirror 且未自定义时参与测速。 */
const KNOWN_MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
];

/**
 * 一次测速的采样字节数。
 * 128KB 太小：握手 + TLS 就有几百毫秒，测出来的「速度」其实主要在测延迟，
 * 会把「延迟高但带宽大」的源误判成慢。256KB 能把两者分开，流量也可以接受。
 */
const SAMPLE_BYTES = 256 * 1024;

function openUrl(url, { timeout = 10000, headers = {}, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('重定向次数过多'));
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('地址无效')); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method: 'GET',
      timeout,
      headers: {
        'User-Agent': 'ApkStart/0.3 (Windows)',
        'Accept-Encoding': 'identity',
        ...headers,
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        openUrl(next, { timeout, headers, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
    req.end();
  });
}

/** 取一小段 JSON（带重定向、超时、大小上限） */
async function getJson(url, timeout = 10000) {
  const res = await openUrl(url, { timeout });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error(`${new URL(url).host} ${res.statusCode}`);
  }
  const chunks = [];
  let len = 0;
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      len += c.length;
      if (len > 4 * 1024 * 1024) { res.destroy(); resolve(); return; }
      chunks.push(c);
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 真下载一小段字节来测速度。
 * @returns {Promise<{url:string, ok:boolean, speed:number, got:number, ms:number, error?:string}>}
 */
function measure(url, { bytes = SAMPLE_BYTES, timeoutMs = 9000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let firstAt = 0;
    let got = 0;
    let settled = false;
    let req = null;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try { req?.destroy(); } catch (_) { /* ignore */ }
      const now = Date.now();
      // 吞吐只算「开始收到字节之后」的时间：TLS 握手 + DNS 那几百毫秒是固定开销，
      // 对 1.4GB 的包几乎不影响总耗时，混进速度里会把判断带偏。
      const span = Math.max(1, now - (firstAt || t0));
      resolve({
        url,
        ok: ok && got > 0,
        got,
        ms: now - t0,
        ttfb: firstAt ? firstAt - t0 : 0,
        speed: ok && got > 0 ? (got / span) * 1000 : 0,
        error,
      });
    };
    const timer = setTimeout(() => done(got > 0), timeoutMs);
    if (timer.unref) timer.unref();

    openUrl(url, {
      timeout: timeoutMs,
      headers: { Range: `bytes=0-${bytes - 1}` },
    }).then((res) => {
      req = res;
      if (res.statusCode >= 400) {
        res.resume();
        clearTimeout(timer);
        done(false, `HTTP ${res.statusCode}`);
        return;
      }
      res.on('data', (c) => {
        if (!firstAt) firstAt = Date.now();
        got += c.length;
        if (got >= bytes) { clearTimeout(timer); done(true); }
      });
      // 资产本身比样本还小：读到 EOF 也算成功
      res.on('end', () => { clearTimeout(timer); done(got > 0); });
      res.on('error', (e) => { clearTimeout(timer); done(false, e.message); });
    }).catch((e) => { clearTimeout(timer); done(false, e.message); });
  });
}

/** 把 GitHub 资产地址套上镜像前缀 */
function withMirror(url, prefix) {
  if (!prefix || !/^https?:\/\//i.test(prefix)) return '';
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${p}${url}`;
}

/** mirrors 列表：用户自定义优先，其次内置（autoMirror 关掉就只用自定义的） */
function mirrorList(settings) {
  const r = (settings && settings.runtime) || {};
  const custom = String(r.mirrorPrefix || process.env.APKSTART_MIRROR || '').trim();
  if (custom) return [custom];
  if (r.autoMirror === false) return [];
  return KNOWN_MIRRORS.slice();
}

class Sources {
  constructor(settingsFn) {
    this.settings = typeof settingsFn === 'function' ? settingsFn : () => ({});
    this._rankCache = new Map();   // url -> {at, speed, ok}
    this._rankTtl = 30 * 60 * 1000;
  }

  /** 各源的最新 release（并发，任何一个失败都不影响另一个） */
  async fetchReleases() {
    const prefs = String((this.settings().runtime || {}).sourcePreference || 'auto');
    const ids = prefs === 'github' || prefs === 'gitee' ? [prefs] : ['github', 'gitee'];
    const jobs = ids.map(async (id) => {
      const s = SOURCES[id];
      try {
        const rel = await getJson(`${s.api}/releases/latest`, 9000);
        return { source: id, name: s.name, web: s.web, rel };
      } catch (e) {
        // Gitee 没有正式 release、或 GitHub 被墙，都退回列表取第一条
        try {
          const list = await getJson(`${s.api}/releases?per_page=10`, 9000);
          const first = (Array.isArray(list) ? list : []).find((r) => r && !r.draft);
          if (first) return { source: id, name: s.name, web: s.web, rel: first };
        } catch (_) { /* 这个源彻底不可用 */ }
        return { source: id, name: s.name, web: s.web, error: e.message };
      }
    });
    return Promise.all(jobs);
  }

  /**
   * 合并两边的最新版本：版本号更高的胜出，但**资产列表取并集**，
   * 这样即使 Gitee 只放了元数据、资产在 GitHub，也能两条路都试。
   */
  async latest() {
    const all = await this.fetchReleases();
    const ok = all.filter((x) => x && x.rel);
    if (!ok.length) {
      const why = all.map((x) => `${x.name || x.source}: ${x.error || '无数据'}`).join('；');
      throw new Error(`连不上更新服务器（${why}）`);
    }
    const cmp = require('./updater').cmpVer;
    ok.sort((a, b) => cmp(b.rel.tag_name || b.rel.name, a.rel.tag_name || a.rel.name));
    const top = ok[0];
    const tag = String(top.rel.tag_name || top.rel.name || '');
    const version = tag.replace(/^v/i, '');

    // 只有同版本的资产才算数（不同源的旧版本资产不能拿来装）
    const assets = [];
    const seen = new Set();
    for (const item of ok) {
      const t = String(item.rel.tag_name || item.rel.name || '').replace(/^v/i, '');
      if (t !== version) continue;
      for (const a of (item.rel.assets || [])) {
        const key = String(a.name || '');
        if (!key || seen.has(key)) {
          // 同名资产保留第一个（按源顺序：先 GitHub 后 Gitee，或反之）
          continue;
        }
        seen.add(key);
        assets.push({
          name: key,
          size: Number(a.size) || 0,
          url: a.browser_download_url || a.url || '',
          source: item.source,
        });
      }
    }

    return {
      version,
      tag,
      name: top.rel.name || tag,
      notes: top.rel.body || '',
      htmlUrl: top.rel.html_url || top.web,
      publishedAt: top.rel.published_at || top.rel.created_at || '',
      assets,
      sources: ok.map((x) => ({ source: x.source, name: x.name, tag: x.rel.tag_name || x.rel.name || '' })),
      unreachable: all.filter((x) => x && x.error).map((x) => ({ source: x.source, name: x.name, error: x.error })),
      bySource: top.source,
    };
  }

  /** 某个资产在所有源 + 镜像下的候选地址（去重、保序：源站优先，其次镜像） */
  candidates(assetOrUrl) {
    const url = typeof assetOrUrl === 'string' ? assetOrUrl : assetOrUrl.url;
    const out = [];
    if (url) out.push(url);
    for (const m of mirrorList(this.settings())) {
      const u = withMirror(url, m);
      if (u && !out.includes(u)) out.push(u);
    }
    return out;
  }

  /**
   * 按实测速度排序候选地址。测速结果缓存 30 分钟；
   * 全部测速失败就退回原始顺序（保证「最坏情况还是能下」）。
   */
  async rank(urls, { onProgress } = {}) {
    const list = (urls || []).filter(Boolean);
    if (list.length <= 1) return list;
    const now = Date.now();
    const need = [];
    for (const u of list) {
      const c = this._rankCache.get(u);
      if (!c || now - c.at > this._rankTtl) need.push(u);
    }
    if (need.length) {
      onProgress?.({ stage: 'probe', message: `正在测速 ${need.length} 个下载源…` });
      // 顺序测而不是并发测：并发会互相抢带宽，测出来的名次变成「谁抢得凶」，
      // 而不是「谁真的快」。每个源 256KB，正常也就一秒左右。
      for (const u of need) {
        // eslint-disable-next-line no-await-in-loop
        const r = await measure(u);
        this._rankCache.set(u, { at: Date.now(), ok: r.ok, speed: r.speed });
      }
    }
    const score = (u) => {
      const c = this._rankCache.get(u);
      return c && c.ok ? c.speed : -1;
    };
    const sorted = list.slice().sort((a, b) => score(b) - score(a));
    const best = sorted[0];
    const s = score(best);
    if (s > 0) {
      onProgress?.({
        stage: 'probe',
        message: `已选最快的源：${new URL(best).host}（约 ${(s / 1048576).toFixed(2)} MB/s）`,
      });
    }
    return sorted;
  }

  /** 测速缓存清空（用户改了镜像前缀 / 换了网络后调用） */
  reset() {
    this._rankCache.clear();
  }
}

module.exports = { Sources, SOURCES, measure, KNOWN_MIRRORS, withMirror, mirrorList };
