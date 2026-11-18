'use strict';
/**
 * 自动检测 · 采集层（只在主进程跑）
 *
 * 职责：把机器的真实状态采成一份**纯数据**快照 obs，交给 src/core/autodebug.js 判定。
 * 采集层允许失败 —— 拿不到就留空，让判定层「不知道」，绝不编造结论。
 *
 * 采集项与耗时预算（一次全量约 2~5 秒）：
 *   - 运行时状态（引擎 status：环境 + adb 在线）
 *   - adb 设备授权状态
 *   - 磁盘余量、数据分区容量、共享目录可写性
 *   - AVD 残留锁、快照空壳、孤儿模拟器进程
 *   - 最近日志里的错误行
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { AVD_NAME, SNAPSHOT_NAME } = require('./emulator');

/** 引导阶段计时：第一次看到「在跑但没 ready」的时刻 */
let bootingSince = 0;

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { setTimeout(() => resolve(fallback), ms); }),
  ]);
}

/** 数 AVD 目录里残留的 .lock（文件或目录都算） */
function countLocks(avdDir) {
  try {
    return fs.readdirSync(avdDir).filter((f) => /\.lock$/i.test(f)).length;
  } catch (_) {
    return 0;
  }
}

/**
 * 快照是不是「空壳」：snapshot.pb 在但内存镜像没了或太小。
 * 这种快照每次开机都要「加载失败再冷启动」，等于白占几 GB 磁盘。
 * 只读判断，不在这里删 —— 删除交给用户确认或修复动作。
 */
function inspectSnapshot(avdHome, avdName, snapshotName) {
  const base = path.join(avdHome, `${avdName}.avd`, 'snapshots', snapshotName);
  const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
  const pb = size(path.join(base, 'snapshot.pb'));
  const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
  if (pb === 0 && ram === 0) return { present: false, stale: false, mb: 0 };
  const mb = Math.round((pb + ram) / 1048576);
  const stale = !(pb > 1024 && ram > 1024 * 1024);
  return { present: true, stale, mb };
}

