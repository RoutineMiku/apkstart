'use strict';
/**
 * 本机体检 + 自动配置。
 *
 * 为什么需要它：ApkStart 装完之后能不能跑，取决于四件和软件无关的事 ——
 *   1. CPU 虚拟化（VT-x / AMD-V）在 BIOS 里有没有开；
 *   2. Windows 的「虚拟机监控程序平台 / Hyper-V」有没有开（WHPX 靠它）；
 *   3. 显卡能撑到什么程度（厂商、显存、驱动版本，能不能走硬件渲染）；
 *   4. 内存 / 磁盘够不够开一台 2~8GB 的安卓虚拟机。
 *
 * 这些以前都是「启动失败 → 用户看日志 → 自己猜」。现在先查一遍，能自动改的直接改
 * （内存、核心、画质、渲染后端），必须提权的给出一个按钮（开功能 / 装驱动），
 * 只能在 BIOS 里做的说清楚按哪个键、改成什么。
 *
 * 分层：
 *   - collect()   —— 只做探测（Windows 上用一次 PowerShell 取全部信息），有降级路径；
 *   - evaluate()  —— 纯函数：把探测结果翻译成「体检项 + 建议配置」，可单测；
 *   - 应用动作在 main.js（保存设置 / 调已有的提权接口），本模块不碰权限。
 *
 * 注意：**不假装能替用户开 BIOS 虚拟化**。那一步只能人去改，我们只负责判断和指路。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');

// ---------------- 探测 ----------------

/**
 * 跑一段快捷脚本（Windows 的 powershell.exe），取 JSON；失败/超时返回 null。
 *
 * 用异步 execFile 而不是 execFileSync：脚本启动 + 两条 CIM 查询要 1~2 秒，
 * 同步跑会把主进程（也就是整个界面）卡住，用户会以为点「体检」把程序点死了。
 */
function psJson(script, timeout = 15000) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const { execFile } = require('child_process');
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
      ], { encoding: 'utf8', windowsHide: true, timeout }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const t = String(stdout || '').trim();
        if (!t) { resolve(null); return; }
        try { resolve(JSON.parse(t)); } catch (_) { resolve(null); }
      });
    } catch (_) {
      resolve(null);
    }
  });
}

const HW_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue";',
  '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,VirtualizationFirmwareEnabled,VMMonitorModeExtensions,SecondLevelAddressTranslationExtensions;',
  '$cs = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 HypervisorPresent,TotalPhysicalMemory;',
  '$gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,DriverDate,AdapterRAM,VideoProcessor,Status);',
  // AdapterRAM 在 >4GB 时会被截成 4294967295；真实值在注册表 qwMemorySize（每个适配器一个 000N 子键）
  '$vram = 0;',
  'Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}" -ErrorAction SilentlyContinue | ForEach-Object {',
  '  $v = (Get-ItemProperty $_.PSPath -Name "HardwareInformation.qwMemorySize" -ErrorAction SilentlyContinue)."HardwareInformation.qwMemorySize";',
  '  if ($v -and $v -gt $vram) { $vram = $v }',
  '};',
  '[pscustomobject]@{ cpu = $cpu; cs = $cs; gpu = $gpu; vram = $vram } | ConvertTo-Json -Depth 6 -Compress',
].join(' ');

const FEATURE_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue";',
  '$o = [ordered]@{};',
  'foreach ($n in @("HypervisorPlatform","VirtualMachinePlatform","Microsoft-Hyper-V-All")) {',
  '  try { $o[$n] = (Get-WindowsOptionalFeature -Online -FeatureName $n -ErrorAction Stop).State } catch { $o[$n] = "unknown" }',
  '}',
  '$o | ConvertTo-Json -Compress',
].join(' ');

/** 判断文件存在（探测 WHPX 的 API 库 / AEHD 驱动 / 虚拟机平台服务） */
function fileExists(rel) {
  try {
    return fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', rel));
  } catch (_) {
    return false;
  }
}

