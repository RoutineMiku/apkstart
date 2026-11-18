'use strict';
const { t } = require('../i18n');
/**
 * 游戏按键映射 —— 纯数据层
 *
 * 把键盘按键映射到安卓触屏坐标。每个映射条目：
 *   { key: 'w', action: 'tap', x: 0.15, y: 0.85 }   // 相对坐标 (0~1)
 *   { key: 'space', action: 'tap', x: 0.5, y: 0.9 }
 *   { key: 'j', action: 'swipe', x1: 0.7, y1: 0.5, x2: 0.3, y2: 0.5, duration: 100 }
 *
 * 坐标是相对于 LCD 面板的归一化值 (0~1)，运行时乘以实际 wm size 得到像素。
 *
 * 预设模板覆盖常见游戏类型：
 *   - fps: WASD 移动摇杆区域 + 鼠标瞄准（鼠标由 Qt 原生处理，这里只管键盘）
 *   - rpg: WASD 移动 + J/K/L 技能 + Space 确认
 *   - generic: 方向键 + Enter/Space
 */

const PRESETS = {
  fps: {
    get label() { return t('FPS / 射击类'); },
    get desc() { return t('WASD 控制左侧虚拟摇杆区域，J 射击，K 换弹，Space 跳跃'); },
    mappings: [
      { key: 'w', action: 'tap', x: 0.15, y: 0.75 },
      { key: 'a', action: 'tap', x: 0.08, y: 0.82 },
      { key: 's', action: 'tap', x: 0.15, y: 0.89 },
      { key: 'd', action: 'tap', x: 0.22, y: 0.82 },
      { key: 'j', action: 'tap', x: 0.85, y: 0.75 },
      { key: 'k', action: 'tap', x: 0.92, y: 0.82 },
      { key: ' ', action: 'tap', x: 0.78, y: 0.82 },
    ],
  },
  rpg: {
    get label() { return t('RPG / 动作类'); },
    get desc() { return t('WASD 移动，J 攻击，K 技能，L 大招，Space 确认/对话'); },
    mappings: [
      { key: 'w', action: 'tap', x: 0.15, y: 0.75 },
      { key: 'a', action: 'tap', x: 0.08, y: 0.82 },
      { key: 's', action: 'tap', x: 0.15, y: 0.89 },
      { key: 'd', action: 'tap', x: 0.22, y: 0.82 },
      { key: 'j', action: 'tap', x: 0.82, y: 0.78 },
      { key: 'k', action: 'tap', x: 0.90, y: 0.78 },
      { key: 'l', action: 'tap', x: 0.86, y: 0.70 },
      { key: ' ', action: 'tap', x: 0.5, y: 0.92 },
    ],
  },
  generic: {
    get label() { return t('通用 / 休闲类'); },
    get desc() { return t('方向键移动，Enter 确认，Space 取消/返回'); },
    mappings: [
      { key: 'ArrowUp', action: 'tap', x: 0.15, y: 0.75 },
      { key: 'ArrowLeft', action: 'tap', x: 0.08, y: 0.82 },
      { key: 'ArrowDown', action: 'tap', x: 0.15, y: 0.89 },
      { key: 'ArrowRight', action: 'tap', x: 0.22, y: 0.82 },
      { key: 'Enter', action: 'tap', x: 0.5, y: 0.92 },
      { key: ' ', action: 'keyevent', code: 4 },  // BACK
    ],
  },
};

/**
 * 把 Electron 的 key 名标准化为映射表里用的格式。
 * Electron KeyboardEvent.key 值如 'w', 'W', 'ArrowUp', ' ', 'Enter' 等。
 */
function normalizeKey(key) {
  if (!key) return '';
  // 单字母统一小写
  if (key.length === 1 && /[A-Za-z]/.test(key)) return key.toLowerCase();
  return key;
}

/**
 * 查找某个按键在当前映射表里的动作。
 * @param {Array} mappings 映射条目数组
 * @param {string} key Electron KeyboardEvent.key
 * @returns {object|null} 匹配的映射条目
 */
function lookup(mappings, key) {
  const nk = normalizeKey(key);
  if (!nk || !Array.isArray(mappings)) return null;
  return mappings.find((m) => normalizeKey(m.key) === nk) || null;
}

/**
 * 把映射条目 + LCD 尺寸转成 adb shell 命令。
 * @param {object} mapping 映射条目
 * @param {number} width LCD 宽度（像素）
 * @param {number} height LCD 高度（像素）
 * @returns {string} adb shell 命令（如 'input tap 192 612'）
 */
function toCommand(mapping, width, height) {
  if (!mapping) return '';
  if (mapping.action === 'tap') {
    const x = Math.round(mapping.x * width);
    const y = Math.round(mapping.y * height);
    return `input tap ${x} ${y}`;
  }
  if (mapping.action === 'swipe') {
    const x1 = Math.round(mapping.x1 * width);
    const y1 = Math.round(mapping.y1 * height);
    const x2 = Math.round(mapping.x2 * width);
    const y2 = Math.round(mapping.y2 * height);
    const dur = mapping.duration || 100;
    return `input swipe ${x1} ${y1} ${x2} ${y2} ${dur}`;
  }
  if (mapping.action === 'keyevent') {
    return `input keyevent ${mapping.code}`;
  }
  return '';
}

module.exports = { PRESETS, normalizeKey, lookup, toCommand };
