'use strict';
/*
 * Traductor de superposición (overlay) para ApkStart.
 *
 * Idea: en lugar de reescribir las ~1.500 cadenas incrustadas en el código,
 * se traduce el texto en el momento de mostrarlo. Un idioma nuevo es un
 * archivo JSON en src/i18n/locales/<locale>.json con pares "original": "traducido".
 *
 * Soporta entradas plantilla: si la clave contiene marcadores ${...}, se compila
 * a una expresión regular con capturas y el valor puede reordenarlos por nombre:
 *
 *   "已就绪 · Android ${v}"      -> "Listo · Android ${v}"
 *   "${n} 个应用"                -> "${n} aplicaciones"
 *   "正在为《${label}》切换到${land ? '横屏' : '竖屏'}" ...
 *
 * Sin dependencias: sólo Node y APIs estándar de JS.
 */

const PLACEHOLDER = /\$\{([^}]+)\}/g;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compila una clave con marcadores a {re, holes, out}. */
function compilePattern(source, target) {
  const holes = [];
  let re = '^';
  let last = 0;
  const g = /\$\{([^}]+)\}/g;
  let m;
  while ((m = g.exec(source))) {
    re += escapeRe(source.slice(last, m.index));
    re += '([\\s\\S]*?)';
    holes.push(m[1].trim());
    last = m.index + m[0].length;
  }
  re += escapeRe(source.slice(last)) + '$';
  return { re: new RegExp(re, 'u'), holes, out: target };
}

/**
 * Crea un traductor a partir de un diccionario plano.
 * @param {Record<string,string>} dict
 */
function createTranslator(dict) {
  const exact = new Map();
  const patterns = [];
  for (const [source, target] of Object.entries(dict || {})) {
    if (typeof target !== 'string' || !target) continue;
    if (/\$\{[^}]+\}/.test(source)) patterns.push(compilePattern(source, target));
    else exact.set(source, target);
  }
  // Las claves más largas primero: evita que una plantilla corta se coma una frase.
  patterns.sort((a, b) => b.re.source.length - a.re.source.length);

  const cache = new Map();

  /** Traduce una cadena exacta o que encaje en una plantilla. Devuelve el original si no hay entrada. */
  function t(text) {
    if (typeof text !== 'string' || !text) return text;
    if (cache.has(text)) return cache.get(text);
    let out = exact.get(text);
    if (out === undefined) {
      for (const p of patterns) {
        const m = p.re.exec(text);
        if (!m) continue;
        out = p.out;
        p.holes.forEach((name, i) => {
          out = out.split('${' + name + '}').join(m[i + 1]);
        });
        // marcadores que no aparecían en la clave (por ejemplo reordenados) quedan intactos
        break;
      }
    }
    if (out === undefined) out = text;
    cache.set(text, out);
    return out;
  }

  /** true si la cadena tiene traducción (útil para informes de cobertura). */
  function has(text) {
    if (typeof text !== 'string' || !text) return false;
    if (exact.has(text)) return true;
    return patterns.some((p) => p.re.test(text));
  }

  // Sustitución por trozos: para textos que mezclan partes ya traducidas con
  // restos en el idioma original dentro del mismo nodo (p. ej. un saludo
  // generado por función + una frase traducida). Aplica las claves más largas
  // primero, así no parte palabras por la mitad.
  const byFirst = new Map();
  for (const key of exact.keys()) {
    if (key.length < 1) continue;
    const first = key[0];
    if (!byFirst.has(first)) byFirst.set(first, []);
    byFirst.get(first).push(key);
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.length - a.length);

  function partial(text) {
    if (typeof text !== 'string' || !text) return text;
    let out = '';
    let i = 0;
    while (i < text.length) {
      const cands = byFirst.get(text[i]);
      let hit = null;
      if (cands) {
        for (const key of cands) {
          if (text.startsWith(key, i)) {
            hit = key;
            break;
          }
        }
      }
      if (hit) {
        out += exact.get(hit);
        i += hit.length;
      } else {
        out += text[i];
        i += 1;
      }
    }
    return out;
  }

  return { t, has, partial, size: exact.size + patterns.length, patterns: patterns.length, exact: exact.size };
}

const API = { createTranslator, compilePattern, PLACEHOLDER };

// Proceso principal y tests (Node).
if (typeof module !== 'undefined' && module.exports) module.exports = API;

// Renderer: lo carga la página antes de ui/i18n.js.
if (typeof window !== 'undefined') window.ApkStartI18nEngine = API;
