'use strict';
/**
 * 界面本地化（i18n）—— 不依赖 Electron，可同时被主进程与 preload 使用。
 *
 * 设计取舍（对应当前仓库的约定）：
 * - 源码里的界面文案仍然是中文（CONTRIBUTING 的历史约定），词典以「中文原文」为 key，
 *   只在**显示层**翻译。逻辑判断、正则、adb/emulator 命令、包名、路径、配置键、
 *   IPC 通道一律不经过这里，因此翻译不会改变程序行为。
 * - 默认中文：没有词典条目时原样返回中文；非中文条目缺失时逐条回退中文。
 * - 带插值的文案（如「已安装 {n} 个应用」）支持精确查表与按骨架反查两种方式，
 *   动态拼出来的字符串也能命中。
 *
 * 支持的语言：zh(中文) / en(English) / ru(Русский) / vi(Tiếng Việt) / es(Español) /
 *             pt(Português) / ja(日本語) / ko(한국어)。可继续在 src/i18n/ 下加词典。
 *
 * 语言来源优先级：APKSTART_LANG / --lang= 环境覆盖（冒烟测试用）> settings.uiLanguage
 * > 系统首选语言（zh* → 中文，其它按系统语言匹配，匹配不到 → 英文）。
 */
const catalogs = {
  'zh-CN': require('../locales/zh-CN.json'),
  en: require('../locales/en.json'),
  'pt-BR': require('../locales/pt-BR.json'),
  ru: require('../locales/ru.json'),
};
const EN = require('../i18n/en.json');

// 其余语种词典：缺失时降级为空对象，保证某个语种文件损坏也不会拖垮启动。
function loadDict(name) {
  try { return require('../i18n/' + name + '.json'); } catch (_) { return {}; }
}
const DICTS = {
  zh: {}, // 中文是源语言，不需要词典
  en: EN,
  ru: loadDict('ru'),
  vi: loadDict('vi'),
  es: loadDict('es'),
  pt: loadDict('pt'),
  ja: loadDict('ja'),
  ko: loadDict('ko'),
};

/** 支持的语言清单（供设置界面下拉与首次选择引导使用）。 */
const LANGUAGES = [
  { code: 'auto', label: '跟随系统 / Follow system' },
  { code: 'zh', label: '简体中文' },
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Русский' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
];

const CJK_RE = /[\u4e00-\u9fff]/;

// Catalog IDs remain supported for existing UI and runtime messages. New
// source-text translations use the same active language and upstream dictionary.
for (const [locale, code] of [['en', 'en'], ['pt-BR', 'pt'], ['ru', 'ru']]) {
  DICTS[code] = { ...DICTS[code] };
  for (const [key, source] of Object.entries(catalogs['zh-CN'])) {
    if (/[\u4e00-\u9fff]/.test(source)) DICTS[code][source] = catalogs[locale][key];
  }
}
let lang = 'zh';
let dict = {};
let patterns = null;
let literalKeys = null;
const patternCache = new Map();

function normalizeLang(loc) {
  const s = String(loc || '').trim().toLowerCase().replace('_', '-');
  if (!s) return '';
  if (s === 'zh' || s.startsWith('zh-')) return 'zh';
  if (s === 'en' || s.startsWith('en-')) return 'en';
  if (s === 'ru' || s.startsWith('ru-')) return 'ru';
  if (s === 'vi' || s.startsWith('vi-')) return 'vi';
  if (s === 'es' || s.startsWith('es-')) return 'es';
  if (s === 'pt' || s.startsWith('pt-')) return 'pt';
  if (s === 'ja' || s.startsWith('ja-')) return 'ja';
  if (s === 'ko' || s.startsWith('ko-')) return 'ko';
  return '';
}

/** 从系统语言列表里挑一个受支持的语言；都不匹配时落到英文（与历史行为一致）。 */
function pickSystemLang(list) {
  const arr = Array.isArray(list) ? list : [list];
  // 按系统语言优先级取第一个受支持的语言
  for (const item of arr) {
    const n = normalizeLang(item);
    if (n) return n;
  }
  return 'en';
}

/**
 * @param {string} setting 'auto' | 'zh' | 'en' | 'ru' | ...
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
  const explicit = normalizeLang(setting);
  if (explicit) return explicit;
  return pickSystemLang(systemLanguages || []);
}

function setLanguage(next) {
  const n = normalizeLang(next);
  lang = n || 'zh';
  dict = DICTS[lang] || {};
  patterns = null;
  literalKeys = null;
  patternCache.clear();
}

function getLanguage() { return lang; }

/** 当前语言的词典浅拷贝：preload 通过 contextBridge 暴露给渲染层时用。 */
function dictionary() { return { ...dict }; }

