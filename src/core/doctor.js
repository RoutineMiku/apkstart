'use strict';
/**
 * 设备自适应 / 自动诊断（零配置底座）
 *
 * 目标：不同机器上都不需要用户调任何参数。
 *  - chooseProfile()  根据物理内存、CPU、磁盘、加速状态、emulator 版本推导启动参数；
 *  - planVariants()   给出「启动失败后依次降级」的重试方案（GPU → 加速 → 内存 → 冷启动）；
 *  - diagnose()       把 emulator 的英文 stderr 翻译成可执行的修复建议；
 *  - shortPath()      处理中文/空格安装路径（emulator 的 QEMU 对非 ASCII 路径极其敏感）。
 *
 * 本模块是纯函数 + 只读探测，不写设置、不拉起 Android，方便单测。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ASCII = /^[\x20-\x7e]*$/;
const isAsciiPath = (p) => ASCII.test(String(p || ''));

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/** 本机画像（毫秒级，只读） */
function hostInfo() {
  const totalMB = Math.round(os.totalmem() / 1048576);
  const freeMB = Math.round(os.freemem() / 1048576);
  const cores = Math.max(1, (os.cpus() || []).length || 2);
  const home = os.homedir();
  return {
    platform: process.platform,
    arch: process.arch,
    totalMB,
    freeMB,
    cores,
    home,
    homeAscii: isAsciiPath(home),
    tmp: os.tmpdir(),
    rdp: /RDP/i.test(String(process.env.SESSIONNAME || '')) || !!process.env.CLIENTNAME,
  };
}

/** 目录所在盘可用空间（MB）；取不到返回 0 */
function freeDiskMB(dir) {
  try {
    let d = path.resolve(dir || '.');
    for (let i = 0; i < 6 && !fs.existsSync(d); i += 1) d = path.dirname(d);
    const st = fs.statfsSync(d);
    return Math.floor((st.bavail * st.bsize) / 1048576);
  } catch (_) {
    return 0;
  }
}

