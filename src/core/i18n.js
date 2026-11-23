'use strict';
/**
 * 界面本地化（i18n）—— 不依赖 Electron，可同时被主进程与 preload 使用。
 *
 * 设计取舍（对应当前仓库的约定）：
 * - 源码里的界面文案仍然是中文（CONTRIBUTING 的历史约定），词典以「中文原文」为 key，
 *   只在**显示层**翻译。逻辑判断、正则、adb/emulator 命令、包名、路径、配置键、
 *   IPC 通道一律不经过这里，因此翻译不会改变程序行为。
 * - 默认中文：没有词典条目时原样返回中文；en-US 条目缺失时逐条回退。
 * - 带插值的文案（如「已安装 {n} 个应用」）支持精确查表与按骨架反查两种方式，
 *   动态拼出来的字符串也能命中。
 *
 * 语言来源优先级：APKSTART_LANG / --lang= 环境覆盖（冒烟测试用）> settings.uiLanguage
 * > 系统首选语言（zh* → 中文，其它 → 英文）。
 */
const EN = require('../i18n/en.json');

const CJK_RE = /[\u4e00-\u9fff]/;

let lang = 'zh';
let patterns = null;
let literalKeys = null;
const patternCache = new Map();

function normalizeLang(loc) {
  const s = String(loc || '').trim().toLowerCase().replace('_', '-');
  if (!s) return '';
  if (s === 'zh' || s.startsWith('zh-')) return 'zh';
  if (s === 'en' || s.startsWith('en-')) return 'en';
  return '';
}

/** 从系统语言列表里挑一个受支持的语言。只有 zh* 才保持中文，其余落到英文。 */
function pickSystemLang(list) {
  for (const item of Array.isArray(list) ? list : [list]) {
    if (normalizeLang(item) === 'zh') return 'zh';
  }
  return 'en';
}

/**
 * @param {string} setting 'auto' | 'zh' | 'en'
 * @param {string[]|string} systemLanguages Electron getPreferredSystemLanguages() 的结果
 */
function resolveLanguage(setting, systemLanguages) {
  const forced = normalizeLang(process.env.APKSTART_LANG);
  if (forced) return forced;
  const arg = (process.argv || []).find((a) => String(a).startsWith('--lang='));
  if (arg) {
    const n = normalizeLang(arg.slice('--lang='.length));
    if (n) return n;
  }
  if (setting === 'zh' || setting === 'en') return setting;
  return pickSystemLang(systemLanguages || []);
}

function setLanguage(next) {
  const n = normalizeLang(next);
  lang = n || 'zh';
  patternCache.clear();
}

function getLanguage() { return lang; }

/** 词典浅拷贝：preload 通过 contextBridge 暴露给渲染层时用。 */
function dictionary() { return { ...EN }; }

function escapeRe(s) {
  return String(s).replace(/[.*+?^$()|[\]\\]/g, '\\$&');
}

/**
 * 拼装/骨架翻译后的英文润色：
 * - 中文顿号/全角标点来自源码里的连接符，转成英文标点；
 * - "{n} notices" 在 n=1 时改成单数。只处理明确的英文复数词，避免误伤。
 */
