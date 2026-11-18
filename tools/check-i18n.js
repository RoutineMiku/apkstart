#!/usr/bin/env node
'use strict';
/**
 * i18n coverage check.
 *
 *  1. Collects every translation key:
 *       - t('…') / tHtml('…') / N_('…') calls in src/**.js (key = literal, whitespace-collapsed;
 *         N_ only marks a key whose t() call happens elsewhere)
 *       - static text, title/placeholder/alt/aria-label and [data-i18n-html] blocks in src/ui/*.html
 *  2. Reports, per language (en / vi):
 *       - keys used in code but missing from the dictionary
 *       - {placeholder} sets that differ between key and translation
 *       - HTML tag sets that differ between key and translation (a translation must not add markup)
 *       - empty translations
 *     and across languages: keys present in one dictionary but not the other (en <-> vi parity).
 *  3. With --strays: lists CJK string literals NOT wrapped in t() (log-only strings are expected there).
 *  4. With --dump <file>: writes all keys (JSON array) for translators.
 *
 * Exit code 1 when any key is missing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const CJK = /[　-〿一-鿿＀-￯]/;
const BS = String.fromCharCode(92);
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Minimal JS lexer → [{ line, quote, body, start, end }] for every string literal (comments skipped). */
function lexStrings(src) {
  const out = []; let i = 0, line = 1; const n = src.length;
  let prevSig = '';
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
    // regex literal (heuristic: after an operator / opening bracket / keyword)
    if (c === '/' && (prevSig === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prevSig) || /\b(return|typeof|case)$/.test(prevSig))) {
      i++; let cls = false;
      while (i < n && src[i] !== '\n') {
        if (src[i] === BS) { i += 2; continue; }
        if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false;
        else if (src[i] === '/' && !cls) { i++; break; }
        i++;
      }
      while (i < n && /[a-z]/i.test(src[i])) i++;
      prevSig = 'x'; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; const start = i, l0 = line; i++;
      const parts = [];
      let seg = '';
      while (i < n) {
        const d = src[i];
        if (d === BS) { seg += src.slice(i, i + 2); i += 2; continue; }
        if (d === '\n') line++;
        if (q === '`' && d === '$' && src[i + 1] === '{') {
          i += 2; let b = 1; const es = i;
          while (i < n && b > 0) {
            if (src[i] === '{') b++; else if (src[i] === '}') b--; else if (src[i] === '\n') line++;
            else if (src[i] === '`' || src[i] === "'" || src[i] === '"') { const qq = src[i]; i++; while (i < n && src[i] !== qq) { if (src[i] === BS) i++; i++; } }
            i++;
          }
          parts.push(seg); seg = ''; parts.push({ expr: src.slice(es, i - 1) });
          continue;
        }
        if (d === q) { i++; break; }
        seg += d; i++;
      }
      parts.push(seg);
      out.push({ line: l0, quote: q, start, end: i, raw: src.slice(start, i), hasExpr: parts.some((p) => typeof p === 'object'), body: parts.filter((p) => typeof p === 'string').join('') });
      prevSig = 'x';
      continue;
    }
    // identifiers / punctuation
    let j = i;
    if (/[A-Za-z0-9_$]/.test(c)) { while (j < n && /[A-Za-z0-9_$.]/.test(src[j])) j++; prevSig = src.slice(i, j); i = j; continue; }
    prevSig = c; i++;
  }
  return out;
}

