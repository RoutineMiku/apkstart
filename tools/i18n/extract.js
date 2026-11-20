'use strict';
/* 提取界面中文文案 → 生成可编辑的翻译目录 JSON（已存在的键保留原译文）。
   node tools/i18n/extract.js [--report] */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const CJK = /[\u4e00-\u9fff]/;
const OUT = path.join(ROOT, 'tools', 'i18n', 'translations.ru.json');

// HTML 里要翻的属性；JS 里出现这些属性名 + 中文的行是动态 title，不抽字符串字面量
const HTML_ATTRS = ['title', 'placeholder', 'aria-label'];
const DYN_ATTR_RE = new RegExp('\\.(' + HTML_ATTRS.join('|') + ')\\s*=');

function* genLines(file) {
  const src = fs.readFileSync(file, 'utf8');
  let n = 0;
  for (const line of src.split('\n')) yield [++n, line];
}

function extractHtml(file) {
  const out = []; // {str, line, colStart, colEnd, kind}
  let src = fs.readFileSync(file, 'utf8');
  // 记录注释区间（按字符偏移），跳过注释内文本
  const comments = [];
  const cre = /<!--[\s\S]*?-->/g; let m;
  while ((m = cre.exec(src))) comments.push([m.index, m.index + m[0].length]);
  const inComment = (i) => comments.some(([a, b]) => i >= a && i < b);
  const lineOf = (i) => src.slice(0, i).split('\n').length;

  // 文本节点
  const tre = />([^<>]+)</g;
  while ((m = tre.exec(src))) {
    const raw = m[1];
    if (inComment(m.index + 1)) continue;
    const t = raw.trim();
    if (!t || !CJK.test(t)) continue;
    const dec = document_decode(t);
    if (!dec) continue;
    const s = m.index + 1 + (raw.length - raw.trimStart().length);
    out.push({ str: dec, line: lineOf(s), start: s, end: s + (raw.trimStart().length - (raw.trimEnd().length - raw.trimEnd().trimEnd().length) ), kind: 'text', file });
  }
  // 属性
  for (const attr of HTML_ATTRS) {
    const are = new RegExp(attr + '="([^"]*)"', 'g');
    while ((m = are.exec(src))) {
      const t = m[1].trim();
      if (!t || !CJK.test(t)) continue;
      out.push({ str: decodeEntities(t), line: lineOf(m.index), start: m.index + attr.length + 2, end: m.index + attr.length + 2 + m[1].length, kind: 'attr', file });
    }
  }
  return out;
}
function document_decode(t) { return decodeEntities(t); }
function decodeEntities(t) {
  return t.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp);/g, (all, e) => {
    if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>';
    if (e === 'quot') return '"'; if (e === 'apos') return "'"; if (e === 'nbsp') return '\u00a0';
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : all;
  });
}

function extractJs(file) {
  const out = [];
  for (const [ln, line] of genLines(file)) {
    const s = line.trim();
    if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) continue;
    if (DYN_ATTR_RE.test(line)) continue; // 动态 title：运行时用 trAttr 翻
    for (const q of ["'", '"']) {
      const re = new RegExp(q + '((?:[^' + q + '\\\\\\n]|\\\\.)*)' + q, 'g');
      let m;
      while ((m = re.exec(line))) {
        const t = m[1];
        if (!CJK.test(t)) continue;
        out.push({ str: unescapeJs(t), line: ln, kind: 'js', file });
      }
    }
  }
  return out;
}
function unescapeJs(t) {
  return t.replace(/\\(['"\\nrt])/g, (all, c) => ({ n: '\n', r: '\r', t: '\t' }[c] || c));
}

const files = ['src/ui/index.html', 'src/ui/shell.html', 'src/ui/splash.html', 'src/ui/app.js', 'src/ui/shell.js', 'src/ui/splash.js']
  .map((f) => path.join(ROOT, f));
let items = [];
for (const f of files) items = items.concat(f.endsWith('.html') ? extractHtml(f) : extractJs(f));

const uniq = new Map();
for (const it of items) if (!uniq.has(it.str)) uniq.set(it.str, it);

if (process.argv.includes('--report')) {
  console.log(`total occurrences: ${items.length}, unique strings: ${uniq.size}`);
  const dict = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const missing = [...uniq.keys()].filter((k) => !(k in dict));
  console.log(`missing translations: ${missing.length}`);
  for (const m of missing.slice(0, 50)) console.log('MISS ' + JSON.stringify(m));
  process.exit(0);
}

// 合并已有目录（保留人工译文），新键留空
const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const next = {};
for (const k of [...uniq.keys()].sort()) next[k] = Object.prototype.hasOwnProperty.call(old, k) ? old[k] : '';
fs.writeFileSync(OUT, JSON.stringify(next, null, 1) + '\n', 'utf8');
console.log(`wrote ${Object.keys(next).length} keys (${Object.values(next).filter(Boolean).length} translated)`);
