'use strict';
/**
 * 清理旧版本残留。
 *
 * 用户升级 ApkStart 常出现「装过好几个版本、卸载不干净」：便携版每换一次版本就多一个
 * ApkStart-vX.Y.Z-win64-portable 目录；NSIS 安装版升级后可能留下指向已删除目录的
 * 卸载项；更新过程还会在数据目录里留下一堆临时包。
 *
 * 这里只做**可证明安全**的清理：
 *   - 只认「目录里确实有 ApkStart.exe」的旧版本目录，且绝不碰当前正在运行的那个；
 *   - 只删除「InstallLocation 已经不存在」的注册表卸载项（那个本来就已经是死条目）；
 *   - 只删自己更新缓存里的临时文件与指向不存在目标的开始菜单/桌面快捷方式。
 * 任何一步拿不准就跳过，并把原因如实返回给界面。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const EXE = 'ApkStart.exe';

function dirSize(p) {
  let n = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(f);
        else n += fs.statSync(f).size;
      } catch (_) { /* 占用/无权限，跳过 */ }
    }
  };
  walk(p);
  return n;
}

function norm(p) {
  try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); }
}

// 与 emulator.js `_cleanLegacySnapshots` 完全同一条策略：
// default_boot 是早期版本留下的（一份 ram.img 约 3GB），*.stale-<数字> 是
// 「删不掉就改名」的残留。其它名字（包括当前在用的 apkstart）一律不碰。
const LEGACY_SNAPSHOT = /^default_boot$|\.stale-\d+$/i;
const CURRENT_SNAPSHOT = 'apkstart';

function resolveAvdHome(avdHome) {
  if (!avdHome) return '';
  try { return path.resolve(String(avdHome)); } catch (_) { return ''; }
}

/** AVD 快照根：<avdHome>/apkstart.avd/snapshots 的绝对路径；没有 avdHome 时返回空串 */
function snapshotsRoot(avdHome) {
  const home = resolveAvdHome(avdHome);
  return home ? path.join(home, `${CURRENT_SNAPSHOT}.avd`, 'snapshots') : '';
}

/** 是不是符号链接/目录联接。lstat 拿不到时按「不可证明」处理：当成链接，拒绝删除。
 *  注意：这里绝不把「API 不存在」当成「不是链接」——那会把测试桩的不完整变成生产放行。 */
function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return true; }
}

/**
 * 校验受控目录链并返回快照根。
 *
 * 策略（策略 A）：avdHome 是 main/Provisioner 给出的逻辑入口；若它本身是链接/联接，
 * 说明无法从当前调用链证明这是用户明确选择的物理根，**跳过自动清理并保留数据**。
 * avdHome 以下的 apkstart.avd、snapshots 必须是真实目录（lstat 不是链接、isDirectory 为真）；
 * 任一级 lstat/realpath 失败都拒绝，不退回弱检查。
 *
 * 只对 avdHome 以上已存在的系统重定向不作逐字比较：这里以 avdHome 作为逻辑锚点，
 * 不承诺识别其祖先目录是否为系统重定向。
 */
function snapshotChain(avdHome) {
  const home = resolveAvdHome(avdHome);
  if (!home) return { ok: false, reason: '缺少 AVD 目录，无法确认快照位置' };
  const avdDir = path.join(home, `${CURRENT_SNAPSHOT}.avd`);
  const root = path.join(avdDir, 'snapshots');
  const levels = [
    { p: home, label: 'AVD 根目录' },
    { p: avdDir, label: 'AVD 数据目录' },
    { p: root, label: '快照目录' },
  ];
  for (const { p, label } of levels) {
    let st;
    try { st = fs.lstatSync(p); } catch (_) { return { ok: false, reason: `${label}不存在或无法读取，拒绝清理` }; }
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        reason: p === home
          ? '安卓数据目录使用了目录链接，本次自动清理已跳过；数据未删除。'
          : `${label}是链接/联接，拒绝清理`,
      };
    }
    if (!st.isDirectory()) return { ok: false, reason: `${label}不是目录，拒绝清理` };
  }
  let realHome;
  let realRoot;
  try {
    realHome = fs.realpathSync(home);
    realRoot = fs.realpathSync(root);
  } catch (_) { return { ok: false, reason: '无法解析 AVD 目录的真实路径，拒绝清理' }; }
  let rel;
  try { rel = path.relative(realHome, realRoot); } catch (_) { return { ok: false, reason: '无法确认快照目录位置，拒绝清理' }; }
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return { ok: false, reason: '快照目录不在 AVD 根目录下，拒绝清理' };
  }
  return { ok: true, home, root, realHome, realRoot };
}

