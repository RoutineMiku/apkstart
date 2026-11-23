'use strict';
/**
 * 界面文案提取器：扫描源码里的中文界面文案，生成/补齐 src/i18n/en.json。
 *
 * 只提取「会显示给用户」的文案：
 *   - HTML 的文本节点与 title / placeholder / aria-label / alt
 *   - JS 的字符串字面量与模板字符串（`${...}` 变成 {0} {1} 占位符）
 * 明确跳过：注释、日志（appLog/console/runtime:log）、正则与错误分类用的字符串。
 *
 * 用法：
 *   node tools/i18n/extract.js            # 补齐 en.json，空值 = 待翻译
 *   node tools/i18n/extract.js --report   # 只报告，不写文件
 *   node tools/i18n/extract.js --check    # CI 用：有缺失/占位符不一致就以非 0 退出
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DICT_FILE = path.join(ROOT, 'src', 'i18n', 'en.json');
const CJK = /[\u4e00-\u9fff]/;

const UI_DIR = path.join(ROOT, 'src', 'ui');
const TARGETS = [
  path.join(UI_DIR, 'index.html'),
  path.join(UI_DIR, 'shell.html'),
  path.join(UI_DIR, 'splash.html'),
  path.join(UI_DIR, 'app.js'),
  path.join(UI_DIR, 'shell.js'),
  path.join(UI_DIR, 'splash.js'),
  path.join(ROOT, 'src', 'main.js'),
];

const HTML_ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
const RISKY_LINE = /appLog\s*\(|console\.|runtime:log|new\s+RegExp|_RE\b|\.test\s*\(|\.match\s*\(|\.exec\s*\(/;

function decodeEntities(t) {
  return t.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp);/g, (all, e) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e === 'nbsp') return '\u00a0';
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : all;
  });
}

function normalizeKey(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function unescapeJs(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|n|r|t|b|f|v|0|'|"|`|\\|\n)/g, (all, e) => {
    if (e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '' };
    return Object.prototype.hasOwnProperty.call(map, e) ? map[e] : e;
  });
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

function collectHtml(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  const comments = [];
  for (const m of src.matchAll(/<!--[\s\S]*?-->/g)) comments.push([m.index, m.index + m[0].length]);
  const inComment = (i) => comments.some(([a, b]) => i >= a && i < b);

  for (const m of src.matchAll(/>([^<>]+)</g)) {
    if (inComment(m.index)) continue;
    const text = normalizeKey(decodeEntities(m[1]));
    if (!text || !CJK.test(text)) continue;
    out.push({ key: text, file, line: lineOf(src, m.index) });
  }
  for (const attr of HTML_ATTRS) {
    const re = new RegExp(attr + '="([^"]*)"', 'g');
    for (const m of src.matchAll(re)) {
      if (inComment(m.index)) continue;
      const text = normalizeKey(decodeEntities(m[1]));
      if (!text || !CJK.test(text)) continue;
      out.push({ key: text, file, line: lineOf(src, m.index) });
    }
  }
  return out;
}

/** 跳过一个 JS 字符串字面量（兼容转义），返回闭合引号之后的位置。 */
function skipString(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === quote) return j + 1;
    j++;
  }
  return j;
}

/** `/` 是正则开头还是除号：看它前面最近的有效字符。 */
function regexAllowed(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  if ('([{:;,=!&|?+-*%^~<>'.includes(src[j])) return true;
  return /\b(return|typeof|case|delete|void|new|in|of|yield|await)$/.test(src.slice(Math.max(0, j - 8), j + 1));
}

/** 跳过一个正则字面量，避免把里面的引号当成字符串开头（replace(/'/g, …) 是重灾区）。 */
function skipRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') { inClass = true; j++; continue; }
    if (c === ']') { inClass = false; j++; continue; }
    if (c === '/' && !inClass) {
      j++;
      while (j < src.length && /[a-z]/i.test(src[j])) j++;
      return j;
    }
    if (c === '\n') return j;
    j++;
  }
  return j;
}

/**
 * 跳过 ${...} 表达式。表达式里可能有嵌套模板、字符串、注释和更深的花括号，
 * 直接数花括号会在 `'}'` 或嵌套模板上算错，所以这里按语法单元跳过。
 */
function skipExpression(src, i) {
  let depth = 1;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === "'" || c === '"') { j = skipString(src, j); continue; }
    if (c === '`') { j = readTemplate(src, j).end; continue; }
    if (c === '/' && src[j + 1] === '/') { while (j < src.length && src[j] !== '\n') j++; continue; }
    if (c === '/' && src[j + 1] === '*') {
      j += 2;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j += 2;
      continue;
    }
    if (c === '/' && regexAllowed(src, j)) { j = skipRegex(src, j); continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return j;
}

/** 读取模板字符串，把 ${expr} 变成 {0} {1}…，返回结束位置与骨架。 */
function readTemplate(src, i) {
  let j = i + 1;
  let raw = '';
  let key = '';
  let seq = 0;
  let interpolated = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { raw += c + (src[j + 1] || ''); j += 2; continue; }
    if (c === '`') { j++; break; }
    if (c === '$' && src[j + 1] === '{') {
      interpolated = true;
      key += raw + `{${seq++}}`;
      raw = '';
      j = skipExpression(src, j + 2);
      continue;
    }
    raw += c;
    j++;
  }
  key += raw;
  return { end: j, key, interpolated };
}

