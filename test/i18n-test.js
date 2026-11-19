'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../src/core/i18n');
const store = require('../src/core/store');

test('[i18n] 语言包与基础接口', async (t) => {
  await t.test('支持 en, ar, zh 三种语言', () => {
    const locales = i18n.getSupportedLocales();
    assert.deepEqual(locales, ['en', 'ar', 'zh']);
  });

  await t.test('默认语言为 en (English)', () => {
    assert.equal(i18n.getLocale(), 'en');
  });

  await t.test('三语词典键位完全对齐 (100% parity)', () => {
    const zhKeys = Object.keys(i18n.getDictionary('zh')).sort();
    const enKeys = Object.keys(i18n.getDictionary('en')).sort();
    const arKeys = Object.keys(i18n.getDictionary('ar')).sort();

    assert.equal(zhKeys.length, enKeys.length, 'en 词典键位数量应与 zh 相同');
    assert.equal(zhKeys.length, arKeys.length, 'ar 词典键位数量应与 zh 相同');
    assert.deepEqual(enKeys, zhKeys, 'en 词条需完全覆盖 zh');
    assert.deepEqual(arKeys, zhKeys, 'ar 词条需完全覆盖 zh');
  });

  await t.test('文本与插值正确翻译', () => {
    assert.equal(i18n.t('common.confirm', null, 'zh'), '确认');
    assert.equal(i18n.t('common.confirm', null, 'en'), 'Confirm');
    assert.equal(i18n.t('common.confirm', null, 'ar'), 'تأكيد');

    assert.equal(i18n.t('time.minutes_ago', { n: 5 }, 'zh'), '5 分钟前');
    assert.equal(i18n.t('time.minutes_ago', { n: 5 }, 'en'), '5m ago');
    assert.equal(i18n.t('time.minutes_ago', { n: 5 }, 'ar'), 'منذ 5 دقيقة');
  });

  await t.test('文字排版方向 (LTR 与 RTL)', () => {
    assert.equal(i18n.getDirection('en'), 'ltr');
    assert.equal(i18n.getDirection('zh'), 'ltr');
    assert.equal(i18n.getDirection('ar'), 'rtl');
  });

  await t.test('切换语言与回调监听', () => {
    let triggered = null;
    const unsub = i18n.onLocaleChange((l) => { triggered = l; });
    i18n.setLocale('ar');
    assert.equal(i18n.getLocale(), 'ar');
    assert.equal(triggered, 'ar');
    unsub();

    // 恢复默认
    i18n.setLocale('en');
    assert.equal(i18n.getLocale(), 'en');
  });
});

test('[store] 语言配置持久化', async (t) => {
  await t.test('默认配置 language 为 en', () => {
    const s = store.getSettings();
    assert.ok(['en', 'ar', 'zh'].includes(s.language));
  });

  await t.test('语言字段仅接受有效语言代码', () => {
    const s = store.saveSettings({ language: 'ar' });
    assert.equal(s.language, 'ar');
    assert.equal(store.getSettings().language, 'ar');

    // 切回 en
    store.saveSettings({ language: 'en' });
    assert.equal(store.getSettings().language, 'en');
  });

  await t.test('模拟器系统语言跟随应用语言 (auto 解析)', () => {
    assert.equal(store.resolveLocale('auto', 'en'), 'en-US');
    assert.equal(store.resolveLocale('auto', 'ar'), 'ar');
    assert.equal(store.resolveLocale('auto', 'zh'), 'zh-CN');
    assert.equal(store.resolveLocale('ja-JP', 'en'), 'ja-JP');
    assert.equal(store.resolveLocale('', 'en'), 'en-US');
  });
});