/**
 * 在已验证的目录里统计普通文件的逻辑字节长度。
 * 不跟随链接：遇到链接、未知类型、读不到内容都拒绝整项（保守跳过）。
 * 返回的是文件字节长度之和，不是磁盘实际回收的物理空间。
 */
function measureLogicalBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = fs.lstatSync(cur); } catch (_) { return { ok: false, reason: '无法读取待清理内容，拒绝清理' }; }
    if (st.isSymbolicLink()) return { ok: false, reason: '待清理目录里包含链接/联接，拒绝清理' };
    if (st.isDirectory()) {
      let list;
      try { list = fs.readdirSync(cur); } catch (_) { return { ok: false, reason: '无法读取待清理目录，拒绝清理' }; }
      for (const name of list) stack.push(path.join(cur, name));
    } else if (st.isFile()) {
      total += st.size;
    } else {
      return { ok: false, reason: '待清理目录里包含无法确认类型的条目，拒绝清理' };
    }
  }
  return { ok: true, bytes: total };
}

/**
 * 快照条目能不能删。返回空串表示可以，否则是拒绝原因。
 * 只认 snapshots 根的直接子项 + 旧版命名策略；其它路径（别的盘、父目录跳转、
 * 另一个 AVD 根下的同名目录）全部拒绝。
 */
function snapshotRefusal(itemPath, avdHome) {
  // 扫描结果是待处理列表，不是永久删除授权：这里重新取得当前根并核验整条受控链。
  const chain = snapshotChain(avdHome);
  if (!chain.ok) return chain.reason;
  if (!itemPath) return '缺少快照路径';
  let full;
  try { full = path.resolve(String(itemPath)); } catch (_) { return '快照路径无法解析'; }
  const name = path.basename(full);
  if (name === CURRENT_SNAPSHOT) return '这是当前在用的快照';
  if (!LEGACY_SNAPSHOT.test(name)) return '不是旧版遗留的快照名';
  let rel;
  try { rel = path.relative(chain.root, full); } catch (_) { return '快照路径无法解析'; }
  if (!rel || rel !== name || rel === '..' || rel.startsWith('..' + path.sep)
      || path.isAbsolute(rel) || /[\\/]/.test(rel)) {
    return '不是 AVD 快照目录的直接子项';
  }
  let st;
  try { st = fs.lstatSync(full); } catch (_) { return '快照目标不存在或无法读取，拒绝删除'; }
  if (st.isSymbolicLink()) return '这是链接/联接，拒绝删除';
  if (!st.isDirectory()) return '快照目标不是目录，拒绝删除';
  let realFull;
  try { realFull = fs.realpathSync(full); } catch (_) { return '无法解析快照目标的真实路径，拒绝删除'; }
  let realRel;
  try { realRel = path.relative(chain.realRoot, realFull); } catch (_) { return '无法确认快照目标的真实位置，拒绝删除'; }
  if (!realRel || realRel !== path.basename(realFull) || realRel === '..'
      || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel) || /[\\/]/.test(realRel)) {
    return '快照目标的真实路径不在快照根下，拒绝删除';
  }
  return '';
}

/**
 * 在若干「可能放程序的」目录里找旧版本目录。
 *
 * 以前只扫当前 exe 的父目录 + LOCALAPPDATA\Programs + ProgramFiles，结果用户把
 * 便携版解压到别的地方（E:\下载、桌面、某个项目目录）就永远扫不到 —— 这正是
 * 「其他文件夹里的旧版本清不掉」的原因。现在多路发现：
 *   - 常见安装位置；
 *   - 各磁盘根目录下的浅层（很多便携版直接丢在 D:\ApkStart-…）；
 *   - 桌面 / 开始菜单里现存快捷方式指向的真实 exe 所在目录（最准，用户装过就一定有）。
 */
function candidateRoots(installDir) {
  const roots = new Set();
  const add = (p) => { if (p) roots.add(p); };
  add(path.dirname(installDir));
  const local = process.env.LOCALAPPDATA;
  if (local) add(path.join(local, 'Programs'));
  add(process.env.ProgramFiles);
  add(process.env['ProgramFiles(x86)']);
  // 用户主目录下几个高频位置
  const home = os.homedir();
  if (home) {
    add(path.join(home, 'Downloads'));
    add(path.join(home, 'Desktop'));
    add(path.join(home, 'Documents'));
  }
  // 每个本地磁盘根目录（便携版常直接放盘根）
  try {
    for (const drv of ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\', 'H:\\']) {
      if (fs.existsSync(drv)) add(drv.replace(/\\+$/, ''));
    }
  } catch (_) { /* ignore */ }
  return [...roots];
}

