'use strict';
/**
 * 生成 userdata 种子镜像（调试用）。
 * 用法: node tools/make-userdata.js <输出文件> [大小MB]
 */
const fs = require('fs');
const { buildEmptyExt4 } = require('../src/core/userdata');

const out = process.argv[2];
if (!out) {
  console.error('用法: node tools/make-userdata.js <输出文件> [大小MB]');
  process.exit(2);
}
const sizeMB = Number(process.argv[3] || 64);
const img = buildEmptyExt4({ sizeMB });
fs.writeFileSync(out, img);
console.log(`已生成 ${out}（${(img.length / 1024 / 1024).toFixed(0)}MB，ext4/4KB block）`);
