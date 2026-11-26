'use strict';
/**
 * 界面多语言测试
 *
 * 守住三件事：
 *  1) 词典是合法 JSON，占位符 {n} 在原文和译文里一一对应；
 *  2) 模板 / 列表 / 拼接句子能翻，应用名之类的用户内容不会被翻坏；
 *  3) 中文界面完全不受影响（原样返回）。
 */
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || '不相等'}\n      期望: ${JSON.stringify(b)}\n      实际: ${JSON.stringify(a)}`);
}

const ROOT = path.join(__dirname, '..');
const i18n = require(path.join(ROOT, 'src', 'i18n'));

console.log('\n[i18n · 词典]');

test('en-US.json 是合法 JSON，占位符一一对应', () => {
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'en-US.json'), 'utf8'));
  const ph = (s) => (String(s).match(/\{\d+\}/g) || []).sort().join();
  const bad = Object.entries(dict).filter(([k, v]) => v && !k.startsWith('//') && ph(k) !== ph(v));
  eq(bad.length, 0, `占位符不一致：${bad.slice(0, 3).map(([k]) => k).join(' | ')}`);
});

console.log('\n[i18n · 语言选择]');

test('auto 跟随系统：中文系统用中文，其它用英文', () => {
  eq(i18n.resolveLang('auto', 'zh-CN'), 'zh-CN');
  eq(i18n.resolveLang('auto', 'zh-Hans-CN'), 'zh-CN');
  eq(i18n.resolveLang('auto', 'en-US'), 'en-US');
  eq(i18n.resolveLang('auto', 'de-DE'), 'en-US');
  eq(i18n.resolveLang('zh-CN', 'en-US'), 'zh-CN');
  eq(i18n.resolveLang('en-US', 'zh-CN'), 'en-US');
});

console.log('\n[i18n · 翻译]');

test('中文界面原样返回', () => {
  i18n.setLang('zh-CN');
  eq(i18n.t('设置'), '设置');
  eq(i18n.t('5 分钟前'), '5 分钟前');
});

test('完全匹配，保留首尾空白', () => {
  i18n.setLang('en-US');
  eq(i18n.t('设置'), 'Settings');
  eq(i18n.t('  设置\n'), '  Settings\n');
});

test('模板匹配：数字与应用名原样带过去', () => {
  i18n.setLang('en-US');
  eq(i18n.t('5 分钟前'), '5 min ago');
  eq(i18n.t('确定卸载「红果短剧」？'), 'Uninstall "红果短剧"?');
});

test('模板里的列表与可选后缀也会翻', () => {
  i18n.setLang('en-US');
  eq(i18n.t('缺少 引擎、系统镜像'), 'Missing Engine, System image');
  eq(i18n.t('运行时已就绪 · Android 14 · 独立窗口已启用'), 'Runtime ready · Android 14 · own window enabled');
});

test('不认识的中文（应用名等）不做半截替换', () => {
  i18n.setLang('en-US');
  eq(i18n.t('微信设置'), '微信设置');
  eq(i18n.t('红果短剧'), '红果短剧');
});

test('非中文文字不动', () => {
  i18n.setLang('en-US');
  eq(i18n.t('ApkStart v0.6.4'), 'ApkStart v0.6.4');
});

test('t() 填占位符', () => {
  i18n.setLang('en-US');
  eq(i18n.t('{0} 个应用', 3), '3 apps');
});

test('tDeep 翻译对话框参数与菜单模板', () => {
  i18n.setLang('en-US');
  const o = i18n.tDeep({ title: '设置', buttons: ['取消', '继续'], message: '已保存', type: 'info' });
  eq(o.title, 'Settings');
  eq(o.buttons.join('|'), 'Cancel|Continue');
  eq(o.type, 'info');
  const m = i18n.tDeep([{ label: '退出', submenu: [{ label: '设置' }] }]);
  eq(m[0].label, 'Quit');
  eq(m[0].submenu[0].label, 'Settings');
});

i18n.setLang('zh-CN');
console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
