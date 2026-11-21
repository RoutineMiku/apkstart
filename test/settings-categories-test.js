'use strict';
/**
 * 设置页分类导航 + 搜索（0.6.0）结构测试
 *
 * 设置页是用户最常碰的面，一旦分类与分组对不上就会出现「某个分类点进去是空的」。
 * 这里做源码级断言：HTML 里每个分组都必须有 data-cat，导航项必须与分组用到的分类一致，
 * 前端的分类表必须与 HTML 对得上。
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
const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'src/ui/app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/ui/style.css'), 'utf8');

/** 取设置面板主体（settingsBody）里的 HTML 片段 */
const bodyMatch = html.match(/<div class="modal-body" id="settingsBody">([\s\S]*?)\n    <\/div>\n    <\/div>\n    <footer/);
assert(bodyMatch, '应能定位到设置面板主体');

console.log('\n[设置分类 · 结构]');
test('设置面板有分类导航与搜索框', () => {
  assert(html.includes('id="setNav"'), '应有分类导航容器');
  assert(html.includes('id="setSearch"'), '应有搜索框');
  assert(html.includes('id="btnClearSearch"'), '应有清除搜索按钮');
  assert(html.includes('id="settingsBody"'), '内容区应有稳定 id（定位与滚动要用）');
});

test('导航项覆盖全部 9 个分类（含实验室）', () => {
  const navMatch = html.match(/<nav class="set-nav" id="setNav"[\s\S]*?<\/nav>/);
  assert(navMatch, '应有 nav');
  const items = navMatch[0].match(/data-cat="([a-z]+)"/g) || [];
  const ids = items.map((s) => s.replace(/data-cat="|"/g, ''));
  const expected = ['basic', 'display', 'input', 'perf', 'net', 'diag', 'files', 'about', 'lab'];
  assert(ids.length === expected.length, `导航项应有 ${expected.length} 个，实际 ${ids.length}`);
  for (const e of expected) {
    assert(ids.includes(e), `导航缺少分类 ${e}`);
  }
});

test('每个设置分组都归了类（没有漏网的分组）', () => {
  // 取设置主体里所有顶层分组的起始标签
  const groups = bodyMatch[1].match(/<(div class="group"|details class="advanced-group")[^>]*>/g) || [];
  assert(groups.length >= 15, `设置分组应不少于 15 个，实际 ${groups.length}`);
  for (const g of groups) {
    assert(/data-cat="[a-z]+"/.test(g), `分组缺少 data-cat：${g}`);
  }
});

test('分组用到的分类都在导航里（不会出现「点了是空的」）', () => {
  const navMatch = html.match(/<nav class="set-nav" id="setNav"[\s\S]*?<\/nav>/);
  const navIds = (navMatch[0].match(/data-cat="([a-z]+)"/g) || []).map((s) => s.replace(/data-cat="|"/g, ''));
  const used = (bodyMatch[1].match(/data-cat="([a-z]+)"/g) || []).map((s) => s.replace(/data-cat="|"/g, ''));
  const usedSet = Array.from(new Set(used));
  for (const u of usedSet) {
    assert(navIds.includes(u), `分类 ${u} 没有对应的导航项`);
  }
  // 每个分类至少有一个分组，空分类应当从导航里去掉
  for (const n of navIds) {
    assert(used.includes(n), `分类 ${n} 没有任何分组，不该出现在导航里`);
  }
});

test('关键分组落在合理的分类里', () => {
  const expect = [
    ['id="runtimeGroup"', 'basic'],
    ['id="perfGroup"', 'perf'],
    ['id="preflightGroup"', 'diag'],
    ['id="driverGroup"', 'diag'],
    ['id="autodebugGroup"', 'diag'],
    ['id="downloadGroup"', 'net'],
    ['id="updateGroup"', 'about'],
    ['id="aboutGroup"', 'about'],
    ['id="labGroup"', 'lab'],
  ];
  for (const [marker, cat] of expect) {
    const idx = html.indexOf(marker);
    assert(idx > 0, `找不到 ${marker}`);
    const tail = html.slice(idx, idx + 120);
    assert(tail.includes(`data-cat="${cat}"`), `${marker} 应归到 ${cat}`);
  }
});

