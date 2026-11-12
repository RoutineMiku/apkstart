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

  // 2. 系统镜像：system.img 压成 .gz，其余原样带
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
            if (/^(system|vendor|cache)\.img$/i.test(f) && sizeOf(src) > 32 * 1024 * 1024) {
              // 大镜像压一份，原图不进包
              const gz = path.join(to, `${f}.gz`);
              console.log(`压缩 ${f}（${(sizeOf(src) / 1073741824).toFixed(2)} GB）…`);
              // eslint-disable-next-line no-await-in-loop
              await gzipFile(src, gz);
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
