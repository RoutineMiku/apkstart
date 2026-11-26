'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveLocale, format, getCatalog, setLocale, t } = require('../src/core/i18n');
const locales = ['zh-CN', 'en', 'pt-BR', 'ru'];
const source = getCatalog('zh-CN');
const parameters = (s) => [...s.matchAll(/\{\d+\}/g)].map(m => m[0]).sort();
for (const locale of locales) {
  const catalog = getCatalog(locale);
  assert.deepEqual(Object.keys(catalog).sort(), Object.keys(source).sort(), `${locale}: missing keys`);
  for (const [key, message] of Object.entries(catalog)) {
    assert.equal(typeof message, 'string');
    assert.ok(message.length, `${locale}/${key}: empty message`);
    assert.deepEqual(parameters(message), parameters(source[key]), `${locale}/${key}: parameters`);
  }
}
assert.equal(resolveLocale('auto', 'pt-BR'), 'pt-BR');
assert.equal(resolveLocale('auto', 'pt_PT'), 'pt-BR');
assert.equal(resolveLocale('auto', 'zh-TW'), 'zh-CN');
assert.equal(resolveLocale('auto', 'en-GB'), 'en');
assert.equal(resolveLocale('auto', 'de-DE'), 'en');
assert.equal(resolveLocale('auto', 'ru-RU'), 'ru');
assert.equal(resolveLocale('auto', 'ru'), 'ru');
assert.equal(resolveLocale('en', 'pt-BR'), 'en');
assert.equal(resolveLocale('invalid', 'pt-BR'), 'pt-BR');
assert.equal(format('{0} / {1}', ['$&', '{0}']), '$& / {0}');
assert.equal(format('{0} / {1}', ['one']), 'one / {1}');
setLocale('pt-BR');
assert.equal(t('m0390'), 'Configurações');
assert.equal(t('m0010', [3]), '3 apps');
assert.equal(t('missing'), 'missing');
const { describeProfile } = require('../src/core/doctor');
for (const locale of locales) {
  setLocale(locale);
  const profile = describeProfile({ memoryMB: 2048, cores: 2, gpu: 'host', accelOk: true, snapshot: true, lite: true, port: 5554 });
  assert.ok(profile.includes('2.0') && profile.includes('host') && profile.includes('5554'));
  if (locale !== 'zh-CN') assert.ok(!/\p{Script=Han}/u.test(profile));
}
setLocale('pt-BR');
for (const file of ['index.html', 'shell.html', 'splash.html']) {
  const html = fs.readFileSync(path.join(__dirname, '../src/ui', file), 'utf8');
  for (const match of html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)) {
    assert.ok(Object.hasOwn(source, match[1]), `${file}: unknown key ${match[1]}`);
  }
}
for (const file of ['main.js', 'core/doctor.js', 'ui/app.js', 'ui/shell.js', 'ui/splash.js']) {
  const js = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
  for (const match of js.matchAll(/\b(?:tr|t)\('([^']+)'/g)) {
    assert.ok(Object.hasOwn(source, match[1]), `${file}: unknown key ${match[1]}`);
  }
}
(async () => {
  for (const locale of locales) {
    const elements = [{ dataset: { i18n: 'm0390' }, textContent: '' }];
    const attrs = {};
    const input = { getAttribute: () => 'm0475', setAttribute: (a, v) => { attrs[a] = v; } };
    const document = { documentElement: {}, querySelectorAll: (s) => s === '[data-i18n]' ? elements : s === '[data-i18n-placeholder]' ? [input] : [] };
    const window = { apkstart: { getI18n: async () => ({ locale, preference: locale, messages: getCatalog(locale) }) } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/ui/i18n.js'), 'utf8'), { window, document });
    await window.i18n.ready;
    assert.equal(document.documentElement.lang, locale);
    assert.equal(elements[0].textContent, getCatalog(locale).m0390);
    assert.equal(attrs.placeholder, getCatalog(locale).m0475);
    assert.equal(window.i18n.t('m0010', [2]), format(getCatalog(locale).m0010, [2]));
  }
  console.log(`i18n: ${Object.keys(source).length} messages × ${locales.length} locales; locale resolution, interpolation and renderer passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
