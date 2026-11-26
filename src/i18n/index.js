'use strict';
/**
 * 界面多语言（i18n）。
 *
 * 设计目标：**上游代码照常写中文，不需要到处改调用点**。
 *   - 词典以「中文原文」为 key（gettext 风格），见 en-US.json；
 *   - 渲染层由 ui/i18n-dom.js 在文字显示到界面上时统一翻译（含动态生成的文字）；
 *   - 主进程只在对话框 / 托盘 / 系统通知这些「不经过 DOM」的出口调用 t()；
 *   - 查不到的文字原样返回中文，所以新加的文案不会坏，只是暂时没翻译。
 *
 * 匹配顺序：完全匹配 → 模板匹配（`${x}` 在 key 里写成 {0}、{1}…）→ 片段替换。
 * 片段替换用于字符串拼接出来的句子，只在前两步都失败时才用。
 *
 * Interface translation. Keys are the original Chinese strings; values are the
 * translation. Missing keys fall back to the Chinese text. Run
 * `node scripts/i18n-extract.js` to list strings that still need translating.
 */
const fs = require('fs');
const path = require('path');

const SUPPORTED = ['zh-CN', 'en-US'];
const CJK = /[㐀-鿿豈-﫿]/;

/** 设置值（auto / zh-CN / en-US）+ 系统语言 → 实际使用的界面语言 */
function resolveLang(pref, systemLocale) {
  const p = String(pref || 'auto');
  if (SUPPORTED.includes(p)) return p;
  const sys = String(systemLocale || '').toLowerCase();
  return sys.startsWith('zh') ? 'zh-CN' : 'en-US';
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

/** 把中文全角标点换成英文标点：只在片段替换后、句子里还夹着标点时用 */
function westernPunct(s) {
  return s
    .replace(/\s*，\s*/g, ', ')
    .replace(/\s*。\s*/g, '. ')
    .replace(/\s*；\s*/g, '; ')
    .replace(/\s*：\s*/g, ': ')
    .replace(/\s*、\s*/g, ', ')
    .replace(/\s*！\s*/g, '! ')
    .replace(/\s*？\s*/g, '? ')
    .replace(/（\s*/g, ' (').replace(/\s*）/g, ') ')
    .replace(/[「『“]/g, '"').replace(/[」』”]/g, '"')
    .replace(/\s*——\s*/g, ' — ')
    .replace(/ {2,}/g, ' ')
    .replace(/ ([,.;:!?)])/g, '$1')
    .trim();
}

class Translator {
  constructor(lang, dict) {
    this.lang = lang;
    this.exact = new Map();
    this.templates = [];
    this.cache = new Map();
    this.fragRe = null;
    this.frag = new Map();
    if (lang !== 'zh-CN') this._build(dict || {});
  }

  _build(dict) {
    const fragKeys = [];
    for (const [k0, v] of Object.entries(dict)) {
      if (!v || k0.startsWith('//')) continue;
      const k = norm(k0);
      if (/\{\d+\}/.test(k)) {
        const parts = k.split(/\{(\d+)\}/);
        // parts: [lit, idx, lit, idx, lit...]
        let re = '^';
        const order = [];
        let literal = 0;
        for (let i = 0; i < parts.length; i++) {
          if (i % 2 === 0) { re += escapeRe(parts[i]); literal += parts[i].length; }
          else { re += '([\\s\\S]*?)'; order.push(Number(parts[i])); }
        }
        re += '$';
        this.templates.push({ re: new RegExp(re), order, value: v, literal });
      } else {
        this.exact.set(k, v);
        if (CJK.test(k) && k.length >= 2) fragKeys.push(k);
      }
    }
    // 字面部分越长越具体，优先匹配
    this.templates.sort((a, b) => b.literal - a.literal);
    fragKeys.sort((a, b) => b.length - a.length);
    for (const k of fragKeys) this.frag.set(k, this.exact.get(k));
    if (fragKeys.length) this.fragRe = new RegExp(fragKeys.map(escapeRe).join('|'), 'g');
  }

  /** 模板占位符捕获到的内容：可能是列表（「、」分隔）或另一句已知文案 */
  _capture(s) {
    if (!CJK.test(s)) return s;
    const e = this.exact.get(norm(s));
    if (e != null) return e;
    if (s.includes('、')) {
      const items = s.split('、');
      if (items.every((x) => this.exact.has(norm(x)) || !CJK.test(x))) {
        return items.map((x) => this.exact.get(norm(x)) ?? x).join(', ');
      }
    }
    // 其余交给完整流程（片段替换要求整句覆盖，应用名之类不会被翻坏），保留前导空白
    const lead = s.match(/^\s*/)[0];
    const r = this._core(s);
    return r === s ? s : lead + r;
  }

