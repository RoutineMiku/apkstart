'use strict';
/**
 * 把一版发布同步到 Gitee。
 *
 * 为什么需要这个脚本：Gitee 发行版附件单文件上限 100MB（实测 104,857,600 字节，
 * 104,800,000 的上传能成功）。便携包用 7-Zip 压出来约 99.6MB，现在可以直接放
 * 一个完整 zip，用户点开就能解压 —— 不再切 part1/part2（那种包必须按顺序拼接，
 * 手动下载的人根本用不了）。只有真的超过上限时才会退回分片，应用端 updater
 * 两套都认。
 * 安装版 Setup（1.4GB）与运行时整包（1.4GB）超限太多，继续留在 GitHub ——
 * 应用端对「哪个源有资产」是并集处理，不影响更新。
 *
 * 用法：
 *   GITEE_TOKEN=xxxx node tools/publish-gitee.js v0.3.3 D:/dist
 *     v0.3.3   要发布的 tag（必须是已推送到 Gitee 的 tag）
 *     D:/dist  目录里放 ApkStart-v0.3.3-win64-portable.zip（可选，也可用 --zip 指定）
 *
 *   node tools/publish-gitee.js v0.3.3 --zip D:/x.zip --notes notes.md
 */
const fs = require('fs');
const path = require('path');

const OWNER = 'daily-miku';
const REPO = 'apkstart';
const API = `https://gitee.com/api/v5/repos/${OWNER}/${REPO}`;
const HARD_LIMIT = 100 * 1024 * 1024;  // Gitee 附件单文件上限（100MiB，实测可用）
const PART_LIMIT = 99 * 1024 * 1024;   // 真要分片时的单片大小，留 1MB 给 multipart 头

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
}