function unescapeJs(s) {
  try { return JSON.parse('"' + s.replace(/"/g, '\\"').replace(/\\'/g, "'").replace(/\\`/g, '`').replace(/\n/g, '\\n') + '"'); } catch (_) { return s; }
}

function jsKeys(file, keys, strays) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  // t() calls anywhere (also nested inside ${} of an outer template literal)
  const re = /(?<![A-Za-z0-9_$.])(?:t|tHtml|N_)\(\s*(?:'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`([^`$]*)`)/g;
  for (const m of src.matchAll(re)) {
    const k = m[3] !== undefined ? m[3] : unescapeJs(m[1] !== undefined ? m[1] : m[2]);
    if (!CJK.test(k)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    keys.set(norm(k), keys.get(norm(k)) || `${rel}:${line}`);
  }
  for (const s of lexStrings(src)) {
    if (!CJK.test(s.body)) continue;
    const before = src.slice(Math.max(0, s.start - 40), s.start);
    const isT = /(?:^|[^A-Za-z0-9_$.])(?:t|tHtml|N_)\(\s*$/.test(before) || /\bi18n\.(?:t|tHtml|N_)\(\s*$/.test(before);
    if (isT) {
      if (s.hasExpr) { strays.push(`${rel}:${s.line}: t() with \${} interpolation (use {name} placeholders): ${s.raw.slice(0, 80)}`); continue; }
      continue;
    } else {
      strays.push(`${rel}:${s.line}: ${s.raw.replace(/\n/g, ' ').slice(0, 120)}`);
    }
  }
}

function htmlKeys(file, keys) {
  let html = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  // [data-i18n-html] blocks: whole innerHTML (no nested same-name tags in our markup)
  html = html.replace(/<(\w+)([^>]*\bdata-i18n-html\b[^>]*)>([\s\S]*?)<\/\1>/g, (m, tag, attrs, inner) => {
    if (CJK.test(inner)) keys.set(norm(inner), keys.get(norm(inner)) || `${rel} [data-i18n-html]`);
    return `<${tag}${attrs}></${tag}>`;
  });
  for (const m of html.matchAll(/\b(?:title|placeholder|alt|aria-label)="([^"]*)"/g)) {
    if (CJK.test(m[1])) keys.set(norm(m[1]), keys.get(norm(m[1])) || `${rel} [attr]`);
  }
  const text = html.replace(/<[^>]*>/g, '\u0000');
  for (const chunk of text.split('\u0000')) {
    if (CJK.test(chunk)) keys.set(norm(chunk), keys.get(norm(chunk)) || `${rel} [text]`);
  }
}

function placeholders(s) { return [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(','); }
function tags(s) { return [...String(s).matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => m[0].toLowerCase()).sort().join(','); }

/** Static checks on the dictionaries themselves (also used by test/i18n-test.js). */
function checkDicts(dicts) {
  const problems = [];
  const langs = Object.keys(dicts);
  for (const lang of langs) {
    const d = dicts[lang];
    for (const [k, v] of Object.entries(d)) {
      if (typeof v !== 'string' || !v.trim()) { problems.push(`[${lang}] empty translation: ${k.slice(0, 80)}`); continue; }
      if (placeholders(k) !== placeholders(v)) problems.push(`[${lang}] placeholder mismatch: ${k.slice(0, 80)}  ->  ${v.slice(0, 80)}`);
      if (tags(k) !== tags(v)) problems.push(`[${lang}] HTML tag mismatch: ${k.slice(0, 80)}  ->  ${v.slice(0, 80)}`);
    }
    for (const other of langs) {
      if (other === lang) continue;
      for (const k of Object.keys(d)) if (!(k in dicts[other])) problems.push(`[${other}] key present in ${lang} but missing here: ${k.slice(0, 80)}`);
    }
  }
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const keys = new Map();
  const strays = [];
  for (const f of walk(SRC)) {
    if (f.includes(`${path.sep}i18n${path.sep}`)) continue;
    if (f.endsWith('.js')) jsKeys(f, keys, strays);
    else if (f.endsWith('.html')) htmlKeys(f, keys);
  }
  const dumpAt = args.indexOf('--dump');
  if (dumpAt >= 0) {
    fs.writeFileSync(args[dumpAt + 1], JSON.stringify([...keys.keys()], null, 2));
  }
  let missing = 0;
  const dicts = {};
  for (const lang of ['en', 'vi']) {
    const dict = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n', `${lang}.json`), 'utf8'));
    dicts[lang] = dict;
    const miss = [...keys.entries()].filter(([k]) => !(k in dict));
    const unused = Object.keys(dict).filter((k) => !keys.has(k));
    console.log(`[${lang}] keys=${keys.size} missing=${miss.length} unused=${unused.length}`);
    for (const [k, where] of miss.slice(0, args.includes('--all') ? Infinity : 30)) console.log(`  missing: ${where}  ${k.slice(0, 100)}`);
    if (args.includes('--unused')) for (const k of unused) console.log(`  unused: ${k.slice(0, 100)}`);
    missing += miss.length;
  }
  const problems = checkDicts(dicts);
  console.log(`dictionary problems=${problems.length}`);
  for (const pr of problems) console.log(`  ${pr}`);
  missing += problems.length;
  if (args.includes('--strays')) {
    console.log(`\nCJK string literals not wrapped in t() (${strays.length}):`);
    for (const s of strays) console.log('  ' + s);
  }
  process.exit(missing ? 1 : 0);
}

if (require.main === module) main();
module.exports = { lexStrings, htmlKeys, jsKeys, walk, checkDicts, placeholders, tags, SRC };
