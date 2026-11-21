'use strict';
/**
 * 独立窗口布局入口的**行为**回归（issue #99 的后续接线门）。
 *
 * 现有 test/display-scale-test.js 的“接线”部分只读源码字符串：把
 * _physical() 换成语法有效的空操作（if (false) physicalRect(...); return rect）
 * 仍会全绿。本测试完整加载 src/core/appwin.js，在 require 之前注入假的
 * Electron screen/BrowserWindow/nativeImage、agent 与 store/pointer，然后执行真实的
 * openDetached / toggleMaximize / openDetachedLayoutOnly，断言 fake agent.layout
 * 收到的具体数值。
 *
 * 隔离：不创建真实 Electron 窗口/nativeImage，不启动窗口代理、模拟器、PowerShell、
 * 子进程、GUI、网络，也不做真实文件写入。所有 setTimeout 由虚拟时钟立即结算并
 * 限制在 5 秒内；任何未预期的依赖访问、进程/网络/写盘调用都会记录并让测试失败。
 *
 * 运行：node test/appwin-layout-behavior-test.js
 */
const assert = require('assert/strict');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

const APPWIN_PATH = path.join(__dirname, '..', 'src', 'core', 'appwin.js');

const env = {
  violations: [],
  appwinRequests: [],
  timers: [],
  agentCalls: [],
  layoutCalls: [],
  probeCalls: 0,
  electronCalls: [],
  display: null,
  // 竖屏设备面板固定 9:16；_panelRatio() 读壳窗口 bounds，这里给它一个稳定的
  // 面板尺寸夹具，避免依赖 open() 算出的壳窗口宽高（那会改变 0.5625 这个比例）。
  panelBounds: { x: 0, y: 0, width: 540, height: 960 },
  probeRect: null,
};

const restores = [];

/** 已知属性放行，未知属性记录为违规并返回会抛错的桩。 */
function guarded(target, label) {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop, receiver);
      if (prop in t) {
        const v = Reflect.get(t, prop, receiver);
        return typeof v === 'function' ? v.bind(t) : v;
      }
      env.violations.push(`${label}.${String(prop)}`);
      return () => {
        env.violations.push(`${label}.${String(prop)}()`);
        throw new Error(`unanticipated ${label}.${String(prop)}`);
      };
    },
  });
}

const screenFake = guarded({
  getCursorScreenPoint: () => ({
    x: env.display.workArea.x + 1,
    y: env.display.workArea.y + 1,
  }),
  getDisplayNearestPoint: () => env.display,
  getDisplayMatching: () => env.display,
}, 'screen');

const nativeImageFake = guarded({
  createFromPath(p) {
    env.electronCalls.push(`nativeImage.createFromPath(${p})`);
    return {};
  },
}, 'nativeImage');

class FakeBrowserWindow extends EventEmitter {
  constructor(opts) {
    super();
    this._opts = opts;
    this._destroyed = false;
    this.webContents = guarded({
      on() {},
      send(channel) { env.electronCalls.push(`webContents.send(${channel})`); },
    }, 'webContents');
    env.electronCalls.push('BrowserWindow');
    return guarded(this, 'BrowserWindow');
  }

  loadFile() {}
  getBounds() { return { ...env.panelBounds }; }
  getContentBounds() { return { ...env.panelBounds }; }
  hide() {}
  show() {}
  focus() {}
  moveTop() {}
  setTitle() {}
  isDestroyed() { return this._destroyed; }
  isMaximized() { return false; }
  maximize() { env.violations.push('BrowserWindow.maximize'); }
  unmaximize() {}
  minimize() {}
  destroy() {
    this._destroyed = true;
    this.emit('closed');
  }
}

const electronFake = { BrowserWindow: FakeBrowserWindow, screen: screenFake, nativeImage: nativeImageFake };