/**
 * 从快捷方式（.lnk / .desktop）反查 ApkStart.exe 的真实所在目录。
 * 这是最可靠的发现手段：只要用户曾经创建过桌面图标或开始菜单项，目标路径就在里面，
 * 无论它被放在哪个盘、哪个深层文件夹。
 */
function rootsFromShortcuts() {
  const dirs = new Set();
  const homes = [os.homedir(), process.env.APPDATA, process.env.LOCALAPPDATA]
    .filter(Boolean);
  const linkDirs = [];
  for (const h of homes) {
    linkDirs.push(path.join(h, 'Desktop'));
    linkDirs.push(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    linkDirs.push(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ApkStart'));
  }
  for (const d of linkDirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!/\.(lnk|desktop)$/i.test(e.name)) continue;
      const full = path.join(d, e.name);
      try {
        if (/\.desktop$/i.test(e.name)) {
          const txt = fs.readFileSync(full, 'utf8');
          const m = /^Exec=(.+)$/m.exec(txt);
          if (m) {
            const exePath = m[1].trim().replace(/^"|"$/g, '').split(/\s+/)[0];
            if (exePath && /[\\/]ApkStart(\.exe)?$/i.test(exePath)) dirs.add(path.dirname(exePath));
          }
        } else {
          // .lnk 是二进制，但目标路径以可读形式内嵌，直接扫字节里的 ApkStart*.exe
          const buf = fs.readFileSync(full);
          const s = buf.toString('latin1');
          const re = /[A-Za-z]:\\[^\x00\x01-\x1f]*?ApkStart(?:-[^\x00\x01-\x1f]*)?[\\/]?ApkStart\.exe|[A-Za-z]:\\[^\x00\x01-\x1f]*?ApkStart\.exe/gi;
          let mm;
          while ((mm = re.exec(s))) {
            dirs.add(path.dirname(mm[0].replace(/\x00.*$/, '')));
          }
        }
      } catch (_) { /* 读不动就跳过 */ }
    }
  }
  return [...dirs];
}

/** 旧版本程序目录：形如 ApkStart*，且里面有 ApkStart.exe，且不是当前安装目录 */
function scanDirs(installDir) {
  const out = [];
  const seen = new Set();
  const cur = norm(installDir);
  const consider = (full) => {
    const key = norm(full);
    if (seen.has(key)) return;
    seen.add(key);
    if (key === cur) return;
    // 必须是「真的是 ApkStart」的目录，避免误删同名文件夹
    if (!fs.existsSync(path.join(full, EXE))) return;
    out.push({
      kind: 'dir',
      path: full,
      size: dirSize(full),
      note: '旧版本程序目录（含 ' + EXE + '）',
    });
  };
  for (const root of candidateRoots(installDir)) {
    let list = [];
    try { list = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!e.isDirectory()) continue;
      if (!/^ApkStart/i.test(e.name)) continue;
      consider(path.join(root, e.name));
    }
  }
  // 快捷方式反查到的目录：本身可能就是旧版本目录，或其父/子目录是
  for (const d of rootsFromShortcuts()) {
    if (/^ApkStart/i.test(path.basename(d))) consider(d);
    // 也看看它的同级（dist 下往往并排好几个版本目录）
    const parent = path.dirname(d);
    let sib = [];
    try { sib = fs.readdirSync(parent, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of sib) {
      if (e.isDirectory() && /^ApkStart/i.test(e.name)) consider(path.join(parent, e.name));
    }
  }
  return out;
}

