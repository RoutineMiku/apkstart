'use strict';
/**
 * 内置手册的「故障 → 教程章节」映射（纯函数，不依赖 electron / fs）
 *
 * 0.6.2：手册随应用分发（src/ui/manual.html）。主进程打开手册时只接受
 * 这里给出的锚点，避免渲染层把任意 file:// 路径传进来。
 *
 * 同一个故障可能有多个入口：自动检测的问题 code、安装失败的原始报错、
 * 用户手点的「教程」按钮。三路都汇到 resolve()，保证落到同一节。
 */

/** 章节 id 与 src/ui/manual.html 的锚点一一对应（由 docs/build-manual-html.py 生成） */
const TOPICS = Object.freeze({
  overview: { id: 'overview', anchor: 'apkstart-user-manual-troubleshooting-guide', title: 'User Manual · Contents' },
  accel: { id: 'accel', anchor: '6-1-hardware-acceleration-not-enabled-slow-boot', title: 'Hardware Acceleration Not Enabled / Slow Boot' },
  install: { id: 'install', anchor: '6-2-installation-failed-install_failed_', title: 'Installation Failed (INSTALL_FAILED_*)' },
  arm: { id: 'arm', anchor: '6-3-missing-arm-translation-layer-arm-app-fails-to-install-or-crashes', title: 'ARM Translation Layer / ARM App Fails to Install' },
  adb: { id: 'adb', anchor: '6-4-adb-unauthorized-allow-usb-debugging', title: 'adb Unauthorized (Allow USB Debugging)' },
  startup: { id: 'startup', anchor: '6-5-double-clicking-icon-does-nothing-infinite-spinner-window-with-rotate-button', title: 'Launch Failure / Window with Rotate Button' },
  other: { id: 'other', anchor: '6-6-other-startup-issues-quick-reference', title: 'Other Startup Issues Quick Reference' },
  sound: { id: 'sound', anchor: '6-7-no-sound-low-volume-in-apps', title: 'No Sound / Low Volume in Apps' },
  dll: { id: 'dll', anchor: '6-8-store-edition-launch-failure-0xc0000135-dll-load-failed', title: 'Store Edition Launch Failure / 0xC0000135 (DLL Load Failed)' },
  mic: { id: 'mic', anchor: '6-9-app-cannot-access-microphone-voice-calls-recording-fail', title: 'App Cannot Access Microphone / Recording Fail' },
  gpu: { id: 'gpu', anchor: '6-10-discrete-integrated-gpu-rendering-gpu-preference', title: 'Discrete / Integrated GPU Rendering (GPU Preference)' },
  diagnose: { id: 'diagnose', anchor: '5-4-built-in-user-manual-auto-tutorials', title: 'Built-in User Manual & Auto-Tutorials' },
  settings: { id: 'settings', anchor: '3-6-settings-navigation', title: 'Settings Navigation' },
  storage: { id: 'storage', anchor: '8-data-directory-layout', title: 'Data & Directory Layout' },
  network: { id: 'network', anchor: '5-2-auto-debug-automatic-diagnostics', title: 'Auto-Debug & Network Repair' },
});

// 反模拟 / 安全校验导致的启动退出也归到 6.3：该章节末尾已说明这类应用属于限制。
const ARM_RE = /NO_MATCHING_ABIS|DoBadTrampoline|libndk_translation|UnsatisfiedLinkError|arm64-v8a|armeabi-v7a|ARM translation|ARM 翻译层|ARM 转译层|反模拟|反仿真|反调试|anti[-_ ]?emulat|emulator.?detect|safetynet|play.?integrity/i;
const ADB_RE = /ADB_UNAUTHORIZED|unauthorized|Allow USB debugging|USB debugging|debugging authorization|允许 USB 调试|调试授权/i;
const SOUND_RE = /audio|AUDIO|sound|volume|mute|声音|音量|静音|Audiosrv/i;
// 0xC0000135 / DLL 加载失败： Decimal 3221225781 也要认，诊断里两种写法都出现
const DLL_RE = /0x0?c0000135|3221225781|STATUS_DLL_NOT_FOUND|DLL load failed|DLL 加载失败|依赖 DLL|missing DLL|MSVCP140|VCRUNTIME|FaultingModuleName/i;

