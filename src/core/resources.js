'use strict';
const { t } = require('../i18n');
/**
 * 资源分配（内存 / CPU / 存储）的纯逻辑。
 *
 * 为什么要单独一层：「给安卓分多少内存」最终要落进 qemu 命令行（-memory / -cores），
 * 改完下次开机生效；但「用户能填多大」「填过头会发生什么」这套判断是纯函数，
 * 抽出来不依赖 electron，CI 里可以直接 require 做单测。
 *
 * 三条硬约束（都是实测踩出来的）：
 *   1. 内存不能把宿主吃满：Windows + 前台程序至少要留 25%，否则整机开始换页，
 *      安卓侧表现为长时间黑屏、动画卡死，看起来像「模拟器坏了」。
 *   2. 存储要按「安装包 × 1.8 + 2GB」估：50GB 的在线游戏解包后往往 80~90GB，
 *      只按安装包大小放行，一定会装到一半失败。
 *   3. 任何自动值都必须能算得出来：拿不到宿主信息就退回保守默认，不能返回 NaN。
 */

const DEFAULT_STEP_MB = 512;
const MIN_MEM_MB = 1024;
/** 给宿主（Windows + 前台程序）留的比例 */
const HOST_RESERVE_RATIO = 0.25;
/** 低于这个比例就提示「偏紧」 */
const TIGHT_RATIO = 0.8;
/** 完全不够用（连系统都跑不动）的绝对下限 */
const ABSOLUTE_MIN_MB = 768;

function toInt(v, fallback = 0) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 宿主能力。参数可注入，方便测试；不传就读本机。
 * @returns {{ totalMB:number, cores:number }}
 */
function hostProfile(sys) {
  let totalMB = 0;
  let cores = 0;
  const src = sys || {};
  if (Number(src.totalMB) > 0) {
    totalMB = toInt(src.totalMB);
  } else if (Number(src.totalmem) > 0) {
    totalMB = Math.round(Number(src.totalmem) / 1048576);
  } else {
    try {
      // require('os') 放在函数里：避免模块加载期就去碰宿主环境
      const os = require('os');
      totalMB = Math.round(os.totalmem() / 1048576);
      cores = os.cpus() ? os.cpus().length : 0;
    } catch (_) { totalMB = 0; }
  }
  if (Number(src.cores) > 0) cores = toInt(src.cores);
  return { totalMB, cores: Math.max(1, cores || 1) };
}

/**
 * 内存可填范围。没读到宿主内存时给一个保守上限，避免界面出现 0。
 * @returns {{ minMB:number, maxMB:number, stepMB:number, totalMB:number }}
 */
function memoryLimits(totalMB) {
  const total = toInt(totalMB);
  if (total <= 0) return { minMB: MIN_MEM_MB, maxMB: 8192, stepMB: DEFAULT_STEP_MB, totalMB: 0 };
  const usable = Math.floor((total * (1 - HOST_RESERVE_RATIO)) / DEFAULT_STEP_MB) * DEFAULT_STEP_MB;
  const maxMB = Math.max(MIN_MEM_MB, Math.min(usable, 65536));
  return { minMB: MIN_MEM_MB, maxMB, stepMB: DEFAULT_STEP_MB, totalMB: total };
}

/**
 * 把用户填的内存收敛到合法值。0 = 自动，原样返回 0（由各底座自己推导）。
 * @returns {{ mb:number, capped:boolean, reason:string }}
 */
function clampMemoryMB(mb, totalMB) {
  const want = toInt(mb);
  if (want <= 0) return { mb: 0, capped: false, reason: 'auto' };
  const lim = memoryLimits(totalMB);
  const rounded = Math.round(want / lim.stepMB) * lim.stepMB;
  if (rounded > lim.maxMB) {
    return {
      mb: lim.maxMB,
      capped: true,
      reason: t('宿主内存 {v1} GB，最多只能分 {v2} GB（要留 25% 给 Windows）', { v1: Math.round(lim.totalMB / 1024), v2: Math.round(lim.maxMB / 1024) }),
    };
  }
  if (rounded < lim.minMB) return { mb: lim.minMB, capped: true, reason: t('安卓至少要 {minMB} MB 才能启动', { minMB: lim.minMB }) };
  return { mb: rounded, capped: rounded !== want, reason: rounded !== want ? t('已按 512 MB 对齐') : '' };
}

/**
 * CPU 核心数收敛。0 = 自动。
 * 上限定在「物理核 - 1」，至少留 1 核给宿主；单核机器只给 1 核。
 */
function clampCores(n, hostCores) {
  const want = toInt(n);
  const total = Math.max(1, toInt(hostCores) || 1);
  const max = total > 1 ? total - 1 : 1;
  if (want <= 0) return { cores: 0, capped: false, reason: 'auto' };
  if (want > max) {
    return { cores: max, capped: true, reason: t('本机 {total} 核，最多分 {max} 核（留 1 核给 Windows）', { total, max }) };
  }
  return { cores: Math.max(1, want), capped: false, reason: '' };
}

/**
 * 内存分配合不合理（用于界面提示 + 装大包前提醒）。
 * @returns {{ level:'ok'|'tight'|'insufficient'|'unknown', ratio:number, note:string }}
 */
