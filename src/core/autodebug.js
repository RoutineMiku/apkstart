'use strict';
/**
 * 自动检测（自动 debug）内核
 *
 * 分两层，刻意分开：
 *   1) 采集层（src/core/autodebug-probe.js，主进程）：把机器真实状态采成一份纯数据快照 obs；
 *   2) 判定层（本文件，纯函数）：evaluate(obs) → issues[]。
 *
 * 判定层不碰 fs / child_process / electron，CI 可以直接 require 并单测
 * （教训见记忆 2026-11-17：CI 上 require 顶层依赖 electron 的模块会全红）。
 * 唯一额外依赖是同目录的 manual.js（纯映射表），用来把问题直接指到内置教程章节。
 *
 * 一条铁律：obs 里没有的字段一律当作「不知道」，不能因为探测失败就报问题。
 * 误报比漏报更伤用户信任 —— 用户一旦发现弹出来的「检测结果」是假的，
 * 就再也不会相信自动检测给出的任何结论了。
 */

const manual = require('./manual');

/** 问题分类（设置页按这个顺序分组展示） */
const CATEGORIES = [
  { id: 'runtime', name: 'Runtime', hint: 'Android VM processes, boot phase, snapshots, and stale locks' },
  { id: 'device', name: 'Device Connection', hint: 'adb authorization status and device online state' },
  { id: 'storage', name: 'Storage', hint: 'Disk free space, data partition, and shared folder' },
  { id: 'settings', name: 'Settings', hint: 'Conflicting or mutually overriding settings' },
  { id: 'network', name: 'Network', hint: 'Android network and download source connectivity' },
  { id: 'logs', name: 'Logs', hint: 'Errors recorded in runtime logs' },
];

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

/** 严重度排序：数字越大越严重 */
const SEVERITY_RANK = { error: 3, warn: 2, info: 1 };

/** 归一化一条问题，保证 UI 拿到的字段永远齐全 */
function normalise(raw) {
  if (!raw || !raw.code) return null;
  const severity = SEVERITY_RANK[raw.severity] ? raw.severity : 'info';
  const item = {
    code: String(raw.code),
    category: CATEGORY_IDS.includes(raw.category) ? raw.category : 'runtime',
    severity,
    title: String(raw.title || raw.code),
    hint: String(raw.hint || ''),
    // fix 是「一键修复」的动作名，由渲染层映射到具体操作；没有就留空
    fix: raw.fix || '',
    // detail 是给人看的补充信息（路径、数值等），不进标题
    detail: raw.detail === undefined || raw.detail === null ? '' : String(raw.detail),
  };
  // 0.6.2：每条问题都自带「教程」目标，渲染层不用再复制一份故障分类表
  item.help = manual.topicForIssue(item);
  return item;
}

/**
 * 判定：把观测快照变成问题列表
 * @param {object} obs 采集层给出的快照（字段可缺省）
 * @returns {Array<object>} 归一化后的问题列表
 */