function versionNumbers(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/**
 * emulator 36.4.9 起把 swiftshader_indirect 标记为弃用，新增 -gpu software。
 * 37.x 上传 swiftshader_indirect 会出现 GL 初始化失败/直接退出（设备差异很大）。
 * 因此必须按版本挑候选，且每个候选都有退路。
 */
function gpuCandidates(emulatorVersion) {
  const [major, minor, patch] = versionNumbers(emulatorVersion);
  const modern = major > 36 || (major === 36 && (minor > 4 || (minor === 4 && patch >= 9)));
  return modern
    // host 直接用显卡渲染，最省 CPU 也最跟手；失败会自动降到软件渲染重试
    ? ['host', 'software', 'swangle', 'swiftshader']
    : ['host', 'swiftshader_indirect', 'swiftshader'];
}

/** Windows 8.3 短路径：中文用户名 / 中文安装目录时 emulator 会找不到文件 */
/** 屏幕规格：有硬件加速就上 720x1280（清晰），纯软件模拟降到 540x960（流畅优先） */
function lcdFor({ accelOk = true, crisp = true } = {}) {
  return accelOk && crisp ? { w: 720, h: 1280, dpi: 320 } : { w: 540, h: 960, dpi: 240 };
}

function shortPath(p) {
  if (process.platform !== 'win32' || !p || isAsciiPath(p)) return p;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~sI`], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    if (line && isAsciiPath(line) && fs.existsSync(line)) return line;
  } catch (_) { /* 8.3 被关闭时保持原路径 */ }
  return p;
}

/**
 * 推导零配置启动参数。
 * 用户设置里若显式给了 engine.memoryMB / cores / gpuMode，则作为上限/覆盖，
 * 但不会再因为「没设置」而用 4G/4核 硬编码把小内存机器搞崩。
 */
/**
 * 「轻量容器」配额：只约束最影响主机手感的那一项 —— vCPU 数。
 *
 * 旧逻辑给 16 核机器分 4 核，qemu 的 4 个 vCPU 线程会长期占满物理核，
 * Windows 桌面、鼠标、浏览器只能抢剩下的时间片，表现就是「一打开就卡」。
 * 实际跑一个 Android App 2 个 vCPU 已经绰绰有余，多给只是拖慢主机。
 *
 * 内存、分辨率刻意不动：内存上限本来就是 2~3G，降分辨率还会让 quickboot
 * 快照指纹变化、每次切模式都要重新冷启动，得不偿失。
 *
 * 纯函数，settings 为 null 时返回 null（保持旧调用方/单测的行为不变）。
 */
function liteProfile({ host = hostInfo(), engine = {} } = {}) {
  if (engine && engine.liteMode === false) return null;
  const cores = engine && engine.resourceMode === 'save'
    ? 2
    // 老逻辑是 floor(核数/4) 再夹到 2~3 —— 8 核机器只给 2 个 vCPU，软件解码视频
    // （红果/抖音这类）直接卡成幻灯片。改成「一半物理核、上限 4」：
    // 8 核给 4、4 核给 2，桌面仍有富余核，视频也够用。
    : clamp(Math.floor((host.cores || 2) / 2), 2, 4);
  return { cores, priority: 'below' };
}

function chooseProfile({
  host = hostInfo(), accel, emulatorVersion = '', diskMB = 0,
  port = 5554, adbPort = 5044, overrides = {}, settings = null,
} = {}) {
  const accelOk = !!(accel && accel.ok);
  // 3GB 足够 Android 14 与主流应用；再高只会放大内存占用和 quickboot 快照体积
  let memoryMB = clamp(Math.floor((host.totalMB * 0.22) / 256) * 256, 2048, 3072);
  // 物理可用内存不够时下调；Android 14 最低 2G，低于此只能靠 TCG 慢速跑
  if (host.freeMB && host.freeMB < memoryMB + 1024) {
    memoryMB = Math.max(2048, Math.floor((host.freeMB * 0.5) / 256) * 256);
  }
  if (overrides.memoryMB) memoryMB = clamp(Number(overrides.memoryMB) || memoryMB, 1536, 8192);

  let cores = clamp(Math.floor(host.cores / 2), 2, 4);
  if (overrides.cores) cores = clamp(Number(overrides.cores) || cores, 1, 8);
  // 用户没手动指定核数时才由轻量模式收敛，手动值永远优先
  const lite = settings ? liteProfile({ host, engine: settings.engine || {} }) : null;
  if (lite && !overrides.cores) cores = Math.min(cores, lite.cores);

  const disk = diskMB || freeDiskMB(host.tmp);
  // /data 容量：应用本体、游戏资源包和它们的「更新包」都占这里，4GB 太容易满
  // （表现就是应用内更新时提示「磁盘空间不足」）。默认按磁盘余量给 6/8GB，
  // 用户也可以直接在设置里指定（改大后下次开机就地扩容，不丢数据）。
  const wantGB = Number((settings && settings.engine && settings.engine.dataPartitionGB) || 0);
  const autoDataMB = disk && disk < 12288 ? 4096 : 6144;
  const dataMB = wantGB > 0 ? clamp(Math.round(wantGB * 1024), 2048, 65536) : autoDataMB;

  const gpus = gpuCandidates(emulatorVersion);
  const gpu = overrides.gpuMode && gpus.includes(overrides.gpuMode) ? overrides.gpuMode : gpus[0];

  // 渲染分辨率：auto 时按加速状态选（软件模拟降到 540x960 保流畅）
  const wantLcd = String((settings && settings.engine && settings.engine.renderSize) || 'auto');
  const lcd = /^\d{3,4}x\d{3,4}$/.test(wantLcd)
    ? { ...lcdFor({ accelOk }), ...(() => {
      const [w, h] = wantLcd.split('x').map(Number);
      return { w, h, dpi: w <= 540 ? 240 : (w <= 720 ? 320 : 420) };
    })() }
    : lcdFor({ accelOk });

  return {
    memoryMB,
    cores,
    heapMB: memoryMB >= 3072 ? 384 : 256,
    dataMB,
    lcd,
    gpu,
    gpuCandidates: gpus,
    accel: accelOk ? 'auto' : 'off',
    accelOk,
    port,
    adbPort,
    snapshot: true,
    lite: !!lite,
    // 无加速的纯软件模拟在 Windows 上确实能起来，但 Android 14 冷启动可能 5-10 分钟
    bootTimeoutMs: accelOk ? 240000 : 600000,
    emulatorVersion,
    host,
  };
}

/**
 * 把「高级参数」里的用户设置转成 overrides。
 * 0 / auto / 未设置一律视为「不覆盖」，仍然走自动推导；
 * 只有用户主动关掉自动内存并填了具体数值才生效。
 */
function overridesFromSettings(engine = {}) {
  const e = engine || {};
  const manual = e.autoMemory === false;
  return {
    memoryMB: manual ? Number(e.memoryMB) || 0 : 0,
    cores: manual ? Number(e.cores) || 0 : 0,
    gpuMode: e.gpuMode && e.gpuMode !== 'auto' ? e.gpuMode : '',
  };
}

/**
 * 展示 / 诊断用的统一入口：不启动 Android 也能算出与真实开机一致的参数。
 * 之前设置页直接调 chooseProfile()（不带版本和加速状态），会在 37.x 机器上
 * 错误地显示已弃用的 swiftshader_indirect / 软件模拟，和实跑参数对不上。
 */
function autoProfile({ settings = {}, accel, emulatorVersion = '', diskMB = 0, port = 5554, adbPort = 5044 } = {}) {
  return chooseProfile({
    accel, emulatorVersion, diskMB, port, adbPort, settings,
    overrides: overridesFromSettings(settings && settings.engine),
  });
}

/**
 * 失败重试矩阵：从「最优」到「最保守」，最多 4 次。
 * 依次换 GPU 后端 → 关硬件加速走 TCG → 降内存并强制冷启动清快照。
 */
function planVariants(profile) {
  const out = [];
  const gpus = profile.gpuCandidates || [];
  const firstGpu = profile.gpu || gpus[0] || 'software';
  const safeGpu = gpus.find((g) => /software|swiftshader/.test(g)) || firstGpu;
  const ordered = [firstGpu, ...gpus.filter((g) => g !== firstGpu && /swiftshader|swangle/.test(g))].slice(0, 2);
  for (const gpu of ordered) {
    out.push({ ...profile, gpu, label: `${gpu} / ${profile.accel === 'auto' ? '硬件加速' : '软件模拟'}`, wipe: false, snapshot: true });
  }
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    label: '关闭加速的软件模拟（慢，但兼容性最好）',
    wipe: false,
    snapshot: false,
  });
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    memoryMB: 2048,
    cores: 2,
    dataMB: Math.min(profile.dataMB, 2048),
    label: '保守冷启动（最小内存 + 清快照）',
    // 这里**绝对不能** wipe：以前写的是 wipe:true，而磁盘写满时每次尝试都会失败，
    // 于是连续重试把用户已装的应用和存档一起「清快照 + 清数据」了 ——
    // 「磁盘满了，结果打开 ApkStart 应用全没了」就是这么发生的。
    // 需要重建 userdata 时由 ensureDataPartition 自己判断（它只在镜像损坏时重建），
    // 不靠启动参数里的 -wipe-data。
    wipe: false,
    snapshot: false,
    lastResort: true,
  });
  // 去重（相同 gpu/accel/wipe 组合不重复试）——但「最后一档」必须保留：
  // 它是唯一「不加载快照」的方案，小内存机器上可能和前一档参数完全一样。
  const seen = new Set();
  return out.filter((v) => {
    const k = `${v.gpu}|${v.accel}|${!!v.wipe}|${v.memoryMB}|${v.snapshot !== false ? 'snap' : 'nosnap'}|${v.lastResort ? 'last' : ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 检测一对空闲端口（emulator console + adb 注册端口必须相邻偶数/奇数） */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function freePortPair(start = 5554) {
  for (let p = start; p <= start + 40; p += 2) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p) && await isPortFree(p + 1)) return p;
  }
  return start;
}

