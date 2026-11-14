'use strict';
/**
 * 版本号比较。独立成模块，避免 updater ↔ sources 互相 require 形成循环依赖。
 */

/** v0.3.2 / 0.3.2-preview / 1.0.0+build 归一化成可比较的数组 */
function parseVer(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((x) => (/^\d+$/.test(x) ? Number(x) : x))
    .filter((x) => x !== '');
}

/** a>b 返回 1，a<b 返回 -1，相等 0 */
function cmpVer(a, b) {
  const A = parseVer(a);
  const B = parseVer(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i += 1) {
    const x = A[i];
    const y = B[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1;
    } else {
      const sx = String(x);
      const sy = String(y);
      if (sx !== sy) return sx < sy ? -1 : 1;
    }
  }
  return 0;
}

module.exports = { parseVer, cmpVer };
