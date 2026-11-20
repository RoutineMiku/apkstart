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
function setDictionary(d) { dict = d || null; }

/** 翻译一条中文原文；无字典或非俄语环境时原样返回。 */
function tr(zh, vars) {
  let out = zh;
  if (lang === 'ru' && dict && Object.prototype.hasOwnProperty.call(dict, zh)) {
    out = dict[zh];
  }
  if (vars) {
    for (const k of Object.keys(vars)) {
      out = out.split('{' + k + '}').join(String(vars[k]));
    }
  }
  return out;
}

module.exports = { tr, setLanguage, getLanguage, setDictionary, resolveLanguage, normalizeLocale };