/**
 * adb server 端口：固定不复用探测。
 * 之前是"从 5044 往上找一个空闲端口"，但 adb server 本身是常驻进程，占着这个端口，
 * 于是每启动一次 ApkStart 就会多一个 adb server（实测一次会话跑出 6 个），
 * 而且端口老是变，下次启动想接管上次的模拟器时对不上号。
 * 5044 是 ApkStart 专用端口（用户自己的 adb 在 5037），直接固定用。
 */
async function freeAdbPort(start = 5044) {
  return Number(process.env.APKSTART_ADB_PORT) || start;
}

/**
 * 配置指纹：只有「镜像 / 数据分区 / 引擎版本」变化才作废快照。
 * 故意不包含 GPU、加速方式、内存 —— 那些是自动重试会频繁切换的参数，
 * 若纳入会让每次重试都触发 -wipe-data，把用户已装的应用清空。
 */
/**
 * quickboot 快照的「配置指纹」：只有这些变化会让旧快照失效（加载后黑屏/起不来）。
 *
 * 刻意**不包含 dataMB**：数据分区调大以后旧快照照样能用（qemu 会按新的分区大小
 * 重新挂载），把它算进指纹的后果是「用户只想扩个容，结果快照作废 + 冷启动 +
 * 数据被删」—— 实测踩过一次，代价是整机应用全丢。
 */
