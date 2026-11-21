'use strict';
/**
 * 设置页 UI 冒烟测试（需要真实 Electron 窗口）
 *
 * 运行：electron test/settings-ui-test.js
 * 输出：test/out/settings-*.png
 *
 * 为什么单独写：设置页的结构刚大改过（加了分类导航与搜索），
 * 纯 Node 单测只能校验源码结构，校验不了「点得动、显示得对」。
 * 这里用真实渲染进程跑一遍：打开设置 → 切分类 → 搜索 → 截图。
 */

const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const UI = path.join(__dirname, '..', 'src', 'ui');

const SETTINGS = {
  adbPath: '',
  runtime: { isoPath: '', sourcePreference: 'auto', autoMirror: true, giteeToken: '', mirrorPrefix: '', downloadConnections: 8 },
  engine: {
    memoryMB: 4096, cores: 4, idleShutdownMinutes: 15, audio: true, liteMode: true,
    prewarm: true, priorityMode: 'balanced', deepTrim: false, mouseRightBack: true,
    mouseWheelMode: 'smooth', mouseSideButtons: false, keymapEnabled: true,
    resourceMode: 'balanced', renderSize: 'auto', dataPartitionGB: 6, fastDns: true,
    locale: 'zh-CN', chineseIme: true, keepSnapshot: true, logLimitKB: 2048,
  },
  display: {
    mode: 'window', portrait: '900x1600', autoFullscreenOnLaunch: false, landscape: false,
    orientationMode: 'auto', autoRotate: true, tabletMode: true, windowEmbed: true,
  },
  createShortcutOnInstall: true,
  createStartMenuShortcut: true,
  shortcutDir: '',
  sharedDir: path.join(process.env.USERPROFILE || '', 'ApkStartShared'),
  deviceSharedDir: '/sdcard/ApkStartShared',
  autoStart: true,
  notifyOnInstall: true,
  debug: { auto: true, intervalMin: 10, notify: true },
};

const DEBUG_ISSUES = [
  { code: 'device.unauthorized', category: 'device', severity: 'error', title: '安卓设备未授权调试', hint: '重启运行时后会重新弹出确认框。', fix: 'restartRuntime', detail: '' },
  { code: 'storage.diskLow', category: 'storage', severity: 'warn', title: '运行时所在磁盘空间偏紧', hint: '剩余不足 8 GB。', fix: 'disk', detail: '剩余 5120 MB' },
  { code: 'settings.orientationConflict', category: 'settings', severity: 'warn', title: '屏幕方向策略与当前面板方向相反', hint: '把面板方向改成与策略一致即可。', fix: 'orientation', detail: '' },
];

const OVERRIDES = {
  'settings:get': () => SETTINGS,
  'settings:set': () => SETTINGS,
  'app:info': () => ({ version: '0.6.0', isDev: true, dataDir: 'C:\\data', runtimeDir: 'C:\\data\\runtime' }),
  'apps:list': () => ({ apps: [] }),
  'assoc:status': () => ({ registered: false }),
  'doctor:profile': () => ({ profile: {}, text: '均衡 · 4 核 / 4 GB / 720p' }),
  'doctor:selfCheck': () => ({ issues: [], accel: { ok: true }, free: 102400 }),
  'doctor:report': () => ({ ok: true, file: 'C:\\report.txt' }),
  'runtime:usage': () => ({ totalText: '8.2 GB', reclaimableText: '1.1 GB', count: 3 }),
  'runtime:status': () => ({ mode: 'builtin', backend: 'builtin', backendLabel: '内置', installed: true, vmRunning: false, deviceOnline: false, ready: false, phase: 'idle', needsSetup: null, error: '', env: { adb: { ok: true }, emulator: { ok: true }, sysimg: { ok: true } }, accel: { ok: true }, network: null }),
  'runtime:dataInfo': () => ({ avdDir: 'C:\\data\\avd', configuredGB: 6, actualGB: 6 }),
  'android:status': () => ({ running: false, wifi: true, airplane: false, anim: true, volume: 50, font: 1, density: 320 }),
  'drivers:list': () => ({ drivers: [], errors: [] }),
  'preflight:run': () => ({ items: [] }),
  'autodebug:state': () => ({ issues: DEBUG_ISSUES, summary: { total: 3, errors: 1, warns: 2, infos: 0, health: 'error', byCategory: [] }, at: Date.now(), running: false }),
  'autodebug:run': () => ({ issues: DEBUG_ISSUES, summary: { total: 3, errors: 1, warns: 2, infos: 0, health: 'error', byCategory: [] }, at: Date.now(), running: false }),
  'autodebug:config': () => SETTINGS.debug,
  'app:startupInfo': () => ({ firstRun: false, tips: [] }),
  'app:updateCheck': () => ({ ok: true, current: '0.6.0', hasUpdate: false, sources: [] }),
  'runtime:log': () => [],
  'leftovers:scan': () => ({ items: [] }),
  'engine:resources': () => ({ memory: {}, cores: {} }),
  'display:state': () => ({ mode: 'window' }),
  'keymap:getPresets': () => ({ presets: [] }),
  'keymap:isEnabled': () => ({ enabled: true }),
};

