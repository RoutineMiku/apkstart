#!/usr/bin/env node
'use strict';
/**
 * .apk 关联命令行开关（无需启动界面）
 *   node scripts/assoc.js on   → 注册双击 APK 安装
 *   node scripts/assoc.js off  → 取消关联
 */
const path = require('path');
const fs = require('fs');
const { registerAssociation, unregisterAssociation } = require('../src/core/assoc');

const action = process.argv[2] || 'on';
const isDev = !process.env.APKSTART_PACKAGED;
const exe = isDev
  ? path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe')
  : process.execPath;
const appDir = path.join(__dirname, '..');

if (action === 'on') {
  const iconPath = path.join(__dirname, '..', 'build', 'apkstart.ico');
  const r = registerAssociation(exe, fs.existsSync(iconPath) ? iconPath : undefined,
    isDev ? `"${appDir}"` : undefined);
  console.log('已注册 .apk 关联：', r.progId);
  console.log('现在在资源管理器中双击 .apk 即可安装到 ApkStart。');
} else if (action === 'off') {
  unregisterAssociation();
  console.log('已取消 .apk 关联。');
} else {
  console.log('用法：node scripts/assoc.js [on|off]');
  process.exit(1);
}