/** 该语言是否有可用词典（zh 视为总是可用）。 */
function hasDictionary(code) {
  const n = normalizeLang(code);
  if (n === 'zh') return true;
  return !!(DICTS[n] && Object.keys(DICTS[n]).length);
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^$()|[\]\\]/g, '\\$&');
}

/**
 * 拼装/骨架翻译后的译文润色：
 * - 中文标点（顿号/全角标点）转成目标语言常用标点（目前以拉丁语种为主）；
 * - 英文里 "{n} notices" 在 n=1 时改成单数。只处理明确的英文复数词，避免误伤。
 * 日语/韩语不使用这些拉丁规则。
 */
function polish(text) {
  let s = String(text);
  if (lang === 'ja' || lang === 'ko' || lang === 'zh') return s.trim();
  return s
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
  for (const key of Object.keys(dict)) {
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
    patterns.push({ re, text: dict[key], names });
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
 * 避免出现半中半外的夹生界面。
 */
function compose(raw, depth) {
  if (!literalKeys) {
    literalKeys = Object.keys(dict)
      .filter((k) => !/\{/.test(k) && CJK_RE.test(k) && k.length >= 2)
      .sort((a, b) => b.length - a.length);
  }
  let out = raw;
  let replaced = 0;
  for (const key of literalKeys) {
    const at = out.indexOf(key);
    if (at < 0) continue;
    out = out.split(key).join(lookup(key, depth + 1) || dict[key]);
    replaced++;
  }
  return replaced && !CJK_RE.test(out) ? out : undefined;
}

/**
 * 查一条译文。找不到返回 undefined（调用方据此决定是否回退中文）。
 * 主进程可以用 lookup() 判断「有没有译文」，渲染层用它避免无谓的 DOM 改动。
 */
function lookup(text, depth = 0) {
  if (lang === 'zh' || !dict || !Object.keys(dict).length) return undefined;
  const raw = String(text == null ? '' : text);
  if (!raw || !CJK_RE.test(raw)) return undefined;
  if (Object.prototype.hasOwnProperty.call(dict, raw)) return dict[raw];
  const norm = normalizeKey(raw);
  if (norm !== raw && Object.prototype.hasOwnProperty.call(dict, norm)) return dict[norm];
  if (patternCache.has(norm)) return patternCache.get(norm) || undefined;
  let hit = matchPattern(norm, depth) || compose(norm, depth);
  if (hit !== undefined) hit = polish(hit);
  patternCache.set(norm, hit || '');
  return hit;
}

/**
 * 翻译一条界面文案；vars 用于精确查表 + 插值（如 t('已安装 {n} 个应用', { n: 3 })）。
 * 中文模式或没有译文时原样返回。
 */
function t(text, vars) {
  if (Object.hasOwn(catalogs['zh-CN'], text)) {
    return format(getCatalog(getLanguage())[text], vars);
  }
  const raw = String(text == null ? '' : text);
  if (!raw) return raw;
  let out = lookup(raw) ?? raw;
  if (vars && typeof vars === 'object') {
    out = out.replace(/\{([^{}]+)\}/g, (m, k) => {
      const key = String(k).trim();
      return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m;
    });
  }
  return out;
}

module.exports = {
  LANGUAGES,
  normalizeLang,
  pickSystemLang,
  resolveLanguage,
  setLanguage,
  getLanguage,
  dictionary,
  hasDictionary,
  normalizeKey,
  lookup,
  t,
  // 测试用：清掉按语言缓存的骨架正则
  _reset() { patterns = null; literalKeys = null; patternCache.clear(); },
};

function resolveLocale(preference, systemLocale = 'en') {
  const code = normalizeLang(preference) || pickSystemLang(systemLocale);
  return code === 'zh' ? 'zh-CN' : code === 'pt' ? 'pt-BR' : code;
}
function format(message, values = []) {
  return message.replace(/\{(\d+)\}/g, (match, index) => (
    index < values.length ? String(values[index]) : match
  ));
}
function getCatalog(locale) {
  const resolved = resolveLocale(locale);
  if (catalogs[resolved]) return catalogs[resolved];
  const sourceDict = DICTS[normalizeLang(resolved)] || {};
  return Object.fromEntries(Object.entries(catalogs['zh-CN']).map(([key, source]) => (
    [key, sourceDict[source] || catalogs.en[key]]
  )));
}
function setLocale(locale) { setLanguage(locale); }
Object.assign(module.exports, { resolveLocale, format, getCatalog, setLocale });