// 其余通道统一返回空对象：app.js 里所有调用都有 .catch / 空值兜底
const CHANNELS = [
  'apk:pick', 'apk:parse', 'apk:install', 'apk:reveal', 'dialog:openDir',
  'settings:restoreSystem', 'settings:refreshPointer', 'settings:unhook', 'settings:setSharedDir',
  'runtime:probe', 'runtime:start', 'runtime:stop', 'runtime:vcRedist', 'runtime:installVcRedist',
  'runtime:cleanup', 'runtime:resetData', 'runtime:repairNetwork', 'runtime:checkNetwork',
  'runtime:setDataSize', 'runtime:resetAndResize', 'runtime:autoDeploy', 'runtime:startInstaller',
  'runtime:markInstalled', 'runtime:resetInstall', 'app:confirm', 'display:set', 'display:toggle',
  'shortcut:rebuild', 'preflight:apply', 'drivers:import', 'drivers:openFolder',
  'drivers:exportTemplate', 'drivers:setEnabled', 'app:clearLocks', 'app:removeSelf',
  'app:clearOrphans', 'app:clearSnapshot', 'runtime:restart', 'assoc:register', 'assoc:unregister',
  'share:sync', 'share:open', 'shell:open', 'window:minimize', 'window:maximize', 'window:close',
  'window:hide', 'app:foreground', 'app:updateApply', 'app:updateCancel', 'app:updateOpen',
  'app:restart', 'app:pin', 'app:setOrientation', 'app:launch', 'app:stop', 'app:uninstall',
  'app:createShortcut', 'app:clearData', 'app:revealApk', 'android:set', 'android:open',
  'android:tune', 'android:permissions', 'android:grantAll', 'keymap:getMap', 'keymap:setMap',
  'keymap:setEnabled', 'keymap:applyPreset', 'leftovers:clean', 'provision:check',
  'provision:probeSources', 'provision:installAdb', 'provision:installQemu', 'provision:installEmulator',
  'provision:installSysimg', 'provision:installPlayImage', 'provision:installAehd',
  'provision:enableAccel', 'provision:enableVirtualization', 'provision:openWindowsFeatures',
  'provision:downloadIso', 'provision:createDisk', 'provision:importIso', 'provision:importDisk',
];

