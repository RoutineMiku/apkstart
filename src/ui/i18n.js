'use strict';
/*
 * Overlay de traducción del renderer.
 *
 * Traduce los nodos de texto y los atributos visibles del DOM (placeholder,
 * title, aria-label, alt, data-tip) usando el diccionario que preload expone en
 * window.apkstartI18n. Después queda observando los cambios para cubrir el HTML
 * que se genera dinámicamente (app.js pinta casi toda la interfaz así).
 *
 * Si el idioma activo es el de origen (zh-CN) no hace absolutamente nada.
 * Se puede desactivar un subárbol con el atributo data-i18n-skip.
 */
(() => {
  const boot = (typeof window !== 'undefined') ? window.apkstartI18n : null;
  const Engine = (typeof window !== 'undefined') ? window.ApkStartI18nEngine : null;
  if (!boot || !Engine || !boot.dict || boot.locale === 'zh-CN') return;

  const { t, partial } = Engine.createTranslator(boot.dict);

  // Índice de bloques: los párrafos con etiquetas dentro se buscan sin espacios,
  // porque el HTML (saltos de línea, sangría) no es estable entre versiones.
  const blockMap = new Map();
  for (const [k, v] of Object.entries(boot.dict)) {
    if (typeof v === 'string' && v) blockMap.set(k.replace(/\s+/g, ''), v);
  }

  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-tip'];
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'KBD', 'SAMP', 'TEXTAREA']);

  /** Traduce conservando los espacios de los extremos (importantes en HTML en línea). */
  function tr(text) {
    if (!text || !CJK.test(text)) return text;
    const lead = text.match(/^\s*/)[0];
    const trail = text.match(/\s*$/)[0];
    const core = text.slice(lead.length, text.length - trail.length);
    if (!core) return text;
    let out = t(core);
    if (out === core || CJK.test(out)) {
      // Sustitución por trozos solo si cubre el texto completo: si queda algún
      // carácter sin traducir, se deja el nodo como está (evita frases mestizas).
      const piece = partial(out);
      if (!CJK.test(piece)) out = piece;
    }
    return out === core ? text : lead + out + trail;
  }

  function trTextNode(node) {
    const value = node.nodeValue;
    const out = tr(value);
    if (out !== value) {
      node.__i18nWritten = out;
      node.nodeValue = out;
    }
  }

  function trAttributes(el) {
    if (!el || el.nodeType !== 1) return;
    for (const name of ATTRS) {
      if (!el.hasAttribute(name)) continue;
      const value = el.getAttribute(name);
      const out = tr(value);
      if (out !== value) {
        el.__i18nAttr = el.__i18nAttr || {};
        el.__i18nAttr[name] = out;
        el.setAttribute(name, out);
      }
    }
  }

  // Párrafos con formato dentro (negritas, código…): se traducen como bloque,
  // porque traducir cada trozo de texto por separado rompe la sintaxis.
  const BLOCK_SEL = 'p, label, option, li, blockquote, .sub, .inline-note, .group-title, .lab-notice, .guide-tip';

  function trBlock(el) {
    const raw = el.textContent;
    if (!raw || !CJK.test(raw)) return;
    const hit = blockMap.get(raw.replace(/\s+/g, ''));
    if (!hit) return;
    if (hit.indexOf('<') >= 0) el.innerHTML = hit;
    else el.textContent = hit;
  }

  function trBlocks(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches(BLOCK_SEL)) trBlock(root);
    for (const el of root.querySelectorAll(BLOCK_SEL)) trBlock(el);
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      trTextNode(root);
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    const el = root.nodeType === 1 ? root : null;
    if (el) {
      if (SKIP_TAGS.has(el.tagName) || el.hasAttribute('data-i18n-skip')) return;
      trAttributes(el);
    }
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      const children = node.childNodes;
      if (!children) continue;
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (child.nodeType === 3) {
          trTextNode(child);
        } else if (child.nodeType === 1) {
          if (SKIP_TAGS.has(child.tagName) || child.hasAttribute('data-i18n-skip')) continue;
          trAttributes(child);
          stack.push(child);
        }
      }
    }
  }

  function start() {
    trBlocks(document.documentElement);
    walk(document.documentElement);
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'characterData') {
          if (m.target.nodeValue !== m.target.__i18nWritten) trTextNode(m.target);
        } else if (m.type === 'childList') {
          for (const n of m.addedNodes) {
            trBlocks(n);
            walk(n);
          }
        } else if (m.type === 'attributes' && m.attributeName) {
          const el = m.target;
          const cached = el.__i18nAttr && el.__i18nAttr[m.attributeName];
          if (cached && el.getAttribute(m.attributeName) === cached) continue;
          trAttributes(el);
        }
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
    // El <title> puede cambiar por código (document.title = ...).
    if (document.head) {
      new MutationObserver(() => {
        const titleEl = document.querySelector('title');
        if (titleEl && titleEl.firstChild) trTextNode(titleEl.firstChild);
      }).observe(document.head, { childList: true, subtree: true, characterData: true });
    }
    window.__apkstartI18n = { locale: boot.locale, translate: t };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
