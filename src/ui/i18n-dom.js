'use strict';
/**
 * 渲染层翻译：页面上出现的每一段文字（静态 HTML + app.js 动态写入的）都在这里
 * 过一遍词典。app.js 不需要改调用点，照常写中文即可。
 *
 * 不翻译的区域：带 translate="no" 或 data-i18n-skip 的元素（应用名、包名、
 * 日志、用户输入等），以及 <input>/<textarea> 的值。
 *
 * Renderer-side translation: walks the DOM and translates text nodes and a few
 * attributes as they appear, using the dictionary exposed by the preload.
 */
(function () {
  const api = window.apkstartI18n;
  if (!api || api.lang === 'zh-CN') return;
  const CJK = /[㐀-鿿豈-﫿]/;
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-tip', 'data-title'];
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);

  document.documentElement.lang = api.lang;

  function skipped(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
      if (SKIP_TAGS.has(n.tagName)) return true;
      if (n.getAttribute('translate') === 'no' || n.hasAttribute('data-i18n-skip')) return true;
    }
    return false;
  }

  function tr(s) {
    try { return api.t(s); } catch (_) { return s; }
  }

  // 中文和 <b>/<code> 之间不留空格，译成英文后单词会粘在一起（「andnever」）：
  // 紧挨着行内元素的那一侧补一个空格
  const WORDY_END = /[A-Za-z0-9,;:)"'.]$/;
  const WORDY_START = /^[A-Za-z0-9("']/;
  function spaced(node, out) {
    if (node.nextSibling && node.nextSibling.nodeType === 1 && WORDY_END.test(out)) out += ' ';
    if (node.previousSibling && node.previousSibling.nodeType === 1 && WORDY_START.test(out)) out = ' ' + out;
    return out;
  }

  function setText(node, v) {
    const out = tr(v);
    if (out !== v) node.nodeValue = spaced(node, out);
  }

  // 只剩中文标点的文本节点（「<code>x</code>。」里的句号）换成英文标点
  const PUNCT_ONLY = /^\s*[。，；：、！？）]+\s*$/;
  const PUNCT = { '。': '.', '，': ',', '；': ';', '：': ':', '、': ',', '！': '!', '？': '?', '）': ')' };
  const punct = (v) => v.replace(/[。，；：、！？）]/g, (c) => PUNCT[c]);

  function textNode(node) {
    const v = node.nodeValue;
    if (v && PUNCT_ONLY.test(v) && !(node.parentNode && skipped(node.parentNode))) { node.nodeValue = punct(v); return; }
    if (!v || !CJK.test(v)) return;
    if (node.parentNode && skipped(node.parentNode)) return;
    setText(node, v);
  }

  function element(el) {
    if (skipped(el)) return;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && CJK.test(v)) {
        const out = tr(v);
        if (out !== v) el.setAttribute(a, out);
      }
    }
    // 按钮型 input 的 value 是显示文字；文本框的 value 是用户数据，不动
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) && CJK.test(el.value)) {
      el.value = tr(el.value);
    }
  }

  function walk(root) {
    if (root.nodeType === 3) { textNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (skipped(root)) return;
      element(root);
    }
    const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1 && (SKIP_TAGS.has(n.tagName) || n.getAttribute('translate') === 'no' || n.hasAttribute('data-i18n-skip'))) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = it.nextNode())) {
      if (n.nodeType === 3) {
        const v = n.nodeValue;
        if (v && PUNCT_ONLY.test(v)) n.nodeValue = punct(v);
        else if (v && CJK.test(v)) setText(n, v);
      } else {
        element(n);
      }
    }
  }

  function titleFix() {
    if (CJK.test(document.title)) document.title = tr(document.title);
  }

  const obs = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'childList') {
        m.addedNodes.forEach(walk);
      } else if (m.type === 'characterData') {
        textNode(m.target);
      } else if (m.type === 'attributes') {
        if (m.target.nodeType === 1) element(m.target);
      }
    }
    titleFix();
  });

  function start() {
    walk(document.documentElement);
    titleFix();
    obs.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ATTRS,
    });
  }

  // 本脚本放在页面里第一个 <script>：先翻静态内容，再监听后续变化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  // 渲染层自己弹的 alert/confirm/prompt 也翻译
  const _alert = window.alert, _confirm = window.confirm, _prompt = window.prompt;
  window.alert = (m) => _alert.call(window, tr(String(m ?? '')));
  window.confirm = (m) => _confirm.call(window, tr(String(m ?? '')));
  window.prompt = (m, d) => _prompt.call(window, tr(String(m ?? '')), d);
})();
