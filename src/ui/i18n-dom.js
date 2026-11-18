'use strict';
/**
 * Renderer-side i18n helpers. Loaded before app.js / shell.js.
 *
 *  - window.t(src, vars): translate a Chinese source string (see src/i18n/index.js)
 *  - window.tHtml(src, vars): same, for innerHTML — interpolated values are HTML-escaped
 *  - translateDom(root): translate static markup in place:
 *      · elements with [data-i18n-html]  → whole innerHTML is one key (mixed text + <b>/<code>…)
 *      · every other text node           → its trimmed text is the key
 *      · title / placeholder / alt / aria-label attributes
 *    The Chinese source of every translated node is remembered, so translateDom can run
 *    again after a live language change (the app window shell is not reloaded — it hosts
 *    the running Android display).
 */
(function () {
  const i18n = (window.apkstart && window.apkstart.i18n) || null;
  const t = (src, vars) => (i18n ? i18n.t(src, vars) : String(src));
  const tHtml = (src, vars) => (i18n && i18n.tHtml ? i18n.tHtml(src, vars) : String(src));
  const CJK = /[　-〿一-鿿＀-￯]/;
  const ATTRS = ['title', 'placeholder', 'alt', 'aria-label'];
  let curTag = (i18n && i18n.tag) || 'en-US';
  const curLang = () => (i18n && i18n.getLang ? i18n.getLang() : (i18n && i18n.lang) || 'en');

  // node → Chinese source (text nodes: nodeValue; elements: { attr: value, html: innerHTML })
  const srcText = new WeakMap();
  const srcEl = new WeakMap();

  function translateText(node) {
    let raw = srcText.get(node);
    if (raw == null) {
      raw = node.nodeValue;
      if (!raw || !CJK.test(raw)) return;
      srcText.set(node, raw);
    }
    const key = raw.replace(/\s+/g, ' ').trim();
    const out = t(key);
    const lead = raw.match(/^\s*/)[0];
    const trail = raw.match(/\s*$/)[0];
    node.nodeValue = out === key ? raw : (lead ? ' ' : '') + out + (trail ? ' ' : '');
  }

  function remembered(el) {
    let m = srcEl.get(el);
    if (!m) { m = {}; srcEl.set(el, m); }
    return m;
  }

  function translateEl(el) {
    if (!el.getAttribute) return;
    for (const a of ATTRS) {
      const m = srcEl.get(el);
      const v = (m && m[a]) || el.getAttribute(a);
      if (v && CJK.test(v)) {
        remembered(el)[a] = v;
        el.setAttribute(a, t(v));
      }
    }
  }

  function translateDom(root) {
    if (!i18n) return;
    root = root || document.body;
    if (root.nodeType === 1) translateEl(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1 && (n.tagName === 'SCRIPT' || n.tagName === 'STYLE')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const skip = [];
    let n = walker.currentNode;
    while ((n = walker.nextNode())) {
      if (skip.length && skip.some((s) => s.contains(n))) continue;
      if (n.nodeType === 3) { translateText(n); continue; }
      translateEl(n);
      if (n.hasAttribute('data-i18n-html')) {
        const m = remembered(n);
        if (m.html == null) m.html = n.innerHTML;
        const key = m.html.replace(/\s+/g, ' ').trim();
        const out = t(key);
        // Dictionary templates are trusted markup; there are no interpolated values here.
        n.innerHTML = out === key ? m.html : out;
        skip.push(n);
      }
    }
  }

  function applyLangAttrs() {
    window.I18N_LANG = curLang();
    window.I18N_TAG = curTag;
    try {
      document.documentElement.lang = window.I18N_TAG;
      document.documentElement.dataset.lang = window.I18N_LANG;
    } catch (_) { /* ignore */ }
  }

  window.t = t;
  window.tHtml = tHtml;
  window.translateDom = translateDom;
  applyLangAttrs();

  // Live switch (app window shell only; other windows reload).
  if (i18n && i18n.onChange) {
    i18n.onChange((_lang, tag) => {
      if (tag) curTag = tag;
      applyLangAttrs();
      translateDom(document.body);
      try { window.dispatchEvent(new Event('i18n:changed')); } catch (_) { /* ignore */ }
    });
  }
})();