test('前端分类表与导航项一一对应', () => {
  const m = appJs.match(/const SETTINGS_CATS = \[([\s\S]*?)\];/);
  assert(m, 'app.js 里应有 SETTINGS_CATS');
  const ids = (m[1].match(/id:\s*'([a-z]+)'/g) || []).map((s) => s.replace(/id:\s*'|'/g, ''));
  const navMatch = html.match(/<nav class="set-nav" id="setNav"[\s\S]*?<\/nav>/);
  const navIds = (navMatch[0].match(/data-cat="([a-z]+)"/g) || []).map((s) => s.replace(/data-cat="|"/g, ''));
  assert(ids.length === navIds.length, `前端分类 ${ids.length} 个，导航 ${navIds.length} 个`);
  for (const n of navIds) {
    assert(ids.includes(n), `前端缺少分类 ${n}`);
  }
});

console.log('\n[设置分类 · 行为]');
test('实现了切换、过滤与记忆', () => {
  assert(appJs.includes('function switchSettingsCat'), '应有分类切换函数');
  assert(appJs.includes('function applySettingsFilter'), '应有可见性过滤函数');
  assert(appJs.includes('function groupMatches'), '应有搜索匹配函数');
  assert(appJs.includes('function focusGroup'), '应有定位到分组的函数');
  assert(appJs.includes('apkstart.settings.cat'), '应记住上次停留的分类');
});

test('搜索是跨分类的（否则搜到了却看不见）', () => {
  // 过滤时按命中决定可见性，而不是只看当前分类
  const fn = appJs.match(/function applySettingsFilter\(\) \{[\s\S]*?\n\}/);
  assert(fn, '应能定位 applySettingsFilter');
  assert(/g\.hidden = q \? !hit : !inCat/.test(fn[0]), '搜索时应按命中显示（跨分类）');
});

test('跳转入口都改成了 focusGroup（分类切换后仍能定位到分组）', () => {
  assert(appJs.includes("focusGroup($('runtimeGroup'))"), '部署向导应定位到运行时分组');
  assert(appJs.includes("focusGroup($('perfGroup'))"), '数据分区问题应定位到性能分组');
  // 旧的直接 scrollIntoView 定位应已被 focusGroup 取代
  const direct = appJs.match(/box\.scrollIntoView\(\{ block: 'start', behavior: 'smooth' \}\)/g) || [];
  assert(direct.length === 0, `不应再有直接 scrollIntoView 的定位（还有 ${direct.length} 处）`);
});

test('自动检测面板的修复按钮复用 fixIssue', () => {
  assert(appJs.includes('data-code="${esc(it.code)}"'), '检测项应带 code 以便修复');
  assert(appJs.includes('fixIssue(issue)'), '应复用统一的修复入口');
});

test('实验室分组有多开开关，且接到 engine.multiWindow', () => {
  assert(html.includes('id="setMultiWindow"'), '应有多窗口多开开关');
  assert(html.includes('id="setKeepBackground"'), '应有后台保留数设置');
  assert(html.includes('class="lab-notice"'), '实验室要有实验性提示');
  // 开关要读写真实设置项，而不是空壳
  assert(/setMultiWindow'\)\.checked = !!s\.engine\.multiWindow/.test(appJs), '要回填 multiWindow 状态');
  assert(/engine:\s*\{\s*multiWindow:\s*e\.target\.checked/.test(appJs), '要把开关存到 engine.multiWindow');
  assert(/engine:\s*\{\s*keepBackground:/.test(appJs), '要保存后台保留数');
  // 底层确实消费这个设置（不是只有 UI）
  const engineJs = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
  assert(/s\.engine && s\.engine\.multiWindow/.test(engineJs), 'engine 要读取 multiWindow 决定不 force-stop 旧应用');
  const storeJs = fs.readFileSync(path.join(ROOT, 'src/core/store.js'), 'utf8');
  assert(/multiWindow:\s*false/.test(storeJs), 'store 要有 multiWindow 默认值且默认关闭');
});

console.log('\n[设置分类 · 样式]');
test('有导航、搜索与检测面板的样式', () => {
  for (const sel of ['.set-nav', '.set-nav-item', '.set-search', '.dbg-list', '.dbg-item', '.modal-main']) {
    assert(css.includes(sel), `style.css 应有 ${sel}`);
  }
});

test('弹窗变宽了但没有撑破小屏', () => {
  assert(/\.modal \{[^}]*width: 880px/.test(css), '弹窗应为 880px');
  assert(css.includes('max-width: calc(100vw - 48px)'), '小屏上应自适应');
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