/** 自动检测的问题 code → 章节 id */
const ISSUE_MAP = Object.freeze({
  'accel.softwareEmulation': 'accel',
  'device.unauthorized': 'adb',
  'device.offline': 'adb',
  'device.missing': 'adb',
  'settings.orientationConflict': 'startup',
  'settings.detachedFullscreen': 'startup',
  'settings.snapshotOffLowDisk': 'storage',
  'storage.sharedBroken': 'storage',
  'settings.audioDisabled': 'sound',
  'audio.disabled': 'sound',
  'audio.windowsServiceStopped': 'sound',
  'audio.microphoneDisabled': 'mic',
  'storage.diskCritical': 'storage',
  'storage.diskLow': 'storage',
  'storage.dataNeedsReset': 'storage',
  'storage.dataMismatch': 'storage',
  'network.guestDown': 'network',
  'network.sourcesDown': 'network',
  'runtime.staleLocks': 'startup',
  'runtime.orphanProcesses': 'startup',
  'runtime.staleSnapshot': 'startup',
  'runtime.stuckBoot': 'startup',
  // 诊断分类里 0xC0000135 归在 code='DLL'；缺 VC++ 实测项归 vcRedist
  DLL: 'dll',
  vcRedist: 'dll',
});

/** 兜底：用标题/详情里的关键字再判一次，覆盖 doctor:selfCheck 的旧 code */
function topicByText(text) {
  const s = String(text || '');
  if (ARM_RE.test(s)) return 'arm';
  if (ADB_RE.test(s)) return 'adb';
  if (SOUND_RE.test(s)) return 'sound';
  if (DLL_RE.test(s)) return 'dll';
  if (/INSTALL_FAILED|INSTALL_PARSE|signature|invalid apk|签名|安装包|APK 损坏/i.test(s)) return 'install';
  if (/hardware acceleration|hypervisor|WHPX|AEHD|accel|硬件加速|虚拟机监控程序/i.test(s)) return 'accel';
  if (/attach failed|emu:0|rotate|embedded|cannot lock AVD|failed to start|旋转|嵌入|打不开|没反应|图标/i.test(s)) return 'startup';
  if (/disk|space|shared folder|data partition|磁盘|空间|共享目录|数据分区/i.test(s)) return 'storage';
  if (/network|DNS|download source|网络|联网|下载源/i.test(s)) return 'network';
  return 'overview';
}

/** 自动检测问题 → 教程章节 */
function topicForIssue(issue) {
  if (!issue) return TOPICS.overview;
  const code = String(issue.code || '');
  let id = ISSUE_MAP[code];
  // 启动失败要看真实原因：ARM 翻译层崩溃有专属章节，不能一律甩给「打不开」
  if (!id || code === 'runtime.bootFailed' || code === 'logs.errors') {
    id = topicByText(`${issue.title || ''} ${issue.detail || ''}`);
    if (id === 'overview' && code === 'runtime.bootFailed') id = 'startup';
    if (id === 'overview' && code === 'logs.errors') id = 'other';
  }
  return TOPICS[id] || TOPICS.overview;
}

/** 安装/运行原始报错 → 教程章节 */
function topicForError(text) {
  const s = String(text || '');
  if (!s.trim()) return TOPICS.overview;
  if (ARM_RE.test(s)) return TOPICS.arm;
  if (ADB_RE.test(s)) return TOPICS.adb;
  if (SOUND_RE.test(s)) return TOPICS.sound;
  if (DLL_RE.test(s)) return TOPICS.dll;
  if (/INSTALL_|PARSE_FAILED|Install failed|signature|安装失败|签名|安装包/i.test(s)) return TOPICS.install;
  if (/attach failed|emu:0|device not found|rotate button|旋转窗口/i.test(s)) return TOPICS.startup;
  return topicByText(s) === 'overview' ? TOPICS.install : TOPICS[topicByText(s)];
}

/**
 * 统一入口：渲染层只传它手里有的东西（code / error / topic），
 * 主进程永远拿回一个受信任的章节锚点。
 */
function resolve(payload) {
  const p = typeof payload === 'string' ? { error: payload } : (payload || {});
  let topic = TOPICS.overview;
  if (p.topic && TOPICS[p.topic]) topic = TOPICS[p.topic];
  else if (p.issue || p.code) {
    const issue = typeof p.issue === 'string'
      ? { code: p.issue, title: p.title, detail: p.detail }
      : (p.issue || { code: p.code, title: p.title, detail: p.detail });
    topic = topicForIssue(issue);
  } else if (p.error || p.message || p.text) topic = topicForError(p.error || p.message || p.text);
  return {
    id: topic.id,
    anchor: topic.anchor,
    title: topic.title,
    reason: String(p.reason || ''),
  };
}

module.exports = { TOPICS, ISSUE_MAP, topicForIssue, topicForError, topicByText, resolve };
