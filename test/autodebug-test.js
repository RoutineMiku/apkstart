'use strict';
/**
 * 自动检测内核（src/core/autodebug.js）单测
 *
 * 纯函数，不依赖 electron / adb / 网络 —— CI 可直接跑。
 * 重点守住两条底线：
 *   1) 探测失败不许变成「有问题」（不能瞎报）；
 *   2) 真出问题时必须报出来，而且给出可执行的修复动作。
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
const ad = require(path.join(ROOT, 'src/core/autodebug'));

const codes = (issues) => issues.map((i) => i.code);

console.log('\n[自动检测 · 空快照不误报]');
test('完全空的快照不产生任何问题', () => {
  const issues = ad.evaluate({});
  assert(issues.length === 0, `不该有问题，实际 ${JSON.stringify(codes(issues))}`);
});

test('只知道一半状态时也不会瞎报', () => {
  // 只知道「在跑」，别的都不知道
  const issues = ad.evaluate({ runtime: { running: true } });
  assert(issues.length === 0, `不该有问题，实际 ${JSON.stringify(codes(issues))}`);
});

test('设备没检查过时不会报「没看到设备」', () => {
  const issues = ad.evaluate({ runtime: { running: true }, device: { checked: false } });
  assert(!codes(issues).includes('device.missing'), '不该报设备缺失');
});

console.log('\n[自动检测 · 运行时]');
test('上次启动失败会报出来，并带上真实报错', () => {
  const issues = ad.evaluate({ runtime: { error: 'FATAL: cannot lock AVD' } });
  const it = issues.find((i) => i.code === 'runtime.bootFailed');
  assert(it, '应报出启动失败');
  assert(it.severity === 'error', '应是严重问题');
  assert(it.detail.includes('cannot lock AVD'), '应带上真实原因');
  assert(it.fix === 'restartRuntime', '应给出可执行的修复动作');
});

test('引导卡住超过 2 分半才提示（刚开机不算问题）', () => {
  const soon = ad.evaluate({ runtime: { running: true, phase: 'booting', bootMs: 30000 } });
  assert(!codes(soon).includes('runtime.stuckBoot'), '刚开机不该提示');
  const stuck = ad.evaluate({ runtime: { running: true, phase: 'booting', bootMs: 200000 } });
  assert(codes(stuck).includes('runtime.stuckBoot'), '卡久了应提示');
});

test('残留锁文件与孤儿进程各报一条', () => {
  const issues = ad.evaluate({ runtime: { locks: 2, orphans: 1 } });
  assert(codes(issues).includes('runtime.staleLocks'), '应报残留锁');
  assert(codes(issues).includes('runtime.orphanProcesses'), '应报孤儿进程');
});

test('快照空壳会被识别出来', () => {
  const issues = ad.evaluate({ runtime: { snapshotStale: true } });
  assert(codes(issues).includes('runtime.saleSnapshot') === false, '不应有拼错的 code');
  assert(codes(issues).includes('runtime.staleSnapshot'), '应报快照损坏');
});

console.log('\n[自动检测 · 设备连接]');
test('unauthorized 是严重问题（安卓弹了授权框没人点）', () => {
  const issues = ad.evaluate({ device: { checked: true, state: 'unauthorized' } });
  const it = issues.find((i) => i.code === 'device.unauthorized');
  assert(it, '应报未授权');
  assert(it.severity === 'error', '应是严重问题');
  assert(it.category === 'device', '应归到设备连接');
});

test('offline 与 no-device 区分开，且严重度不同', () => {
  const off = ad.evaluate({ device: { checked: true, state: 'offline' } });
  assert(codes(off).includes('device.offline'), '应报 offline');
  const none = ad.evaluate({ runtime: { running: true }, device: { checked: true, state: 'no-device' } });
  assert(codes(none).includes('device.missing'), '应报设备缺失');
});

console.log('\n[自动检测 · 存储]');
test('磁盘不足 2GB 是严重问题，8GB 以下是提醒', () => {
  const crit = ad.evaluate({ storage: { freeMB: 1024 } });
  const ci = crit.find((i) => i.code === 'storage.diskCritical');
  assert(ci && ci.severity === 'error', '低于 2GB 应是严重问题');
  const warn = ad.evaluate({ storage: { freeMB: 5000 } });
  const wi = warn.find((i) => i.code === 'storage.diskLow');
  assert(wi && wi.severity === 'warn', '低于 8GB 应是提醒');
});

test('数据分区被差量盘挡住会如实报告', () => {
  const issues = ad.evaluate({ storage: { needsReset: true, configuredGB: 16, actualGB: 6 } });
  const it = issues.find((i) => i.code === 'storage.dataNeedsReset');
  assert(it, '应报扩容未生效');
  assert(it.detail.includes('16') && it.detail.includes('6'), '应带上配置值与实际值');
});

test('配置容量大于实际容量是严重问题', () => {
  const issues = ad.evaluate({ storage: { configuredGB: 24, actualGB: 6 } });
  const it = issues.find((i) => i.code === 'storage.dataMismatch');
  assert(it && it.severity === 'error', '应是严重问题');
});

test('共享目录不可写会被报出来', () => {
  const issues = ad.evaluate({ storage: { sharedOk: false, sharedPath: 'D:\\share' } });
  const it = issues.find((i) => i.code === 'storage.sharedBroken');
  assert(it, '应报共享目录异常');
  assert(it.detail.includes('share'), '应带上目录路径');
});

console.log('\n[自动检测 · 设置冲突]');
test('强制竖屏但面板是横屏 —— 方向打架', () => {
  const issues = ad.evaluate({ settings: { orientationMode: 'portrait', landscape: true } });
  assert(codes(issues).includes('settings.orientationConflict'), '应报方向冲突');
});

test('强制横屏但面板是竖屏 —— 方向打架', () => {
  const issues = ad.evaluate({ settings: { orientationMode: 'landscape', landscape: false } });
  assert(codes(issues).includes('settings.orientationConflict'), '应报方向冲突');
});

test('跟随应用 + 任意面板方向都不算冲突', () => {
  const a = ad.evaluate({ settings: { orientationMode: 'auto', landscape: true } });
  const b = ad.evaluate({ settings: { orientationMode: 'auto', landscape: false } });
  assert(!codes(a).includes('settings.orientationConflict'), 'auto 不该报冲突');
  assert(!codes(b).includes('settings.orientationConflict'), 'auto 不该报冲突');
});

console.log('\n[自动检测 · 声音（0.6.2）]');
test('安卓声音被关掉会报出来，并带上教程', () => {
  const issues = ad.evaluate({ audio: { checked: true, enabled: false, serviceRunning: true } });
  const it = issues.find((i) => i.code === 'audio.disabled');
  assert(it, '应报声音开关被关');
  assert(it.category === 'settings' && it.fix === 'audio', '应归到设置且能一键处理');
  assert(it.help && it.help.id === 'sound', '应带内置教程');
});

test('Windows 音频服务停止会报出来', () => {
  const issues = ad.evaluate({ audio: { checked: true, enabled: true, serviceRunning: false } });
  const it = issues.find((i) => i.code === 'audio.windowsServiceStopped');
  assert(it, '应报音频服务停止');
  assert(it.fix === 'audioService', '应给出对应修复动作');
});

test('音频服务探测失败不当成问题', () => {
  const issues = ad.evaluate({ audio: { checked: true, enabled: true, serviceRunning: null } });
  assert(!codes(issues).includes('audio.windowsServiceStopped'), '不知道就不该报');
});

console.log('\n[自动检测 · 网络与日志]');
test('安卓没网会报出来，并给出修复动作', () => {
  const issues = ad.evaluate({ network: { ok: false, reason: 'dns timeout' } });
  const it = issues.find((i) => i.code === 'network.guestDown');
  assert(it, '应报安卓无网络');
  assert(it.fix === 'repairNetwork', '应给出修复动作');
});

test('下载源不通会计数', () => {
  const issues = ad.evaluate({ network: { sources: [{ name: 'GitHub', ok: false }, { name: 'Gitee', ok: true }] } });
  const it = issues.find((i) => i.code === 'network.sourcesDown');
  assert(it, '应报源不通');
  assert(it.detail.includes('GitHub'), '应指出哪个源');
  assert(!it.detail.includes('Gitee'), '正常的源不该列进去');
});

test('日志里的错误会被摘出来', () => {
  const issues = ad.evaluate({ logs: { errors: ['2026-01-01 FATAL: cannot lock AVD'] } });
  const it = issues.find((i) => i.code === 'logs.errors');
  assert(it, '应报日志错误');
  assert(it.detail.includes('cannot lock'), '应带上错误原文');
});

console.log('\n[自动检测 · 汇总与差异]');
test('汇总按严重度计数，并给出健康度', () => {
  const s = ad.summarize(ad.evaluate({
    runtime: { error: 'boom' },
    storage: { freeMB: 1024 },
    device: { checked: true, state: 'unauthorized' },
  }));
  assert(s.total === 3, `应有 3 项，实际 ${s.total}`);
  assert(s.errors === 3, `应有 3 个严重问题，实际 ${s.errors}`);
  assert(s.health === 'error', '健康度应为 error');
  assert(s.byCategory.length === 6, '分类数应固定为 6');
});

test('没有问题时健康度是 ok', () => {
  const s = ad.summarize([]);
  assert(s.total === 0 && s.health === 'ok', '应为空且健康');
});

test('同 code 的多条只留最后一条', () => {
  const list = ad.dedupe([
    { code: 'x', severity: 'warn', title: '旧的' },
    { code: 'x', severity: 'error', title: '新的' },
  ]);
  assert(list.length === 1, '应只剩一条');
  assert(list[0].title === '新的', '应保留最后一条');
});

test('差异能分出「新出现」和「已消失」', () => {
  const prev = [{ code: 'a', severity: 'error' }, { code: 'b', severity: 'warn' }];
  const next = [{ code: 'b', severity: 'warn' }, { code: 'c', severity: 'error' }];
  const d = ad.diff(prev, next);
  assert(d.added.length === 1 && d.added[0].code === 'c', '应识别出新问题');
  assert(d.resolved.length === 1 && d.resolved[0].code === 'a', '应识别出已消失');
});

test('严重度变了也算「新出现」（error 升级自 warn 要提醒）', () => {
  const d = ad.diff([{ code: 'a', severity: 'warn' }], [{ code: 'a', severity: 'error' }]);
  assert(d.added.length === 1, '严重度升级应重新提醒');
});

console.log('\n[自动检测 · 结构约束]');
test('每条问题都有分类、严重度、标题', () => {
  const issues = ad.evaluate({
    runtime: { error: 'x', locks: 1, orphans: 1, snapshotStale: true },
    device: { checked: true, state: 'offline' },
    storage: { freeMB: 100, needsReset: true, sharedOk: false },
    settings: { orientationMode: 'portrait', landscape: true },
    network: { ok: false },
    logs: { errors: ['err'] },
  });
  assert(issues.length > 0, '应有若干问题');
  for (const it of issues) {
    assert(it.code, '必须有 code');
    assert(ad.CATEGORY_IDS.includes(it.category), `分类必须合法：${it.category}`);
    assert(['error', 'warn', 'info'].includes(it.severity), `严重度必须合法：${it.severity}`);
    assert(it.title, '必须有标题');
    assert(typeof it.hint === 'string', '必须有说明');
  }
});

test('分类表在前后端保持一致（渲染层 DEBUG_CATS）', () => {
  const appJs = fs.readFileSync(path.join(ROOT, 'src/ui/app.js'), 'utf8');
  const m = appJs.match(/const DEBUG_CATS = \[([\s\S]*?)\];/);
  assert(m, 'app.js 里应该有 DEBUG_CATS');
  const ids = (m[1].match(/id:\s*'([a-z]+)'/g) || []).map((s) => s.replace(/id:\s*'|'/g, ''));
  assert(ids.length === ad.CATEGORIES.length, `分类数应一致：前端 ${ids.length} / 后端 ${ad.CATEGORIES.length}`);
  for (const c of ad.CATEGORIES) {
    assert(ids.includes(c.id), `前端缺少分类 ${c.id}`);
  }
});

console.log('\n[自动检测 · 主进程接线]');
test('主进程注册了检测相关的 IPC', () => {
  const mainJs = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  for (const ch of ['autodebug:run', 'autodebug:state', 'autodebug:config', 'app:clearOrphans', 'app:clearSnapshot', 'runtime:restart']) {
    assert(mainJs.includes(`'${ch}'`), `主进程应注册 ${ch}`);
  }
  assert(mainJs.includes('scheduleAutodebug()'), '主进程应排上定时检测');
});

test('preload 暴露了检测接口，且放行了状态事件', () => {
  const p = fs.readFileSync(path.join(ROOT, 'src/preload.js'), 'utf8');
  for (const fn of ['autodebugRun', 'autodebugState', 'autodebugConfig', 'clearOrphans', 'clearSnapshot', 'restartRuntime']) {
    assert(p.includes(fn), `preload 应暴露 ${fn}`);
  }
  assert(p.includes("'autodebug:state'"), 'preload 应放行 autodebug:state 事件');
});

test('设置项里有自动检测的开关与按钮', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  for (const id of ['setAutodebugAuto', 'setAutodebugInterval', 'setAutodebugNotify', 'btnAutodebugRun', 'autodebugList']) {
    assert(html.includes(`id="${id}"`), `设置页应有 ${id}`);
  }
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
