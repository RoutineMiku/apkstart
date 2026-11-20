'use strict';
/**
 * 主进程本地化（i18n）：托盘菜单、系统对话框、系统通知等「渲染层之外」的文案。
 *
 * - 语言来源：settings.language（'auto' | 'zh' | 'ru'）。
 *   'auto' 时按系统语言判断：以 ru 开头 → 俄语，否则中文（保持原有行为）。
 * - setDictionary() 由 src/main.js 在启动/改设置时注入字典文件（src/ui/i18n.js 的纯对象导出），
 *   这样 core 目录不依赖 electron，字典也只维护一份。
 * - 译文里可以用 {name} 占位符，tr() 会用第二个参数回填；找不到词条时原样返回中文串。
 */
let dict = null;
let lang = 'zh';

function normalizeLocale(loc) {
  const s = String(loc || '').toLowerCase();
  return s.startsWith('ru') ? 'ru' : 'zh';
}

/** 解析界面语言：优先 navigator.language，其次 Electron/系统 locale。 */
function detectUiLanguage(electronApp) {
  try {
    const nav = electronApp && typeof electronApp.getPreferredSystemLanguages === 'function'
      ? electronApp.getPreferredSystemLanguages() : null;
    if (nav && nav.length) return normalizeLocale(nav[0]);
  } catch (_) { /* ignore */ }
  try {
    if (electronApp && typeof electronApp.getLocale === 'function') {
      return normalizeLocale(electronApp.getLocale());
    }
  } catch (_) { /* ignore */ }
  return normalizeLocale(process.env.LANG || process.env.LC_ALL || '');
}

/** 由 settings.language + 系统语言算出当前应使用的界面语言。 */
function resolveLanguage(setting, electronApp) {
  if (setting === 'ru' || setting === 'zh') return setting;
  return detectUiLanguage(electronApp);
}

function setLanguage(l) { lang = l === 'ru' ? 'ru' : 'zh'; }
function getLanguage() { return lang; }
function setDictionary(d) {
  dict = d || null;
  patternEntries = null;
  patternCache.clear();
  literalKeys = null;
  fragmentCache.clear();
}

/* 主进程里大量文案是模板串：等它到达这里时 ${...} 已被替换成真实值，
   精确查表必落空。按词条骨架反查，命中后回填捕获到的值。 */
let patternEntries = null;
const patternCache = new Map();

function escapeRe(s) {
  return s.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

function buildPatterns() {
  if (patternEntries || !dict) return;
  patternEntries = [];
  for (const k of Object.keys(dict)) {
    if (!/\{[^{}]+\}/.test(k)) continue;
    // 纯占位符键会生成匹配任意串的万能模式，必须排除
    if (!/[\u4e00-\u9fff]/.test(k.replace(/\{[^{}]+\}/g, ''))) continue;
    const parts = [], names = [];
    let last = 0, m;
    const tok = /\{[^{}]+\}/g;
    while ((m = tok.exec(k))) {
      parts.push(escapeRe(k.slice(last, m.index)));
      names.push(m[0]);
      last = m.index + m[0].length;
    }
    parts.push(escapeRe(k.slice(last)));
    let src = '';
    for (let i = 0; i < names.length; i++) src += parts[i] + '([\\s\\S]*?)';
    src += parts[names.length];
    let re;
    try { re = new RegExp('^' + src + '$'); } catch (_) { continue; }
    patternEntries.push({ re, text: dict[k], names });
  }
}

function fuzzyTranslate(raw) {
  if (lang !== 'ru' || !dict || !raw || !/[\u4e00-\u9fff]/.test(raw)) return raw;
  buildPatterns();
  if (patternCache.has(raw)) return patternCache.get(raw);
  let out = raw;
  for (const p of patternEntries) {
    const m = p.re.exec(raw);
    if (!m) continue;
    out = p.text.replace(/\{[^{}]+\}/g, (tok) => {
      const idx = p.names.indexOf(tok);
      return idx < 0 ? tok : m[idx + 1];
    });
    break;
  }
  patternCache.set(raw, out);
  return out;
}

/* 整串查不到时，翻译其中夹着的独立中文词条（如「本机不匹配」）。 */
let literalKeys = null;
const fragmentCache = new Map();

function fragmentTranslate(raw) {
  if (fragmentCache.has(raw)) return fragmentCache.get(raw);
  if (!literalKeys) {
    literalKeys = Object.keys(dict)
      .filter((k) => !/\{/.test(k) && /[\u4e00-\u9fff]/.test(k) && k.length >= 2)
      .sort((a, b) => b.length - a.length);
  }
  let out = raw;
  for (const k of literalKeys) {
    const at = out.indexOf(k);
    if (at < 0) continue;
    const before = at > 0 ? out.charAt(at - 1) : '';
    const after = at + k.length < out.length ? out.charAt(at + k.length) : '';
    if (/[\u4e00-\u9fff]/.test(before) || /[\u4e00-\u9fff]/.test(after)) continue;
    out = out.split(k).join(dict[k]);
  }
  fragmentCache.set(raw, out);
  return out;
}

/** 翻译一条中文原文；无字典或非俄语环境时原样返回。 */
function tr(zh, vars) {
  let out = zh;
  if (lang === 'ru' && dict) {
    out = Object.prototype.hasOwnProperty.call(dict, zh) ? dict[zh] : fuzzyTranslate(zh);
    if (out === zh) out = fragmentTranslate(zh);
  }
  if (vars) {
    for (const k of Object.keys(vars)) {
      out = out.split('{' + k + '}').join(String(vars[k]));
    }
  }
  return out;
}

module.exports = { tr, setLanguage, getLanguage, setDictionary, resolveLanguage, normalizeLocale };
