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
let OUT = process.env.APKSTART_PACK_OUT
  ? path.resolve(process.env.APKSTART_PACK_OUT)
  : path.join(ROOT, 'dist', 'ApkStart-win64-portable');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

function copy(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

console.log('打包便携版 →', OUT);
// 目标已存在时不做整树删除：部分环境会拦截批量删除，且打包中途失败会丢掉
// 上一个可用版本。改为先把旧目录改名保留，再全新构建；占用中则自动换目录。
if (fs.existsSync(OUT)) {
  try {
    const backup = `${OUT}.prev-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(OUT, backup);
    console.log('旧版本已保留 →', backup);
  } catch (_) {
    // 某些环境（杀软 / 搜索索引 / 资源管理器）会长时间持有目录句柄，
    // 整目录改名必然 EBUSY；这时退到带版本号的目录，产物一样可用且不再重名。
    OUT = path.join(ROOT, 'dist', `ApkStart-v${require(path.join(ROOT, 'package.json')).version}-win64-portable`);
    console.log('旧目录被占用，改输出到 →', OUT);
  }
}
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

console.log(`完成。运行 ${path.join(OUT, 'ApkStart.exe')} 即可使用。`);