function snapshotKey(plan, imageDir) {
  return crypto.createHash('sha1').update([
    imageIdentity(imageDir), plan.emulatorVersion || '', plan.api || '', plan.tag || '',
  ].join('|')).digest('hex').slice(0, 16);
}

/**
 * 系统镜像的「身份」：只保留 `system-images/...` 之后的部分。
 *
 * 镜像放哪个盘都无所谓，同一套镜像换个目录不该被当成「换了镜像」——
 * 否则用户把运行时从 C 盘挪到 D 盘（我们自己在设置里就建议这么做）以后，
 * AVD 里的 sysdir 与新路径不一致 → 判定镜像变了 → -wipe-data → 已装应用全丢。
 * 这个坑在实测中真的会踩到，所以两个地方（AVD 配置、快照指纹）都必须用身份而不是绝对路径。
 */
function imageIdentity(dir) {
  const p = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const i = p.indexOf('system-images/');
  if (i >= 0) return p.slice(i);
  return p.split('/').slice(-3).join('/');
}

const RULES = [
  {
    code: 'ACCESS_VIOLATION',
    // Windows 上 emulator/qemu 以 0xC0000005（十进制 3221225477）退出：
    // 实测多见于「显卡驱动 / Vulkan 后端在 guest 刚要启动时崩掉」，
    // 与 CPU、内存、镜像都无关（同机换 -gpu software 往往就能过）。
    // 必须排在 GPU_INIT 前面：崩溃日志里通常也带着渲染初始化信息，先判崩溃更准。
    re: /emulator exit 3221225477|exit code 3221225477|0xC0000005|STATUS_ACCESS_VIOLATION/i,
    title: '渲染后端崩溃（0xC0000005 访问冲突）',
    hint: '已自动改用更保守的渲染后端重试，并记住这个后端下次不再先试。'
      + '若反复出现，请更新显卡驱动；或在设置 → 性能与资源里把画质调低、关闭远程桌面/虚拟机显卡直通后再试。',
  },
  {
    code: 'GPU_INIT',
    // 只匹配「失败」语境：正常日志里也会出现 Vulkan/EGL/ANGLE 字样，不能误判为致命错误
    re: /Failed to initialize GL emulation|Could not initialize (OpenGL|emulated framebuffer)|Failed to create .*GLES|EGL_(BAD|NOT_INITIALIZED|CONTEXT_LOST)|Failed to (load|initialize) .*vulkan|vulkan.*(failed|error)|ANGLE.*(fail|error)/i,
    title: '显卡渲染后端初始化失败',
    hint: '已自动切换软件渲染重试。若仍失败，请更新显卡驱动，或关闭远程桌面/虚拟机显卡直通后再试。',
  },
  {
    code: 'GPU_MODE',
    re: /Unknown option|invalid .*-gpu|Unrecognized .*gpu|Unsupported gpu/i,
    title: '当前运行时不接受该 GPU 模式',
    hint: '已自动按运行时版本挑选可用的 GPU 模式重试（老版本用 swiftshader_indirect，新版本用 software）。',
  },
  {
    code: 'ACCEL',
    re: /x86_64 emulation currently requires hardware acceleration|acceleration.*not (installed|available|supported)|WHPX.*(not|failed)|AEHD.*(not|failed)|ERROR_ACCESS_DENIED|加速.*不可用/i,
    title: '硬件加速不可用',
    hint: '已自动回退软件模拟（首次启动会明显变慢）。想要流畅可用，请在「Windows 功能」勾选「虚拟机平台」，或安装 AEHD 驱动后重启。',
  },
  {
    code: 'MEMORY',
    re: /Cannot allocate memory|not enough memory|commit charge|Failed to allocate|out of memory|内存不足/i,
    title: '内存分配失败',
    hint: '已自动下调分配给 Android 的内存与核心数。请关闭占内存的程序后重试。',
  },
  {
    code: 'PORT_BUSY',
    re: /port.*(in use|busy)|Address already in use|bind.*failed|Failed to (setup|bind) .*console/i,
    title: '模拟器端口被占用',
    hint: '已自动换用空闲端口。若反复出现，请退出夜神/MuMu/蓝叠等模拟器，或重启电脑。',
  },
  {
    code: 'AVD_LOCK',
    re: /already running|lock file|\.lock|AVD is in use|emulator is running/i,
    title: '上次运行残留了锁文件',
    hint: '已自动清理 AVD 锁文件并重新拉起。',
  },
  {
    code: 'IMAGE',
    re: /system\.img.*(missing|not found|corrupt)|kernel-ranchu.*(missing|not found)|invalid magic|Failed to open .*\.img|APEX.*(fail|error|loop)|boot loop|verity.*fail/i,
    title: '系统镜像缺失或损坏 / 与旧用户数据不兼容',
    hint: '已自动用干净的用户数据重新开机。若仍失败，请在「运行时」里删除镜像后重新下载。',
  },
  {
    code: 'DLL',
    re: /0xc0000135|STATUS_DLL_NOT_FOUND|missing DLL|Qt6.*not found|MSVCP140|VCRUNTIME|无法启动此程序|The code execution cannot proceed/i,
    title: '运行时组件被杀毒软件删除或缺少 VC++ 运行库',
    hint: '请把 ApkStart 目录加入杀毒软件白名单后重新解压安装包，并安装微软 VC++ 2015-2022 运行库。',
  },
  {
    code: 'DISK_FULL',
    re: /No space left|disk full|not enough space|磁盘空间不足/i,
    title: '磁盘空间不足，无法启动安卓',
    hint: '请把运行时目录（设置 → 系统集成 → 运行时数据目录）改到空间充足的盘，'
      + '或在设置里关掉「保留快速启动快照」/ 调小数据分区。安卓数据不会被自动清除。',
  },
  {
    code: 'NON_ASCII',
    re: /Unicode|non-ASCII|路径.*(无效|找不到)|cannot find the path/i,
    title: '安装路径含中文或特殊字符',
    hint: '已自动改用 Windows 短路径。若仍失败，请把 ApkStart 移到纯英文目录（如 C:\\ApkStart）。',
  },
  {
    // 上次被强制结束后 AVD 目录会留下 hardware-qemu.ini.lock / multiinstance.lock，
    // 模拟器一律拒绝启动，报出来的却是容易被误读成 CPU 问题的话。必须排在 CPU 规则前。
    code: 'AVD_LOCK',
    re: /Running multiple emulators with the same AVD|AVD .*is already running|hardware-qemu\.ini\.lock/i,
    title: '上一次运行没有正常退出，残留了锁文件',
    hint: 'ApkStart 会自动清掉残留锁并重试；若反复出现，请检查是否有别的模拟器正在用同一套运行时。',
  },
  {
    code: 'CPU_FEATURE',
    re: /host doesn't support requested feature|CPUID.*not supported|unsupported CPU|missing.*(AVX|SSE4|xsave)/i,
    title: 'CPU 缺少运行时要求的指令集',
    hint: '这类提示在部分老 CPU 上只是警告、仍能开机；若确实起不来，请把「运行时」里的引擎更新到较旧兼容版本，或换一台支持 VT-x/AVX 的电脑。',
  },

  {
    code: 'SNAPSHOT',
    re: /snapshot|Quick Boot|ram\.img|Saving state/i,
    title: '快速启动快照损坏',
    hint: '已自动丢弃旧快照走冷启动；下一次正常退出会重新生成快照。',
  },
];

