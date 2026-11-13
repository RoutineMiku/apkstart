'use strict';
/**
 * 把 engine/ 整理成「可随包分发」的运行时：build/runtime/
 *
 * 关键一步是 system.img 的压缩。AOSP 的 system.img 是 3.1GB 的稀疏镜像，
 * 其中绝大部分是零，gzip 之后只有 ~580MB。单文件发行版的体积几乎全在这里。
 * 再加上 emulator（瘦身后约 340MB）+ Electron + platform-tools，整包约 1.0~1.1GB。
 * 不压缩的话发行版要做到 1.4GB 以上。
 * 代价是首次启动花 1~2 分钟把它展开到用户目录（只做一次），
 * 展开逻辑在 src/core/provision.js 的 materializeImages()。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'engine');
const OUT = path.join(ROOT, 'build', 'runtime');
const MARK = path.join(OUT, '.prepared');

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

async function gzipFile(src, dest) {
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(dest),
  );
}

/** 大镜像用 XZ（LZMA2）：比 gzip -6 再省 ~25%（system.img 1.5GB→~1.1GB）。
 *  默认 9e 极限档；CI 双核可用 XZ_PRESET=6 把时间压到 1/3（体积 +3%）。
 *
 *  实现说明（踩过的坑）：
 *   - 用 python 的 lzma（单线程、稳定）。@napi-rs/lzma 的 createCompressStream 在某些
 *     环境下会 0 字节挂死（实测挂 18 分钟无输出），只能当最后兜底且要带超时。
 *   - 找不到 python 时退回 gzip -9：体积大 ~30% 但绝不会挂，保证 CI 能出包。
 */
function findPython() {
  const { spawnSync } = require('child_process');
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      const r = spawnSync(cmd, ['-c', 'import lzma;print("ok")'], {
        encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (r.status === 0 && /ok/.test(String(r.stdout))) return cmd;
    } catch (_) { /* 试下一个 */ }
  }
  return null;
}

async function xzFile(src, dest) {
  const preset = Math.max(0, Math.min(9, Number(process.env.XZ_PRESET || 9)));
  const extreme = preset >= 9 && process.env.XZ_NO_EXTREME !== '1';
  const pyPreset = extreme ? '9|lzma.PRESET_EXTREME' : String(preset);
  const dictSize = preset >= 9 ? (1 << 27) : preset >= 6 ? (1 << 26) : (1 << 23);
  const py = findPython();
  if (py) {
    const { spawn } = require('child_process');
    const ok = await new Promise((resolve) => {
      const p = spawn(py, ['-c', [
        'import lzma,sys,shutil',
        `flt=[{"id":lzma.FILTER_LZMA2,"preset":${pyPreset},"dict_size":${dictSize}}]`,
        'z=lzma.LZMAFile(sys.stdout.buffer,mode="wb",format=lzma.FORMAT_XZ,filters=flt)',
        'shutil.copyfileobj(sys.stdin.buffer,z); z.close()',
      ].join(';')], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
      const out = fs.createWriteStream(dest);
      p.stdout.pipe(out);
      p.on('exit', (c) => resolve(c === 0));
      p.on('error', () => resolve(false));
    });
    if (ok) return;
    console.log(`  （${py} 压缩失败，改用 gzip -9）`);
  } else {
    console.log('  （未找到 python，改用 gzip -9（体积略大但可靠））');
  }
  // 兜底：gzip -9（不是 xz，运行时 materializeImages 按扩展名选择解压器）
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(dest.replace(/\.xz$/i, '.gz')),
  );
}

async function main() {
  const force = process.argv.includes('--force');
  if (fs.existsSync(MARK) && !force) {
    console.log('build/runtime 已是最新（加 --force 重建）');
    return;
  }
  if (!fs.existsSync(SRC)) {
    console.error('缺少 engine/ 目录，无法准备运行时');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  // 1. 直接复制 emulator / platform-tools（不含历史产物）
  for (const dir of ['emulator', 'platform-tools']) {
    const s = path.join(SRC, dir);
    if (!fs.existsSync(s)) continue;
    console.log(`复制 ${dir}…`);
    fs.cpSync(s, path.join(OUT, dir), { recursive: true });
  }

  // 1.5 瘦身：删掉固定启动参数下永远不会被加载的文件（约 -400MB）
  if (!process.argv.includes('--no-slim')) {
    console.log('瘦身运行时…');
    const { slim } = require('./slim-runtime');
    slim(OUT, { aggressive: !process.argv.includes('--safe-slim') });
  }

  // 2. 系统镜像：大镜像压成 .xz（运行时 materializeImages 流式解压），其余原样带
  const imgRoot = path.join(SRC, 'system-images');
  let compressed = 0;
  if (fs.existsSync(imgRoot)) {
    for (const api of fs.readdirSync(imgRoot)) {
      for (const tag of fs.readdirSync(path.join(imgRoot, api))) {
        for (const abi of fs.readdirSync(path.join(imgRoot, api, tag))) {
          const from = path.join(imgRoot, api, tag, abi);
          const to = path.join(OUT, 'system-images', api, tag, abi);
          fs.mkdirSync(to, { recursive: true });
          for (const f of fs.readdirSync(from)) {
            const src = path.join(from, f);
            if (!fs.statSync(src).isFile()) continue;
            // NOTICE.txt 是 GMS 许可文本（~20MB），运行不需要
            if (/^NOTICE\.txt$/i.test(f)) continue;
            if (/^(system|vendor|cache)\.img$/i.test(f) && sizeOf(src) > 32 * 1024 * 1024) {
              // 大镜像压一份，原图不进包；已有 .xz（且大小合理）则跳过重复压缩
              const xz = path.join(to, `${f}.xz`);
              const xzSize = sizeOf(xz);
              // 已有 .xz 且大小合理（>4MB 且不小于源文件的 5%）则跳过重复压缩。
              // 注意不能用固定 32MB 阈值：vendor.img.gz 只有 ~21MB，会被误判为"无效"重压。
              if (xzSize > 4 * 1024 * 1024 && xzSize > sizeOf(src) * 0.05) {
                console.log(`跳过 ${f}（已有 .xz ${(xzSize / 1048576).toFixed(0)} MB）`);
                compressed += 1;
                continue;
              }
              console.log(`压缩 ${f}（${(sizeOf(src) / 1073741824).toFixed(2)} GB）→ XZ 9e（较慢，一次性）…`);
              // eslint-disable-next-line no-await-in-loop
              await xzFile(src, xz);
              compressed += 1;
            } else {
              fs.copyFileSync(src, path.join(to, f));
            }
          }
        }
      }
    }
  }

  fs.writeFileSync(MARK, new Date().toISOString());
  const gzCount = compressed;
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else total += sizeOf(p);
    }
  };
  walk(OUT);
  console.log(`完成：build/runtime（${(total / 1073741824).toFixed(2)} GB，压缩了 ${gzCount} 个大镜像）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
