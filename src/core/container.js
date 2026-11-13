'use strict';
/**
 * 应用级容器（纯计算层）
 *
 * ApkStart 底层是 QEMU 全系统虚拟机，不可能像 WSA / 卓易通那样「只加载某个 App
 * 需要的那几个系统服务」——Linux 内核、zygote、system_server 必须整包起来。
 * 但用户真正感受到的「重」并不来自这些常驻服务，而来自：
 *   1. 每开一个 App 就重新引导一次完整 Android（冷启 40~142 秒，CPU/磁盘打满）；
 *   2. 之前开过的 App 全留在后台继续吃内存、拉网络、起唤醒锁；
 *   3. 没有 App 在前台时，qemu 仍以 Normal 优先级和桌面抢 CPU；
 *   4. 文件同步、通知轮询在没有任何 App 打开时也照跑。
 *
 * 这里把能真实裁掉的部分做成可编排、可单测的命令：
 *   - 环境只引导一次，之后「开 App」= am start + 挂窗口（由 Runtime.beginApp 负责）；
 *   - 开新 App 时停掉其他用户 App 的进程，只留当前这个需要的运行环境；
 *   - 关掉最后一个 App 时让 Android 进 idle、清后台进程、qemu 降优先级；
 *   - 系统包默认一律不动（停 GMS 会让依赖推送/登录的 App 反复弹错），
 *     只在用户显式开启「深度裁剪」时才禁用一小批明确无用的后台包。
 *
 * 本文件不依赖 adb / Electron，全部是纯函数，便于回归测试。
 */

/** 任何情况下都不能裁剪：动它们会直接导致界面黑屏或应用崩溃 */
const NEVER_TRIM = [
  'android',
  'com.android.systemui',
  'com.android.settings',
  'com.android.inputmethod.latin',
  'com.google.android.inputmethod.latin',
  'com.android.webview',
  'com.google.android.webview',
  'com.google.android.gms',
  'com.google.android.gsf',
  'com.android.providers.settings',
  'com.android.server.telecom',
];

/** 只有「深度裁剪」才禁用：这些包只做后台更新/壁纸/打印，停掉不影响打开 App */
const OPTIONAL_SYSTEM = [
  'com.android.vending',                    // Play 商店（后台更新扫描）
  'com.google.android.setupwizard',         // 首次设置向导
  'com.android.printspooler',               // 打印服务
  'com.android.wallpapercropper',
  'com.android.dreams.basic',               // 屏保
  'com.android.providers.calendar',
  'com.android.providers.contacts',
  'com.android.managedprovisioning',
  'com.android.statementservice',
  'com.android.backupconfirm',
];

/** 明显属于系统/框架的包：会话裁剪时跳过，避免误杀 */
const SYSTEM_PREFIXES = [
  'android', 'com.android.', 'com.google.android.',
  'com.qualcomm.', 'com.qti.', 'vendor.', 'com.mediatek.',
];

/** 只有合法 Android 包名才允许拼进 shell 命令，防止清单被污染后注入 */
const SAFE_PKG = /^[A-Za-z][A-Za-z0-9_.]+$/;

function isSystemPackage(pkg) {
  const p = String(pkg || '').trim();
  if (!p) return true;
  if (!SAFE_PKG.test(p)) return true;
  return SYSTEM_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
}

/**
 * 启动某个 App 时要执行的裁剪命令。
 * @param {object} o
 * @param {string} o.pkg            当前要打开的包
 * @param {string[]} o.installed    已装进本机的用户 App 包（store 里的清单）
 * @param {boolean} o.deep          深度裁剪（禁用系统后台包），默认 false
 * @param {boolean} o.killBackground 是否顺带清后台缓存进程，默认 false
 *   （启动阶段清后台可能误伤刚进前台的 App，清理由 endApp 的停放命令负责）
 * @returns {{commands:string[], stopped:string[], disabled:string[], kept:string[]}}
 */
function buildSessionCommands({
  pkg, installed = [], deep = false, killBackground = false,
} = {}) {
  const target = SAFE_PKG.test(String(pkg || '').trim()) ? String(pkg).trim() : '';
  const commands = [];
  const stopped = [];
  const disabled = [];
  const kept = [];

  for (const raw of installed) {
    const p = String(raw || '').trim();
    if (!p || p === target || isSystemPackage(p) || NEVER_TRIM.includes(p)) {
      if (p) kept.push(p);
      continue;
    }
    stopped.push(p);
    commands.push(`am force-stop ${p}`);
  }

  // 清掉系统缓存的后台进程（不含前台、不含 persistent 服务），
  // 让「只留当前 App」不只是 force-stop 包名，而是真的把内存还回来。
  if (killBackground) commands.push('am kill-all 2>/dev/null || true');

  if (deep) {
    for (const p of OPTIONAL_SYSTEM) {
      if (NEVER_TRIM.includes(p)) continue;
      disabled.push(p);
      commands.push(`pm disable-user --user 0 ${p} 2>/dev/null || true`);
    }
    // 计量网络下禁后台数据，避免商店/同步在后台持续唤醒
    commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  }

  return { commands, stopped, disabled, kept };
}

/**
 * 关掉最后一个 App 后让容器「空转但不吃资源」。
 * 不关机、不销毁 AVD：下次打开还是秒进，只是先把 CPU/内存让给 Windows。
 */
function buildIdleCommands({ deep = false } = {}) {
  const commands = [
    'am kill-all 2>/dev/null || true',
    'dumpsys deviceidle force-idle 2>/dev/null || true',
  ];
  if (deep) commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  return commands;
}

/** 从深度裁剪恢复（用户关掉开关时调用，保证可回退） */
function buildRestoreCommands() {
  return [
    ...OPTIONAL_SYSTEM.map((p) => `pm enable ${p} 2>/dev/null || true`),
    'settings put global restricted_background_data 0 2>/dev/null || true',
  ];
}

/**
 * 会话状态机：判断一次 launch/close 之后容器该处于什么状态。
 * 纯函数，方便验证「多窗口切换」「最后一个窗口关闭」等边界。
 */
function nextSessionState(active, event, pkg) {
  const set = new Set(active || []);
  if (event === 'open') set.add(pkg);
  else if (event === 'close') set.delete(pkg);
  return {
    active: [...set],
    hasApp: set.size > 0,
    foreground: event === 'open' ? pkg : (set.size ? [...set][set.size - 1] : null),
    idle: set.size === 0,
  };
}

/** 给日志/诊断用的一行摘要 */
function describeSession(state, plan) {
  const n = state.active.length;
  if (!n) return '容器空闲（Android 常驻但已降优先级，0 个应用进程）';
  return `容器活跃：${n} 个应用窗口${plan && plan.stopped && plan.stopped.length
    ? `，已停掉 ${plan.stopped.length} 个后台应用` : ''}`;
}

module.exports = {
  NEVER_TRIM, OPTIONAL_SYSTEM, SYSTEM_PREFIXES,
  isSystemPackage, buildSessionCommands, buildIdleCommands,
  buildRestoreCommands, nextSessionState, describeSession,
};
