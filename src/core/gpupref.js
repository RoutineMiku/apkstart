'use strict';
/**
 * 独显 / 核显渲染偏好（Windows 10 1803+ 的 UserGpuPreferences 机制）
 *
 * 背景：PC 上有独显 + 核显时，Windows 默认按「应用是普通窗口还是游戏」自己挑 GPU，
 * 模拟器这种 Qt 进程经常被分到核显，即使机器有独显也用不上。Windows 允许为每个 exe
 * 指定「节能（核显）/ 高性能（独显）/ 系统默认」，写在 HKCU 下，无需管理员权限：
 *
 *   HKCU\Software\Microsoft\DirectX\UserGpuPreferences
 *     <exe 完整路径> = "GpuPreference=1;"   // 1 = 节能（核显）
 *                     = "GpuPreference=2;"   // 2 = 高性能（独显）
 *     // 删除该值 = 回到系统默认（auto）
 *
 * 纯逻辑模块：算注册表键/值、模式归一化，不在这里执行 reg.exe。主进程拿到
 * preferenceCommand() 的结果后自己决定是否执行（写注册表是可选增强，失败不影响启动）。
 */
const KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';

const MODES = Object.freeze({
  auto: { value: '', preference: null, label: '系统默认（推荐）' },
  integrated: { value: 'GpuPreference=1;', preference: 1, label: '核显优先（省电）' },
  discrete: { value: 'GpuPreference=2;', preference: 2, label: '独显优先（性能）' },
});

/** 归一化模式：非法值一律回退 auto，绝不让外部输入拼进注册表命令 */
function normalize(mode) {
  const m = String(mode || '').toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(MODES, m) ? m : 'auto';
}

/** 该模式对应的注册表数据；auto 返回空串（表示应删除该值） */
function valueFor(mode) {
  return MODES[normalize(mode)].value;
}

/**
 * 生成要执行的 reg 命令。返回 null 表示无需改动（auto 且本来就没设置）。
 * @param {string} exePath 目标 exe 完整路径（emulator.exe）
 * @param {string} mode auto | integrated | discrete
 * @returns {{args:string[], mode:string, action:'set'|'remove'}|null}
 */
function preferenceCommand(exePath, mode) {
  const exe = String(exePath || '').trim();
  if (!exe) return null;
  const normalized = normalize(mode);
  if (normalized === 'auto') {
    return { args: ['delete', KEY, '/v', exe, '/f'], mode: normalized, action: 'remove' };
  }
  const value = MODES[normalized].value;
  return { args: ['add', KEY, '/v', exe, '/t', 'REG_SZ', '/d', value, '/f'], mode: normalized, action: 'set' };
}

/**
 * 判断一段 UserGpuPreferences 的值属于哪种模式（用于自检/报告）。
 * 兼容带前后空格、大小写差异、以及 "GpuPreference=2;OtherKey=x;" 这种多键串。
 */
function parseValue(raw) {
  const s = String(raw || '');
  const m = /GpuPreference\s*=\s*([12])\s*(?:;|$)/i.exec(s);
  if (!m) return 'auto';
  return m[1] === '2' ? 'discrete' : 'integrated';
}

module.exports = { KEY, MODES, normalize, valueFor, preferenceCommand, parseValue };