async function api(method, p, body) {
  const token = process.env.GITEE_TOKEN;
  if (!token) throw new Error('缺少环境变量 GITEE_TOKEN');
  const url = `${API}${p}${p.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 可能是空响应 */ }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
  return json || {};
}

/** 切分大文件；返回切成后的路径数组 */
function splitFile(file, limit) {
  const size = fs.statSync(file).size;
  if (size <= limit) return [];
  const fd = fs.openSync(file, 'r');
  const out = [];
  try {
    let index = 1;
    let offset = 0;
    while (offset < size) {
      const len = Math.min(limit, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const p = `${file}.part${index}`;
      fs.writeFileSync(p, buf);
      out.push(p);
      offset += len;
      index += 1;
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

/**
 * 上传单个附件。
 * 95MB 的整包是一次 POST 传完的（Gitee 没有分片上传接口），国内链路上很容易
 * 传到一半就 fetch failed —— 以前这里没有重试，一次抖动就得整条命令重跑，
 * 而重跑还要先删干净旧附件，很折腾。所以这里带 3 次重试 + 递增等待。
 */
async function upload(releaseId, file, attempts = 3) {
  const token = process.env.GITEE_TOKEN;
  const name = path.basename(file);
  const buf = fs.readFileSync(file);
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const fd = new FormData();
      fd.append('access_token', token);
      fd.append('file', new Blob([buf]), name);
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${API}/releases/${releaseId}/attach_files`, { method: 'POST', body: fd });
      // eslint-disable-next-line no-await-in-loop
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      // 4xx（除 429）不值得重试：token 失效、文件名冲突之类重传也没用
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(`上传 ${name} 失败：${res.status} ${text.slice(0, 200)}`);
      }
      lastErr = new Error(`${res.status} ${text.slice(0, 120)}`);
    } catch (e) {
      lastErr = e;
      if (/^上传 .* 失败/.test(e.message)) throw e;
    }
    if (i < attempts) {
      const wait = i * 8;
      console.warn(`   第 ${i} 次上传失败（${lastErr.message}），${wait} 秒后重试…`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  throw new Error(`上传 ${name} 失败（已试 ${attempts} 次）：${lastErr && lastErr.message}`);
}

(async () => {
  const tag = process.argv[2];
  if (!tag || !/^v\d/.test(tag)) {
    console.error('用法：GITEE_TOKEN=xxx node tools/publish-gitee.js v0.3.3 [--zip 路径] [--notes 文件]');
    process.exit(1);
  }
  const dir = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '';
  let zip = arg('--zip', '');
  if (!zip && dir) {
    const hit = fs.existsSync(dir)
      ? fs.readdirSync(dir).find((n) => /portable\.zip$/i.test(n))
      : '';
    if (hit) zip = path.join(dir, hit);
  }
  if (!zip || !fs.existsSync(zip)) {
    console.error(`找不到便携包：${zip || '(未指定)'}。用 --zip 指定，或把 zip 放进 ${dir}`);
    process.exit(1);
  }
  const notesFile = arg('--notes', '');
  const body = notesFile && fs.existsSync(notesFile)
    ? fs.readFileSync(notesFile, 'utf8')
    : `便携版安装包（分片，应用内自动更新会自己拼装）。完整安装版与运行时整包在 GitHub Releases。`;

  console.log('1) 查找/创建发行版', tag);
  const list = await api('GET', `/releases?per_page=50`);
  let rel = (Array.isArray(list) ? list : []).find((r) => r.tag_name === tag);
  if (!rel) {
    rel = await api('POST', '/releases', {
      tag_name: tag,
      name: tag,
      target_commitish: 'main',
      body,
    });
    console.log('   已创建 id =', rel.id);
  } else {
    console.log('   已存在 id =', rel.id);
  }

  // 重发同一版本时（改过代码重新打包），旧附件必须先删掉，否则页面上会同时挂着
  // 新旧两套 part1/part2，客户端按名字取到的是哪一份完全看运气。
  if (process.argv.includes('--replace')) {
    console.log('2) 清理同名旧附件');
    const list = await api('GET', `/releases/${rel.id}/attach_files`);
    const olds = (Array.isArray(list) ? list : []).filter((a) => /^ApkStart-.*\.zip(\.part\d+)?$/i.test(a.name || ''));
    for (const a of olds) {
      // eslint-disable-next-line no-await-in-loop
      await api('DELETE', `/releases/${rel.id}/attach_files/${a.id}`);
      console.log('   删除', a.name);
    }
  }

  const zipSize = fs.statSync(zip).size;
  if (zipSize > HARD_LIMIT) {
    console.warn(`⚠️  便携包 ${(zipSize / 1048576).toFixed(1)} MB 超过 Gitee 单文件上限，只能切成分片；`
      + '手动下载的人需要按顺序拼接才能解压，建议先用 `node build/zip.js` 压紧、或给包瘦身。');
  }
  console.log('3) 准备上传（整包优先，超限才切分）');
  const parts = splitFile(zip, PART_LIMIT);
  const files = parts.length ? parts : [zip];

  // 同一个版本可能换过打包方式（整包 ↔ 分片）：把另一种形式的同名附件删掉，
  // 否则发行版里同时挂着 `x.zip` 和 `x.zip.part1/part2`，客户端取哪个全看运气。
  // --replace 会连别的版本号一起清，这里只清「当前这个包名」的另一种形态。
  {
    const base = path.basename(zip).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const other = parts.length ? new RegExp(`^${base}$`, 'i') : new RegExp(`^${base}\\.part\\d+$`, 'i');
    const list = await api('GET', `/releases/${rel.id}/attach_files`);
    for (const a of Array.isArray(list) ? list : []) {
      if (!other.test(a.name || '')) continue;
      // eslint-disable-next-line no-await-in-loop
      await api('DELETE', `/releases/${rel.id}/attach_files/${a.id}`);
      console.log('   删除上一版式的旧附件', a.name);
    }
  }

  for (const f of files) {
    console.log(`   上传 ${path.basename(f)} (${(fs.statSync(f).size / 1048576).toFixed(1)} MB)`);
    // eslint-disable-next-line no-await-in-loop
    await upload(rel.id, f);
  }
  for (const p of parts) fs.rmSync(p, { force: true });
  console.log(`\n完成：https://gitee.com/${OWNER}/${REPO}/releases/tag/${tag}`);
})().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
