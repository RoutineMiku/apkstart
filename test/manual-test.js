'use strict';
/**
 * 内置手册映射测试（0.6.2）
 *
 * 重点守两件事：
 *  1) 每个章节锚点都必须真的存在于随包分发的 src/ui/manual.html；
 *  2) 自动检测 / 安装报错 / 用户手点三路入口都落到同一个正确章节。
 */
const fs = require('fs');
const path = require('path');
const zhMessages = require('../src/locales/zh-CN.json');

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
const manual = require(path.join(ROOT, 'src/core/manual'));
const html = fs.readFileSync(path.join(ROOT, 'src/ui/manual.html'), 'utf8');

console.log('\n[内置手册 · 锚点]');
test('每个主题的锚点都存在于随包 HTML', () => {
  for (const topic of Object.values(manual.TOPICS)) {
    assert(html.includes(`id="${topic.anchor}"`), `${topic.id} 的锚点 ${topic.anchor} 在手册里不存在`);
  }
});

test('手册正文包含 0.6.2 版本号与声音章节', () => {
  assert(html.includes('v0.6.2'), '手册应标注 v0.6.2');
  assert(html.includes('应用没有声音'), '手册应有声音排障章节');
  assert(html.includes('内置使用手册与自动教程'), '手册应说明自动教程');
});

console.log('\n[内置手册 · 自动检测问题 → 章节]');
test('硬件加速问题定位到 6.1', () => {
  const t = manual.topicForIssue({ code: 'accel.softwareEmulation', title: '当前没有硬件加速' });
  assert(t.id === 'accel', `应定位到 accel，实际 ${t.id}`);
});

test('adb 未授权定位到 6.4', () => {
  const t = manual.topicForIssue({ code: 'device.unauthorized', title: '安卓设备未授权调试' });
  assert(t.id === 'adb', `应定位到 adb，实际 ${t.id}`);
});

test('声音开关与服务停止都定位到 6.7', () => {
  assert(manual.topicForIssue({ code: 'audio.disabled' }).id === 'sound', '声音开关应到 6.7');
  assert(manual.topicForIssue({ code: 'audio.windowsServiceStopped' }).id === 'sound', '音频服务应到 6.7');
});

test('启动失败带 ARM 日志时优先定位到 6.3', () => {
  const t = manual.topicForIssue({
    code: 'runtime.bootFailed',
    title: '安卓运行时上次启动失败',
    detail: 'DoBadTrampoline libndk_translation',
  });
  assert(t.id === 'arm', `应定位到 arm，实际 ${t.id}`);
});

test('普通启动失败定位到 6.5', () => {
  const t = manual.topicForIssue({ code: 'runtime.bootFailed', title: '启动失败', detail: 'cannot lock AVD' });
  assert(t.id === 'startup', `应定位到 startup，实际 ${t.id}`);
});

console.log('\n[内置手册 · 安装报错 → 章节]');
test('NO_MATCHING_ABIS 定位到 ARM 章节', () => {
  assert(manual.topicForError('INSTALL_FAILED_NO_MATCHING_ABIS').id === 'arm', '应到 ARM 章节');
});

test('其它 INSTALL_FAILED 定位到安装章节', () => {
  assert(manual.topicForError('INSTALL_FAILED_INSUFFICIENT_STORAGE').id === 'install', '应到安装章节');
});

test('adb 与声音的原始报错分别定位', () => {
  assert(manual.topicForError('ADB_UNAUTHORIZED').id === 'adb', 'adb 报错应到 6.4');
  assert(manual.topicForError('audio disabled -no-audio').id === 'sound', '声音报错应到 6.7');
});

console.log('\n[内置手册 · 统一入口]');
test('resolve 接受字符串 / issue / topic 三种形状', () => {
  assert(manual.resolve('INSTALL_FAILED_NO_MATCHING_ABIS').id === 'arm', '字符串应能识别');
  assert(manual.resolve({ issue: 'audio.disabled' }).id === 'sound', 'issue code 应能识别');
  assert(manual.resolve({ topic: 'overview', reason: 'toolbar' }).anchor, 'topic 应能识别');
});

test('未知输入回目录页，不抛异常', () => {
  const r = manual.resolve({});
  assert(r.id === 'overview' && r.anchor, '应回目录页');
});

console.log('\n[内置手册 · 接线检查]');
test('主进程注册了 manual:open，preload 暴露了 openManual', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  assert(/ipcMain\.handle\('manual:open'/.test(main), '主进程未注册 manual:open');
  assert(/openManual:\s*\(payload\)/.test(preload), 'preload 未暴露 openManual');
  assert(/new BrowserWindow\([\s\S]*manual\.html/.test(main), '主进程未创建手册窗口');
});

test('标题栏 / 关于页都有手册入口', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  assert(/id="btnManual"/.test(html), '标题栏缺少手册按钮');
  assert(/id="btnOpenManual"/.test(html), '关于页缺少手册按钮');
  assert(/\$\('btnManual'\)\?\.addEventListener/.test(js), '标题栏按钮未绑定');
  assert(/\$\('btnOpenManual'\)\?\.addEventListener/.test(js), '关于页按钮未绑定');
});

test('安装失败与修复失败都会自动打开对应教程', () => {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  assert(/openManualForError\(raw, 'install-failed'\)/.test(js), '安装失败未自动开教程');
  assert(/function failFix\([\s\S]*openManualForIssue\(issue, 'fix-failed'\)/.test(js), '修复失败未自动开教程');
  assert(/case 'audioService'/.test(js) && /case 'audio':/.test(js), '声音修复动作未接入');
});

test('诊断条目带教程按钮', () => {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  assert(js.includes("tr('v062.m0045'") && /class="dbg-help"/.test(zhMessages['v062.m0045']),
    '自动检测条目缺少教程按钮');
  assert(js.includes("tr('v062.m0063'") && /class="ec-help"/.test(zhMessages['v062.m0063']),
    '自检条目缺少教程按钮');
});

console.log(`\n内置手册测试：${passed} 通过，${failed} 失败\n`);
process.exitCode = failed ? 1 : 0;
