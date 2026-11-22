'use strict';
/**
 * 界面多语言（目前：简体中文 = 源语言，Español = 西班牙语）。
 *
 * 设计取舍：源码里的中文文案保持原样（CONTRIBUTING 约定 UI 文案用中文），
 * 不把每一处字符串改成 t('key')。翻译只发生在「显示的那一刻」：
 *   - 渲染进程：MutationObserver 把 DOM 里的文本节点和 title / placeholder / alt 换成译文；
 *   - 主进程：托盘菜单、系统通知、原生对话框在交给 Electron 之前过一遍 tr()。
 * 所以业务逻辑里对中文字符串的比较、日志、错误匹配都不受影响；
 * 选中文（默认）时本模块什么都不做。
 *
 * 词典格式见 es.js：键是源中文，动态部分写成 {0} {1}…，值是对应译文。
 *
 * 同一个文件既给主进程 require，也给渲染进程用 <script> 加载。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ApkI18n = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const HAN = /[㐀-鿿]/;
  const LANGS = ['zh-CN', 'es'];
  const LANG_NAMES = { 'zh-CN': '简体中文', es: 'Español' };

  const dicts = {};
  const engines = {};

  function register(lang, dict) {
    dicts[lang] = dict;
    delete engines[lang];
  }

  function loadDict(lang) {
    if (dicts[lang]) return dicts[lang];
    if (typeof require === 'function') {
      try { dicts[lang] = require('./' + lang + '.js'); } catch (_) { dicts[lang] = null; }
    }
    return dicts[lang];
  }

  /** 'auto' → 跟随系统语言；系统是西班牙语就用 es，否则保持中文 */
  function resolveLang(pref, systemLangs) {
    if (pref && pref !== 'auto') return LANGS.includes(pref) ? pref : 'zh-CN';
    const list = Array.isArray(systemLangs) ? systemLangs : [systemLangs];
    for (const l of list) {
      const s = String(l || '').toLowerCase();
      if (s.startsWith('es')) return 'es';
      if (s.startsWith('zh')) return 'zh-CN';
    }
    return 'zh-CN';
  }

  const PUNCT = { '、': ', ', '，': ', ', '；': '; ', '：': ': ', '（': ' (', '）': ')', '「': '«', '」': '»', '。': '. ', '！': '! ', '？': '? ' };
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  function buildEngine(dict) {
    const exact = new Map();
    const patterns = [];
    const pieces = [];
    for (const [k, v] of Object.entries(dict)) {
      if (!v) continue;
      const key = norm(k);
      if (/\{\d+\}/.test(key)) {
        const literal = key.replace(/\{\d+\}/g, '');
        if (!HAN.test(literal)) continue;
        const order = [];
        const re = new RegExp('^' + key.split(/(\{\d+\})/).map((p) => {
          const m = /^\{(\d+)\}$/.exec(p);
          if (m) { order.push(Number(m[1])); return '([\\s\\S]*?)'; }
          return escRe(p);
        }).join('') + '$');
        patterns.push({ re, order, value: v, weight: literal.length });
      } else {
        exact.set(key, v);
        if (key.length >= 2) pieces.push(key);
      }
    }
    // 字面量越长越具体，优先匹配
    patterns.sort((a, b) => b.weight - a.weight);
    pieces.sort((a, b) => b.length - a.length);
    const pieceRe = pieces.length ? new RegExp(pieces.map(escRe).join('|'), 'g') : null;
    return { exact, patterns, pieceRe, cache: new Map() };
  }

  function getEngine(lang) {
    if (engines[lang]) return engines[lang];
    const d = loadDict(lang);
    engines[lang] = d ? buildEngine(d) : null;
    return engines[lang];
  }

  // 专有名词不改小写
  const PROPER = /^\s*(Android|ApkStart|Windows|GitHub|Gitee|Google|Microsoft|QEMU|Douyin|Hongguo|Play|Wi-Fi|WebP|PowerShell|Nox|MuMu|MEmu|BlueStacks|Bliss)\b/;
  const lowerFirst = (s) => (PROPER.test(s) ? s : s.replace(/^(\s*)(\p{Lu})(?=\p{Ll})/u, (_m, sp, c) => sp + c.toLowerCase()));

  /** 动态部分本身可能也是一段中文（比如三元表达式里的后缀），递归翻一次 */
  function fillArg(eng, lang, a) {
    if (a === undefined) return '';
    if (!HAN.test(a)) return a;
    let t = matchWhole(eng, norm(a), lang);
    // 拼出来的复合文案（带「、」「（」这类分隔）再走一遍完整翻译；单个词（可能是应用名）保持原样
    if (t === null && /[、，；（]/.test(a)) t = translate(lang, a).trim();
    if (t === null) return a;
    return (/^\s/.test(a) ? ' ' : '') + t + (/\s$/.test(a) && !/\s$/.test(t) ? ' ' : '');
  }

  function matchWhole(eng, s, lang) {
    const hit = eng.exact.get(s);
    if (hit !== undefined) return hit;
    for (const p of eng.patterns) {
      const m = p.re.exec(s);
      if (!m) continue;
      const args = [];
      p.order.forEach((idx, i) => { args[idx] = m[i + 1]; });
      return p.value.replace(/\{(\d+)\}/g, (_x, d, off) => {
        const a = args[Number(d)];
        const r = fillArg(eng, lang, a);
        return off > 0 && a && HAN.test(a) ? lowerFirst(r) : r; // 句中被翻译的片段首字母小写
      });
    }
    return null;
  }

  /** 把一段（可能带首尾空白的）中文翻成目标语言；翻不了就原样返回 */
  function translate(lang, text) {
    if (!text || lang === 'zh-CN' || !HAN.test(text)) return text;
    const eng = getEngine(lang);
    if (!eng) return text;
    const cached = eng.cache.get(text);
    if (cached !== undefined) return cached;
    const lead = /^\s*/.exec(text)[0];
    const trail = /\s*$/.exec(text)[0];
    const core = norm(text);
    let out = matchWhole(eng, core, lang);
    if (out === null) {
      // 多行文本（日志、换行拼接的提示）逐行处理
      if (/\n/.test(text.trim())) {
        out = text.trim().split('\n').map((line) => translate(lang, line)).join('\n');
      } else if (/[a-zA-Z]:\\|\/[\w.-]+\//.test(core)) {
        out = core; // 看起来是路径：可能含用户的中文文件夹名，不做片段替换
      } else if (eng.pieceRe) {
        // 兜底：把已知的整句/短语片段替换掉（处理多段字符串在运行时拼起来的情况）
        eng.pieceRe.lastIndex = 0;
        out = core.replace(eng.pieceRe, (m, offset) => {
          const t = eng.exact.get(m) || m;
          // 句中的片段：译文首字母改小写（「抖音 已安装」→「抖音 instalada」），缩写不动
          return offset > 0 ? lowerFirst(t) : t;
        });
      } else {
        out = core;
      }
    }
    // 译文里残留的全角标点（多段拼接时夹在中间的「、」「（」等）换成半角
    if (!HAN.test(out)) out = out.replace(/[、，；：（）「」。！？]/g, (c) => PUNCT[c]).replace(/ {2,}/g, ' ').replace(/ ([,;:)!?])/g, '$1').replace(/ \.(?=\s|$)/g, '.').replace(/([\p{L}\p{N}])\(/gu, '$1 (').trim();
    const result = lead + out + trail;
    if (eng.cache.size > 5000) eng.cache.clear();
    eng.cache.set(text, result);
    return result;
  }

  /** 原生对话框选项（showMessageBox / showOpenDialog / showSaveDialog）里的可见文案 */
  function translateDialog(lang, opts) {
    if (!opts || lang === 'zh-CN') return opts;
    const t = (s) => (typeof s === 'string' ? translate(lang, s) : s);
    const out = Object.assign({}, opts);
    for (const k of ['title', 'message', 'detail', 'buttonLabel', 'checkboxLabel', 'nameFieldLabel']) {
      if (k in out) out[k] = t(out[k]);
    }
    if (Array.isArray(out.buttons)) out.buttons = out.buttons.map(t);
    if (Array.isArray(out.filters)) out.filters = out.filters.map((f) => Object.assign({}, f, { name: t(f.name) }));
    return out;
  }

  /** 托盘 / 右键菜单模板；skip(item) 返回 true 的项（比如应用名）保持原样 */
  function translateMenu(lang, template, skip) {
    if (lang === 'zh-CN') return template;
    return template.map((it) => {
      const o = Object.assign({}, it);
      if (typeof o.label === 'string' && !(skip && skip(it))) o.label = translate(lang, o.label);
      if (typeof o.sublabel === 'string') o.sublabel = translate(lang, o.sublabel);
      if (typeof o.toolTip === 'string') o.toolTip = translate(lang, o.toolTip);
      if (Array.isArray(o.submenu)) o.submenu = translateMenu(lang, o.submenu, skip);
      return o;
    });
  }

  /**
   * 渲染进程：接管整个文档。
   * 带 translate="no" 的元素（应用名、用户数据）及其子孙不翻译，里面再标 translate="yes" 的部分照常翻译；
   * 输入框的值本来就不是文本节点，不受影响。
   */
  function installDom(lang, doc) {
    if (!doc || lang === 'zh-CN' || !getEngine(lang)) return () => {};
    const ATTRS = ['title', 'placeholder', 'alt', 'aria-label'];
    const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, KBD: 1 };
    const frozen = (el) => {
      for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
        if (SKIP_TAGS[e.tagName]) return true;
        const tr = e.getAttribute('translate');
        if (tr === 'no') return true;
        if (tr === 'yes') return false;
      }
      return false;
    };
    const INLINE = { B: 1, STRONG: 1, SPAN: 1, A: 1, CODE: 1, KBD: 1, EM: 1, I: 1 };
    const doText = (n) => {
      const v = n.nodeValue;
      if (!v || !HAN.test(v) || frozen(n.parentElement)) return;
      let t = translate(lang, v);
      // 紧跟在 <b>应用名</b> 这类行内元素后面的文本是半句话，首字母小写
      const prev = n.previousSibling;
      if (prev && prev.nodeType === 1 && INLINE[prev.tagName] && /^\s/.test(v)) t = lowerFirst(t);
      if (t !== v) n.nodeValue = t;
    };
    const doAttrs = (el) => {
      if (frozen(el)) return;
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (v && HAN.test(v)) {
          const t = translate(lang, v);
          if (t !== v) el.setAttribute(a, t);
        }
      }
    };
    const doTree = (rootNode) => {
      if (rootNode.nodeType === 3) { doText(rootNode); return; }
      if (rootNode.nodeType !== 1 && rootNode.nodeType !== 9 && rootNode.nodeType !== 11) return;
      if (rootNode.nodeType === 1) doAttrs(rootNode);
      const w = doc.createTreeWalker(rootNode, 1 | 4);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (n.nodeType === 3) doText(n); else doAttrs(n);
      }
    };

    try {
      doc.documentElement.lang = lang;
      if (doc.title) doc.title = translate(lang, doc.title);
    } catch (_) { /* ignore */ }
    doTree(doc.documentElement || doc);

    const mo = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'characterData') doText(m.target);
        else if (m.type === 'attributes') doAttrs(m.target);
        else m.addedNodes.forEach(doTree);
      }
    });
    mo.observe(doc.documentElement || doc, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS,
    });

    // 渲染进程里直接弹的 confirm / alert / prompt
    const win = doc.defaultView;
    if (win) {
      for (const fn of ['confirm', 'alert', 'prompt']) {
        const orig = win[fn];
        if (typeof orig !== 'function') continue;
        win[fn] = function (msg, ...rest) { return orig.call(win, translate(lang, String(msg ?? '')), ...rest); };
      }
    }
    return () => mo.disconnect();
  }

  return {
    LANGS, LANG_NAMES, HAN,
    register, resolveLang, translate, translateDialog, translateMenu, installDom,
    /** 绑定某个语言（或一个返回当前语言的函数），得到 tr(text) 这类便捷函数 */
    bind(langOrFn) {
      const cur = typeof langOrFn === 'function' ? langOrFn : () => langOrFn;
      return {
        lang: () => cur(),
        tr: (s) => translate(cur(), s),
        dialog: (o) => translateDialog(cur(), o),
        menu: (t, skip) => translateMenu(cur(), t, skip),
      };
    },
  };
});
