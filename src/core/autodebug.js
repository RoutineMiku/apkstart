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
  { id: 'runtime', name: '运行时', hint: '安卓虚拟机进程、启动阶段、快照与残留锁' },
  { id: 'device', name: '设备连接', hint: 'adb 授权状态、设备是否在线' },
  { id: 'storage', name: '存储', hint: '磁盘余量、数据分区、共享目录' },
  { id: 'settings', name: '设置', hint: '配置之间的冲突与互相抵消' },
  { id: 'network', name: '网络', hint: '安卓网络与下载源连通性' },
  { id: 'logs', name: '日志', hint: '运行日志里的错误' },
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
      title: '安卓运行时上次启动失败',
      hint: '运行时的真实报错已经拿到，按这条原因处理通常一次就能恢复。',
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
      title: '安卓开机卡在引导阶段',
      hint: '已经引导超过 2 分半还没进系统。常见原因是快速启动快照损坏，重启运行时（会走一次冷启动）通常能解决。',
      detail: `阶段：${runtime.phase}`,
      fix: 'restartRuntime',
    });
  }

  // 残留锁文件：会让下次启动被判成「AVD 已被占用」直接 FATAL
  if (Number(runtime.locks) > 0) {
    push({
      code: 'runtime.staleLocks',
      category: 'runtime',
      severity: 'warn',
      title: `检测到 ${runtime.locks} 个上次残留的锁文件`,
      hint: '锁文件没清会让下一次启动被判定为「AVD 已被占用」而直接失败。可以一键清掉。',
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
      title: `有 ${runtime.orphans} 个残留的模拟器进程`,
      hint: '上次没有正常关机的安卓进程还占着资源与 AVD 锁，会让下次开机失败。可以一键清理（不会动已装应用与存档）。',
      fix: 'orphans',
    });
  }

  // 快照空壳：文件在但校验不过，每次开机都要「加载失败再冷启动」，等于白留了几 GB
  if (runtime.snapshotStale) {
    push({
      code: 'runtime.staleSnapshot',
      category: 'runtime',
      severity: 'warn',
      title: '快速启动快照已损坏',
      hint: '快照文件还在但校验不通过，每次开机都要额外冷启动一次。删掉它会用一次冷启动换回磁盘空间。',
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
      title: '安卓设备未授权调试',
      hint: '安卓侧弹过「允许 USB 调试吗」但没被确认，adb 一直连不上。重启运行时（走一次冷启动）会重新弹出确认框，确认后即恢复。',
      fix: 'restartRuntime',
    });
  } else if (device.state === 'offline') {
    push({
      code: 'device.offline',
      category: 'device',
      severity: 'warn',
      title: '安卓设备处于 offline 状态',
      hint: 'adb 能看到设备但连不上，通常是虚拟机还在引导或 adb 服务没握手成功。等一会儿仍不恢复就重启运行时。',
      fix: 'restartRuntime',
    });
  } else if (runtime.running && device.checked && device.state === 'no-device') {
    push({
      code: 'device.missing',
      category: 'device',
      severity: 'warn',
      title: '运行时在跑，但 adb 没看到设备',
      hint: '安卓进程活着、adb 却看不到设备，多半是 adb 服务端口被别的程序占了，或者引导还没完成。',
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
      title: '运行时所在磁盘快满了',
      hint: '剩余空间不足 2 GB，装应用和写快照都会失败。点「一键清理」回收旧镜像、旧快照和日志。',
      detail: `剩余 ${freeMB} MB`,
      fix: 'disk',
    });
  } else if (freeMB > 0 && freeMB < 8192) {
    push({
      code: 'storage.diskLow',
      category: 'storage',
      severity: 'warn',
      title: '运行时所在磁盘空间偏紧',
      hint: '剩余不足 8 GB，快照和系统镜像还需要空间。建议先清理一次可回收文件。',
      detail: `剩余 ${freeMB} MB`,
      fix: 'disk',
    });
  }

  // 数据分区实际容量比配置小 → 装的游戏会提示「存储空间不足」
  if (storage.needsReset) {
    push({
      code: 'storage.dataNeedsReset',
      category: 'storage',
      severity: 'warn',
      title: '数据分区扩容没有真正生效',
      hint: '快速启动用的差量盘挡着就地扩容，guest 里看到的还是旧容量。需要「重置安卓数据」后按新容量重建（会清掉已装应用）。',
      detail: `配置 ${storage.configuredGB} GB · 实际 ${storage.actualGB} GB`,
      fix: 'dataReset',
    });
  } else if (Number(storage.configuredGB) > 0 && Number(storage.actualGB) > 0
    && Number(storage.configuredGB) > Number(storage.actualGB)) {
    push({
      code: 'storage.dataMismatch',
      category: 'storage',
      severity: 'error',
      title: '安卓数据分区比配置的小',
      hint: '安卓里实际可用容量小于设置里写的值，装大游戏会提示存储空间不足。',
      detail: `配置 ${storage.configuredGB} GB · 实际 ${storage.actualGB} GB`,
      fix: 'dataReset',
    });
  }

  if (storage.sharedOk === false) {
    push({
      code: 'storage.sharedBroken',
      category: 'storage',
      severity: 'warn',
      title: '共享目录不可用',
      hint: '文件互通用的本机目录不存在或没有写权限，安卓里保存的文件同步不过去。',
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
      title: '屏幕方向策略与当前面板方向相反',
      hint: '策略要求竖屏，但面板现在是横屏，安卓只会给应用一条窄画面加两侧黑边。把面板方向改成与策略一致即可。',
      fix: 'orientation',
    });
  } else if (mode === 'landscape' && settings.landscape === false) {
    push({
      code: 'settings.orientationConflict',
      category: 'settings',
      severity: 'warn',
      title: '屏幕方向策略与当前面板方向相反',
      hint: '策略要求横屏，但面板现在是竖屏，看剧/游戏会是一条竖着的窄画面。把面板方向改成与策略一致即可。',
      fix: 'orientation',
    });
  }

  if (settings.windowEmbed === false && settings.autoFullscreen) {
    push({
      code: 'settings.detachedFullscreen',
      category: 'settings',
      severity: 'info',
      title: '原生窗口模式下的「启动时自动全屏」不会生效',
      hint: '原生窗口由模拟器自己开窗，全屏由它自己决定，不受这里的开关控制。想铺满屏幕可在窗口里按 F11，或把窗口承载方式改成嵌入模式。',
    });
  }

  if (settings.keepSnapshot === false && freeMB > 0 && freeMB < 4096) {
    push({
      code: 'settings.snapshotOffLowDisk',
      category: 'settings',
      severity: 'info',
      title: '磁盘偏紧，快速启动快照已关闭',
      hint: '当前磁盘余量不到 4 GB，快照又被关掉：打开应用会走一次完整冷启动（十几秒）。磁盘够的话建议重新打开快照。',
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
      title: '安卓应用声音已在设置里关闭',
      hint: '模拟器是以 -no-audio 启动的，所以只有 ApkStart 里的应用没声音。点「处理」重新打开，并重启一次运行时即可。',
      fix: 'audio',
    });
  }
  if (audio.checked && audio.serviceRunning === false) {
    push({
      code: 'audio.windowsServiceStopped',
      category: 'settings',
      severity: 'warn',
      title: 'Windows 音频服务（Audiosrv）未运行',
      hint: '这会连系统其它软件一起没声音。到 services.msc 启动 Windows Audio 并设为自动，或在管理员 PowerShell 里执行 net start Audiosrv。',
      fix: 'audioService',
    });
  }

  /* ---------------- 网络 ---------------- */

  if (network.ok === false) {
    push({
      code: 'network.guestDown',
      category: 'network',
      severity: 'warn',
      title: '安卓里没有网络',
      hint: '安卓侧解析或联网失败，视频/资讯类应用会一直转圈。可以用「修复网络」重置安卓数据解决（应用清单会保留）。',
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
      title: `${badSources.length} 个下载源连不上`,
      hint: '更新检查会同时问多个源，有一个不通不影响使用；如果全都不通，请检查网络或代理。',
      detail: badSources.map((s) => s.name).join('、'),
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
      title: `运行日志里有 ${errLines.length} 条错误`,
      hint: '最近一次运行留下了错误记录，展开诊断报告可以看到完整上下文。',
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
      title: '当前没有硬件加速',
      hint: '只能跑纯软件模拟，开机慢到几分钟、画面也容易掉帧。开启「Windows 虚拟机监控程序平台」后重启即可。',
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
