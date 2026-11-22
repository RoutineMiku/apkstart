'use strict';
/**
 * 生成增量更新资产：一份清单 + 一个「代码层」zip。
 *
 * 便携包约 99MB，大头是 Electron 外壳（exe / dll / locales），只有升级 Electron
 * 才会变；每次发版真正变化的是 resources/app 下的 JS / 资源 / node_modules。
 * 这里把 app 层单独打成一个小包，并列出每个文件的 sha256，客户端本机 Electron
 * 版本一致时就只下这两个小文件，覆盖 resources/app 即可完成升级。
 *
 * 产物（写到 --out 目录，默认当前目录）：
 *   ApkStart-v<版本>-manifest.json
 *   ApkStart-v<版本>-app.zip
 *
 * 用法：node build/incremental.js <便携版目录> <tag> [--out 目录]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { sha256File } = require('../src/core/download');
const { find7z } = require('./zip');

const ROOT = path.dirname(__dirname);

/** 这次构建用的 Electron 版本：客户端用它判断能否只换代码层 */
function electronVersion(root = ROOT) {
  const candidates = [
    path.join(root, 'node_modules', 'electron', 'package.json'),
    path.join(root, 'package.json'),
  ];
  for (const p of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.name === 'electron' && j.version) return String(j.version);
    } catch (_) { /* 下一个 */ }
  }
  try {
    const ep = path.join(root, 'package.json');
    const dev = (JSON.parse(fs.readFileSync(ep, 'utf8')).devDependencies || {}).electron;
    if (dev) return String(dev).replace(/^[^\d]*/, '');
  } catch (_) { /* ignore */ }
  return '';
}

/** 递归列出目录下所有文件的相对路径（正斜杠） */
function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs, base));
    else if (e.isFile()) out.push(path.relative(base, abs).replace(/\\/g, '/'));
  }
  return out;
}

function zipApp(exe, srcDir, outZip, rootDir) {
  // cwd 设为便携版根目录，让包内路径保留 resources/app/... 前缀
  const r = spawnSync(exe, ['a', '-tzip', '-mm=Deflate', '-mx=9', '-bso0', '-bsp0', '-y', outZip, 'resources\\app'], {
    cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`代码包压缩失败（${r.status}）：${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  if (!fs.existsSync(srcDir)) throw new Error(`找不到代码层目录：${srcDir}`);
}

async function build(portableDir, tag, outDir = process.cwd()) {
  const portable = path.resolve(portableDir);
  const appDir = path.join(portable, 'resources', 'app');
  if (!fs.existsSync(path.join(portable, 'ApkStart.exe'))) throw new Error('便携版目录缺少 ApkStart.exe');
  if (!fs.existsSync(path.join(appDir, 'package.json'))) throw new Error('便携版目录缺少 resources/app/package.json');

  const version = String(tag || '').replace(/^v/i, '');
  if (!version) throw new Error('缺少版本号 / tag');

  fs.mkdirSync(outDir, { recursive: true });
  const appName = `ApkStart-v${version}-app.zip`;
  const manifestName = `ApkStart-v${version}-manifest.json`;
  const appZip = path.join(outDir, appName);
  const manifestPath = path.join(outDir, manifestName);

  fs.rmSync(appZip, { force: true });
  const exe = find7z();
  if (!exe) throw new Error('找不到 7-Zip，无法生成代码包（CI 的 windows-latest 自带）');
  zipApp(exe, appDir, appZip, portable);

  const files = {};
  const rels = walk(appDir).sort();
  for (const rel of rels) {
    const abs = path.join(appDir, ...rel.split('/'));
    files[`resources/app/${rel}`] = {
      size: fs.statSync(abs).size,
      sha256: await sha256File(abs),
    };
  }
  const packHash = await sha256File(appZip);
  const manifest = {
    schema: 1,
    version,
    tag: tag.startsWith('v') ? tag : `v${tag}`,
    electronVersion: electronVersion(ROOT),
    generatedAt: new Date().toISOString(),
    app: {
      asset: appName,
      sha256: packHash,
      size: fs.statSync(appZip).size,
      files,
    },
    full: { asset: `ApkStart-v${version}-win64-portable.zip` },
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`清单：${manifestPath}`);
  console.log(`代码包：${appZip}（${(fs.statSync(appZip).size / 1024 / 1024).toFixed(2)} MB，${rels.length} 个文件）`);
  console.log(`Electron：${manifest.electronVersion || '(未知)'}`);
  return { manifestPath, appZip, manifest };
}

if (require.main === module) {
  const dir = process.argv[2];
  const tag = process.argv[3];
  const oi = process.argv.indexOf('--out');
  const out = oi > 0 ? process.argv[oi + 1] : process.cwd();
  if (!dir || !tag) {
    console.error('用法：node build/incremental.js <便携版目录> <tag> [--out 目录]');
    process.exit(1);
  }
  build(dir, tag, out).catch((e) => { console.error('生成增量资产失败：', e.message); process.exit(1); });
}

module.exports = { build, electronVersion, walk };