function makeAgent() {
  const target = {
    detach(keep) {
      env.agentCalls.push(['detach', keep]);
      return Promise.resolve({ ok: true });
    },
    setTitle(title) {
      env.agentCalls.push(['setTitle', title]);
      return Promise.resolve({ ok: true });
    },
    setIcon(p) {
      env.agentCalls.push(['setIcon', p]);
      return Promise.resolve({ ok: true });
    },
    show() {
      env.agentCalls.push(['show']);
      return Promise.resolve({ ok: true });
    },
    layout(rect) {
      env.layoutCalls.push({ ...rect });
      return Promise.resolve({ ok: true });
    },
    probe() {
      env.probeCalls += 1;
      return Promise.resolve(env.probeRect ? { ...env.probeRect } : null);
    },
    hide() { return Promise.resolve({ ok: true }); },
    park() { return Promise.resolve({ ok: true }); },
    fit() { return Promise.resolve({ ok: true }); },
    embed() { return Promise.resolve({ ok: true }); },
    setHook() { return Promise.resolve({ ok: true }); },
  };
  return guarded(target, 'agent');
}

function installInterceptors() {
  // --- appwin 的依赖：electron / pointer / store 在加载前替换 ---
  const origLoad = Module._load;
  const ALLOWED = new Set(['electron', 'fs', 'path', './pointer', './store', './geometry']);
  Module._load = function patchedLoad(request, parent, isMain) {
    const parentFile = parent && parent.filename ? path.resolve(parent.filename) : '';
    if (parentFile === path.resolve(APPWIN_PATH)) {
      env.appwinRequests.push(request);
      if (request === 'electron') return electronFake;
      if (request === './pointer') {
        return { hookOptions: () => ({ enabled: false, rightBack: false, wheel: 'off', side: false }) };
      }
      if (request === './store') {
        return { getSettings: () => ({ engine: { priorityMode: 'performance' } }) };
      }
      if (!ALLOWED.has(request)) {
        env.violations.push(`require(${request})`);
        throw new Error(`unanticipated require(${request}) from appwin`);
      }
    }
    return origLoad.call(this, request, parent, isMain);
  };
  restores.push(() => { Module._load = origLoad; });

  // --- 子进程 ---
  const cp = require('child_process');
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const orig = cp[name];
    if (typeof orig !== 'function') continue;
    cp[name] = (...args) => {
      env.violations.push(`child_process.${name}(${String(args[0])})`);
      throw new Error(`blocked child_process.${name}`);
    };
    restores.push(() => { cp[name] = orig; });
  }

  // --- 真实写盘 ---
  const fs = require('fs');
  for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync',
    'unlinkSync', 'renameSync', 'copyFileSync', 'chmodSync', 'writeFile', 'appendFile',
    'createWriteStream', 'openSync']) {
    const orig = fs[name];
    if (typeof orig !== 'function') continue;
    fs[name] = (...args) => {
      env.violations.push(`fs.${name}(${String(args[0])})`);
      throw new Error(`blocked fs.${name}`);
    };
    restores.push(() => { fs[name] = orig; });
  }

  // --- 网络 ---
  for (const modName of ['http', 'https']) {
    const mod = require(modName);
    for (const name of ['request', 'get']) {
      const orig = mod[name];
      if (typeof orig !== 'function') continue;
      mod[name] = (...args) => {
        env.violations.push(`${modName}.${name}(${String(args[0])})`);
        throw new Error(`blocked ${modName}.${name}`);
      };
      restores.push(() => { mod[name] = orig; });
    }
  }
  const net = require('net');
  for (const name of ['connect', 'createConnection']) {
    const orig = net[name];
    if (typeof orig !== 'function') continue;
    net[name] = (...args) => {
      env.violations.push(`net.${name}(${String(args[0])})`);
      throw new Error(`blocked net.${name}`);
    };
    restores.push(() => { net[name] = orig; });
  }
  const tls = require('tls');
  const tlsConnect = tls.connect;
  tls.connect = (...args) => {
    env.violations.push(`tls.connect(${String(args[0])})`);
    throw new Error('blocked tls.connect');
  };
  restores.push(() => { tls.connect = tlsConnect; });

  const fetchOrig = globalThis.fetch;
  globalThis.fetch = (...args) => {
    env.violations.push(`fetch(${String(args[0])})`);
    throw new Error('blocked fetch');
  };
  restores.push(() => { globalThis.fetch = fetchOrig; });

  // --- 虚拟时钟：setTimeout 立即结算，上限 5 秒；禁止 interval ---
  const setTimeoutOrig = global.setTimeout;
  const clearTimeoutOrig = global.clearTimeout;
  const setIntervalOrig = global.setInterval;
  global.setTimeout = (fn, ms) => {
    const delay = Number(ms) || 0;
    env.timers.push(delay);
    if (!Number.isFinite(delay) || delay < 0 || delay > 5000) {
      env.violations.push(`setTimeout(${delay})`);
      throw new Error(`unbounded timer ${delay}`);
    }
    queueMicrotask(fn);
    return 0;
  };
  global.clearTimeout = () => {};
  global.setInterval = (...args) => {
    env.violations.push(`setInterval(${String(args[1])})`);
    throw new Error('blocked setInterval');
  };
  restores.push(() => {
    global.setTimeout = setTimeoutOrig;
    global.clearTimeout = clearTimeoutOrig;
    global.setInterval = setIntervalOrig;
  });
}