/** 数还活着的模拟器孤儿进程（emulator.exe / qemu-system*.exe） */
function countOrphanProcesses() {
  return new Promise((resolve) => {
    let out = '';
    try {
      execFile('tasklist.exe', ['/NH', '/FO', 'CSV'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        if (err) { resolve(null); return; }
        out = String(stdout || '');
        const lines = out.split(/\r?\n/).filter((l) => /emulator\.exe|qemu-system/i.test(l));
        resolve(lines.length);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

/** 读最近日志文件里的错误行（最多看尾部 300 行） */
function recentLogErrors(files, max = 300) {
  const out = [];
  for (const file of files) {
    let text = '';
    try {
      const size = fs.statSync(file).size;
      const take = Math.min(size, 512 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(take);
        fs.readSync(fd, buf, 0, take, size - take);
        text = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch (_) { continue; }
    const lines = text.split(/\r?\n/).slice(-max);
    for (const line of lines) {
      if (/\b(ERROR|FATAL|FATAL ERROR|Exception|FATAL:|panic:)\b/i.test(line)) {
        out.push(line.trim().slice(0, 240));
      }
    }
  }
  return out.slice(-20);
}

/**
 * 采一份快照
 * @param {object} ctx { runtime, store, doctor }
 * @returns {Promise<object>} obs
 */
async function collect(ctx) {
  const { runtime, store, doctor } = ctx;
  const obs = {
    at: Date.now(),
    runtime: {},
    device: { checked: false },
    storage: {},
    settings: {},
    network: {},
    logs: {},
    accel: { checked: false },
  };

  // ---- 设置（最便宜，先取） ----
  let settings = {};
  try { settings = store.getSettings() || {}; } catch (_) { settings = {}; }
  obs.settings = {
    orientationMode: (settings.display && settings.display.orientationMode) || 'auto',
    landscape: !!(settings.display && settings.display.landscape),
    // 0.6.0 起默认原生窗口：只有显式 true 才算嵌入模式
    windowEmbed: !!(settings.display && settings.display.windowEmbed === true),
    autoFullscreen: !!(settings.display && settings.display.autoFullscreenOnLaunch),
    keepSnapshot: !(settings.engine && settings.engine.keepSnapshot === false),
    resourceMode: (settings.engine && settings.engine.resourceMode) || '',
  };

  // ---- 运行时状态 ----
  let status = null;
  try {
    status = await withTimeout(runtime.status(), 20000, null);
  } catch (_) { status = null; }

  let paths = null;
  try { paths = runtime.provisioner.paths(); } catch (_) { paths = null; }

  const running = !!(status && status.vmRunning)
    || (() => { try { return !!(runtime.emulator && runtime.emulator.running()); } catch (_) { return false; } })();

  const phase = status ? (status.phase || '') : '';
  const ready = !!(status && status.ready);
  if (running && !ready) {
    if (!bootingSince) bootingSince = Date.now();
  } else {
    bootingSince = 0;
  }

  const lastFailure = status ? status.lastFailure : null;
  obs.runtime = {
    running,
    phase,
    ready,
    bootMs: bootingSince ? Date.now() - bootingSince : 0,
    error: (status && status.error && !/缺少 adb/.test(status.error)) ? status.error : '',
    lastFailure: lastFailure ? { error: lastFailure.error || lastFailure.reason || '' } : null,
    locks: paths ? countLocks(paths.avdHome) : 0,
    orphans: null,
    snapshotStale: false,
  };

  // ---- adb 设备授权状态 ----
  try {
    const client = runtime.client();
    if (client && typeof client.deviceState === 'function') {
      const state = await withTimeout(client.deviceState(), 10000, null);
      if (state) {
        obs.device = { checked: true, state };
      }
    }
  } catch (_) { /* 探测不到就留 checked:false */ }

  // ---- 存储 ----
  try {
    const root = paths ? paths.root : null;
    if (root) {
      const freeMB = doctor.freeDiskMB(root);
      obs.storage.freeMB = Number(freeMB) || 0;
    }
  } catch (_) { /* ignore */ }

  try {
    const backend = runtime.backend;
    const info = (backend && typeof backend.dataInfo === 'function') ? (backend.dataInfo() || {}) : {};
    obs.storage.configuredGB = Number(info.configuredGB) || 0;
    obs.storage.actualGB = Number(info.actualGB) || 0;
    obs.storage.needsReset = !!(info.pendingGB || info.needsReset);
  } catch (_) { /* ignore */ }

  try {
    const shared = String(settings.sharedDir || '').trim();
    if (shared) {
      let ok = true;
      try {
        fs.accessSync(shared, fs.constants.W_OK);
      } catch (_) { ok = false; }
      obs.storage.sharedOk = ok;
      obs.storage.sharedPath = shared;
    }
  } catch (_) { /* ignore */ }

  // ---- 快照 / 锁 / 孤儿 ----
  try {
    if (paths) {
      const snap = inspectSnapshot(paths.avdHome, AVD_NAME, SNAPSHOT_NAME);
      obs.runtime.snapshotStale = snap.stale;
      obs.runtime.snapshotMB = snap.mb;
    }
  } catch (_) { /* ignore */ }

  const orphans = await countOrphanProcesses();
  if (orphans !== null) {
    // 正在跑的那台本身就是 emulator.exe + qemu 两个进程，不是残留。
    const expected = running ? 2 : 0;
    obs.runtime.orphans = Math.max(0, orphans - expected);
  }

  // ---- 网络 ----
  try {
    const snap = typeof runtime._networkSnapshot === 'function' ? runtime._networkSnapshot() : null;
    if (snap) obs.network = { ok: !!snap.ok, reason: snap.reason || '', ip: snap.ip || '' };
  } catch (_) { /* ignore */ }

  // ---- 加速 ----
  try {
    if (status && status.accel) {
      obs.accel = { checked: true, ok: !!status.accel.ok, note: status.accel.note || '' };
    }
  } catch (_) { /* ignore */ }

  // ---- 日志 ----
  try {
    const dir = path.join(store.DATA_DIR, 'logs');
    const files = [path.join(store.DATA_DIR, 'app.log'), path.join(dir, 'emulator.log')];
    const errors = recentLogErrors(files);
    obs.logs = { errors, count: errors.length };
  } catch (_) { /* ignore */ }

  return obs;
}

module.exports = { collect, inspectSnapshot, countLocks, recentLogErrors, countOrphanProcesses };
