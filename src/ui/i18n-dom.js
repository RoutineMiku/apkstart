'use strict';
/**
 * 渲染层 i18n：在 DOM 边界翻译，中文源码保持不动。
 *
 * 为什么不在每个 textContent 赋值处手写 t()：界面文案分散在 HTML 与 app.js 的
 * 模板字符串里，逐处改会制造巨大的 diff 和冲突面；而「中文原文」本身就是稳定的 key。
 * 这里只改**显示结果**，不参与任何逻辑判断，因此不会出现「翻译了错误文本导致行为变化」。
 *
 * 跳过区域（用户数据 / 日志 / 代码）用 data-i18n-skip 标记，例如应用名、包名、路径。
 */
(function initI18nDom() {
  const api = (window.apkstart && window.apkstart.i18n)
    || (window.apkstartSplash && window.apkstartSplash.i18n);
  if (!api || typeof api.lookup !== 'function') return;

  const TEXT_ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'SVG']);

  const textOrigin = new WeakMap();
  const textApplied = new WeakMap();
  const attrOrigin = new WeakMap();
  const attrApplied = new WeakMap();
  const reported = new Set();

  function reportMissing(text) {
    if (!api.collect) return;
    if (!/[\u4e00-\u9fff]/.test(text)) return;
    if (reported.has(text)) return;
    reported.add(text);
    console.warn('[i18n-missing]', text);
  }

  function skipped(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (SKIP_TAGS.has(n.tagName)) return true;
      if (n.hasAttribute && n.hasAttribute('data-i18n-skip')) return true;
    }
    return false;
  }

  function splitEdge(s) {
    const lead = (s.match(/^\s*/) || [''])[0];
    const trail = (s.match(/\s*$/) || [''])[0];
    return { lead, core: s.slice(lead.length, s.length - trail.length), trail };
  }

  /**
   * 中文列表里常把「：」「，」单独放在 <b>/<code> 之间，这些节点没有汉字，
   * 不进词典。英文界面下顺手把全角标点换成半角，列表才不会出现「Boot menu：New」。
   */
  const PUNCT = { '：': ': ', '，': ', ', '、': ', ', '；': '; ', '。': '. ', '！': '! ', '？': '? ', '（': ' (', '）': ')', '「': '"', '」': '"' };
  function translatePunctuation(core) {
    if (!/^[：，、；。！？（）「」]+$/.test(core)) return undefined;
    return Array.from(core).map((c) => PUNCT[c] || c).join('');
  }

  function translateText(node) {
    if (!node || node.nodeType !== 3) return;
    const parent = node.parentNode;
    if (!parent || parent.nodeType !== 1 || skipped(parent)) return;

    const value = node.nodeValue;
    if (value == null) return;

    let src = textOrigin.get(node);
    if (src === undefined) {
      src = value;
      textOrigin.set(node, src);
    } else if (textApplied.has(node) && value !== textApplied.get(node) && value !== src) {
      // 运行时用新的中文文案覆盖了这个节点：把新文案当作原文重新翻译
      src = value;
      textOrigin.set(node, src);
    }

    const { lead, core, trail } = splitEdge(src);
    if (!core) return;
    // 所有非中文界面都用半角标点（英文/俄文/越文/日文等），中文保持原样
    const langNow = api.getLanguage ? api.getLanguage() : 'zh';
    const punct = langNow !== 'zh' ? translatePunctuation(core) : undefined;
    const out = punct !== undefined ? punct : api.lookup(core);
    if (out === undefined) {
      reportMissing(core);
      if (value !== src) node.nodeValue = src;
      textApplied.delete(node);
      return;
    }
    const next = lead + out + trail;
    if (value !== next) node.nodeValue = next;
    textApplied.set(node, next);
  }

  function translateAttr(el, name) {
    if (!el || el.nodeType !== 1 || !el.hasAttribute(name)) return;
    if (skipped(el)) return;
    const value = el.getAttribute(name);
    if (!value || !value.trim()) return;

    let originMap = attrOrigin.get(el);
    if (!originMap) { originMap = new Map(); attrOrigin.set(el, originMap); }
    let appliedMap = attrApplied.get(el);
    if (!appliedMap) { appliedMap = new Map(); attrApplied.set(el, appliedMap); }

    let src = originMap.get(name);
    if (src === undefined) {
      src = value;
      originMap.set(name, src);
    } else if (appliedMap.has(name) && value !== appliedMap.get(name) && value !== src) {
      src = value;
      originMap.set(name, src);
    }

    const { lead, core, trail } = splitEdge(src);
    if (!core) return;
    const out = api.lookup(core);
    if (out === undefined) {
      if (name === 'title' || name === 'aria-label') reportMissing(core);
      if (value !== src) el.setAttribute(name, src);
      appliedMap.delete(name);
      return;
    }
    const next = lead + out + trail;
    if (value !== next) el.setAttribute(name, next);
    appliedMap.set(name, next);
  }

  function translateElement(el) {
    for (const name of TEXT_ATTRS) translateAttr(el, name);
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { translateText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      translateElement(root);
      if (skipped(root)) return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === 3) {
          const p = node.parentNode;
          return p && p.nodeType === 1 && !skipped(p) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
        if (SKIP_TAGS.has(node.tagName) || (node.hasAttribute && node.hasAttribute('data-i18n-skip'))) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node = walker.currentNode;
    while (node) {
      if (node.nodeType === 1) translateElement(node);
      else translateText(node);
      node = walker.nextNode();
    }
  }

  function retranslateAll() {
    walk(document.body);
  }

  const HTML_LANG = { zh: 'zh-CN', en: 'en', ru: 'ru', vi: 'vi', es: 'es', pt: 'pt-BR', ja: 'ja', ko: 'ko', it: 'it' };
  function setHtmlLang() {
    const lang = api.getLanguage ? api.getLanguage() : 'zh';
    document.documentElement.lang = HTML_LANG[lang] || 'zh-CN';
  }

  function start() {
    setHtmlLang();
    retranslateAll();

    // 动态插入的 toast / 列表项 / 弹窗文案也要翻译；写入我们自己的译文时
    // translateText/Attr 是幂等的（值没变不写），不会形成观察器死循环。
    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.type === 'childList') {
          for (const n of rec.addedNodes) walk(n);
        } else if (rec.type === 'characterData') {
          translateText(rec.target);
        } else if (rec.type === 'attributes') {
          if (TEXT_ATTRS.includes(rec.attributeName)) translateAttr(rec.target, rec.attributeName);
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: TEXT_ATTRS,
    });

    if (typeof api.onLanguageChange === 'function') {
      api.onLanguageChange(() => {
        setHtmlLang();
        retranslateAll();
      });
    }
  }

  window.ApkStartI18N = {
    t: (s, vars) => api.t(s, vars),
    apply: walk,
    retranslateAll,
    getLanguage: () => (api.getLanguage ? api.getLanguage() : 'zh'),
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