function evaluate(obs) {
  const o = obs || {};
  const runtime = o.runtime || {};
  const device = o.device || {};
  const storage = o.storage || {};
  const settings = o.settings || {};
  const network = o.network || {};
  const logs = o.logs || {};
  const accel = o.accel || {};
  const out = [];

  const push = (raw) => {
    const it = normalise(raw);
    if (it) out.push(it);
  };

  /* ---------------- 运行时 ---------------- */

  // 开机失败：直接给最后一条真实原因，别让用户猜
  const bootError = runtime.error || (runtime.lastFailure && runtime.lastFailure.error) || '';
  if (bootError) {
    push({
      code: 'runtime.bootFailed',
      category: 'runtime',
      severity: 'error',
      title: 'Android runtime failed to start last time',
      hint: 'The actual runtime error was captured; resolving this usually restores startup in one step.',
      detail: bootError,
      fix: 'restartRuntime',
    });
  }

  // 一直卡在引导中：超过阈值还没 ready，多半是快照坏了或镜像有问题
  if (runtime.running && runtime.phase && runtime.phase !== 'ready' && runtime.bootMs > 150000) {
    push({
      code: 'runtime.stuckBoot',
      category: 'runtime',
      severity: 'warn',
      title: 'Android boot stuck in startup phase',
      hint: 'Booting for over 2.5 minutes without becoming ready. Often caused by a corrupted Quickboot snapshot; restarting the runtime (cold boot) usually fixes it.',
      detail: `Phase: ${runtime.phase}`,
      fix: 'restartRuntime',
    });
  }

  // 残留锁文件：会让下次启动被判成「AVD 已被占用」直接 FATAL
  if (Number(runtime.locks) > 0) {
    push({
      code: 'runtime.staleLocks',
      category: 'runtime',
      severity: 'warn',
      title: `Detected ${runtime.locks} stale lock file(s)`,
      hint: 'Uncleaned lock files cause the next boot to fail with "AVD already in use". Click Fix to clean them.',
      fix: 'lock',
    });
  }

  // 孤儿进程：emulator.exe 只是启动器，qemu 是 detached 的独立进程，
  // 只杀启动器会留下孤儿占着 multiinstance.lock（记忆 2026-11-13）。
  if (Number(runtime.orphans) > 0) {
    push({
      code: 'runtime.orphanProcesses',
      category: 'runtime',
      severity: 'warn',
      title: `${runtime.orphans} orphan emulator process(es) found`,
      hint: 'Leftover Android processes from an unclean shutdown are holding resources and AVD locks. Click Fix to clean them (preserves installed apps and data).',
      fix: 'orphans',
    });
  }

  // 快照空壳：文件在但校验不过，每次开机都要「加载失败再冷启动」，等于白留了几 GB
  if (runtime.snapshotStale) {
    push({
      code: 'runtime.staleSnapshot',
      category: 'runtime',
      severity: 'warn',
      title: 'Quickboot snapshot is corrupted',
      hint: 'The snapshot file exists but fails validation, forcing a cold boot every time. Deleting it reclaims disk space.',
      fix: 'snapshots',
    });
  }

  /* ---------------- 设备连接 ---------------- */

  // unauthorized：安卓弹了「允许 USB 调试吗」但没人点（记忆 2026-11-17 的老坑）
  if (device.state === 'unauthorized') {
    push({
      code: 'device.unauthorized',
      category: 'device',
      severity: 'error',
      title: 'Android device debugging unauthorized',
      hint: 'The "Allow USB debugging?" prompt on Android was not confirmed, blocking adb. Restarting the runtime (cold boot) will show the prompt again.',
      fix: 'restartRuntime',
    });
  } else if (device.state === 'offline') {
    push({
      code: 'device.offline',
      category: 'device',
      severity: 'warn',
      title: 'Android device is offline',
      hint: 'adb sees the device but cannot connect, usually because the VM is still booting or adb handshake stalled. Restart the runtime if it persists.',
      fix: 'restartRuntime',
    });
  } else if (runtime.running && device.checked && device.state === 'no-device') {
    push({
      code: 'device.missing',
      category: 'device',
      severity: 'warn',
      title: 'Runtime is running, but adb sees no device',
      hint: 'The Android process is alive but adb cannot see it, often due to a port conflict or incomplete boot.',
      fix: 'restartRuntime',
    });
  }

  /* ---------------- 存储 ---------------- */

  const freeMB = Number(storage.freeMB) || 0;
  if (freeMB > 0 && freeMB < 2048) {
    push({
      code: 'storage.diskCritical',
      category: 'storage',
      severity: 'error',
      title: 'Runtime drive is nearly full',
      hint: 'Less than 2 GB free; app installs and snapshot writes will fail. Click Fix to clean old images, snapshots, and logs.',
      detail: `${freeMB} MB free`,
      fix: 'disk',
    });
  } else if (freeMB > 0 && freeMB < 8192) {
    push({
      code: 'storage.diskLow',
      category: 'storage',
      severity: 'warn',
      title: 'Runtime drive space is low',
      hint: 'Less than 8 GB free; snapshots and system images need room. Cleaning reclaimable files is recommended.',
      detail: `${freeMB} MB free`,
      fix: 'disk',
    });
  }

  // 数据分区实际容量比配置小 → 装的游戏会提示「存储空间不足」
  if (storage.needsReset) {
    push({
      code: 'storage.dataNeedsReset',
      category: 'storage',
      severity: 'warn',
      title: 'Data partition expansion is not active yet',
      hint: 'The Quickboot differential disk blocks in-place resizing, so Android still sees the old size. Click "Reset Android Data" to rebuild at the new capacity (clears installed apps).',
      detail: `Configured ${storage.configuredGB} GB · Actual ${storage.actualGB} GB`,
      fix: 'dataReset',
    });
  } else if (Number(storage.configuredGB) > 0 && Number(storage.actualGB) > 0
    && Number(storage.configuredGB) > Number(storage.actualGB)) {
    push({
      code: 'storage.dataMismatch',
      category: 'storage',
      severity: 'error',
      title: 'Android data partition is smaller than configured',
      hint: 'Actual usable space inside Android is smaller than configured; large games may report insufficient storage.',
      detail: `Configured ${storage.configuredGB} GB · Actual ${storage.actualGB} GB`,
      fix: 'dataReset',
    });
  }

  if (storage.sharedOk === false) {
    push({
      code: 'storage.sharedBroken',
      category: 'storage',
      severity: 'warn',
      title: 'Shared folder unavailable',
      hint: 'The PC shared folder for file sharing does not exist or is not writable.',
      detail: storage.sharedPath || '',
      fix: 'shared',
    });
  }

  /* ---------------- 设置 ---------------- */

  // 方向策略与物理面板打架 → 安卓只给应用中间一条窄画面（记忆 2026-11-18 的老坑）
  const mode = String(settings.orientationMode || 'auto');
  if (mode === 'portrait' && settings.landscape === true) {
    push({
      code: 'settings.orientationConflict',
      category: 'settings',
      severity: 'warn',
      title: 'Orientation policy conflicts with current panel',
      hint: 'Policy requires portrait, but the panel is landscape, causing letterboxing. Match the panel orientation to the policy.',
      fix: 'orientation',
    });
  } else if (mode === 'landscape' && settings.landscape === false) {
    push({
      code: 'settings.orientationConflict',
      category: 'settings',
      severity: 'warn',
      title: 'Orientation policy conflicts with current panel',
      hint: 'Policy requires landscape, but the panel is portrait, causing a narrow vertical strip. Match the panel orientation to the policy.',
      fix: 'orientation',
    });
  }

  if (settings.windowEmbed === false && settings.autoFullscreen) {
    push({
      code: 'settings.detachedFullscreen',
      category: 'settings',
      severity: 'info',
      title: '"Auto Full Screen" has no effect in Native Window mode',
      hint: 'Native windows are managed by the emulator itself. Press F11 in the window or switch to Embedded Mode to use auto full screen.',
    });
  }

  if (settings.keepSnapshot === false && freeMB > 0 && freeMB < 4096) {
    push({
      code: 'settings.snapshotOffLowDisk',
      category: 'settings',
      severity: 'info',
      title: 'Low disk space; Quickboot snapshot disabled',
      hint: 'With less than 4 GB free and snapshots off, launching apps will cold boot (~15s). Re-enable snapshots if disk space permits.',
      fix: 'settings',
    });
  }

  /* ---------------- 声音 ---------------- */

  // 0.6.2 新增：用户反馈「有的应用没声音」时，第一反应往往是系统音量问题，
  // 实际上最常见是引擎开关被关掉（-no-audio）或 Windows Audio 服务被停了。
  const audio = o.audio || {};
  if (audio.checked && audio.enabled === false) {
    push({
      code: 'audio.disabled',
      category: 'settings',
      severity: 'warn',
      title: 'Android app audio is disabled in settings',
      hint: 'The Android audio toggle is off, muting all apps in ApkStart. Click Fix to re-enable and restart the runtime.',
      fix: 'audio',
    });
  }
  if (audio.checked && audio.serviceRunning === false) {
    push({
      code: 'audio.windowsServiceStopped',
      category: 'settings',
      severity: 'warn',
      title: 'Windows Audio service (Audiosrv) is not running',
      hint: 'This mutes all Windows apps too. Start "Windows Audio" in services.msc (set to Automatic) or run `net start Audiosrv` as Administrator.',
      fix: 'audioService',
    });
  }
  // 麦克风输入被关掉：语音/通话/录音类应用会拿不到录音设备。
  // 只在明确关掉时才提示（micEnabled===false），探测不到不报，避免误报。
  if (audio.checked && audio.micEnabled === false) {
    push({
      code: 'audio.microphoneDisabled',
      category: 'settings',
      severity: 'warn',
      title: 'Microphone input is disabled in settings',
      hint: 'Voice chat, calls, and recording in apps will fail. Click Fix to re-enable and restart the runtime; also verify Windows microphone permissions.',
      fix: 'microphone',
    });
  }

  /* ---------------- 网络 ---------------- */

  if (network.ok === false) {
    push({
      code: 'network.guestDown',
      category: 'network',
      severity: 'warn',
      title: 'No network inside Android',
      hint: 'Android DNS or internet connectivity failed. Use "Repair Network" to reset Android network state (preserves app list).',
      detail: network.reason || '',
      fix: 'repairNetwork',
    });
  }

  const badSources = Array.isArray(network.sources) ? network.sources.filter((s) => s && s.ok === false) : [];
  if (badSources.length) {
    push({
      code: 'network.sourcesDown',
      category: 'network',
      severity: 'warn',
      title: `${badSources.length} download source(s) unreachable`,
      hint: 'Update checks query multiple sources, so one being down is fine; if all fail, check your network or proxy.',
      detail: badSources.map((s) => s.name).join(', '),
      fix: 'settings',
    });
  }

  /* ---------------- 日志 ---------------- */

  const errLines = Array.isArray(logs.errors) ? logs.errors.filter(Boolean) : [];
  if (errLines.length) {
    push({
      code: 'logs.errors',
      category: 'logs',
      severity: 'warn',
      title: `${errLines.length} error(s) in runtime log`,
      hint: 'The last run recorded errors; export a diagnostic report to view full context.',
      detail: errLines.slice(-1)[0],
      fix: 'report',
    });
  }

  /* ---------------- 加速 ---------------- */

  if (accel.checked && accel.ok === false) {
    push({
      code: 'accel.softwareEmulation',
      category: 'runtime',
      severity: 'warn',
      title: 'Hardware acceleration is not enabled',
      hint: 'Running in pure software emulation: boot takes minutes and frame rates drop. Enable "Windows Hypervisor Platform" and restart.',
      detail: accel.note || '',
      fix: 'virtualization',
    });
  }

  return dedupe(out);
}

