'use strict';
/**
 * 启动尝试诊断隔离 / 最终 accel 预算一致性（纯 Node，不拉起 emulator/adb/Electron）。
 *
 * D1：每轮 attempt 的 lastDiagnosis 必须只来自本轮。基线在第二轮 fatal 时复用
 *     上一轮 UNKNOWN，导致本轮日志里的 `emulator exit 3221225477` 被短路。
 * D2：最终有效 accel=off 的计划必须消费软件模拟预算（≥600000），auto 保持 240000；
 *     驱动 forceTcg 把 auto 改成 off 后同样如此；进程退出/明确 fatal 仍立即失败。
 *
 * 这里走 EmulatorEngine.start() 的真实 attempt 决策路径：假时钟（虚拟 setTimeout/Date.now）、
 * 假进程、显式依赖桩（provisioner/AVD/spawn/adb/report/checkNetwork）。
 *
 * 外部进程面在 require 任何被测模块之前封闭：child_process 的每个执行入口都被替换成
 * 「记录 + 夹具或拦截」。GPU 发现给固定夹具；其余任何调用都会被记为 blocked 并让用例失败，
 * 即使被测目标自己 catch 掉异常。不依赖「PATH 上没有 adb」之类的环境巧合。
 *
 * 运行：node test/attempt-diagnosis-budget-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

// ---------------------------------------------------------------- 外部进程防线
// 必须在 require doctor/emulator 之前装好：doctor 解构 execFileSync，emulator 解构
// spawn/execFile；先 require 再装桩会把真实函数留在模块闭包里，隔离等于没做。
const CP_METHODS = ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'];
const cpOriginals = new Map();
const cpCalls = [];
let cpFixture = null;
let cpInstalled = false;

function installProcessGuard() {
  if (cpInstalled) return;
  cpInstalled = true;
  for (const name of CP_METHODS) {
    cpOriginals.set(name, childProcess[name]);
    childProcess[name] = function guardedChildProcess(...args) {
      const cmd = String(args[0] || '');
      const hit = cpFixture ? cpFixture(name, args) : null;
      cpCalls.push({ name, cmd, at: Date.now(), status: hit ? 'fixture' : 'blocked' });
      if (hit) {
        if (hit.error) throw hit.error;
        return hit.value;
      }
      const err = new Error(`外部进程调用被测试防线拦截：${name} ${cmd}`);
      err.code = 'AGENT_EXTERNAL_PROCESS_BLOCKED';
      throw err;
    };
  }
}

function restoreProcessGuard() {
  if (!cpInstalled) return;
  for (const [name, fn] of cpOriginals) childProcess[name] = fn;
  cpOriginals.clear();
  cpInstalled = false;
}

const guard = {
  reset() { cpCalls.length = 0; },
  blocked() { return cpCalls.filter((c) => c.status === 'blocked'); },
  fixtureCalls() { return cpCalls.filter((c) => c.status === 'fixture'); },
  calls: cpCalls,
};

installProcessGuard();
process.on('exit', restoreProcessGuard);
// 与本题无关的 GPU 发现：固定夹具，不启动 powershell/wmic。
cpFixture = (name, args) => {
  const cmd = String(args[0] || '').toLowerCase();
  if (name === 'execFileSync' && /powershell|wmic/.test(cmd)) {
    return { value: 'NVIDIA GeForce RTX 4060' };
  }
  return null;
};

const store = require('../src/core/store');
const doctor = require('../src/core/doctor');
const { EmulatorEngine } = require('../src/core/emulator');

const REAL = {
  autoProfile: doctor.autoProfile,
  planVariants: doctor.planVariants,
  writeReport: doctor.writeReport,
  freeDiskMB: doctor.freeDiskMB,
  freePortPair: doctor.freePortPair,
  freeAdbPort: doctor.freeAdbPort,
  getSettings: store.getSettings,
  saveSettings: store.saveSettings,
  dataDir: store.DATA_DIR,
};

let passed = 0;
let failed = 0;
// 用例结束统一核查外部进程记录：目标自己 catch 掉也逃不过。
async function runGuarded(fn, allowBlocked = 0) {
  guard.reset();
  try { await fn(); }
  catch (e) { return { ok: false, error: e }; }
  const blocked = guard.blocked();
  if (blocked.length > allowBlocked) {
    return {
      ok: false,
      blocked,
      error: new Error(`用例期间发生 ${blocked.length} 次未授权外部进程调用：`
        + blocked.map((c) => `${c.name} ${c.cmd}`).join('；')),
    };
  }
  return { ok: true, blocked };
}
async function test(name, fn, opts = {}) {
  const r = await runGuarded(fn, opts.allowBlocked || 0);
  if (r.ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}\n    ${r.error && (r.error.stack || r.error.message)}`); }
}

// ---------------------------------------------------------------- fake clock
function makeClock() {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const realSetImmediate = global.setImmediate;
  const realDateNow = Date.now;
  const clock = { now: 0, seq: 0, timers: new Map() };
  global.setTimeout = (fn, ms) => {
    const id = { id: ++clock.seq };
    clock.timers.set(id, { at: clock.now + Math.max(0, Number(ms) || 0), fn });
    return id;
  };
  global.clearTimeout = (id) => { if (id) clock.timers.delete(id); };
  Date.now = () => clock.now;
  clock.flush = () => new Promise((r) => realSetImmediate(r));
  clock.restore = () => {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    global.setImmediate = realSetImmediate;
    Date.now = realDateNow;
  };
  return clock;
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function baseProfile(over = {}) {
  return {
    memoryMB: 3072,
    cores: 4,
    heapMB: 384,
    dataMB: 6144,
    lcd: { w: 540, h: 960, dpi: 240 },
    gpu: 'host',
    gpuCandidates: ['host', 'swangle', 'software'],
    accel: 'auto',
    accelOk: true,
    port: 5554,
    adbPort: 5044,
    snapshot: true,
    lite: false,
    bootTimeoutMs: 240000,
    emulatorVersion: '37.3.8.0',
    host: {
      platform: 'win32', arch: 'x64', totalMB: 16384, freeMB: 12288, cores: 8,
      home: 'C:\\fake', homeAscii: true, tmp: os.tmpdir(), rdp: false,
    },
    ...over,
  };
}

function fakeProc(idx) {
  return {
    pid: 9000 + idx, killed: false,
    kill() { this.killed = true; },
    once() {}, removeListener() {},
  };
}

// 装桩：真实 start()/attempt 决策路径，但所有外部副作用换成显式桩。
function harness(script) {
  const clock = makeClock();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-attempt-'));
  doctor.autoProfile = () => clone(script.profile || baseProfile());
  doctor.planVariants = script.planVariants || REAL.planVariants;
  doctor.writeReport = () => ({ file: path.join(tmp, 'diagnostic.txt'), diagnosis: { code: 'UNKNOWN' } });
  doctor.freeDiskMB = () => 200000;
  doctor.freePortPair = async (p) => p;
  doctor.freeAdbPort = async (p) => p;
  store.getSettings = () => ({ engine: {}, display: {} });
  store.saveSettings = () => {};
  store.DATA_DIR = tmp;

  const e = new EmulatorEngine(path.join(tmp, 'root'));
  e.provisioner = {
    paths: () => ({ avdHome: tmp, root: tmp, emulatorExe: path.join(tmp, 'emulator.exe'), sysAbi: 'x86_64' }),
    emulatorAccel: async () => script.accel || { ok: true },
    emulatorVersion: async () => ({ version: '37.3.8.0' }),
    systemImageInfo: () => ({ ok: true, dir: tmp }),
    playImageInfo: () => ({ ok: false }),
    adbVersionPath: () => 'adb',
    invalidateEnvCache: () => {},
  };
  e.locate = () => ({ emulatorExe: path.join(tmp, 'emulator.exe'), sysImgDir: tmp, sysImgOk: true, root: tmp });
  e.imageChoice = () => ({ compat: false, api: 34, tag: 'default', dir: tmp, abi: 'x86_64' });
  e._resolveDrivers = () => script.drivers || { applied: [], skipped: [], errors: [], effect: null };
  e._driverEffect = (script.drivers && script.drivers.effect) || null;
  e.ensureAvd = () => ({ wipePending: false });
  e.killOrphanProcesses = async () => {};
  e._resetAdbServer = async () => true;
  e._logWrite = () => {};
  e._noteGpuFailure = () => {};
  e._persistFailure = () => {};
  // 与本题无关的网络体检：固定夹具，避免真实 adb shell / HTTP 探测。
  e.checkNetwork = async () => ({ ok: true, reason: '', fixture: true });
  e.killAttempt = async () => { e.proc = null; };

  let spawns = 0;
  e.spawnOnce = function spawnStub() {
    const i = spawns++;
    e.__idx = i;
    e.__attemptStart = Date.now();
    e.proc = fakeProc(i);
    if (script.spawn) script.spawn(e, i);
  };
  e._waitSpawnSettled = async () => {
    if (script.settled) return !!script.settled(e, e.__idx);
    return false;
  };

  const probe = async (p) => {
    if (!script.probe) return 'pending';
    return script.probe(e, e.__idx, Date.now() - e.__attemptStart, p);
  };

  return {
    clock, tmp, engine: e, probe,
    restore() {
      clock.restore();
      doctor.autoProfile = REAL.autoProfile;
      doctor.planVariants = REAL.planVariants;
      doctor.writeReport = REAL.writeReport;
      doctor.freeDiskMB = REAL.freeDiskMB;
      doctor.freePortPair = REAL.freePortPair;
      doctor.freeAdbPort = REAL.freeAdbPort;
      store.getSettings = REAL.getSettings;
      store.saveSettings = REAL.saveSettings;
      store.DATA_DIR = REAL.dataDir;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    },
  };
}

// 驱动虚拟时钟，直到 start() 的 Promise 落定。
async function runStart(h, script, opts = {}) {
  const e = h.engine;
  const p = e.start({
    onLog: () => {}, probe: h.probe, maxAttempts: script.maxAttempts || 4, ...opts,
  }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  let steps = 0;
  while (!settled) {
    if (++steps > 500000) throw new Error('fake clock: too many steps');
    await h.clock.flush();
    if (settled) break;
    for (let k = 0; k < 4 && !settled && !h.clock.timers.size; k += 1) await h.clock.flush();
    if (settled) break;
    if (!h.clock.timers.size) throw new Error('fake clock stalled before start() settled');
    let bestId = null;
    let best = null;
    for (const [id, t] of h.clock.timers) {
      if (!best || t.at < best.at) { best = t; bestId = id; }
    }
    h.clock.timers.delete(bestId);
    h.clock.now = Math.max(h.clock.now, best.at);
    best.fn();
  }
  return p;
}

(async () => {
  // ============================================================== 隔离
  console.log('\n[隔离 · 外部进程防线]');

  await test('防线先于模块加载安装；意外外部调用即使被目标 catch 也会让用例失败', async () => {
    // 反向控制 1：目标吞掉异常，包装器仍必须判失败（不能靠「没抛出来」过关）
    const swallowed = await runGuarded(async () => {
      try { childProcess.execFileSync('unexpected-tool.exe', ['--x']); } catch (_) { /* target swallows */ }
    }, 0);
    assert.equal(swallowed.ok, false, '被 catch 的外部调用必须被防线判成失败');
    assert.ok(/外部进程/.test(swallowed.error.message), '失败原因应指出来自外部进程防线');
    assert.equal(swallowed.blocked.length, 1);
    assert.equal(swallowed.blocked[0].name, 'execFileSync');

    // 反向控制 2：同一调用在显式配额下被记录并放行，证明红线来自记录核验而非异常本身
    const allowed = await runGuarded(async () => {
      try { childProcess.execFileSync('unexpected-tool.exe', ['--x']); } catch (_) {}
    }, 1);
    assert.equal(allowed.ok, true, allowed.ok ? '' : allowed.error.message);
    assert.equal(allowed.blocked.length, 1);

    // GPU 发现只走夹具：chooseProfile 的真实路径不得启动 powershell/wmic
    const gpu = await runGuarded(
      () => doctor.chooseProfile({ host: baseProfile().host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000 }),
      0,
    );
    assert.equal(gpu.ok, true, gpu.ok ? '' : gpu.error.message);
    assert.equal(guard.fixtureCalls().length, 1, 'GPU 夹具应恰好命中一次');
    assert.equal(guard.blocked().length, 0, 'GPU 发现不得触发未授权进程');
  });

  // ============================================================== D1
  console.log('\n[D1 · 每轮 attempt 诊断隔离]');

  await test('基线反例：前轮 UNKNOWN 超时 → 本轮 30s 崩溃（emulator exit 3221225477）应为本轮 ACCESS_VIOLATION', async () => {
    const h = harness({
      profile: baseProfile({ bootTimeoutMs: 90000 }),
      probe(e, i, elapsed) {
        if (i === 1 && elapsed >= 30000 && e.proc) {
          e.lastExitCode = 3221225477;
          e.log('emulator exit 3221225477（0xC0000005 访问冲突，渲染后端崩溃）');
          e.proc = null;
        }
        return 'pending';
      },
      spawn(e, i) {
        if (i === 1) e.log('emulator: starting (tcg off)');
      },
    });
    try {
      const out = await runStart(h, { maxAttempts: 2 });
      assert.equal(out.ok, false, '两次尝试都应失败');
      const a = h.engine.attempts;
      assert.equal(a.length, 2, `应保留 2 条历史 attempts，实际 ${a.length}`);
      assert.equal(a[0].diagnosis, 'UNKNOWN', `第 1 轮应为 UNKNOWN，实际 ${a[0].diagnosis}`);
      assert.equal(
        a[1].diagnosis, 'ACCESS_VIOLATION',
        `第 2 轮应按本轮日志判 ACCESS_VIOLATION，实际 ${a[1].diagnosis}（1=${a[0].diagnosis}）`,
      );
      assert.equal(a[1].exitCode, 3221225477, '本轮 exitCode 应为本轮退出码');
      assert.equal(a[0].diagnosis, 'UNKNOWN', '第 1 轮历史结论不得被后续轮改写');
      assert.equal(out.error.diagnosis.code, a[1].diagnosis, '最终诊断必须对应最后一轮');
    } finally { h.restore(); }
  });

  await test('前轮 ACCESS_VIOLATION 后本轮端口占用 → PORT_BUSY（不继承崩溃分类）', async () => {
    const h = harness({
      profile: baseProfile({ bootTimeoutMs: 90000 }),
      settled: (e, i) => i === 0,
      spawn(e, i) {
        if (i === 0) {
          e.lastExitCode = 3221225477;
          e.log('emulator exit 3221225477（0xC0000005 访问冲突，渲染后端崩溃）');
          e.proc = null;
        } else if (i === 1) {
          e.log('emulator: starting');
        }
      },
      probe(e, i, elapsed) {
        if (i === 1 && elapsed >= 30000 && e.proc) {
          e.log('Failed to bind console port 5556: Address already in use');
          e.lastExitCode = 1;
          e.proc = null;
        }
        return 'pending';
      },
    });
    try {
      const out = await runStart(h, { maxAttempts: 2 });
      assert.equal(out.ok, false, '两次尝试都应失败');
      const a = h.engine.attempts;
      assert.equal(a[0].diagnosis, 'ACCESS_VIOLATION', '第 1 轮应在 2200ms 内退出的路径上正确分类');
      assert.equal(a[1].diagnosis, 'PORT_BUSY', `第 2 轮应按本轮日志判 PORT_BUSY，实际 ${a[1].diagnosis}`);
    } finally { h.restore(); }
  });

  await test('本轮 45 秒后得到明确诊断并提前退出 → 保留本轮结论，不因重置丢失', async () => {
    const h = harness({
      profile: baseProfile({ bootTimeoutMs: 90000 }),
      spawn(e, i) { if (i === 1) e.log('emulator: starting'); },
      probe(e, i, elapsed) {
        if (i === 0) return 'pending';
        if (elapsed >= 50000) {
          if (e.proc) {
            e.log('emulator exit 3221225477（0xC0000005 访问冲突）');
            e.lastExitCode = 3221225477;
          }
          return 'pending';
        }
        return 'pending';
      },
    });
    try {
      const out = await runStart(h, { maxAttempts: 2 });
      assert.equal(out.ok, false);
      const a = h.engine.attempts;
      assert.equal(a[1].diagnosis, 'ACCESS_VIOLATION', `45s 后的本轮明确 fatal 诊断应保留，实际 ${a[1].diagnosis}`);
      assert.equal(a[1].timeout, false, '该轮应是 fatal 而不是 timeout');
    } finally { h.restore(); }
  });

  // ============================================================== D2
  console.log('\n[D2 · 最终有效 accel 的等待预算]');

  await test('planVariants：auto 档保持 240000；两个 off 回退档 ≥600000，且 wipe/snapshot 原合同不变', async () => {
    const p = baseProfile();
    const vs = REAL.planVariants(p);
    const autos = vs.filter((v) => v.accel === 'auto');
    const offs = vs.filter((v) => v.accel === 'off');
    assert.equal(autos.length, 2, `应有 2 个 auto 档，实际 ${autos.length}`);
    assert.equal(offs.length, 2, `应有 2 个 off 档，实际 ${offs.length}`);
    for (const v of autos) assert.equal(v.bootTimeoutMs, 240000, `auto 档预算应保持 240000，实际 ${v.bootTimeoutMs}`);
    for (const v of offs) {
      assert.ok(v.bootTimeoutMs >= 600000, `off 档预算应 ≥600000，实际 ${v.bootTimeoutMs}（${v.label}）`);
      assert.equal(v.wipe, false, 'off 档不得引入 wipe');
      assert.equal(v.snapshot, false, 'off 档应保持快照关闭');
    }
    const last = offs.find((v) => v.lastResort);
    assert.ok(last, '应保留保守冷启动档');
    assert.equal(last.memoryMB, 2048, '保守冷启动内存规则不变');
  });

  await test('planVariants：原本 off 更长预算 900000 保留；off 600000 不降回 240000', async () => {
    const long = REAL.planVariants(baseProfile({ accel: 'off', accelOk: false, bootTimeoutMs: 900000 }));
    for (const v of long) assert.equal(v.bootTimeoutMs, 900000, `应保留 900000，实际 ${v.bootTimeoutMs}`);
    const base = REAL.planVariants(baseProfile({ accel: 'off', accelOk: false, bootTimeoutMs: 600000 }));
    for (const v of base) assert.equal(v.bootTimeoutMs, 600000, `应为 600000，实际 ${v.bootTimeoutMs}`);
  });

  await test('chooseProfile：硬件加速 240000，无加速 600000', async () => {
    const on = doctor.chooseProfile({
      host: baseProfile().host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000,
    });
    const off = doctor.chooseProfile({
      host: baseProfile().host, accel: { ok: false }, emulatorVersion: '37.3.8.0', diskMB: 200000,
    });
    assert.equal(on.bootTimeoutMs, 240000, `硬件加速应 240000，实际 ${on.bootTimeoutMs}`);
    assert.equal(on.accel, 'auto');
    assert.equal(off.bootTimeoutMs, 600000, `软件模拟应 600000，实际 ${off.bootTimeoutMs}`);
    assert.equal(off.accel, 'off');
  });

  await test('真实等待处消费最终预算：驱动 forceTcg 把 auto 改 off 后，300 秒就绪不得在 240 秒截止', async () => {
    const h = harness({
      profile: baseProfile(),
      drivers: {
        applied: [{ id: 'tcg', name: 'tcg', version: '1' }], skipped: [], errors: [],
        effect: { forceTcg: true, notes: [] },
      },
      probe(e, i, elapsed) {
        return elapsed >= 300000 ? 'ok' : 'pending';
      },
    });
    try {
      const out = await runStart(h, { maxAttempts: 2 });
      assert.equal(out.ok, true, `off 档 300 秒就绪应成功，实际 ${out.ok ? '' : out.error.message}`);
      assert.ok(out.value.bootMs >= 300000 && out.value.bootMs < 302000, `bootMs 应约 300000，实际 ${out.value.bootMs}`);
      assert.equal(h.engine.attempts.length, 0, '应第一轮就成功');
    } finally { h.restore(); }
  });

  await test('真实等待处消费最终预算：初始 profile 即 off（无加速）时 300 秒就绪不超时（不经过 auto→off 回退）', async () => {
    const h = harness({
      profile: baseProfile({ accel: 'off', accelOk: false, bootTimeoutMs: 600000 }),
      probe(e, i, elapsed) { return elapsed >= 300000 ? 'ok' : 'pending'; },
    });
    try {
      const out = await runStart(h, { maxAttempts: 2 });
      assert.equal(out.ok, true, `off 计划 300 秒就绪应成功，实际 ${out.ok ? '' : out.error.message}`);
      assert.ok(out.value.bootMs >= 300000 && out.value.bootMs < 302000, `bootMs 应约 300000，实际 ${out.value.bootMs}`);
    } finally { h.restore(); }
  });

  await test('进程 10 秒退出/明确 fatal → 立即失败，不空等软件模拟预算', async () => {
    const h = harness({
      profile: baseProfile(),
      drivers: {
        applied: [{ id: 'tcg', name: 'tcg', version: '1' }], skipped: [], errors: [],
        effect: { forceTcg: true, notes: [] },
      },
      spawn(e, i) { e.log(`emulator: starting ${i}`); },
      probe(e, i, elapsed) {
        if (elapsed >= 10000 && e.proc) {
          e.log('emulator exit 3221225477（0xC0000005 访问冲突）');
          e.lastExitCode = 3221225477;
          e.proc = null;
        }
        return 'pending';
      },
    });
    try {
      const out = await runStart(h, { maxAttempts: 4 });
      assert.equal(out.ok, false, '4 轮 10 秒退出都应失败');
      assert.equal(h.engine.attempts.length, 4, `应尝试 4 轮，实际 ${h.engine.attempts.length}`);
      assert.ok(h.clock.now < 60000, `不应空等到预算，实际假时钟 ${h.clock.now}ms`);
      for (const a of h.engine.attempts) {
        assert.equal(a.timeout, false, '每轮都应是 fatal 而非 timeout');
        assert.equal(a.diagnosis, 'ACCESS_VIOLATION');
      }
    } finally { h.restore(); }
  });

  restoreProcessGuard();
  console.log(`\n通过 ${passed}，失败 ${failed}`);
  process.exit(failed ? 1 : 0);
})();