  _core(text) {
    const k = norm(text);
    if (!k) return text;
    const e = this.exact.get(k);
    if (e != null) return e;
    for (const t of this.templates) {
      const m = t.re.exec(k);
      if (!m) continue;
      const caps = {};
      t.order.forEach((idx, i) => { caps[idx] = this._capture(m[i + 1]); });
      return t.value
        // 单复数：{0|app|apps} 按第 0 个占位符是不是 1 选词
        .replace(/\{(\d+)\|([^|}]*)\|([^}]*)\}/g, (all, n, one, many) => (Number(String(caps[n]).trim()) === 1 ? one : many))
        .replace(/\{(\d+)\}/g, (all, n) => (n in caps ? caps[n] : all))
        // 中文括号后缀直接拼在词后面（「165 GB（剩余…）」），英文要补一个空格
        .replace(/([A-Za-z0-9.%])\(/g, '$1 (');
    }
    // 几句话拼成一段（「本机 …；内存最多 …。数据分区 …。」）：按句拆开逐句翻，
    // 每句都翻得出来才采用
    const sentences = k.split(/(?<=[。；！？])\s*/).filter(Boolean);
    if (sentences.length > 1) {
      const parts = sentences.map((x) => this._core(x));
      if (parts.every((p, i) => p !== sentences[i] || !CJK.test(p))) return parts.join(' ');
    }
    if (!this.fragRe) return text;
    // 片段替换只在「整句都能被已知片段覆盖」时采用：剩下还有中文，多半夹着应用名
    // 之类的用户内容，硬换一半会把名字也翻坏，宁可整句保持原文。
    const out = k.replace(this.fragRe, (m) => ` ${this.frag.get(m)} `);
    if (out === k || CJK.test(out.replace(/[，。；：、！？（）「」『』“”——…·]/g, ''))) return text;
    return westernPunct(out);
  }

  /** 翻译一段文字；保留首尾空白（DOM 文本节点需要） */
  translate(text) {
    if (this.lang === 'zh-CN' || text == null) return text;
    const s = String(text);
    if (!CJK.test(s)) return s;
    const c = this.cache.get(s);
    if (c != null) return c;
    const lead = s.match(/^\s*/)[0];
    const trail = s.slice(lead.length).match(/\s*$/)[0];
    // 多行文案逐行翻译（对话框 detail、通知正文常见）
    let body = s.slice(lead.length, s.length - trail.length);
    let out;
    if (body.includes('\n') && !this.exact.has(norm(body))) {
      out = body.split('\n').map((line) => {
        const l = line.match(/^\s*/)[0];
        const r = line.slice(l.length);
        return r ? l + this._core(r) : line;
      }).join('\n');
    } else {
      out = this._core(body);
    }
    const res = lead + out + trail;
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(s, res);
    return res;
  }
}

const DICTS = {};
function loadDict(lang) {
  if (lang === 'zh-CN') return {};
  if (!DICTS[lang]) {
    try {
      DICTS[lang] = JSON.parse(fs.readFileSync(path.join(__dirname, `${lang}.json`), 'utf8'));
    } catch (_) {
      DICTS[lang] = {};
    }
  }
  return DICTS[lang];
}

let current = new Translator('zh-CN', {});

function setLang(lang) {
  const l = SUPPORTED.includes(lang) ? lang : 'zh-CN';
  if (l !== current.lang) current = new Translator(l, loadDict(l));
  return current.lang;
}

function getLang() { return current.lang; }

/**
 * t('已安装 {0}', name) —— 先翻译再填占位符；也可以直接 t(已拼好的中文句子)。
 */
function t(text, ...args) {
  let s = current.translate(text);
  if (args.length) s = String(s).replace(/\{(\d+)\}/g, (all, n) => (args[n] != null ? String(args[n]) : all));
  return s;
}

/** 递归翻译对象里的字符串字段（对话框参数、菜单模板） */
function tDeep(obj, keys = ['label', 'title', 'message', 'detail', 'body', 'checkboxLabel', 'toolTip', 'sublabel', 'buttonLabel']) {
  if (current.lang === 'zh-CN' || obj == null) return obj;
  if (Array.isArray(obj)) return obj.map((x) => (typeof x === 'string' ? t(x) : tDeep(x, keys)));
  if (typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && keys.includes(k)) out[k] = t(v);
    else if (k === 'buttons' && Array.isArray(v)) out[k] = v.map((b) => t(b));
    else if (k === 'submenu' && Array.isArray(v)) out[k] = v.map((x) => tDeep(x, keys));
    else if (k === 'filters' && Array.isArray(v)) out[k] = v.map((f) => ({ ...f, name: t(f.name) }));
  }
  return out;
}

module.exports = { SUPPORTED, CJK, resolveLang, setLang, getLang, t, tDeep, Translator, loadDict, westernPunct };