/** 同 code 只留最后一条（后一次检测覆盖前一次） */
function dedupe(issues) {
  const map = new Map();
  for (const raw of issues || []) {
    const it = normalise(raw);
    if (!it) continue;
    map.set(it.code, it);
  }
  return Array.from(map.values());
}

/** 按严重度从高到低排 */
function bySeverity(a, b) {
  const d = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
  if (d) return d;
  return String(a.code).localeCompare(String(b.code));
}

/** 汇总：给状态条计数、给设置页分栏 */
function summarize(issues) {
  const list = dedupe(issues).sort(bySeverity);
  const errors = list.filter((i) => i.severity === 'error').length;
  const warns = list.filter((i) => i.severity === 'warn').length;
  const infos = list.filter((i) => i.severity === 'info').length;
  const byCategory = CATEGORIES.map((c) => {
    const items = list.filter((i) => i.category === c.id);
    return {
      id: c.id,
      name: c.name,
      count: items.length,
      errors: items.filter((i) => i.severity === 'error').length,
    };
  });
  return {
    total: list.length,
    errors,
    warns,
    infos,
    byCategory,
    // 一眼能看出「有没有必须马上处理的问题」
    health: errors ? 'error' : (warns ? 'warn' : (infos ? 'info' : 'ok')),
  };
}

/** 按分类分组，用于设置页分类渲染 */
function groupByCategory(issues) {
  const list = dedupe(issues).sort(bySeverity);
  return CATEGORIES.map((c) => ({
    ...c,
    items: list.filter((i) => i.category === c.id),
  })).filter((g) => g.items.length);
}

/**
 * 对比两次检测结果：找出「新出现」和「已消失」的问题。
 * 自动检测只在新问题出现时提醒用户，已消失的只做静默记账 ——
 * 每次都弹「已恢复 3 项」会变成噪音。
 */
function diff(prevIssues, nextIssues) {
  const prev = new Map((prevIssues || []).map((i) => [i.code, i]));
  const next = new Map((nextIssues || []).map((i) => [i.code, i]));
  const added = [];
  const resolved = [];
  for (const [code, it] of next) {
    const before = prev.get(code);
    if (!before || before.severity !== it.severity) added.push(it);
  }
  for (const [code, it] of prev) {
    if (!next.has(code)) resolved.push(it);
  }
  return { added, resolved };
}

module.exports = {
  CATEGORIES,
  CATEGORY_IDS,
  SEVERITY_RANK,
  normalise,
  evaluate,
  dedupe,
  summarize,
  groupByCategory,
  diff,
  bySeverity,
};
