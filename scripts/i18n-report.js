'use strict';
/*
 * Informe de cobertura de la traducción.
 *
 *   node scripts/i18n-report.js            # resumen + cadenas que faltan
 *   node scripts/i18n-report.js --missing  # solo la lista de faltantes (para traducir)
 *   node scripts/i18n-report.js --lang es
 *
 * Recorre src/ buscando literales de cadena con caracteres chinos (ignora
 * comentarios y código) y dice cuáles no tienen entrada en locales/<lang>.json.
 * Sirve como termómetro para quien traduce: no necesita red ni Electron.
 */
const fs = require('fs');
const path = require('path');
const { createTranslator } = require('../src/i18n/engine');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const LOCALES_DIR = path.join(SRC, 'i18n', 'locales');
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

const args = process.argv.slice(2);
const langIdx = args.indexOf('--lang');
const LANG = langIdx >= 0 ? args[langIdx + 1] : (args.includes('--missing') ? 'es' : 'es');

function loadDict(lang) {
  let p = path.join(LOCALES_DIR, lang + '.json');
  if (!fs.existsSync(p)) {
    // --lang es debe encontrar es-ES.json (basta con el prefijo de idioma).
    const hit = fs.existsSync(LOCALES_DIR)
      ? fs.readdirSync(LOCALES_DIR).find((f) => f.startsWith(lang.split('-')[0] + '-'))
      : null;
    if (hit) p = path.join(LOCALES_DIR, hit);
  }
  if (!fs.existsSync(p)) {
    console.error('No existe', p);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Extrae literales de cadena (comillas o plantillas) que contengan CJK. */
function scanJs(src) {
  const found = [];
  let i = 0;
  const n = src.length;
  let line = 1;
  const push = (text) => {
    if (CJK.test(text)) found.push(text);
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line += 1; i += 1; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let j = i + 1;
      let buf = '';
      while (j < n) {
        if (src[j] === '\\') { buf += src[j] + src[j + 1]; j += 2; continue; }
        if (src[j] === q) break;
        if (src[j] === '\n') { line += 1; if (q !== '`') break; }
        buf += src[j];
        j += 1;
      }
      push(buf);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return found;
}

/** Trozos de texto de una plantilla, fuera de las expresiones ${...}. */
function templateSegments(content) {
  const out = [];
  let i = 0;
  let start = 0;
  while (i < content.length) {
    if (content[i] === '$' && content[i + 1] === '{') {
      if (i > start) out.push(content.slice(start, i));
      let depth = 1;
      let j = i + 2;
      while (j < content.length && depth) {
        if (content[j] === '{') depth += 1;
        else if (content[j] === '}') depth -= 1;
        j += 1;
      }
      i = j;
      start = j;
      continue;
    }
    i += 1;
  }
  if (start < content.length) out.push(content.slice(start));
  return out;
}

/** true si el literal está cubierto: entero o todos sus trozos de texto. */
function isCovered(tr, text) {
  if (tr.has(text)) return true;
  if (text.indexOf('${') < 0) return false;
  const segs = templateSegments(text).map((s) => s.trim()).filter((s) => s && CJK.test(s));
  if (!segs.length) return true;
  return segs.every((s) => tr.has(s));
}

/** Texto visible y atributos traducibles de un HTML. */
function scanHtml(src) {
  const found = [];
  const clean = src.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  for (const m of clean.matchAll(/>([^<>]+)</g)) {
    const t = m[1].trim();
    if (t && CJK.test(t)) found.push(t);
  }
  for (const m of clean.matchAll(/\b(placeholder|title|aria-label|alt|data-tip)="([^"]*)"/g)) {
    if (CJK.test(m[2])) found.push(m[2]);
  }
  return found;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'locales') continue;
      walk(p, out);
    } else if (/\.(js|html)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

function main() {
  const dict = loadDict(LANG);
  const tr = createTranslator(dict);
  const files = walk(SRC);
  const missing = new Map();
  let total = 0;
  let covered = 0;
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (/i18n[\\/]/.test(rel)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const hits = file.endsWith('.html') ? scanHtml(src) : scanJs(src);
    for (const text of hits) {
      const trimmed = text.trim();
      if (!trimmed) continue;
      total += 1;
      if (isCovered(tr, trimmed)) {
        covered += 1;
      } else {
        if (!missing.has(trimmed)) missing.set(trimmed, new Set());
        missing.get(trimmed).add(rel);
      }
    }
  }
  const pct = total ? ((covered / total) * 100).toFixed(1) : '0.0';
  if (args.includes('--missing')) {
    for (const [text, where] of missing) console.log(JSON.stringify({ zh: text, archivos: [...where].slice(0, 4) }));
    return;
  }
  console.log(`Idioma: ${LANG} · entradas en el diccionario: ${Object.keys(dict).length}`);
  console.log(`Cadenas con chino en src/: ${total} · traducidas: ${covered} (${pct}%) · sin traducir: ${total - covered}`);
  console.log(`Cadenas distintas sin traducir: ${missing.size}`);
  const byFile = new Map();
  for (const [text, where] of missing) {
    for (const f of where) byFile.set(f, (byFile.get(f) || 0) + 1);
  }
  console.log('\nPor archivo:');
  for (const [f, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${String(n).padStart(4)}  ${f}`);
  }
  console.log('\nPrimeras 25 sin traducir:');
  let i = 0;
  for (const [text, where] of missing) {
    if (i++ >= 25) break;
    console.log(`  · ${text.slice(0, 70)}   [${[...where][0]}]`);
  }
}

main();
