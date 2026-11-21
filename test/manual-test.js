'use strict';
/**
 * 内置手册映射测试（0.6.3）
 *
 * 重点守两件事：
 *  1) 每个章节锚点都必须真的存在于随包分发的 src/ui/manual.html；
 *  2) 自动检测 / 安装报错 / 用户手点三路入口都落到同一个正确章节。
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
const manual = require(path.join(ROOT, 'src/core/manual'));
const html = fs.readFileSync(path.join(ROOT, 'src/ui/manual.html'), 'utf8');

console.log('\n[内置手册 · 锚点]');
test('每个主题的锚点都存在于随包 HTML', () => {
  for (const topic of Object.values(manual.TOPICS)) {
    assert(html.includes(`id="${topic.anchor}"`), `${topic.id} 的锚点 ${topic.anchor} 在手册里不存在`);
  }
});

test('手册正文包含 0.6.3 版本号与声音章节', () => {
  assert(html.includes('v0.6.3'), '手册应标注 v0.6.3');
  assert(html.includes('应用没有声音'), '手册应有声音排障章节');
  assert(html.includes('内置使用手册与自动教程'), '手册应说明自动教程');
});

test('手册有 6.8 商店版 DLL 加载失败章节，且纠正一刀切误判', () => {
  assert(html.includes('商店版启动失败'), '手册应有 6.8 章节');
  assert(/不等于.*VC\+\+|不等于.*运行库|不等于.*杀毒/.test(html.replace(/<[^>]+>/g, '')),
    '6.8 应明确 0xC0000135 不等于一定缺 VC++');
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

test('DLL / VC++ 诊断问题定位到 6.8', () => {
  assert(manual.topicForIssue({ code: 'DLL', title: '运行时依赖 DLL 加载失败' }).id === 'dll', 'DLL 分类应到 6.8');
  assert(manual.topicForIssue({ code: 'vcRedist', title: '缺少 VC++ 运行库' }).id === 'dll', 'VC++ 实测项应到 6.8');
  const t = manual.topicForIssue({ code: 'runtime.bootFailed', title: '启动失败', detail: '0xC0000135 emulator exit' });
  assert(t.id === 'dll', `带 0xC0000135 的启动失败应到 6.8，实际 ${t.id}`);
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

test('0xC0000135 原始报错定位到 6.8 而非安装章节', () => {
  assert(manual.topicForError('emulator exit 3221225781').id === 'dll', '十进制退出码应到 6.8');
  assert(manual.topicForError('0xC0000135 STATUS_DLL_NOT_FOUND').id === 'dll', '十六进制退出码应到 6.8');
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
  assert(/class="dbg-help"/.test(js), '自动检测条目缺少教程按钮');
  assert(/class="ec-help"/.test(js), '自检条目缺少教程按钮');
});

test('0xC0000135 不再被一刀切成杀毒删 DLL / 缺 VC++', () => {
  const doctor = fs.readFileSync(path.join(ROOT, 'src', 'core', 'doctor.js'), 'utf8');
  const emu = fs.readFileSync(path.join(ROOT, 'src', 'core', 'emulator.js'), 'utf8');
  assert(!/title: '运行时组件被杀毒软件删除或缺少 VC\+\+ 运行库'/.test(doctor), 'doctor 仍在静态归因杀毒/VC++');
  assert(!/缺少 DLL（VC\+\+ 运行库 \/ 运行时组件被杀毒删除）/.test(emu), 'emulator 退出码描述仍在一刀切');
  assert(/原因待查/.test(emu) && /具体原因待定位/.test(doctor), '应标明原因待定位');
});

console.log(`\n内置手册测试：${passed} 通过，${failed} 失败\n`);
process.exitCode = failed ? 1 : 0;