function polishEnglish(s) {
  return String(s)
    .replace(/、/g, ', ')
    .replace(/，/g, ', ')
    .replace(/；/g, '; ')
    .replace(/：/g, ': ')
    .replace(/（/g, ' (')
    .replace(/）/g, ')')
    .replace(/。/g, '. ')
    .replace(/\b1 (notices|apps|items|minutes|hours|days|leftovers|files|cores|threads)\b/g,
      (m, word) => '1 ' + word.replace(/s$/, ''))
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/;([A-Za-z])/g, '; $1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 界面文案匹配前统一空白：HTML 里跨行的段落、模板字符串里的缩进都能对上同一条译文。 */
function normalizeKey(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/**
 * 键里的 {name} 是插值占位符。运行时字符串里的值已经填充好，
 * 所以按「键骨架」生成正则反查；纯占位符键（去掉占位符后没有中文）会被排除，
 * 否则会变成匹配任意字符串的万能模式。
 */
function buildPatterns() {
  if (patterns) return patterns;
  patterns = [];
  for (const key of Object.keys(EN)) {
    const norm = normalizeKey(key);
    if (!/\{[^{}]+\}/.test(norm)) continue;
    if (!CJK_RE.test(norm.replace(/\{[^{}]+\}/g, ''))) continue;
    const parts = [];
    const names = [];
    let last = 0;
    const tok = /\{[^{}]+\}/g;
    let m;
    while ((m = tok.exec(norm))) {
      parts.push(escapeRe(norm.slice(last, m.index)));
      names.push(m[0]);
      last = m.index + m[0].length;
    }
    parts.push(escapeRe(norm.slice(last)));
    let src = '';
    for (let i = 0; i < names.length; i++) src += parts[i] + '([\\s\\S]*?)';
    src += parts[names.length];
    let re;
    try { re = new RegExp('^' + src + '$'); } catch (_) { continue; }
    patterns.push({ re, text: EN[key], names });
  }
  return patterns;
}

function matchPattern(raw, depth) {
  for (const p of buildPatterns()) {
    const m = p.re.exec(raw);
    if (!m) continue;
    return p.text.replace(/\{[^{}]+\}/g, (token) => {
      const idx = p.names.indexOf(token);
      if (idx < 0) return token;
      const value = m[idx + 1];
      // 捕获到的值本身可能是一句中文（例如错误标题），再查一层词典
      const translated = depth < 3 ? lookup(value, depth + 1) : undefined;
      return translated === undefined ? value : translated;
    });
  }
  return undefined;
}

/**
 * 源码里有些文案是跨行拼接出来的（'甲' + '乙'），词典按整句查不到。
 * 这里做一次保守的「整句拼装」：只替换完整命中的中文词条，替换后若还剩中文就放弃，
 * 避免出现半中半英的夹生界面。
 */
function compose(raw, depth) {
  if (!literalKeys) {
    literalKeys = Object.keys(EN)
      .filter((k) => !/\{/.test(k) && CJK_RE.test(k) && k.length >= 2)
      .sort((a, b) => b.length - a.length);
  }
  let out = raw;
  let replaced = 0;
  for (const key of literalKeys) {
    const at = out.indexOf(key);
    if (at < 0) continue;
    out = out.split(key).join(lookup(key, depth + 1) || EN[key]);
    replaced++;
  }
  return replaced && !CJK_RE.test(out) ? out : undefined;
}

/**
 * 查一条译文。找不到返回 undefined（调用方据此决定是否回退中文）。
 * 主进程可以用 lookup() 判断「有没有译文」，渲染层用它避免无谓的 DOM 改动。
 */
function lookup(text, depth = 0) {
  if (lang !== 'en') return undefined;
  const raw = String(text == null ? '' : text);
  if (!raw || !CJK_RE.test(raw)) return undefined;
  if (Object.prototype.hasOwnProperty.call(EN, raw)) return EN[raw];
  const norm = normalizeKey(raw);
  if (norm !== raw && Object.prototype.hasOwnProperty.call(EN, norm)) return EN[norm];
  if (patternCache.has(norm)) return patternCache.get(norm) || undefined;
  let hit = matchPattern(norm, depth) || compose(norm, depth);
  if (hit !== undefined) hit = polishEnglish(hit);
  patternCache.set(norm, hit || '');
  return hit;
}

/**
 * 翻译一条界面文案；vars 用于精确查表 + 插值（如 t('已安装 {n} 个应用', { n: 3 })）。
 * 中文模式或没有译文时原样返回。
 */
function t(text, vars) {
  if (lang !== 'en') return text;
  const raw = String(text == null ? '' : text);
  if (!raw) return raw;
  let out = lookup(raw);
  if (out === undefined) return raw;
  if (vars && typeof vars === 'object') {
    out = out.replace(/\{([^{}]+)\}/g, (m, k) => {
      const key = String(k).trim();
      return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m;
    });
  }
  return out;
}

module.exports = {
  normalizeLang,
  pickSystemLang,
  resolveLanguage,
  setLanguage,
  getLanguage,
  dictionary,
  normalizeKey,
  lookup,
  t,
  // 测试用：清掉按语言缓存的骨架正则
  _reset() { patterns = null; literalKeys = null; patternCache.clear(); },
};
