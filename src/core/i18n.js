'use strict';

const catalogs = {
  'zh-CN': require('../locales/zh-CN.json'),
  en: require('../locales/en.json'),
  'pt-BR': require('../locales/pt-BR.json'),
};
let locale = 'zh-CN';

function resolveLocale(preference, systemLocale = 'en') {
  if (Object.hasOwn(catalogs, preference)) return preference;
  const system = String(systemLocale).toLowerCase().replace(/_/g, '-');
  if (system === 'pt' || system.startsWith('pt-')) return 'pt-BR';
  if (system === 'zh' || system.startsWith('zh-')) return 'zh-CN';
  return 'en';
}

function format(message, values = []) {
  return message.replace(/\{(\d+)\}/g, (match, index) => (
    index < values.length ? String(values[index]) : match
  ));
}

function getCatalog(language) {
  return catalogs[language] || catalogs.en;
}

function setLocale(language) {
  locale = resolveLocale(language);
}

function t(key, values) {
  return format(getCatalog(locale)[key] ?? catalogs.en[key] ?? catalogs['zh-CN'][key] ?? key, values);
}

module.exports = { resolveLocale, format, getCatalog, setLocale, t };
