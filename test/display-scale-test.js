'use strict';
// 断言里比对的是中文原文：固定界面语言，不随本机系统语言变化
require('../src/i18n').setLang('zh');
/**
 * issue #99「非 100% 缩放屏幕显示一半」修复的纯 Node 测试（无需 Electron/模拟器）。
 *
 * 根因：独立窗口模式把 Electron 的 DIP 逻辑像素直接喂给 DPI-aware 进程里的
 *       SetWindowPos（收物理像素），125%/150% 缩放下窗口只有 2/3 大、位置偏移、
 *       点击错位。修复：交给 agent.layout 前用 _physical() 乘 scaleFactor。
 *
 * 覆盖：
 *  - _physical 在 100%/125%/150%/175% 下的换算（含负数坐标、四舍五入）
 *  - sf=1 / 缺省时不改变矩形
 *  - _area() 带上 sf 字段且与 area 同源
 *  - 源码级：独立窗口模式三处 layout 都经过 _physical，还原路径不重复乘
 *
 * 运行：node test/display-scale-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
// 只 require 零依赖的纯换算模块——CI 用 ELECTRON_SKIP_BINARY_DOWNLOAD=1，
// 直接 require appwin.js 会因 electron 二进制缺失而抛错（这正是本测试最初的坑）。
const { physicalRect } = require('../src/core/geometry');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

(() => {
  console.log('\n[issue #99 · DIP → 物理像素换算]');

  test('100% 缩放：矩形原样返回（同一对象，零开销）', () => {
    const r = { x: 100, y: 60, w: 1280, h: 720 };
    assert.equal(physicalRect(r, 1), r, 'sf=1 应直接返回原对象');
    assert.equal(physicalRect(r, 0), r, 'sf 缺失回退也不改');
  });

  test('150% 缩放：宽高与坐标一起放大，四舍五入', () => {
    assert.deepEqual(physicalRect({ x: 100, y: 60, w: 1280, h: 720 }, 1.5),
      { x: 150, y: 90, w: 1920, h: 1080 });
  });

  test('125% 缩放：出现小数时按最近整数取整', () => {
    assert.deepEqual(physicalRect({ x: 33, y: 41, w: 1001, h: 777 }, 1.25),
      { x: Math.round(33 * 1.25), y: Math.round(41 * 1.25), w: Math.round(1001 * 1.25), h: Math.round(777 * 1.25) });
  });

  test('负坐标（-8 灰边溢出）同样按比例换算，不丢符号', () => {
    assert.deepEqual(physicalRect({ x: -8, y: 30 - 8, w: 900, h: 500 }, 2),
      { x: -16, y: 44, w: 1800, h: 1000 });
  });

  test('全屏铺满：workArea DIP × sf = 物理分辨率', () => {
    // 150% 缩放下 1920×1080 物理屏的 workArea 约 1280×693 DIP
    const phys = physicalRect({ x: 0, y: 0, w: 1280, h: 693 }, 1.5);
    assert.equal(phys.w, 1920);
    assert.equal(phys.h, Math.round(693 * 1.5)); // ≈ 1040，留给任务栏
  });

  console.log('\n[源码级 · 独立窗口模式所有 layout 都接入换算]');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');

  test('appwin._physical 委托给零依赖的 geometry.physicalRect', () => {
    assert(/require\('\.\/geometry'\)/.test(src), 'appwin 应引入 geometry');
    const start = src.indexOf('_physical(rect, sf) {');
    const body = src.slice(start, start + 200);
    assert(/physicalRect\(rect/.test(body), '_physical 必须调用 physicalRect（测的才是真实实现）');
  });

  test('_area() 返回 sf，且与 area 取自同一块屏幕', () => {
    const fn = src.slice(src.indexOf('_area() {'), src.indexOf('_scale() {'));
    assert(/scaleFactor/.test(fn), '_area 必须记录 scaleFactor');
    assert(/return \{[^}]*sf:/s.test(fn), '_area 返回值要带 sf 字段');
  });

  test('openDetached 的 layout 经过 _physical', () => {
    const start = src.indexOf('async openDetached(');
    const body = src.slice(start, src.indexOf('async embed(', start));
    assert(/agent\.layout\(this\._physical\(/.test(body),
      'openDetached 里交给 agent.layout 的矩形必须先 _physical');
  });

  test('toggleMaximize 的全屏 layout 经过 _physical', () => {
    const start = src.indexOf('async toggleMaximize()');
    const body = src.slice(start, src.indexOf('openDetachedLayoutOnly(area) {'));
    assert(/agent\.layout\(this\._physical\(/.test(body),
      '独立模式全屏也要换算');
    // 还原路径用的是 probe 返回的物理像素，绝不能再乘一次
    assert(/agent\.layout\(this\._preFullscreenRect\)/.test(body),
      '从 probe 拿到的物理矩形还原时不能重复换算');
  });

  test('openDetachedLayoutOnly 的 layout 经过 _physical', () => {
    const start = src.indexOf('openDetachedLayoutOnly(area) {');
    const body = src.slice(start, start + 600);
    assert(/agent\.layout\(this\._physical\(/.test(body),
      '还原到默认尺寸的路径也要换算');
  });

  test('嵌入模式 _rect() 仍保留自己的 sf 换算（未被本次改动破坏）', () => {
    const start = src.indexOf('_rect() {');
    const body = src.slice(start, start + 500);
    assert(/this\._scale\(\)/.test(body) && /\* sf/.test(body),
      '嵌入模式的物理换算必须保留');
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();
