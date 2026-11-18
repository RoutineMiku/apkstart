'use strict';
/**
 * 独立运行守卫：安装包里**不允许**出现第三方模拟器的任何文件。
 *
 * 为什么需要一道构建期检查：
 *   ApkStart 的安装包（NSIS / 便携版 / MSIX）必须开箱即用 —— 自带 emulator +
 *   platform-tools + 系统镜像，装完就能跑，不要求用户先装 MuMu / 雷电 / 蓝叠。
 *   0.5.6 起更进一步：**代码里根本没有第三方底座**，安装的不是「自带运行时 + 可选复用」，
 *   而是「只有自带运行时」。所以这里除了拦二进制，也拦第三方底座的适配器源码
 *   （backends/mumu.js / backends/fydeos.js / mumu-compat.js）—— 一旦有人把它们加回来，
 *   构建直接失败，避免「代码里又留了一条能接管别人模拟器的路」。
 *
 *   这条约束很容易被悄悄破坏：比如某次把 MuMu 目录当运行时拷进了 build/runtime，
 *   或者在本地把模拟器目录塞进 resources 再打包。那时候应用在开发机上照样能跑，
 *   用户装完却是「要另外装个模拟器」——问题只在别人电脑上暴露。
 *   所以在打包前扫一遍文件名，命中就直接让构建失败。
 */

const fs = require('fs');
const path = require('path');

/**
 * 这些名字一旦出现在打包产物里，就说明把「别人的模拟器」塞进来了。
 * 只匹配各个模拟器自己的特征文件名，不用宽泛的 /android/ 之类，避免误报。
 */
const BANNED = [
  { re: /^mumu/i, vendor: 'MuMu 模拟器' },          // MuMuManager.exe / MuMuPlayer.exe / MuMuVMMVbox
  { re: /\.nemu$/i, vendor: 'MuMu 模拟器' },        // 实例描述文件 MuMuPlayer-12.0-0.nemu
  { re: /^nemu$/i, vendor: 'MuMu 模拟器' },         // MuMu 的 nemu 目录
  { re: /^nx_main$/i, vendor: 'MuMu 模拟器' },      // MuMu 的 nx_main / nx_device 目录
  { re: /^nx_device$/i, vendor: 'MuMu 模拟器' },
  { re: /^ldplayer/i, vendor: '雷电模拟器' },
  { re: /^dnplayer/i, vendor: '雷电模拟器' },
  { re: /^bluestacks/i, vendor: '蓝叠模拟器' },
  { re: /^hd-player/i, vendor: '蓝叠模拟器' },
  { re: /^mgalaxy/i, vendor: 'MEmu 模拟器' },
];

/** 只有这些扩展名算「模拟器本体」；.js/.md/.json 这类是源码与配置，不在拦截范围内 */
const BINARY_EXT = /\.(exe|dll|sys|nemu|vdi|vmdk|vbox|iso|msi|bin|dat|db|img)$/i;

/**
 * 递归找命中的文件/目录。
 * @param {string} dir 要扫描的根目录（通常是打包出来的 resources/runtime 或 app 目录）
 * @param {object} [opts] { limit } 命中多少个就停（默认 20，够用来提示）
 * @returns {Array<{path: string, name: string, vendor: string}>}
 */
function findBundled(dir, { limit = 20 } = {}) {
  const hits = [];
  const walk = (d) => {
    if (hits.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return; // 没权限 / 不存在：当作没东西
    }
    for (const e of entries) {
      if (hits.length >= limit) return;
      const hit = BANNED.find((b) => b.re.test(e.name));
      // 目录直接算；文件必须像二进制（否则会把源码里的 backends/mumu.js 误判成 MuMu 本体）
      if (hit && (e.isDirectory() || BINARY_EXT.test(e.name))) {
        hits.push({ path: path.join(d, e.name), name: e.name, vendor: hit.vendor });
        continue; // 命中目录就不再往里钻，报出来更有用
      }
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(dir);
  return hits;
}

/**
 * 第三方底座的适配器源码（打包产物里出现就说明把「可复用别人模拟器」的能力带回来了）。
 * 这些是 .js，不在 BINARY_EXT 里，所以单独判。
 */
const BANNED_SOURCE = [
  { re: /^mumu\.js$/i, what: 'MuMu 底座适配器' },
  { re: /^fydeos\.js$/i, what: 'FydeOS 底座适配器' },
  { re: /^mumu-compat\.js$/i, what: 'MuMu 兼容策略' },
  { re: /^frame\.js$/i, what: 'MuMu 帧体检' },
];

/**
 * 找打包产物里的第三方底座源码。
 * 只认「backends/xxx.js」或直接位于 src/core 下的那几个文件名，避免误伤别的 frame.js。
 * @param {string} dir
 * @returns {Array<{path: string, name: string, vendor: string}>}
 */
function findForbiddenSource(dir) {
  const hits = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    const dirName = path.basename(d);
    for (const e of entries) {
      if (e.isDirectory()) { walk(path.join(d, e.name)); continue; }
      const hit = BANNED_SOURCE.find((b) => b.re.test(e.name));
      if (!hit) continue;
      // 只认这几个明确的落点：backends/ 下的 mumu|fydeos、core/ 下的 mumu-compat / frame。
      // 别处同名文件（比如渲染层的 frame.js）不拦，避免误伤。
      const suspicious = dirName === 'backends' || (dirName === 'core' && !/^builtin\.js$/i.test(e.name));
      if (suspicious) hits.push({ path: path.join(d, e.name), name: e.name, vendor: hit.what });
    }
  };
  walk(dir);
  return hits;
}

/**
 * 断言目录里没有第三方模拟器。
 * @param {string} dir
 * @param {object} [opts] { label, exit } label 用于提示；exit=false 只返回结果不杀进程
 * @returns {{ok: boolean, skipped?: boolean, hits: Array}}
 */
function assertStandalone(dir, { label = '打包产物', exit = true } = {}) {
  if (!dir || !fs.existsSync(dir)) return { ok: true, skipped: true, hits: [] };
  const hits = findBundled(dir).concat(findForbiddenSource(dir));
  if (!hits.length) return { ok: true, hits: [] };

  const vendors = [...new Set(hits.map((h) => h.vendor))].join(' / ');
  console.error(`\n[守卫] ${label} 里混进了第三方模拟器（${vendors}）：`);
  for (const h of hits) console.error(`  - ${h.path}`);
  console.error('');
  console.error('ApkStart 的安装包必须自带运行时、独立运行：不能依赖、不能捆绑别的模拟器，');
  console.error('也不允许把「接管别人模拟器」的适配器源码带回来。');
  console.error('请把上面这些路径从打包目录里删掉后重试。\n');
  if (exit) process.exit(4);
  return { ok: false, hits };
}

module.exports = { BANNED, BANNED_SOURCE, findBundled, findForbiddenSource, assertStandalone };
