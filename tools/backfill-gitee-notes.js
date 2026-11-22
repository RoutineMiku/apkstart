'use strict';
/**
 * 只回填某个 Gitee Release 的说明（body），不上传/删除任何附件。
 * 用途：历史版本（0.6.1~0.6.4）的 Gitee 页面只有默认的「便携版安装包…」一句话，
 * 需要把 .github/release-notes-v*.md 的详细说明写回去。
 *
 * 用法：
 *   GITEE_TOKEN=xxx node tools/backfill-gitee-notes.js v0.6.4 --notes .github/release-notes-v0.6.4.md
 */
const fs = require('fs');

const OWNER = 'daily-miku';
const REPO = 'apkstart';
const API = `https://gitee.com/api/v5/repos/${OWNER}/${REPO}`;

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
  try { json = JSON.parse(text); } catch (_) { /* 空响应 */ }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
  return json || {};
}

(async () => {
  const tag = process.argv[2];
  const notesFile = arg('--notes', '');
  if (!tag || !/^v\d/.test(tag)) {
    console.error('用法：GITEE_TOKEN=xxx node tools/backfill-gitee-notes.js v0.6.4 --notes 文件');
    process.exit(1);
  }
  if (!notesFile || !fs.existsSync(notesFile)) {
    console.error(`找不到说明文件：${notesFile}`);
    process.exit(1);
  }
  const body = fs.readFileSync(notesFile, 'utf8');

  const rel = await api('GET', `/releases/tags/${tag}`);
  if (!rel || !rel.id) {
    console.log(`· ${tag} 在 Gitee 无 Release，跳过`);
    return;
  }
  await api('PATCH', `/releases/${rel.id}`, { body });
  console.log(`✓ ${tag} Gitee 说明已回填 (id=${rel.id})`);
})().catch((e) => {
  console.error(`回填失败：${e.message}`);
  process.exit(1);
});
