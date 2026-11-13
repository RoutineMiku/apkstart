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
// 预置的 /data 初始模板（已格式化的 ext4，xz 压缩）。见下方 userdata.img 处注释。
const SEED_USERDATA = path.join(__dirname, 'seed', 'userdata.img.gz');

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
 *   - 【CI 曾挂死 3 小时的真因】源文件必须 pipe 到子进程的 stdin，并在读完后关闭。
 *     python 侧是 `shutil.copyfileobj(sys.stdin.buffer, z)`，拿不到 EOF 就永远等输入，
 *     stdout 一个字节都不写、进程永不退出。当时只接了 p.stdout，本地因为已有 .xz
 *     被「跳过重复压缩」蒙过去，CI 全新目录必然中招。
 *   - 再加看门狗：压缩器再出意外也会 kill 后落到 gzip 兜底，绝不让打包链路无限挂起。
 *   - 找不到 python / 压缩失败 → gzip -9（体积略大但绝不会挂），
 *     运行时 materializeImages 按扩展名选解压器，两种产物都认。
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
  // 默认 2 小时（3GB / 2 核 / preset 6 实测 ~40min）；超时即 kill 并落 gzip 兜底。
  const timeoutMs = Math.max(5000, Number(process.env.XZ_TIMEOUT_MS || 2 * 60 * 60 * 1000));
  const py = findPython();
  if (py) {
    const { spawn } = require('child_process');
    const p = spawn(py, ['-c', [
      'import lzma,sys,shutil',
      `flt=[{"id":lzma.FILTER_LZMA2,"preset":${pyPreset},"dict_size":${dictSize}}]`,
      'z=lzma.LZMAFile(sys.stdout.buffer,mode="wb",format=lzma.FORMAT_XZ,filters=flt)',
      'shutil.copyfileobj(sys.stdin.buffer,z); z.close()',
    ].join(';')], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });

    // 先挂监听，避免子进程在我们 await 之前就已经退出而丢掉 close 事件。
    const exited = new Promise((resolve) => {
      p.on('close', resolve);
      p.on('error', () => resolve(-1));
    });
    const watchdog = setTimeout(() => {
      console.log(`  （xz 压缩超过 ${Math.round(timeoutMs / 60000)} 分钟，终止并改用 gzip -9）`);
      try { p.kill(); } catch (_) { /* 已退出 */ }
    }, timeoutMs);

    let ok = false;
    try {
      // 关键：stdin 才是压缩器的输入。pipeline 读完 src 会 end(p.stdin)，
      // python 收到 EOF 才 flush XZ 尾块并正常退出。
      const streams = [
        pipeline(fs.createReadStream(src), p.stdin),
        pipeline(p.stdout, fs.createWriteStream(dest)),
      ];
      // 任一路异常（EPIPE / 写盘失败）立刻终止子进程，别等看门狗。
      streams.forEach((s) => s.catch(() => { try { p.kill(); } catch (_) { /* noop */ } }));
      const settled = await Promise.allSettled(streams);
      const code = await exited;
      ok = code === 0 && settled.every((r) => r.status === 'fulfilled') && sizeOf(dest) > 0;
    } catch (_) {
      ok = false;
    } finally {
      clearTimeout(watchdog);
    }
    if (ok) return;
    // 半个 .xz 留着会污染产物，必须删掉再走兜底。
    try { fs.rmSync(dest, { force: true }); } catch (_) { /* ignore */ }
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
            // userdata.img 用仓库里的预置 ext4 模板（seed）：
            // 官方 sys-img 里那份是 1MB 全零，emulator 扩容时 e2fsck 必然 code=8，
            // 分区停在 1MB → guest invalid magic → /data 只读 → 全新安装永远开不了机。
            // 模板只在构建期生成一次（mke2fs），之后随代码走，CI 不需要额外工具链。
            if (/^userdata\.img$/i.test(f) && fs.existsSync(SEED_USERDATA)) {
              fs.copyFileSync(SEED_USERDATA, path.join(to, 'userdata.img.gz'));
              console.log('userdata.img 使用预置 ext4 模板（build/seed）');
              compressed += 1;
              continue;
            }
            if (/^(system|vendor|cache|userdata)\.img$/i.test(f) && sizeOf(src) > 32 * 1024 * 1024) {
              // 大镜像压一份，原图不进包；已有压缩产物（且大小合理）则跳过重复压缩
              const xz = path.join(to, `${f}.xz`);
              const gz = path.join(to, `${f}.gz`);
              // gzip 兜底路径产出的是 .gz，也必须认，否则每次重建都会把 3GB 重压一遍。
              // 阈值用 >1MB 而非压缩比：vendor.img.gz 只有 ~21MB、userdata.img 几乎全零，
              // 用固定大阈值或「压缩比」判定都会把这些合法产物误判成无效而重压。
              const existing = [xz, gz].find((p) => sizeOf(p) > 1024 * 1024);
              if (existing) {
                console.log(`跳过 ${f}（已有 ${path.extname(existing)} ${(sizeOf(existing) / 1048576).toFixed(1)} MB）`);
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

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
// 供回归测试直接调用（不触发 main 的整包准备流程）
module.exports = { xzFile, gzipFile, findPython };
