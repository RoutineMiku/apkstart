'use strict';

window.i18n = {
  locale: 'zh-CN',
  preference: 'auto',
  messages: {},
  t(key, values = []) {
    const message = this.messages[key] ?? key;
    return message.replace(/\{(\d+)\}/g, (match, index) => (
      index < values.length ? String(values[index]) : match
    ));
  },
  apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = this.t(el.dataset.i18n);
    });
    for (const attr of ['title', 'placeholder', 'alt', 'aria-label', 'value']) {
      root.querySelectorAll(`[data-i18n-${attr}]`).forEach((el) => {
        el.setAttribute(attr, this.t(el.getAttribute(`data-i18n-${attr}`)));
      });
    }
    document.documentElement.lang = this.locale;
  },
};

const i18nApi = window.apkstart || window.apkstartSplash;
async function loadCatalog() {
  const config = await i18nApi.getI18n();
  Object.assign(window.i18n, config);
  window.i18n.apply();
}
window.i18n.ready = loadCatalog();
if (i18nApi.i18n && typeof i18nApi.i18n.onLanguageChange === 'function') {
  i18nApi.i18n.onLanguageChange(() => {
    window.i18n.ready = loadCatalog().then(() => {
      window.dispatchEvent(new Event('apkstart:language'));
    });
    window.i18n.ready.catch(console.error);
  });
}