function restoreInterceptors() {
  while (restores.length) restores.pop()();
}

function setDisplay(x, y, w, h, sf) {
  env.display = {
    bounds: { x, y, width: w, height: h },
    workArea: { x, y, width: w, height: h },
    scaleFactor: sf,
  };
}

let AppWindow = null;

function newApp(agent) {
  return new AppWindow({ agent, setOrientation: async () => true, mouseHook: false });
}

async function openDetachedApp(agent) {
  const app = newApp(agent);
  app.open({
    pkg: 'test.pkg',
    label: 'Test',
    iconPath: '',
    portrait: { w: 540, h: 960 },
    fullscreen: false,
    detached: true,
  });
  return app;
}

let passed = 0;
let failed = 0;

async function scenario(name, fn) {
  env.layoutCalls = [];
  env.agentCalls = [];
  env.probeCalls = 0;
  env.timers = [];
  env.probeRect = null;
  try {
    await fn();
    passed += 1;
    const saw = env.layoutCalls.map((r) => `(${r.x},${r.y},${r.w},${r.h})`).join(' ');
    console.log(`  ✓ ${name}  layout=${saw}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

// 期望值独立推导，不调用生产 physicalRect：
// 竖屏面板 9:16 → _panelRatio() = 540/960 = 0.5625。
// 非全屏：maxH=min(h-140,1000)，maxW=min(w-80,1280)，先按 maxW 取 w 再按比例回夹。
// 全屏：fitW=min(area.w, round(area.h*ratio))。
// 所有 DIP→物理换算手算 Math.round；sf=1 原样。
const CASES = [
  {
    label: 'openDetached sf=1',
    display: [0, 0, 1920, 1080, 1],
    // DIP: w=round(940*0.5625)=529, h=940, x=round((1920-529)/2)=696, y=60
    expected: { x: 696, y: 60, w: 529, h: 940 },
  },
  {
    label: 'openDetached sf=1.25（非 1 比例独立计算）',
    display: [0, 0, 1920, 1080, 1.25],
    // 696*1.25=870, 60*1.25=75, 529*1.25=661.25→661, 940*1.25=1175
    expected: { x: 870, y: 75, w: 661, h: 1175 },
  },
  {
    label: 'openDetached sf=1.5（1920×1080 夹具算例）',
    display: [0, 0, 1920, 1080, 1.5],
    // 696*1.5=1044, 60*1.5=90, 529*1.5=793.5→794, 940*1.5=1410
    expected: { x: 1044, y: 90, w: 794, h: 1410 },
  },
  {
    label: 'openDetached 非零/负屏幕原点 sf=1.25',
    display: [-1280, -200, 1920, 1080, 1.25],
    // DIP x=-1280+695.5=-584.5→-584, y=-200+60=-140；物理 -584*1.25=-730, -140*1.25=-175
    expected: { x: -730, y: -175, w: 661, h: 1175 },
  },
];

(async () => {
  installInterceptors();
  let exitCode = 0;
  const lateErrors = [];
  process.on('unhandledRejection', (e) => {
    lateErrors.push(e);
    console.error('  ✗ unhandledRejection:', (e && e.stack) || e);
  });

  try {
    delete require.cache[require.resolve(APPWIN_PATH)];
    // eslint-disable-next-line global-require
    const appwin = require(APPWIN_PATH);
    AppWindow = appwin.AppWindow;
    if (typeof AppWindow !== 'function') throw new Error('appwin.js did not export AppWindow');

    console.log('\n[AppWindow 实际布局实参 · 行为测试]');

    for (const c of CASES) {
      await scenario(c.label, async () => {
        setDisplay(...c.display);
        const agent = makeAgent();
        const app = await openDetachedApp(agent);
        const ok = await app.openDetached();
        assert.equal(ok, true, 'openDetached 应成功（fake agent 全部返回 ok）');
        assert.equal(env.layoutCalls.length, 1, 'openDetached 应恰好调用一次 agent.layout');
        assert.deepEqual(env.layoutCalls[0], c.expected, 'agent.layout 的物理矩形不符');
        assert.ok(env.timers.every((ms) => Number.isFinite(ms) && ms >= 0 && ms <= 5000),
          `定时器越界：${env.timers.join(',')}`);
      });
    }

    await scenario('toggleMaximize 进入独立全屏 sf=1.5', async () => {
      setDisplay(0, 0, 1920, 1200, 1.5);
      const agent = makeAgent();
      const app = await openDetachedApp(agent);
      await app.toggleMaximize();
      assert.equal(env.probeCalls, 1, '进入全屏前应探测一次当前窗口矩形');
      assert.equal(app._detachedFullscreen, true);
      assert.equal(env.layoutCalls.length, 1, '进入全屏应恰好一次 agent.layout');
      // 面板比 0.5625：fitW=min(1920, round(1200*0.5625)=675)=675,
      // fitH=round(675/0.5625)=1200, x=round(622.5)=623, y=0；
      // 物理 623*1.5=934.5→935, 675*1.5=1012.5→1013, 1200*1.5=1800
      assert.deepEqual(env.layoutCalls[0], { x: 935, y: 0, w: 1013, h: 1800 },
        '进入全屏的 agent.layout 物理矩形不符');
    });

    await scenario('toggleMaximize 从 probe 已物理矩形还原（不重复缩放）', async () => {
      setDisplay(0, 0, 1920, 1200, 1.5);
      // probe 返回的是窗口代理已经换算好的物理像素；还原必须原样送回。
      env.probeRect = { x: 100, y: 120, w: 1000, h: 1600 };
      const agent = makeAgent();
      const app = await openDetachedApp(agent);
      await app.toggleMaximize(); // 进入全屏，记下 probe 矩形
      await app.toggleMaximize(); // 还原
      assert.equal(env.layoutCalls.length, 2);
      assert.deepEqual(env.layoutCalls[1], { x: 100, y: 120, w: 1000, h: 1600 },
        'probe 的物理矩形被重复缩放或改写');
      assert.equal(app._preFullscreenRect, null);
    });

    await scenario('openDetachedLayoutOnly sf=1.25', async () => {
      setDisplay(100, 50, 1600, 1000, 1.25);
      const agent = makeAgent();
      const app = await openDetachedApp(agent);
      // maxH=min(1000-140,1000)=860, maxW=min(1600-80,1280)=1280；
      // w=round(860*0.5625)=484, h=860, x=round(100+558)=658, y=110；
      // 物理 658*1.25=822.5→823, 110*1.25=137.5→138, 484*1.25=605, 860*1.25=1075
      await app.openDetachedLayoutOnly({ x: 100, y: 50, w: 1600, h: 1000, sf: 1.25 });
      assert.equal(env.layoutCalls.length, 1);
      assert.deepEqual(env.layoutCalls[0], { x: 823, y: 138, w: 605, h: 1075 },
        'openDetachedLayoutOnly 的物理矩形不符');
    });

    // 让晚到的 rejection 有机会先被记录。
    await new Promise((resolve) => setImmediate(resolve));

    if (lateErrors.length) {
      failed += 1;
      console.error(`  ✗ 晚到错误：${lateErrors.length} 个 unhandledRejection`);
    }

    if (env.violations.length) {
      failed += 1;
      console.error(`  ✗ 隔离：未预期的调用 ${env.violations.join(', ')}`);
    } else {
      const reqs = [...new Set(env.appwinRequests)].sort().join(', ');
      console.log(`  ✓ 隔离：无未预期依赖/进程/写盘/网络调用（appwin requires: ${reqs}）`);
    }

    console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
    exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('\n测试装载/执行失败：', (e && e.stack) || e);
    exitCode = 1;
  } finally {
    restoreInterceptors();
  }
  process.exit(exitCode);
})();