/** 把日志翻译成 {code,title,hint}，供 UI 展示与自动重试决策 */
function diagnose(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines || '')).slice(-24000);
  for (const r of RULES) {
    if (r.re.test(text)) return { code: r.code, title: r.title, hint: r.hint };
  }
  return {
    code: 'UNKNOWN',
    title: '运行时未能完成开机',
    hint: '已自动按多种参数组合重试。可点「导出诊断报告」把日志发给作者定位。',
  };
}

/** 人类可读的一行摘要，放在设置页让高级用户知道自动选了什么 */
function describeProfile(p) {
  return `自动：${(p.memoryMB / 1024).toFixed(1)}GB 内存 · ${p.cores} 核 · ${p.gpu} 渲染 · `
    + `${p.accelOk ? '硬件加速' : '软件模拟'} · ${p.snapshot ? '按需快照' : '冷启动'}`
    + `${p.lite ? ' · 轻量容器' : ''} · 端口 ${p.port}`;
}

/** 导出诊断报告（纯文本，便于发邮件/贴 issue） */
function writeReport({ dataDir, profile, logLines = [], extra = {} }) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  const d = diagnose(logLines);
  const body = [
    'ApkStart 诊断报告',
    `生成时间：${new Date().toLocaleString()}`,
    '',
    '== 本机 ==',
    JSON.stringify(hostInfo(), null, 2),
    '',
    '== 自动配置 ==',
    JSON.stringify(profile || {}, null, 2),
    describeProfile(profile || chooseProfile()),
    '',
    '== 诊断 ==',
    `${d.code}：${d.title}`,
    d.hint,
    '',
    '== 附加信息 ==',
    JSON.stringify(extra, null, 2),
    '',
    '== 运行时日志（末尾 300 行）==',
    ...(Array.isArray(logLines) ? logLines.slice(-300) : String(logLines || '').split('\n')),
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return { file, diagnosis: d };
}