function memVerdict(allocMB, hostMB) {
  const alloc = toInt(allocMB);
  const host = toInt(hostMB);
  if (!alloc || !host) return { level: 'unknown', ratio: 0, note: '' };
  if (alloc < ABSOLUTE_MIN_MB) {
    return { level: 'insufficient', ratio: alloc / host, note: t('只分 {alloc} MB，安卓可能起不来', { alloc }) };
  }
  const ratio = alloc / host;
  if (ratio > 1 - HOST_RESERVE_RATIO) {
    return {
      level: 'insufficient',
      ratio,
      note: t('占了宿主 {v1}% 内存，Windows 会开始换页，模拟器反而更卡', { v1: Math.round(ratio * 100) }),
    };
  }
  if (ratio > TIGHT_RATIO * (1 - HOST_RESERVE_RATIO)) {
    return { level: 'tight', ratio, note: t('已用 {v1}% 宿主内存，建议同时关掉浏览器标签页', { v1: Math.round(ratio * 100) }) };
  }
  return { level: 'ok', ratio, note: '' };
}

/** 安装一个包实际要占的数据分区空间（含解包与更新包冗余） */
function diskRequiredMB(packageBytes, ratio = 1.8, reserveMB = 2048) {
  const bytes = Math.max(0, Number(packageBytes) || 0);
  if (!bytes) return reserveMB;
  return Math.ceil((bytes / 1048576) * ratio) + reserveMB;
}

/**
 * 数据分区可填上限。磁盘只剩一点时不能让人填 64GB 然后装到一半失败。
 * @returns {{ maxGB:number, warnGB:number, freeMB:number }}
 */
function diskLimits(freeMB) {
  const free = Math.max(0, toInt(freeMB));
  // 分区镜像本身还要占宿主空间（动态镜像会涨到接近分区大小），留 20% 缓冲
  const maxGB = Math.max(0, Math.floor((free / 1024) * 0.8));
  return { maxGB, warnGB: Math.max(0, maxGB - 8), freeMB: free };
}

/**
 * 收敛用户填的数据分区大小（GB）。0 = 自动。
 * @returns {{ gb:number, capped:boolean, reason:string }}
 */
function clampDataGB(gb, freeMB) {
  const want = toInt(gb);
  if (want <= 0) return { gb: 0, capped: false, reason: 'auto' };
  const lim = diskLimits(freeMB);
  if (!lim.freeMB) return { gb: want, capped: false, reason: '' };
  if (want > lim.maxGB) {
    return {
      gb: Math.max(0, lim.maxGB),
      capped: true,
      reason: t('所在磁盘只剩 {v1} GB，最多能分 {maxGB} GB', { v1: (lim.freeMB / 1024).toFixed(1), maxGB: lim.maxGB }),
    };
  }
  return { gb: want, capped: false, reason: '' };
}

/**
 * 存储是否够装这个包。
 * @returns {{ ok:boolean, needMB:number, freeMB:number, shortMB:number, note:string }}
 */
function storageVerdict(freeMB, packageBytes) {
  const need = diskRequiredMB(packageBytes);
  const free = Math.max(0, toInt(freeMB));
  if (!free) return { ok: true, needMB: need, freeMB: 0, shortMB: 0, note: t('读不到磁盘剩余空间，跳过预检') };
  if (free >= need) return { ok: true, needMB: need, freeMB: free, shortMB: 0, note: '' };
  const short = need - free;
  return {
    ok: false,
    needMB: need,
    freeMB: free,
    shortMB: short,
    note: t('需要约 {v1} GB，当前只剩 {v2} GB，还差 {v3} GB', { v1: (need / 1024).toFixed(1), v2: (free / 1024).toFixed(1), v3: (short / 1024).toFixed(1) }),
  };
}

/**
 * 磁盘空间是否够装这个包（50GB 级游戏最常见的失败点）。
 * 和 storageVerdict 的区别：这个只看「够不够」，文案是给安装前拦下来用的。
 * @returns {{ ok:boolean, unknown?:boolean, freeMB:number, requiredMB:number, message:string }}
 */
function diskVerdict(freeMB, requiredMB) {
  const free = Math.max(0, toInt(freeMB));
  const need = Math.max(0, toInt(requiredMB));
  if (!free) return { ok: true, unknown: true, freeMB: 0, requiredMB: need, message: '' };
  if (free >= need) return { ok: true, freeMB: free, requiredMB: need, message: '' };
  return {
    ok: false,
    freeMB: free,
    requiredMB: need,
    message: t('磁盘空间不足：还要约 {v1} GB，但 ApkStart 运行时所在磁盘只剩 {v2} GB。', { v1: Math.ceil(need / 1024), v2: (free / 1024).toFixed(1) })
      + t('请在设置里把运行时目录挪到空间更大的分区，或清理后重试。'),
  };
}

module.exports = {
  DEFAULT_STEP_MB,
  MIN_MEM_MB,
  HOST_RESERVE_RATIO,
  hostProfile,
  memoryLimits,
  clampMemoryMB,
  clampCores,
  memVerdict,
  diskRequiredMB,
  diskVerdict,
  diskLimits,
  clampDataGB,
  storageVerdict,
};