/** 明显是代码（HTML 模板、箭头函数、语句）的字符串不是界面文案，交给 DOM 层按文本节点翻译。 */
function looksLikeCode(key) {
  return key.length > 300
    || /[<>]/.test(key)
    || /=>/.test(key)
    || /\b(function|const|let|var|return|require)\b/.test(key)
    || /;$/.test(key);
}

function collectJs(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  let i = 0;
  const n = src.length;

  const record = (key, at) => {
    const text = normalizeKey(unescapeJs(key));
    if (!text || !CJK.test(text) || looksLikeCode(text)) return;
    const lineStart = src.lastIndexOf('\n', at) + 1;
    const lineEnd = src.indexOf('\n', at) < 0 ? n : src.indexOf('\n', at);
    if (RISKY_LINE.test(src.slice(lineStart, lineEnd))) return;
    out.push({ key: text, file, line: lineOf(src, at) });
  };

  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '/' && src[i + 1] !== '/' && src[i + 1] !== '*' && regexAllowed(src, i)) {
      i = skipRegex(src, i);
      continue;
    }
    if (c === "'" || c === '"') {
      const end = skipString(src, i);
      record(src.slice(i + 1, Math.max(i + 1, end - 1)), i);
      i = end;
      continue;
    }
    if (c === '`') {
      const t = readTemplate(src, i);
      record(t.key, i);
      i = t.end;
      continue;
    }
    i++;
  }
  return out;
}

function collect() {
  const items = [];
  for (const file of TARGETS) {
    if (!fs.existsSync(file)) continue;
    items.push(...(file.endsWith('.html') ? collectHtml(file) : collectJs(file)));
  }
  // 同一句文案在多个文件出现时只保留一条，但记录出现位置方便定位
  const map = new Map();
  for (const it of items) {
    if (!map.has(it.key)) map.set(it.key, { key: it.key, files: [] });
    map.get(it.key).files.push(`${path.relative(ROOT, it.file)}:${it.line}`);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key, 'zh'));
}

function readDict() {
  try { return JSON.parse(fs.readFileSync(DICT_FILE, 'utf8')); } catch (_) { return {}; }
}

function placeholderSet(s) {
  const set = new Set();
  for (const m of String(s).matchAll(/\{([^{}]+)\}/g)) set.add(m[1]);
  return set;
}

function validate(dict) {
  const errors = [];
  const warnings = [];
  for (const [key, value] of Object.entries(dict)) {
    if (!CJK.test(key)) errors.push(`key 不含中文，疑似误收：${JSON.stringify(key)}`);
    if (typeof value !== 'string' || !value.trim()) {
      errors.push(`缺少译文：${key}`);
      continue;
    }
    const kp = placeholderSet(key);
    const vp = placeholderSet(value);
    for (const p of kp) if (!vp.has(p)) errors.push(`占位符丢失：${key} → 缺 {${p}}`);
    for (const p of vp) if (!kp.has(p)) errors.push(`占位符多余：${key} → 多出 {${p}}`);
    if (/\{[^{}]*[\u4e00-\u9fff][^{}]*\}/.test(value)) warnings.push(`译文里还有中文占位符：${key}`);
  }
  return { errors, warnings };
}

function main() {
  const reportOnly = process.argv.includes('--report');
  const check = process.argv.includes('--check');
  const dict = readDict();
  const items = collect();
  const missing = items.filter((it) => !dict[it.key] || !String(dict[it.key]).trim());

  if (!reportOnly && !check) {
    // 保留词典里已有的手工条目：运行期拼接出来的整句、驱动示例文案、核心模块提示
    // 不在源码扫描结果里，但同样需要译文，不能因为跑一次 extract 就被删掉。
    const next = { ...dict };
    for (const it of items) next[it.key] = dict[it.key] || '';
    const sorted = {};
    for (const k of Object.keys(next).sort((a, b) => a.localeCompare(b, 'zh'))) sorted[k] = next[k];
    fs.writeFileSync(DICT_FILE, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
    console.log(`写入 ${path.relative(ROOT, DICT_FILE)}：源码 ${items.length} 条，词典共 ${Object.keys(sorted).length} 条，待翻译 ${missing.length} 条`);
    for (const it of missing.slice(0, 40)) console.log(`  - ${it.key}  (${it.files.join(', ')})`);
    if (missing.length > 40) console.log(`  … 其余 ${missing.length - 40} 条见文件`);
    return;
  }

  const { errors, warnings } = validate(dict);
  console.log(`提取到 ${items.length} 条界面文案；已有译文 ${items.length - missing.length} 条；待翻译 ${missing.length} 条`);
  if (missing.length) {
    console.log('\n待翻译：');
    for (const it of missing) console.log(`  - ${it.key}  (${it.files.join(', ')})`);
  }
  if (warnings.length) {
    console.log('\n警告：');
    for (const w of warnings) console.log(`  ! ${w}`);
  }
  if (errors.length) {
    console.log('\n错误：');
    for (const e of errors) console.log(`  ✗ ${e}`);
  }
  if (check && (errors.length || missing.length)) process.exit(1);
}

if (require.main === module) main();

module.exports = { collect, readDict, validate, placeholderSet, DICT_FILE };