/** 注册表里指向已不存在目录的卸载项 */
function scanRegistry() {
  const out = [];
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    let text = '';
    try {
      text = execFileSync('reg', ['query', root, '/s', '/f', 'ApkStart', '/t', 'REG_SZ'],
        { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    } catch (_) { continue; }
    // reg query 输出是分块的「键 → 值」，这里按块切
    const blocks = String(text).split(/\r?\n\r?\n/);
    for (const b of blocks) {
      const key = (/^(HKEY_[^\r\n]+)$/m.exec(b) || [])[1];
      if (!key) continue;
      if (!/\\ApkStart/i.test(key)) continue;
      const loc = (/InstallLocation\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const disp = (/DisplayName\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const unins = (/UninstallString\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const install = (loc || '').trim().replace(/^"|"$/g, '');
      const uninsPath = (unins || '').trim().replace(/^"|"$/g, '');
      const installMissing = install ? !fs.existsSync(install) : false;
      // 只处理「明明已经没装、却还挂在应用列表里」的死条目
      const deadUninstaller = uninsPath && !fs.existsSync(uninsPath.split('"')[0]);
      if (!installMissing && !deadUninstaller) continue;
      out.push({
        kind: 'registry',
        path: key,
        size: 0,
        note: `失效的卸载项${disp ? `：${String(disp).trim()}` : ''}`,
      });
    }
  }
  return out;
}

/** 更新缓存 / 临时包 */
function scanTemp(dataDir) {
  const out = [];
  const dirs = [path.join(dataDir, 'update'), os.tmpdir()];
  for (const d of dirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      const name = e.name;
      const isOurs = /^ApkStart.*\.(zip|exe|part\d*|tmp)$/i.test(name)
        || /^ApkStart-.*\.part\d+$/i.test(name);
      if (!isOurs) continue;
      const full = path.join(d, name);
      let size = 0;
      try { size = e.isDirectory() ? dirSize(full) : fs.statSync(full).size; } catch (_) { /* ignore */ }
      out.push({ kind: 'temp', path: full, size, note: '更新下载的临时文件' });
    }
  }
  return out;
}

/** 旧/废弃的快速启动快照：default_boot 是早期版本留下的（一份 ram.img 约 3GB），
 *  *.stale-* 是「删不掉就改名」的残留。当前快照名是 apkstart，绝不碰；
 *  不在这条策略里的目录也不上报（它们不是可清理项）。 */
function scanSnapshots(avdHome) {
  const out = [];
  const chain = snapshotChain(avdHome);
  if (!chain.ok) return out;
  const snapDir = chain.root;
  let list = [];
  try { list = fs.readdirSync(snapDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of list) {
    if (!e.isDirectory()) continue;
    if (e.name === CURRENT_SNAPSHOT) continue;   // 当前在用的快照
    if (!LEGACY_SNAPSHOT.test(e.name)) continue; // 与 emulator.js 的旧版清理策略一致
    const full = path.join(snapDir, e.name);
    if (isLink(full)) continue;                  // 链接/联接不当作可清理目录
    out.push({
      kind: 'snapshot',
      path: full,
      size: dirSize(full),
      note: /^default_boot$/i.test(e.name) ? '旧版遗留的快速启动快照' : '废弃的快照残留',
    });
  }
  return out;
}

function scan({ installDir, dataDir, avdHome }) {
  const items = [];
  const push = (list) => { for (const x of list) items.push(x); };
  push(scanDirs(installDir));
  push(scanRegistry());
  push(scanTemp(dataDir));
  push(scanSnapshots(avdHome));
  const total = items.reduce((n, x) => n + (x.size || 0), 0);
  return { items, totalBytes: total };
}

function rm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (_) { return false; }
}

function clean(items, { installDir, avdHome } = {}) {
  const cur = norm(installDir);
  // 快照按删除前实测的「普通文件逻辑字节长度」累加；这不是物理磁盘已回收空间。
  let freed = 0;
  const removed = [];
  const failed = [];
  for (const it of items || []) {
    try {
      if (it.kind === 'dir') {
        // 双保险：绝不删当前正在运行的目录
        if (norm(it.path) === cur) { failed.push({ path: it.path, reason: '这是当前正在运行的版本' }); continue; }
        if (!fs.existsSync(path.join(it.path, EXE))) { failed.push({ path: it.path, reason: '目录里没有 ' + EXE }); continue; }
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: '文件被占用（可能有窗口还开着）' });
      } else if (it.kind === 'snapshot') {
        // 快照不是普通目录：位置、整条受控目录链和类型都要能证明是「本 AVD 快照根下的旧版残留」
        const refusal = snapshotRefusal(it.path, avdHome);
        if (refusal) { failed.push({ path: it.path, reason: refusal }); continue; }
        const target = path.resolve(String(it.path));
        // 删除量由主进程在已验证范围内重新测量，绝不复用界面/缓存里的 it.size
        const measured = measureLogicalBytes(target);
        if (!measured.ok) { failed.push({ path: it.path, reason: measured.reason }); continue; }
        // 测量后、删除前再核验一次：扫描到删除之间的替换在这里被拒绝
        const recheck = snapshotRefusal(target, avdHome);
        if (recheck) { failed.push({ path: it.path, reason: recheck }); continue; }
        if (rm(target) && !fs.existsSync(target)) {
          freed += measured.bytes;
          removed.push(it.path);
        } else {
          failed.push({ path: it.path, reason: '删除失败或未完全删除（可能被占用）' });
        }
      } else if (it.kind === 'registry') {
        const r = execFileSync('reg', ['delete', it.path, '/f'], { windowsHide: true, timeout: 10000 });
        void r;
        removed.push(it.path);
      } else if (it.kind === 'temp') {
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: '文件被占用' });
      } else if (it.kind === 'shortcut') {
        if (rm(it.path)) removed.push(it.path);
        else failed.push({ path: it.path, reason: '删除失败' });
      }
    } catch (e) {
      failed.push({ path: it.path, reason: e.message });
    }
  }
  return { removed, failed, freedBytes: freed };
}

module.exports = { scan, clean };
