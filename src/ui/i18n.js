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

window.i18n.ready = (window.apkstart || window.apkstartSplash).getI18n().then((config) => {
  Object.assign(window.i18n, config);
  window.i18n.apply();
});