/**
 * 检测微软 VC++ 2015-2022 x64 运行库是否安装。
 * 安卓模拟器（Qt6）与 qemu 都依赖它；缺了在「其他电脑」上会直接起不来
 * （报 0xc0000135 / MSVCP140 缺失）。安装版我们已内置 vc_redist.x64.exe，
 * 这里只做检测，供启动前给出明确提示与一键安装入口。
 */
function vcRedistOk() {
  if (process.platform !== 'win32') return true;
  // 先看 DLL：msvcp140 / vcruntime140 正是 Qt6 与 qemu 真正依赖的两个文件。
  // 用文件判断既不用起 reg.exe（部分安全软件会拦、也会拖慢每 60s 的自检），
  // 也不会因为注册表项被清理工具删掉而误报「没装」。
  const sys = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  try {
    if (fs.existsSync(path.join(sys, 'msvcp140.dll'))
      && fs.existsSync(path.join(sys, 'vcruntime140.dll'))) return true;
  } catch (_) { /* 走注册表兜底 */ }

  const key = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64';
  for (const k of [key, key.replace('SOFTWARE\\', 'SOFTWARE\\WOW6432Node\\')]) {
    try {
      const out = execFileSync('reg', ['query', k, '/v', 'Installed'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (/Installed\s+REG_DWORD\s+0x1/i.test(out)) return true;
    } catch (_) { /* 键不存在 = 没装 */ }
  }
  return false;
}

module.exports = {
  hostInfo, freeDiskMB, isAsciiPath, shortPath, lcdFor, liteProfile,
  versionNumbers, gpuCandidates, chooseProfile, planVariants,
  overridesFromSettings, autoProfile,
  freePortPair, freeAdbPort, snapshotKey, imageIdentity,
  diagnose, describeProfile, writeReport, vcRedistOk,
};
