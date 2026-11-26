#!/usr/bin/env node
'use strict';
/**
 * 收集界面上会出现的中文文案，合并进 src/i18n/<lang>.json。
 *
 *   node scripts/i18n-extract.js            # 更新 en-US.json，打印缺失数量
 *   node scripts/i18n-extract.js --check    # 只检查，不写文件（CI 用）
 *   node scripts/i18n-extract.js --missing  # 列出还没翻译的文案
 *
 * 规则：
 *   - JS：字符串 / 模板字符串里含中文的都算；模板里的 ${...} 写成 {0}、{1}…
 *     日志调用（console.* / log( / this._log 等）里的文字跳过，日志保持中文。
 *   - HTML：标签之间的文字 + title / placeholder / aria-label / alt 属性。
 *   - 已有的翻译保留；不再出现的 key 保留（防止分支间来回丢翻译），用 --prune 删掉。
 *
 * Collects user-facing Chinese strings and merges them into the dictionary.
 */
if (!process.execArgv.includes('--expose-internals')) {
  const r = require('child_process').spawnSync(process.execPath, ['--expose-internals', __filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LANG = (process.argv.find((a) => a.startsWith('--lang=')) || '--lang=en-US').slice(7);
const CHECK = process.argv.includes('--check');
const MISSING = process.argv.includes('--missing');
const PRUNE = process.argv.includes('--prune');
const DICT = path.join(ROOT, 'src', 'i18n', `${LANG}.json`);
const CJK = /[㐀-鿿豈-﫿]/;

const SOURCES = [
  'src/ui/index.html', 'src/ui/shell.html', 'src/ui/splash.html',
  'src/ui/app.js', 'src/ui/shell.js', 'src/ui/splash.js',
  'src/main.js',
  'src/core',
  'src/drivers',
];
const SKIP_FILES = new Set(['src/ui/manual.html', 'src/i18n/index.js', 'src/ui/i18n-dom.js']);
// 只写日志的调用：这些里面的中文不进词典
const LOG_RE = /(console\.\w+|\blog\w*|\bdebug|\bnote|\btrace|\bwarn|_log|logLine|appendLog|logger\.\w+)\s*\(\s*$/i;

const norm = (s) => s.replace(/\s+/g, ' ').trim();

function listFiles(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.statSync(abs).isDirectory()) return [rel];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const r = path.posix.join(rel, e.name);
    if (e.isDirectory()) return listFiles(r);
    return /\.(js|html|json)$/.test(e.name) ? [r] : [];
  });
}

/**
 * JS：用 Node 自带的 acorn 解析（node --expose-internals），比手写词法可靠：
 * 正则字面量、模板嵌套、注释里的引号都不会把后面的内容带歪。
 */
const acorn = require('internal/deps/acorn/acorn/dist/acorn');
const LOG_CALLEE = /^(console|log|_log|logLine|appendLog|debug|trace|note|warn|logger)$/i;

function calleeName(c) {
  if (!c) return '';
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression') {
    const obj = c.object && c.object.type === 'Identifier' ? c.object.name : '';
    if (obj === 'console') return 'console';
    return c.property && (c.property.name || c.property.value) || '';
  }
  return '';
}

function jsStrings(src) {
  let ast;
  const opts = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true };
  try { ast = acorn.parse(src, { ...opts, sourceType: 'script' }); }
  catch (_) { ast = acorn.parse(src, { ...opts, sourceType: 'module' }); }
  const out = [];
  (function visit(node, inLog) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Literal' && typeof node.value === 'string') {
      if (!inLog && CJK.test(node.value)) out.push({ text: node.value, before: '' });
    } else if (node.type === 'TemplateLiteral') {
      let text = '';
      node.quasis.forEach((q, i) => {
        text += q.value.cooked ?? q.value.raw;
        if (i < node.expressions.length) text += `{${i}}`;
      });
      if (!inLog && CJK.test(text)) out.push({ text, before: '' });
    }
    const log = inLog || (node.type === 'CallExpression' && LOG_CALLEE.test(calleeName(node.callee)));
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((x) => visit(x, log && k !== 'callee'));
      else if (v && typeof v.type === 'string') visit(v, log && k !== 'callee');
    }
  })(ast, false);
  return out;
}

/** 随包的驱动示例：显示在设置页的 name / description / notes */
function jsonStrings(src) {
  const out = [];
  (function visit(v, key) {
    if (typeof v === 'string') {
      if (CJK.test(v) && ['name', 'description', 'notes'].includes(key)) out.push({ text: v, before: '' });
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, k);
  })(JSON.parse(src), '');
  return out;
}

function htmlStrings(src) {
  const out = [];
  const body = src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  for (const m of body.matchAll(/\b(?:title|placeholder|aria-label|alt|data-tip)="([^"]*)"/g)) {
    if (CJK.test(m[1])) out.push({ text: m[1], before: '' });
  }
  for (const m of body.matchAll(/>([^<>]+)</g)) {
    if (CJK.test(m[1])) out.push({ text: m[1], before: '' });
  }
  return out;
}

function collect() {
  const byFile = new Map();
  const seen = new Set();
  for (const rel of SOURCES.flatMap(listFiles)) {
    if (SKIP_FILES.has(rel)) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const items = rel.endsWith('.html') ? htmlStrings(src)
      : rel.endsWith('.json') ? jsonStrings(src)
        : jsStrings(src);
    const keys = [];
    // JS 里拼 HTML 的字符串：按页面上实际显示的样子拆成文字节点 + 属性
    const expanded = [];
    for (const it of items) {
      if (!rel.endsWith('.html') && /<\/?[a-z][^>]*>/i.test(it.text)) {
        if (LOG_RE.test(it.before)) continue;
        const pieces = htmlStrings(`>${it.text}<`);
        for (const p of pieces) expanded.push({ text: p.text, before: '' });
      } else {
        expanded.push(it);
      }
    }
    for (const { text, before } of expanded) {
      if (LOG_RE.test(before)) continue;
      // 多行文案按行拆（运行时也是逐行翻译）
      for (const line of text.split('\n')) {
        const k = norm(line);
        if (!k || !CJK.test(k) || seen.has(k)) continue;
        seen.add(k);
        keys.push(k);
      }
    }
    if (keys.length) byFile.set(rel, keys);
  }
  return byFile;
}

function main() {
  const old = fs.existsSync(DICT) ? JSON.parse(fs.readFileSync(DICT, 'utf8')) : {};
  const byFile = collect();
  const next = {};
  let total = 0;
  let missing = 0;
  const missingList = [];
  for (const [file, keys] of byFile) {
    next[`// ${file}`] = '';
    for (const k of keys) {
      next[k] = old[k] || '';
      total++;
      if (!next[k]) { missing++; missingList.push(`${file}: ${k}`); }
    }
  }
  // 手工补充的条目（运行时拼出来、源码里找不到原句的）放在最后保留
  const extra = Object.entries(old).filter(([k, v]) => !(k in next) && !k.startsWith('// ') && v);
  if (extra.length && !PRUNE) {
    next['// extra (manual entries)'] = '';
    for (const [k, v] of extra) next[k] = v;
  }
  if (MISSING) console.log(missingList.join('\n'));
  console.log(`${LANG}: ${total - missing}/${total} translated, ${missing} missing, ${extra.length} extra`);
  if (CHECK) { process.exit(0); }
  fs.writeFileSync(DICT, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

main();
