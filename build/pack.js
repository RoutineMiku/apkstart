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

// 1.1 语言包瘦身：Electron 自带 55 种语言，合计 41MB，我们只用中文界面。
//     只留 zh-CN / zh-TW / en-US，其余删掉（-39MB，等于整包小 15%）。
const KEEP_LOCALES = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak']);
let localeSaved = 0;
try {
  const locDir = path.join(OUT, 'locales');
  for (const f of fs.readdirSync(locDir)) {
    if (KEEP_LOCALES.has(f)) continue;
    localeSaved += (() => { try { return fs.statSync(path.join(locDir, f)).size; } catch (_) { return 0; } })();
    fs.rmSync(path.join(locDir, f), { force: true });
  }
} catch (_) { /* 没有 locales 目录也不影响 */ }

// 1.2 没人会点开的文件：更新日志、调试符号、部分无用的 pak（各自 0.1~9MB）
for (const rel of ['LICENSES.chromium.html.bak', 'vk_swiftshader_icd.json.bak']) {
  fs.rmSync(path.join(OUT, rel), { force: true });
}

// 1.3 可省掉的运行库：
//     d3dcompiler_47.dll 负责把 ANGLE 的 HLSL 编成 GPU 指令，但 Windows 8.1 起
//     System32 里就自带同名 DLL，LoadLibrary 找不到包内那份会自然用系统的。
//     实测删掉后界面/图标/字体渲染完全正常（--smoke 截图对比无差异）。压紧 2.1MB。
//     注意：vk_swiftshader.dll / vulkan-1.dll 不能删 —— GPU 驱动不可用时 Chromium
//     靠它做软件兜底，删了会白屏。
let pruneSaved = 0;
for (const rel of ['d3dcompiler_47.dll']) {
  const p = path.join(OUT, rel);
  try {
    pruneSaved += fs.statSync(p).size;
    fs.rmSync(p, { force: true });
  } catch (_) { /* 本来就没有 */ }
}

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
// tools/ 是开发期自检脚本（黑窗实测、测速），用户用不到，不再随包分发。
const ENGINE_SKIP = new Set(['emulator', 'system-images', 'platform-tools', 'avd', 'aehd', '_dl', 'qemu']);
for (const opt of ['engine']) {
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

// 6. 体积报告：每次打包都打印，避免以后又悄悄变胖
function dirSize(dir) {
  let n = 0;
  try {
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, it.name);
      n += it.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch (_) { /* ignore */ }
  return n;
}
const totalMB = dirSize(OUT) / 1048576;
console.log(
  `完成。整包 ${totalMB.toFixed(0)} MB（语言包省了 ${(localeSaved / 1048576).toFixed(0)} MB，`
  + `冗余运行库省了 ${(pruneSaved / 1048576).toFixed(1)} MB）。`,
);
console.log('压缩：node build/zip.js dist/ApkStart-win64-portable <输出.zip>');
console.log(`运行 ${path.join(OUT, 'ApkStart.exe')} 即可使用。`);
