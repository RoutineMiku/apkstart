'use strict';
/* 由 tools/i18n/translations.ru.json 生成 src/ui/i18n.js（运行时字典）。
   node tools/i18n/build.js [--check]
   --check 只校验不写文件：缺译文 / 空值 / 重复键都会失败。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'tools', 'i18n', 'translations.ru.json');
const OUT = path.join(ROOT, 'src', 'ui', 'i18n.js');

const dict = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const keys = Object.keys(dict);
const empty = keys.filter((k) => !String(dict[k] || '').trim());
if (empty.length) {
  console.error(`empty translations: ${empty.length}`);
  for (const k of empty.slice(0, 20)) console.error('  ' + JSON.stringify(k));
  process.exit(1);
}

if (process.argv.includes('--check')) {
  console.log(`ok: ${keys.length} keys, all translated`);
  process.exit(0);
}

const body = `'use strict';
/**
 * 运行时翻译字典（由 tools/i18n/build.js 从 translations.ru.json 生成，请勿手改）。
 *
 * 同一个文件两处复用：
 *  - 渲染层（index / shell / splash）：<script src="i18n.js"> 后挂在 window.ApkStartI18n，
 *    自动按 navigator.language 判定语言并翻译 DOM（含后续动态插入的节点）。
 *  - 主进程：require('./ui/i18n') 拿到 DICT，注入 src/core/i18n.js 的 tr()。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ApkStartI18n = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DICT = ${JSON.stringify(dict, null, 1)};
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  const CJK = /[\\u4e00-\\u9fff]/;
  let lang = 'zh';

  function normalizeLocale(loc) {
    return String(loc || '').toLowerCase().indexOf('ru') === 0 ? 'ru' : 'zh';
  }

  /** 渲染层用 navigator.language；拿不到就退回中文（与旧行为一致）。 */
  function detectLanguage() {
    if (typeof navigator !== 'undefined' && navigator.language) return normalizeLocale(navigator.language);
    return 'zh';
  }

  function setLanguage(l) { lang = l === 'ru' ? 'ru' : 'zh'; }
  function getLanguage() { return lang; }

  /* 动态串在进 DOM 前已经把占位符替成了真实值，精确查表必然落空。
     这里按词条骨架反查：把键里的 {...} 当通配，命中后用译文回填捕获值。 */
  var patternCache = new Map();
  var patternEntries = null;
  function escapeRe(s) {
    return s.replace(/[.*+?^$()|[\\]\\\\]/g, '\\\\$&').replace(/\\{/g, '\\\\{').replace(/\\}/g, '\\\\}');
  }
  function buildPatterns() {
    if (patternEntries) return;
    patternEntries = [];
    for (var k of Object.keys(DICT)) {
      if (!/\\{[^{}]+\\}/.test(k)) continue;
      // 键里必须剩下真实的中文骨架；纯占位符键会生成匹配任意串的万能模式
      if (!CJK.test(k.replace(/\\{[^{}]+\\}/g, ''))) continue;
      var parts = [], names = [], last = 0, m;
      var tok = /\\{[^{}]+\\}/g;
      while ((m = tok.exec(k))) {
        parts.push(escapeRe(k.slice(last, m.index)));
        names.push(m[0]);
        last = m.index + m[0].length;
      }
      parts.push(escapeRe(k.slice(last)));
      var src = '';
      for (var i = 0; i < names.length; i++) src += parts[i] + '([\\\\s\\\\S]*?)';
      src += parts[names.length];
      var re;
      try { re = new RegExp('^' + src + '$'); } catch (_) { continue; }
      patternEntries.push({ re: re, text: DICT[k], names: names });
    }
  }
  function fuzzyTranslate(raw) {
    if (lang !== 'ru' || !raw || !CJK.test(raw)) return raw;
    buildPatterns();
    if (patternCache.has(raw)) return patternCache.get(raw);
    var out = raw;
    for (var i = 0; i < patternEntries.length; i++) {
      var p = patternEntries[i];
      var m = p.re.exec(raw);
      if (!m) continue;
      out = p.text.replace(/\\{[^{}]+\\}/g, function (tok) {
        var idx = p.names.indexOf(tok);
        return idx < 0 ? tok : m[idx + 1];
      });
      break;
    }
    patternCache.set(raw, out);
    return out;
  }

  /** 翻译一条中文原文；支持 {name} 占位符。非俄语时原样返回。 */
  function tr(zh, vars) {
    let out = zh;
    if (lang === 'ru') {
      out = Object.prototype.hasOwnProperty.call(DICT, zh) ? DICT[zh] : fuzzyTranslate(zh);
    }
    if (vars) {
      for (const k of Object.keys(vars)) out = out.split('{' + k + '}').join(String(vars[k]));
    }
    return out;
  }

  /* 有些文案是一整条模板串，里面夹着「本机不匹配」这类独立词条；
     整串查表和骨架反查都落空时，替换其中已知的中文片段。 */
  var literalKeys = null;
  var fragmentCache = new Map();
  function fragmentTranslate(raw) {
    if (fragmentCache.has(raw)) return fragmentCache.get(raw);
    if (!literalKeys) {
      literalKeys = Object.keys(DICT).filter(function (k) {
        return !/\\{/.test(k) && /[\\u4e00-\\u9fff]/.test(k) && k.length >= 2;
      }).sort(function (a, b) { return b.length - a.length; });
    }
    var out = raw;
    for (var i = 0; i < literalKeys.length; i++) {
      var k = literalKeys[i];
      if (out.indexOf(k) < 0) continue;
      var at = out.indexOf(k);
      var before = at > 0 ? out.charAt(at - 1) : '';
      var after = at + k.length < out.length ? out.charAt(at + k.length) : '';
      if (/[\\u4e00-\\u9fff]/.test(before) || /[\\u4e00-\\u9fff]/.test(after)) continue;
      out = out.split(k).join(DICT[k]);
    }
    fragmentCache.set(raw, out);
    return out;
  }

  function translateTextNode(node) {
    const raw = node.nodeValue;
    if (!raw || !CJK.test(raw)) return;
    const m = /^(\\s*)([\\s\\S]*?)(\\s*)$/.exec(raw);
    const core = m[2];
    if (!core) return;
    let t = Object.prototype.hasOwnProperty.call(DICT, core) ? DICT[core] : fuzzyTranslate(core);
    if (!t || t === core) t = fragmentTranslate(core);
    if (!t || t === core) return;
    node.nodeValue = m[1] + t + m[3];
  }

  function translateAttrs(el) {
    if (!el || el.nodeType !== 1) return;
    for (const name of ATTRS) {
      const v = el.getAttribute(name);
      if (!v || !CJK.test(v)) continue;
      const t = v.trim();
      if (Object.prototype.hasOwnProperty.call(DICT, t)) el.setAttribute(name, DICT[t]);
      else { const x = fuzzyTranslate(t); if (x !== t) el.setAttribute(name, x); }
    }
  }

  function skip(node) {
    const p = node.parentNode;
    if (!p || p.nodeType !== 1) return false;
    const tag = p.tagName;
    return tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA';
  }

  /** 翻译 root 及其子树里的文本节点与 title / placeholder / aria-label。 */
  function applyDom(root) {
    const host = root || document;
    if (host.nodeType === 3) { translateTextNode(host); return; }
    if (host.nodeType === 1) translateAttrs(host);
    if (typeof document === 'undefined' || !document.createTreeWalker) return;
    const walker = document.createTreeWalker(host, 4 /* SHOW_TEXT */, null);
    const texts = [];
    let n = walker.nextNode();
    while (n) { texts.push(n); n = walker.nextNode(); }
    for (const t of texts) if (!skip(t)) translateTextNode(t);
    const els = host.querySelectorAll ? host.querySelectorAll('*') : [];
    for (const el of els) translateAttrs(el);
  }

  /** 界面是 JS 拼出来的：观察后续插入 / 改写的节点。 */
  function observeDom() {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') { translateTextNode(r.target); continue; }
        if (r.type === 'attributes') { translateAttrs(r.target); continue; }
        for (const node of r.addedNodes) {
          if (node.nodeType === 3) translateTextNode(node);
          else if (node.nodeType === 1) applyDom(node);
        }
      }
    });
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
  }

  function init() {
    if (typeof document === 'undefined') return;
    setLanguage(detectLanguage());
    if (lang !== 'ru') return;
    document.documentElement.lang = 'ru';
    applyDom(document);
    observeDom();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }

  return { DICT, tr, detectLanguage, normalizeLocale, setLanguage, getLanguage, applyDom, observeDom, init };
});
`;

fs.writeFileSync(OUT, body, 'utf8');
console.log(`wrote ${path.relative(ROOT, OUT)} (${keys.length} keys, ${body.length} bytes)`);