function dateToISO(v) {
  if (!v) return '';
  // PowerShell 的 DateTime → `/Date(1700000000000)/` 或 ISO 字符串
  const m = /\/Date\((\d+)\)\//.exec(String(v));
  if (m) {
    try { return new Date(Number(m[1])).toISOString().slice(0, 10); } catch (_) { return ''; }
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

/**
 * 探测本机硬件与虚拟化状态。
 *
 * 任何一项查不到都返回 null/0，**绝不让探测失败拖垮调用方**：
 * 查不到就是「未知」，体检项里会写「读不到」，而不是编一个结论。
 *
 * @param {object} o { accel } accel 由 provisioner.emulatorAccel() 传入，避免重复拉起 emulator
 * @returns {object} hw
 */
async function collect({ accel = null } = {}) {
  const [raw, feats] = process.platform === 'win32'
    ? await Promise.all([psJson(HW_SCRIPT), psJson(FEATURE_SCRIPT)])
    : [null, null];
  const cpu = (raw && raw.cpu) || {};
  const cs = (raw && raw.cs) || {};
  const gpus = Array.isArray(raw && raw.gpu) ? raw.gpu : (raw && raw.gpu ? [raw.gpu] : []);

  // 选「主显卡」：优先非 Microsoft Basic Display / 非虚拟显示适配器
  const usable = gpus.filter((g) => g && g.Name && !/microsoft basic|remote display|virtual display/i.test(g.Name));
  const gpu = (usable[0] || gpus[0]) || {};
  const name = String(gpu.Name || '');
  let vendor = 'unknown';
  if (/nvidia|geforce|rtx\s|gtx\s|quadro/i.test(name)) vendor = 'nvidia';
  else if (/(?<!virtual\s)(amd|radeon|rx\s\d)/i.test(name)) vendor = 'amd';
  else if (/intel|uhd\s|iris|arc\s/i.test(name)) vendor = 'intel';

  const ramBytes = Number(gpu.AdapterRAM) || 0;
  const qw = Number((raw && raw.vram) || 0);
  // AdapterRAM 是 32 位无符号，>4GB 会变成 4095MB，这种值不可信
  const vramMB = Math.round((qw > 0 ? qw : (ramBytes > 0 && ramBytes < 4096 * 1024 * 1024 ? ramBytes : 0)) / 1048576);

  const hypervisor = cs.HypervisorPresent === true;
  const accelOk = !!(accel && accel.ok);
  /**
   * 注意 WMI 这两个字段的坑（本机实测）：
   * Hyper-V / VBS 一旦接管 VT，`VMMonitorModeExtensions` 与
   * `SecondLevelAddressTranslationExtensions` 会返回 False —— 但机器明明能跑硬件加速。
   * 所以「False」只有在「没有 Hypervisor、加速也不可用」时才能当成「不支持」，
   * 否则一律当「未知」，别把能用的机器误判成不支持虚拟化。
   */
  const vmExt = cpu.VMMonitorModeExtensions;
  const slatRaw = cpu.SecondLevelAddressTranslationExtensions;
  let vtSupported = true;
  if (vmExt === false && !hypervisor && !accelOk) vtSupported = false;
  else if (vmExt !== true) vtSupported = 'unknown';
  const slat = slatRaw === true ? true : (slatRaw === false && !hypervisor && !accelOk ? false : 'unknown');
  // BIOS 侧：同理，Hypervisor 在跑时 firmware 字段也可能不可信
  let vtFirmware = null;
  if (cpu.VirtualizationFirmwareEnabled === true) vtFirmware = true;
  else if (cpu.VirtualizationFirmwareEnabled === false && !hypervisor && !accelOk) vtFirmware = false;
  const winHv = fileExists('System32\\WinHvPlatform.dll');
  const vmCompute = fileExists('System32\\vmcompute.exe');
  const aehd = fileExists('System32\\drivers\\aehd.sys');

  const state = (k) => {
    const v = feats && feats[k];
    return v ? String(v).toLowerCase() : 'unknown';
  };

  return {
    platform: process.platform,
    arch: process.arch,
    osBuild: (() => {
      const m = /(\d+)\s*$/.exec(os.release() || '');
      return m ? Number(m[1]) : 0;
    })(),
    cpu: {
      name: String(cpu.Name || '').trim(),
      cores: Number(cpu.NumberOfCores) || 0,
      threads: Number(cpu.NumberOfLogicalProcessors) || 0,
      vtSupported,
      vtFirmware,
      slat,
    },
    memory: {
      totalMB: Math.round((Number(cs.TotalPhysicalMemory) || os.totalmem()) / 1048576),
      freeMB: Math.round(os.freemem() / 1048576),
    },
    gpu: {
      name,
      vendor,
      vramMB,
      driverVersion: String(gpu.DriverVersion || ''),
      driverDate: dateToISO(gpu.DriverDate),
      status: String(gpu.Status || ''),
    },
    virtualization: {
      hypervisorPresent: hypervisor,
      hypervisorPlatform: state('HypervisorPlatform'),
      vmPlatform: state('VirtualMachinePlatform'),
      hyperV: state('Microsoft-Hyper-V-All'),
      winHvApi: winHv,
      vmCompute,
      aehdInstalled: aehd,
      accelOk,
      accelKind: accel && accel.ok ? String(accel.kind || 'whpx') : 'none',
    },
  };
}

// ---------------- 评估（纯函数） ----------------

/** 硬件推荐档位：内存 / 核心 / 画质。规则保守，宁可少给不可给多。 */
function recommendResources({ totalMB = 0, cores = 0, accelOk = false, vramMB = 0 } = {}) {
  const mem = Number(totalMB) || 0;
  const n = Number(cores) || 1;
  // 虚拟机最多吃宿主的一半，且留 1 核给 Windows；再按绝对区间收一次
  let memoryMB = 2048;
  if (mem >= 32768) memoryMB = 8192;
  else if (mem >= 16384) memoryMB = 6144;
  else if (mem >= 12288) memoryMB = 4096;
  else if (mem >= 8192) memoryMB = 3072;
  else memoryMB = 2048;
  if (mem && memoryMB > Math.floor(mem * 0.5 / 512) * 512) {
    memoryMB = Math.max(2048, Math.floor(mem * 0.5 / 512) * 512);
  }
  const wantCores = n >= 8 ? 4 : n >= 4 ? Math.max(2, n - 2) : 2;
  const c = Math.max(1, Math.min(wantCores, n - 1));
  // 软件模拟 + 小显存：分辨率降到 540p，帧率优先（画面面积只有 56%）
  const renderSize = (!accelOk || (vramMB > 0 && vramMB < 512)) ? '540x960' : 'auto';
  return { memoryMB, cores: c, renderSize };
}

/**
 * 渲染后端建议：0.6.4 起默认建议 host —— 让独显/核显真正参与渲染。
 * 之前 AMD/Intel 一律建议 swangle（软件渲染），独显机器也吃不到硬件加速。
 * 现在 host 崩了有 badGpu 记忆自动降级，swangle 只在「没加速 / 显存极小」时建议。
 */
function recommendGpu({ vendor = 'unknown', accelOk = false, vramMB = 0 } = {}) {
  if (!accelOk) return { gpuMode: 'software', why: t('preflight.why.noAccel') };
  if (vendor === 'unknown') return { gpuMode: 'auto', why: t('preflight.why.unknownGpu') };
  if (vramMB > 0 && vramMB < 512) return { gpuMode: 'swangle', why: t('preflight.why.lowVram') };
  // 有硬件加速、显卡识别得出就走 host（真正调用独显/核显）。显存读不到（0）不再
  // 当成「显卡弱」——核显共享内存本来就报 0，这正是以前误把核显降到软件的原因。
  if (vendor === 'nvidia') return { gpuMode: 'host', why: t('preflight.why.nvidia') };
  if (vendor === 'amd') return { gpuMode: 'host', why: t('preflight.why.amd') };
  if (vendor === 'intel') return { gpuMode: 'host', why: t('preflight.why.intel') };
  return { gpuMode: 'auto', why: t('preflight.why.auto') };
}

/**
 * 把探测结果翻译成体检报告。
 *
 * @param {object} o { hw, settings, edition } edition: 'store' | 'installer'
 * @returns {{ level:string, items:Array, patch:object|null, driver:object|null, summary:string }}
 */
function evaluate({ hw = {}, settings = {}, edition = 'installer' } = {}) {
  const v = hw.virtualization || {};
  const cpu = hw.cpu || {};
  const gpu = hw.gpu || {};
  const mem = hw.memory || {};
  const items = [];

  const add = (item) => items.push(item);

  // ---- 1. CPU 虚拟化（BIOS） ----
  if (cpu.vtSupported === false) {
    add({
      key: 'vt-unsupported',
      level: 'bad',
      title: t('preflight.vt-unsupported.title'),
      detail: t('preflight.vt-unsupported.detail'),
      action: null,
    });
  } else if (cpu.vtFirmware === false) {
    add({
      key: 'vt-bios-off',
      level: 'bad',
      title: t('preflight.vt-bios-off.title'),
      detail: t('preflight.vt-bios-off.detail'),
      action: { kind: 'manual', id: 'bios', label: t('preflight.vt-bios-off.label') },
    });
  } else if (cpu.vtFirmware === true) {
    add({
      key: 'vt-ok',
      level: 'ok',
      title: t('preflight.vt-ok.title'),
      detail: cpu.name ? t('preflight.vt-ok.detail', [cpu.name, cpu.cores || '?', cpu.threads || '?']) : '',
      action: null,
    });
  } else {
    add({
      key: 'vt-unknown',
      level: 'warn',
      title: t('preflight.vt-unknown.title'),
      detail: t('preflight.vt-unknown.detail'),
      action: { kind: 'manual', id: 'bios', label: t('preflight.vt-unknown.label') },
    });
  }

  // ---- 2. Windows 侧：WHPX / Hyper-V ----
  const hp = String(v.hypervisorPlatform || 'unknown');
  const hpxOn = hp === 'enabled' || (hp === 'unknown' && v.winHvApi && v.hypervisorPresent);
  if (hpxOn) {
    add({
      key: 'whpx-ok',
      level: 'ok',
      title: t('preflight.whpx-ok.title'),
      detail: v.hypervisorPresent
        ? t('preflight.whpx-ok.detailRunning')
        : t('preflight.whpx-ok.detailRestart'),
      action: null,
    });
  } else if (edition === 'store') {
    add({
      key: 'whpx-off',
      level: 'bad',
      title: t('preflight.whpx-off.title'),
      detail: t('preflight.whpx-off.detailStore'),
      action: { kind: 'elevate', id: 'virtualization', label: t('preflight.whpx-off.labelStore') },
    });
  } else {
    add({
      key: 'whpx-off',
      level: 'bad',
      title: t('preflight.whpx-off.title'),
      detail: t('preflight.whpx-off.detailInstaller'),
      action: { kind: 'elevate', id: 'virtualization', label: t('preflight.whpx-off.labelInstaller') },
    });
  }

  // ---- 3. 硬件加速当前是否真的能用 ----
  if (v.accelOk) {
    add({
      key: 'accel-ok',
      level: 'ok',
      title: t('preflight.accel-ok.title', [v.accelKind === 'aehd' ? 'AEHD' : 'WHPX']),
      detail: t('preflight.accel-ok.detail'),
      action: null,
    });
  } else {
    add({
      key: 'accel-off',
      level: 'warn',
      title: t('preflight.accel-off.title'),
      detail: edition === 'installer' && v.vtFirmware !== false
        ? t('preflight.accel-off.detailInstaller')
        : t('preflight.accel-off.detailPlain'),
      action: edition === 'installer' && v.vtFirmware !== false
        ? { kind: 'elevate', id: 'accel', label: t('preflight.accel-off.label') }
        : null,
    });
  }

  // ---- 4. 显卡 ----
  if (!gpu.name) {
    add({
      key: 'gpu-unknown',
      level: 'warn',
      title: t('preflight.gpu-unknown.title'),
      detail: t('preflight.gpu-unknown.detail'),
      action: null,
    });
  } else {
    const integrated = /radeon\s+(graphics|vega)|uhd|iris|hd\s+graphics|vega/i.test(gpu.name);
    const vram = gpu.vramMB
      ? t('preflight.vram', [(gpu.vramMB / 1024).toFixed(1), integrated ? t('preflight.vramIntegrated') : ''])
      : t('preflight.vramUnknown');
    add({
      key: 'gpu-info',
      level: 'ok',
      title: `${gpu.name}`,
      detail: `${vram}${gpu.driverVersion ? t('preflight.driverVersion', [gpu.driverVersion]) : ''}${gpu.driverDate ? t('preflight.driverDate', [gpu.driverDate]) : ''}`,
      action: null,
    });
    const old = /^(19|20)\d{2}-\d{2}-\d{2}$/.test(gpu.driverDate || '')
      ? (Date.now() - new Date(gpu.driverDate).getTime()) / 31536000000 : 0;
    if (old > 3) {
      add({
        key: 'gpu-driver-old',
        level: 'warn',
        title: t('preflight.gpu-driver-old.title'),
        detail: t('preflight.gpu-driver-old.detail', [gpu.driverDate, Math.floor(old)]),
        action: null,
      });
    }
  }

  // ---- 5. 内存 / 磁盘 / 系统版本 ----
  const total = Number(mem.totalMB) || 0;
  if (!total) {
    add({ key: 'mem-unknown', level: 'warn', title: t('preflight.mem-unknown.title'), detail: '', action: null });
  } else if (total < 6144) {
    add({
      key: 'mem-low',
      level: 'warn',
      title: t('preflight.mem-low.title', [(total / 1024).toFixed(1)]),
      detail: t('preflight.mem-low.detail'),
      action: null,
    });
  } else {
    add({
      key: 'mem-ok',
      level: 'ok',
      title: t('preflight.mem-ok.title', [(total / 1024).toFixed(0)]),
      detail: '',
      action: null,
    });
  }

  const build = Number(hw.osBuild) || 0;
  if (build && build < 19041) {
    add({
      key: 'os-old',
      level: 'warn',
      title: t('preflight.os-old.title', [build]),
      detail: t('preflight.os-old.detail'),
      action: null,
    });
  }

  // ---- 建议配置 ----
  const rec = recommendResources({ totalMB: total, cores: cpu.threads || cpu.cores, accelOk: !!v.accelOk, vramMB: gpu.vramMB });
  const gpuRec = recommendGpu({ vendor: gpu.vendor, accelOk: !!v.accelOk, vramMB: gpu.vramMB });
  const patch = {
    engine: {
      autoMemory: false,
      memoryMB: rec.memoryMB,
      cores: rec.cores,
      renderSize: rec.renderSize,
      // 加速不可用 → 直接锁定软件模拟，省掉两轮白等；可用则交回 auto 让降级链工作
      gpuMode: v.accelOk ? 'auto' : 'software',
      forceTcg: !v.accelOk,
    },
  };

  // 给这台机器生成一份驱动：以后每次开机都按它来，不用重复体检
  const vendor = gpu.vendor && gpu.vendor !== 'unknown' ? gpu.vendor : 'unknown';
  const driver = {
    format: 'apkstart-driver/1',
    id: `auto-${vendor}-${build || 'x'}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-'),
    name: t('preflight.driverName', [gpu.name || vendor]),
    version: '1.0.0',
    author: t('preflight.driverAuthor'),
    description: t('preflight.driverDescription', [gpuRec.why, v.accelOk ? t('preflight.driverAccelOk') : t('preflight.driverAccelNone')]),
    priority: 5,
    match: {
      platform: [hw.platform || process.platform],
      arch: [hw.arch || process.arch],
      ...(vendor !== 'unknown' ? { gpuVendor: [vendor] } : {}),
      ...(build ? { osBuild: { min: build - 2000, max: build + 2000 } } : {}),
    },
    effect: {
      gpuMode: gpuRec.gpuMode,
      ...(v.accelOk ? {} : { forceTcg: true }),
      notes: [gpuRec.why],
    },
  };

  const bad = items.filter((i) => i.level === 'bad').length;
  const warn = items.filter((i) => i.level === 'warn').length;
  const level = bad ? 'bad' : warn ? 'warn' : 'good';
  const summary = bad
    ? t('preflight.summary.bad', [bad, items.filter((i) => i.level === 'bad').map((i) => i.title).join(t('list.sepComma'))])
    : warn
      ? t('preflight.summary.warn', [warn, items.filter((i) => i.level === 'warn').map((i) => i.title).join(t('list.sepComma'))])
      : t('preflight.summary.good');

  return {
    level,
    items,
    patch,
    driver,
    recommended: { ...rec, ...gpuRec },
    summary,
  };
}

module.exports = {
  collect,
  evaluate,
  recommendResources,
  recommendGpu,
  psJson,
};