let passed = 0;
let failed = 0;
function step(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}${detail ? ` ${detail}` : ''}`); } else { failed++; console.error(`  ✗ ${name}${detail ? ` ${detail}` : ''}`); }
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  for (const ch of CHANNELS) ipcMain.handle(ch, async () => ({}));
  for (const [ch, fn] of Object.entries(OVERRIDES)) ipcMain.handle(ch, async (_e, ...args) => fn(...args));

  const win = new BrowserWindow({
    width: 1180, height: 860, show: false,
    backgroundColor: '#f4f7f5',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);   // 2=warning, 3=error
  });
  await win.loadFile(path.join(UI, 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  const evalJs = (code) => win.webContents.executeJavaScript(code, true);

  console.log('\n[设置页 · 分类导航]');
  // 先打开设置弹窗（自动检测结果是在打开设置时取回来渲染的）
  await evalJs(`document.getElementById('btnSettings').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const modalOpen = await evalJs(`document.getElementById('settingsMask').classList.contains('on')`);
  step('设置弹窗能打开', modalOpen);

  const navInfo = await evalJs(`(() => ({
    items: document.querySelectorAll('#setNav .set-nav-item').length,
    cats: Array.from(document.querySelectorAll('#setNav .set-nav-item')).map(b => b.dataset.cat),
    groups: document.querySelectorAll('#settingsBody [data-cat]').length,
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat),
  }))()`);
  step('导航项渲染出来了', navInfo.items === 9, `${navInfo.items} 项`);
  step('有实验室分类', navInfo.cats.indexOf('lab') >= 0, navInfo.cats.join(','));
  // 注意：分类会被记住（localStorage），所以这里只断言「同一时刻只显示一个分类的分组」
  const oneCat = navInfo.visible.length > 0 && navInfo.visible.every((c) => c === navInfo.visible[0]);
  step('同一时刻只显示一个分类的分组', oneCat, `默认可见：${navInfo.visible.join(',')}`);

  // 点「显示与窗口」
  await evalJs(`document.querySelector('#setNav .set-nav-item[data-cat="display"]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const afterSwitch = await evalJs(`(() => ({
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat),
    on: document.querySelector('#setNav .set-nav-item.on') ? document.querySelector('#setNav .set-nav-item.on').dataset.cat : '',
  }))()`);
  step('切到「显示与窗口」后只显示该分类', afterSwitch.visible.length > 0 && afterSwitch.visible.every((c) => c === 'display'), `可见：${afterSwitch.visible.join(',')}`);
  step('导航高亮跟着切换', afterSwitch.on === 'display', `高亮：${afterSwitch.on}`);

  await win.capturePage().then((img) => fs.writeFileSync(path.join(OUT, 'settings-display.png'), img.toPNG()));

  // 点「实验室」，看多开开关
  await evalJs(`document.querySelector('#setNav .set-nav-item[data-cat="lab"]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const lab = await evalJs(`(() => ({
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat),
    hasSwitch: !!document.getElementById('setMultiWindow'),
    hasKeep: !!document.getElementById('setKeepBackground'),
    notice: (document.querySelector('#labGroup .lab-notice') || {}).textContent || '',
  }))()`);
  step('切到「实验室」只显示该分类', lab.visible.length > 0 && lab.visible.every((c) => c === 'lab'), `可见：${lab.visible.join(',')}`);
  step('实验室有多开开关与后台保留数', lab.hasSwitch && lab.hasKeep, `switch=${lab.hasSwitch} keep=${lab.hasKeep}`);
  step('实验室有实验性提示', /实验/.test(lab.notice), lab.notice.slice(0, 30));

  // 点「诊断与修复」，看自动检测面板
  await evalJs(`document.querySelector('#setNav .set-nav-item[data-cat="diag"]').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const diag = await evalJs(`(() => ({
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat),
    items: document.querySelectorAll('#autodebugList .dbg-item').length,
    groups: document.querySelectorAll('#autodebugList .dbg-group').length,
    text: (document.getElementById('autodebugStateText') || {}).textContent || '',
    fixBtns: document.querySelectorAll('#autodebugList .dbg-fix').length,
  }))()`);
  step('「诊断与修复」下能看到本机体检、驱动与自动检测', diag.visible.includes('diag') && diag.visible.length === 3, `可见：${diag.visible.join(',')}`);
  step('自动检测结果按分类分组渲染', diag.groups >= 3 && diag.items === 3, `${diag.groups} 组 / ${diag.items} 项`);
  step('每条问题都有「处理」按钮', diag.fixBtns === 3, `${diag.fixBtns} 个按钮`);
  step('状态行显示上次检测时间', /上次检测/.test(diag.text), diag.text);

  // 滚到自动检测面板再截图（等合成器跟上，避免拍到上一帧）
  await evalJs(`document.getElementById('autodebugGroup').scrollIntoView({ block: 'start' })`);
  await new Promise((r) => setTimeout(r, 900));
  await win.capturePage().then((img) => fs.writeFileSync(path.join(OUT, 'settings-diag.png'), img.toPNG()));

  console.log('\n[设置页 · 搜索]');
  await evalJs(`(() => { const s = document.getElementById('setSearch'); s.value = '横屏'; s.dispatchEvent(new Event('input')); })()`);
  await new Promise((r) => setTimeout(r, 300));
  const search = await evalJs(`(() => ({
    visible: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).length,
    names: Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => (g.querySelector('.group-title')||{}).textContent),
    clearVisible: !document.getElementById('btnClearSearch').hidden,
  }))()`);
  step('搜索「横屏」能命中分组', search.visible >= 1, `命中 ${search.visible} 个：${search.names.join(' / ')}`);
  step('命中项跨分类可见（不会被当前分类挡住）', search.visible >= 1);
  step('清除按钮出现', search.clearVisible);

  await win.capturePage().then((img) => fs.writeFileSync(path.join(OUT, 'settings-search.png'), img.toPNG()));

  await evalJs(`document.getElementById('btnClearSearch').click()`);
  await new Promise((r) => setTimeout(r, 250));
  const afterClear = await evalJs(`(() => Array.from(document.querySelectorAll('#settingsBody [data-cat]')).filter(g => !g.hidden).map(g => g.dataset.cat))()`);
  step('清除搜索后回到当前分类', afterClear.length > 0 && afterClear.every((c) => c === 'diag'), `可见：${afterClear.join(',')}`);

  console.log('\n[设置页 · 记忆分类]');
  const remembered = await evalJs(`localStorage.getItem('apkstart.settings.cat')`);
  step('上次停留的分类被记住了', remembered === 'diag', `记住了：${remembered}`);

  console.log('\n[设置页 · 渲染无异常]');
  const realErrors = errors.filter((e) => !/Autofill|devtools|Request Autofill/i.test(e));
  step('控制台没有报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
