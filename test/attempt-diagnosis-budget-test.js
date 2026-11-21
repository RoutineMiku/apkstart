'use strict';
/**
 * 启动尝试诊断隔离 / 最终 accel 预算一致性（纯 Node，不拉起 emulator/adb/Electron）。
 *
 * D1：每轮 attempt 的 lastDiagnosis 必须只来自本轮。基线在第二轮 fatal 时复用
 *     上一轮 UNKNOWN，导致本轮日志里的 `emulator exit 3221225477` 被短路。
 * 这里走 EmulatorEngine.start() 的真实 attempt 决策路径：假时钟（虚拟 setTimeout/Date.now）、
 * 假进程、显式依赖桩（provisioner/AVD/spawn/adb/report），不产生真实副作用。
 *
 * 运行：node test/attempt-diagnosis-budget-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e && (e.stack || e.message)}`); }
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

  console.log(`\n通过 ${passed}，失败 ${failed}`);
  process.exit(failed ? 1 : 0);
})();
