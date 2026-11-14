'use strict';
/**
 * 便携包压缩（Windows zip）。
 *
 * 为什么不用 PowerShell 的 `Compress-Archive`：
 * 它走 .NET 自带 deflate（相当于 zlib 6 档），同一个 225MB 目录压出来是
 * 105,213,775 字节；7-Zip 的 deflate（`-mx=9`）只要 99,616,541 字节 —— 差了 5.6MB。
 * 而 Gitee 发行版附件单文件上限是 100MB（实测 104,800,000 字节能上传成功，
 * 105,213,775 就被拆成 part1/part2 让用户没法直接解压）。差这 5MB，
 * 结果就是「国内用户拿到的包要么解压不了，要么得下两份」。
 *
 * 所以这里固定用 7-Zip 压；找不到 7-Zip 才退回 Compress-Archive（并大声提示）。
 *
 * 用法：
 *   node build/zip.js <源目录> <输出.zip> [--limit-mb 100]
 * 退出码：0 成功 / 1 失败 / 2 超过体积上限（CI 里按失败处理，别再悄悄发分片包）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MIB = 1024 * 1024;

/** 在常见位置找 7-Zip 的独立可执行文件（7z.exe 或 7za.exe） */
function find7z() {
  const explicit = process.env.APKSTART_7Z;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const direct = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(__dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
  ];
  for (const p of direct) if (fs.existsSync(p)) return p;

  // PATH 里找（GitHub Actions 的 windows-latest 自带 7-Zip 且在 PATH 上）
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const exe of ['7z.exe', '7za.exe']) {
      const p = path.join(dir, exe);
      try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
    }
  }

  // electron-builder 下载的 7zip 缓存（本地开发机常见）
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  try {
    for (const d of fs.readdirSync(cache)) {
      if (!/^7zip/i.test(d)) continue;
      const base = path.join(cache, d);
      for (const sub of fs.readdirSync(base)) {
        const p = path.join(base, sub, 'bin', '7za.exe');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (_) { /* 没有缓存目录 */ }
  return '';
}

function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else { files += 1; bytes += fs.statSync(p).size; }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** 用 7-Zip 压 zip：cwd 设为源目录，让包内路径相对、不带上层目录名 */
function zipWith7z(exe, srcDir, outZip, level = 9) {
  const r = spawnSync(exe, ['a', '-tzip', '-mm=Deflate', `-mx=${level}`, '-bso0', '-bsp0', '-y', outZip, '*'], {
    cwd: srcDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`7-Zip 压缩失败（${r.status}）：${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
}

/** 兜底：PowerShell Compress-Archive（体积大 5%，只在没装 7-Zip 时用） */
function zipWithPowershell(srcDir, outZip) {
  const ps = `Compress-Archive -Path '${path.join(srcDir, '*')}' -DestinationPath '${outZip}' -CompressionLevel Optimal -Force`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`Compress-Archive 失败：${String(r.stderr || '').slice(0, 400)}`);
  }
}

/** 压缩结果自检：用应用自己的 zip 解析器读一遍，确认条目数与解压总字节对得上 */
function verify(zipPath, expect) {
  const { ZipFile } = require('../src/core/zip');
  const zip = new ZipFile(zipPath);
  try {
    const names = zip.names().filter((n) => !n.endsWith('/'));
    let bytes = 0;
    for (const n of names) bytes += zip.entries.get(n).uncompSize;
    if (names.length !== expect.files) {
      throw new Error(`条目数不符：包内 ${names.length}，源目录 ${expect.files}`);
    }
    if (bytes !== expect.bytes) {
      throw new Error(`解压总字节不符：包内 ${bytes}，源目录 ${expect.bytes}`);
    }
    return names.length;
  } finally {
    zip.close();
  }
}

function main() {
  const srcDir = path.resolve(process.argv[2] || '');
  const outZip = path.resolve(process.argv[3] || '');
  const limArg = process.argv.indexOf('--limit-mb');
  const limitMiB = limArg > 0 ? Number(process.argv[limArg + 1]) : 100;
  if (!srcDir || !fs.existsSync(srcDir) || !outZip) {
    console.error('用法：node build/zip.js <源目录> <输出.zip> [--limit-mb 100]');
    process.exit(1);
  }

  const stats = dirStats(srcDir);
  console.log(`压缩 ${srcDir}（${stats.files} 个文件，${(stats.bytes / MIB).toFixed(1)} MB）`);
  fs.rmSync(outZip, { force: true });

  const exe = find7z();
  if (exe) {
    console.log('压缩器：', exe);
    zipWith7z(exe, srcDir, outZip);
  } else {
    console.warn('⚠️  没找到 7-Zip，退回 Compress-Archive —— 产物会大 5% 左右，可能装不进 Gitee 单文件限额');
    zipWithPowershell(srcDir, outZip);
  }

  const size = fs.statSync(outZip).size;
  const entries = verify(outZip, stats);
  console.log(`完成：${outZip}`);
  console.log(`  ${entries} 个条目，${size} 字节（${(size / MIB).toFixed(2)} MiB），压缩率 ${(size / stats.bytes * 100).toFixed(1)}%`);

  if (size > limitMiB * MIB) {
    console.error(`✗ 超过 ${limitMiB} MiB 上限（Gitee 附件单文件上限 100MB）。请先给包瘦身，不要靠切分片绕过。`);
    process.exit(2);
  }
  console.log(`  ✓ 在 ${limitMiB} MiB 以内（余量 ${((limitMiB * MIB - size) / MIB).toFixed(2)} MiB）`);
}

if (require.main === module) main();

module.exports = { find7z, dirStats, verify };
