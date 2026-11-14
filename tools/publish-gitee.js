'use strict';
/**
 * 把一版发布同步到 Gitee。
 *
 * 为什么需要这个脚本：Gitee 发行版附件单文件上限 100MB，而便携包约 105MB，
 * 所以发布时切成 `xxx.zip.part1` / `.part2`（各 ≤95MB），应用端 updater 会自动
 * 识别分片、逐片选源下载再拼回整包。安装版 Setup（1.4GB）与运行时整包（1.4GB）
 * 超限太多，继续留在 GitHub —— 应用端对「哪个源有资产」是并集处理，不影响更新。
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
const PART_LIMIT = 95 * 1024 * 1024;   // 留 5MB 余量给 multipart 头

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

async function upload(releaseId, file) {
  const token = process.env.GITEE_TOKEN;
  const buf = fs.readFileSync(file);
  const fd = new FormData();
  fd.append('access_token', token);
  fd.append('file', new Blob([buf]), path.basename(file));
  const res = await fetch(`${API}/releases/${releaseId}/attach_files`, { method: 'POST', body: fd });
  const text = await res.text();
  if (!res.ok) throw new Error(`上传 ${path.basename(file)} 失败：${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
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

  console.log('2) 切分便携包（Gitee 单文件上限 100MB）');
  const parts = splitFile(zip, PART_LIMIT);
  const files = parts.length ? parts : [zip];
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
