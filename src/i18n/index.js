'use strict';
/**
 * i18n: interface language (English / Tiếng Việt / 中文).
 *
 * The UI was originally written in Chinese, so the Chinese source text itself is the
 * translation key (gettext style): `t('安装完成')` returns the English / Vietnamese text
 * for the current language, or the Chinese text unchanged when the language is `zh`
 * or when a translation is missing.
 *
 * Placeholders use `{name}`: `t('{n} 分钟前', { n: 5 })`.
 *
 * Shared by the main process and (via preload) the renderer.
 *
 * Language selection (see resolveInitialLanguage):
 *   - a language saved in settings always wins;
 *   - existing users upgrading from a version without this setting keep Chinese (`zh`),
 *     the language they have been using;
 *   - new users get the OS language when it is supported, otherwise English.
 *
 * Missing translations fall back in a fixed order: requested language → English → Chinese source.
 *
 * Only user-visible text goes through t(). adb / emulator commands, log-parsing regexes,
 * package names, paths, settings keys, IPC channels and error codes are never translated,
 * and program logic must branch on stable codes (err.code, result.reason), not on t() output.
 */

const LANGUAGES = [
  { code: 'en', name: 'English', tag: 'en-US' },
  { code: 'vi', name: 'Tiếng Việt', tag: 'vi-VN' },
  { code: 'zh', name: '中文', tag: 'zh-CN' },
];
const DEFAULT_LANG = 'en';
const SUPPORTED = LANGUAGES.map((l) => l.code);
/** Order in which dictionaries are tried for a missing key (the Chinese source text is last). */
const FALLBACK = { vi: ['vi', 'en'], en: ['en'], zh: [] };

const DICTS = {
  en: require('./en.json'),
  vi: require('./vi.json'),
};

let current = null;

/** Supported code for a locale tag (`vi-VN` → `vi`), or null when unsupported. */
function match(lang) {
  const l = String(lang || '').toLowerCase();
  if (l.startsWith('vi')) return 'vi';
  if (l.startsWith('zh')) return 'zh';
  if (l.startsWith('en')) return 'en';
  return null;
}

function normalize(lang) {
  return match(lang) || DEFAULT_LANG;
}

/**
 * Pick the interface language at startup.
 * @param {object} o
 * @param {string}   [o.saved]          settings.language ('' / undefined = never chosen)
 * @param {boolean}  [o.existingUser]   settings/app data existed before this version
 * @param {string[]} [o.systemLocales]  OS preferred languages, most preferred first
 * @returns {{ lang: string, source: 'saved'|'upgrade'|'system'|'default' }}
 */
function resolveInitialLanguage({ saved, existingUser, systemLocales } = {}) {
  const s = match(saved);
  if (s && SUPPORTED.includes(String(saved).toLowerCase())) return { lang: s, source: 'saved' };
  // Versions before i18n only had Chinese UI: keep it so an upgrade changes nothing for them.
  if (existingUser) return { lang: 'zh', source: 'upgrade' };
  for (const loc of systemLocales || []) {
    const m = match(loc);
    if (m) return { lang: m, source: 'system' };
  }
  return { lang: DEFAULT_LANG, source: 'default' };
}

function getLang() {
  if (current) return current;
  try {
    // Lazy require: store.js must stay free of i18n so there is no require cycle.
    // main.js persists the resolved language at startup, so this normally just reads it back.
    const store = require('../core/store');
    current = resolveInitialLanguage({
      saved: store.getSettings().language,
      existingUser: store.existingUser,
      systemLocales: systemLocales(),
    }).lang;
  } catch (_) {
    current = DEFAULT_LANG;
  }
  return current;
}

function setLang(lang) {
  current = normalize(lang);
  return current;
}

/** OS preferred languages, best effort (Electron app API when available, else ICU / env). */
function systemLocales() {
  const out = [];
  try {
    const { app } = require('electron');
    if (app && typeof app.getPreferredSystemLanguages === 'function') out.push(...app.getPreferredSystemLanguages());
    if (app && typeof app.getSystemLocale === 'function' && app.isReady && app.isReady()) out.push(app.getSystemLocale());
  } catch (_) { /* not in Electron main */ }
  try { out.push(Intl.DateTimeFormat().resolvedOptions().locale); } catch (_) { /* ignore */ }
  for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANG']) if (process.env[k]) out.push(process.env[k]);
  return out.filter(Boolean);
}

/** BCP-47 tag for Intl / toLocaleString. */
function localeTag(lang) {
  const l = normalize(lang || getLang());
  return (LANGUAGES.find((x) => x.code === l) || LANGUAGES[0]).tag;
}

/** Collapse whitespace so multi-line HTML text maps to a single dictionary key. */
function normKey(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function format(str, vars) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

const has = (d, k) => Object.prototype.hasOwnProperty.call(d, k) && typeof d[k] === 'string' && d[k] !== '';

/** Translation of `src` following the fallback chain, or null (→ Chinese source text). */
function lookup(src, lang) {
  const l = normalize(lang || getLang());
  const k = normKey(src);
  for (const code of FALLBACK[l] || []) {
    const d = DICTS[code];
    if (!d) continue;
    if (has(d, src)) return d[src];
    if (k !== src && has(d, k)) return d[k];
  }
  return null;
}

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => HTML_ESC[c]);
}

function t(src, vars) {
  if (src == null) return '';
  const s = String(src);
  const hit = lookup(s);
  return format(hit != null ? hit : s, vars);
}

/**
 * Like t(), for strings that end up in innerHTML: the translated template may contain
 * trusted markup (it comes from our own dictionaries), every interpolated value is escaped.
 */
function tHtml(src, vars) {
  if (src == null) return '';
  const s = String(src);
  const hit = lookup(s);
  const safe = {};
  for (const [k, v] of Object.entries(vars || {})) safe[k] = escapeHtml(v);
  return format(hit != null ? hit : s, safe);
}

/** gettext-style no-op marker: flags a source string as a translation key for tools/check-i18n.js. */
function N_(src) { return src; }

/** Dictionary for the current language (empty for Chinese) — handed to the renderer. */
function dict(lang) {
  const l = normalize(lang || getLang());
  const out = {};
  for (const code of [...(FALLBACK[l] || [])].reverse()) Object.assign(out, DICTS[code]);
  return out;
}

module.exports = {
  t, tHtml, N_, escapeHtml, getLang, setLang, normalize, match, resolveInitialLanguage, systemLocales,
  localeTag, normKey, format, lookup, dict, LANGUAGES, SUPPORTED, FALLBACK, DEFAULT_LANG, DICTS,
};
