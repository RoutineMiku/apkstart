'use strict';
/**
 * i18n 单元测试：词典完整性 + 语言解析 + 查表/占位符/回退。
 *
 * 这些断言保护的是「翻译只影响显示」：中文回退、逻辑串原样返回、占位符不丢。
 * 真正的窗口布局由 Electron 冒烟测试覆盖（test/i18n-ui-smoke.js）。
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

const ROOT = path.join(__dirname, '..');
const i18n = require('../src/core/i18n');
const { run } = require('../tools/check-i18n');

console.log('\n[i18n · 语言解析]');
test('中文系统自动选中文', () => {
  assert(i18n.resolveLanguage('auto', ['zh-CN']) === 'zh', 'zh-CN 应选中 zh');
  assert(i18n.resolveLanguage('auto', ['zh-TW', 'en-US']) === 'zh', 'zh-TW 应选中 zh');
});
test('非中文系统自动选英文', () => {
  assert(i18n.resolveLanguage('auto', ['en-US']) === 'en', 'en-US 应选中 en');
  assert(i18n.resolveLanguage('auto', ['fr-FR']) === 'en', '不支持的语言应落到英文');
  assert(i18n.resolveLanguage('auto', []) === 'en', '空列表应落到英文');
});
test('显式设置优先于系统语言', () => {
  assert(i18n.resolveLanguage('zh', ['en-US']) === 'zh', '显式 zh');
  assert(i18n.resolveLanguage('en', ['zh-CN']) === 'en', '显式 en');
});
test('语言代码规范化', () => {
  assert(i18n.normalizeLang('zh_CN') === 'zh', 'zh_CN');
  assert(i18n.normalizeLang('en-GB') === 'en', 'en-GB');
  assert(i18n.normalizeLang('ja-JP') === '', '不支持的语言');
});

console.log('\n[i18n · 查表]');
i18n.setLanguage('zh');
test('中文模式原样返回', () => {
  assert(i18n.t('安装 APK') === '安装 APK', '中文模式不应翻译');
});

i18n.setLanguage('en');
test('精确查表', () => {
  assert(i18n.t('安装 APK') === 'Install APK', '安装 APK');
  assert(i18n.t('设置') === 'Settings', '设置');
});
test('跨行/多余空白也能命中', () => {
  assert(i18n.t('  安装\n  APK  ') === 'Install APK', '空白应被归一化');
});
test('缺失译文回退中文', () => {
  assert(i18n.t('这条文案还没有英文') === '这条文案还没有英文', '应回退原文');
});
test('逻辑串不翻译', () => {
  assert(i18n.t('adb devices') === 'adb devices', 'adb 命令不能被改');
  assert(i18n.t('emulator-5554') === 'emulator-5554', '设备名不能被改');
  assert(i18n.t('/sdcard/ApkStartShared') === '/sdcard/ApkStartShared', '路径不能被改');
});
test('显式占位符插值', () => {
  assert(
    i18n.t('关闭当前应用（{name}）', { name: 'Douyin' }) === 'Close current app (Douyin)',
    '应替换 {name}',
  );
});
test('运行时拼出的字符串按骨架命中', () => {
  assert(i18n.t('清理 7 项') === 'Clean 7 items', '数字占位符');
  assert(i18n.t('「D:\\\\Games」所在盘仅剩 1024 MB，运行时与镜像可能撑爆硬盘。').includes('D:\\\\Games'), '路径应保留');
});
test('跨行拼接的整句能拼装成英文', () => {
  const full = '商店版无法自行提权。请手动开启一次：'
    + '按 Win+R → 输入 optionalfeatures → 勾选「Windows 虚拟机监控程序平台」'
    + '（HypervisorPlatform，WHPX 真正需要的那个），确定后重启电脑。';
  const out = i18n.t(full);
  assert(out !== full, '应发生翻译');
  assert(!/[\u4e00-\u9fff]/.test(out), `不应残留中文：${out}`);
});

console.log('\n[i18n · 词典完整性]');
const report = run();
test('词典不是空文件', () => {
  assert(Object.keys(report.dict).length > 900, `词典只有 ${Object.keys(report.dict).length} 条`);
});
test('所有源码界面文案都有译文', () => {
  assert(report.missing.length === 0, `缺失 ${report.missing.length} 条：${report.missing.slice(0, 5).map((x) => x.key).join(' / ')}`);
});
test('占位符一一对应', () => {
  assert(report.errors.length === 0, report.errors.slice(0, 5).join('；'));
});
test('词典 key 都是中文原文', () => {
  const bad = Object.keys(report.dict).filter((k) => !/[\u4e00-\u9fff]/.test(k));
  assert(bad.length === 0, `非中文 key：${bad.slice(0, 5).join(' / ')}`);
});
test('en.json 是合法 JSON 且按 UTF-8 保存', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'src/i18n/en.json'), 'utf8');
  assert(raw.trim().startsWith('{'), '应以 { 开头');
  assert(!raw.includes('\uFFFD'), '不应有替换字符');
});

console.log(`\n[i18n] ${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
