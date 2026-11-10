'use strict';
/**
 * 便携版打包：产出 dist/ApkStart-win64-portable/
 *   ApkStart.exe（即 electron.exe 改名）+ resources/app（本应用源码）
 * 无需安装器，解压即用；将来接 electron-builder 出安装包时可复用同一目录结构。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 允许指定输出目录（用于目标目录被正在运行的实例占用时，先构建到别处再替换）
const OUT = process.env.APKSTART_PACK_OUT
  ? path.resolve(process.env.APKSTART_PACK_OUT)
  : path.join(ROOT, 'dist', 'ApkStart-win64-portable');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copy(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

console.log('打包便携版 →', OUT);
rmrf(OUT);
fs.mkdirSync(path.join(OUT, 'resources', 'app'), { recursive: true });

// 1. Electron 运行时
console.log('复制 Electron 运行时…');
copy(ELECTRON_DIST, OUT);
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

// 2. 应用本体
console.log('复制应用…');
const appDir = path.join(OUT, 'resources', 'app');
for (const item of ['package.json', 'src', 'LICENSE']) {
  const src = path.join(ROOT, item);
  if (fs.existsSync(src)) copy(src, path.join(appDir, item));
}

// 3. 可选目录
// engine/ 下只有文档类内容随包分发；大体积运行时组件（emulator、system-images、
// platform-tools、avd）由应用首次启动时自动从官方源下载，不进安装包。
const ENGINE_SKIP = new Set(['emulator', 'system-images', 'platform-tools', 'avd', 'aehd', '_dl', 'qemu']);
for (const opt of ['tools', 'engine']) {
  const src = path.join(ROOT, opt);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(appDir, opt);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (opt === 'engine' && ENGINE_SKIP.has(entry.name)) continue;
    fs.cpSync(path.join(src, entry.name), path.join(dest, entry.name), { recursive: true });
  }
}

// 4. 改名主程序
fs.renameSync(path.join(OUT, 'electron.exe'), path.join(OUT, 'ApkStart.exe'));

// 5. 版本信息
const pkg = require(path.join(ROOT, 'package.json'));
fs.writeFileSync(path.join(OUT, 'VERSION.txt'), `ApkStart ${pkg.version}\n构建时间：${new Date().toLocaleString('zh-CN')}\n`);

console.log('完成。运行 dist/ApkStart-win64-portable/ApkStart.exe 即可使用。');
