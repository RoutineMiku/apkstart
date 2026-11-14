'use strict';
/**
 * .apk 文件关联（仅写 HKCU，不需要管理员权限）
 * 双击 apk → apkstart.exe "%1" → 自动安装 → 自动建桌面快捷方式
 */
const { execFileSync } = require('child_process');

const PROGID = 'ApkStart.apk';
const EXT = '.apk';
const CLASSES = 'HKCU\\Software\\Classes';
// 关联前的「原默认程序」记在这里，卸载时原样还回去，别把用户的关联弄丢
const STORE_KEY = 'HKCU\\Software\\ApkStart';
const PREV_VALUE = 'assocPrev';

function reg(args) {
  try {
    execFileSync('reg', args, { windowsHide: true, stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  }
}

/** 读某个键的默认值（REG_SZ），读不到返回空串 */
function regDefault(key) {
  try {
    const out = execFileSync('reg', ['query', key, '/ve'], { windowsHide: true, encoding: 'utf8' });
    const line = String(out).split(/\r?\n/).find((l) => /REG_SZ/i.test(l));
    const m = line && /REG_SZ\s+(.*)$/i.exec(line);
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

/** 读我们记下的「关联前默认值」 */
function readPrev() {
  try {
    const out = execFileSync('reg', ['query', STORE_KEY, '/v', PREV_VALUE], { windowsHide: true, encoding: 'utf8' });
    const m = /REG_SZ\s+(.*)$/im.exec(String(out));
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

function notifyShell() {
  const ps = `
$sig = '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);';
try {
  $t = Add-Type -MemberDefinition $sig -Name 'ShNotify' -Namespace 'ApkStart' -PassThru -ErrorAction Stop;
  $t::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero);
} catch {}
`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true, stdio: 'pipe', timeout: 8000,
    });
  } catch (_) { /* 通知失败不影响关联本身 */ }
}

/**
 * @param {string} exePath apkstart 主程序路径（开发模式下是 electron.exe）
 * @param {string} [iconPath] 可选 ico
 * @param {string} [extraArgs] 开发模式下需要先传应用目录，例如 "\"C:\\path\\apkstart\""
 */
function registerAssociation(exePath, iconPath, extraArgs) {
  const icon = iconPath || exePath;
  const command = `"${exePath}" ${extraArgs ? extraArgs + ' ' : ''}"%1"`;

  // 记住关联前 .apk 的默认程序：用户本来装了别的安卓工具时，卸载 ApkStart
  // 之后应该还给他，而不是把 .apk 变成「没有默认程序」。
  const prev = regDefault(`${CLASSES}\\${EXT}`);
  if (prev && prev !== PROGID) {
    reg(['add', STORE_KEY, '/v', PREV_VALUE, '/d', prev, '/f']);
  } else if (!prev) {
    try { execFileSync('reg', ['delete', STORE_KEY, '/v', PREV_VALUE, '/f'], { windowsHide: true, stdio: 'pipe' }); } catch (_) { /* 本来就没有 */ }
  }

  reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', PROGID, '/f']);
  reg(['add', `${CLASSES}\\${EXT}\\OpenWithProgids`, '/v', PROGID, '/t', 'REG_NONE', '/f']);

  reg(['add', `${CLASSES}\\${PROGID}`, '/ve', '/d', 'Android 应用包', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}`, '/v', 'FriendlyTypeName', '/d', 'Android 应用包', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\DefaultIcon`, '/ve', '/d', `"${icon}",0`, '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\shell\\open`, '/ve', '/d', '安装到 ApkStart', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\shell\\open\\command`, '/ve', '/d', command, '/f']);

  notifyShell();
  return { ok: true, progId: PROGID, previous: prev };
}

/**
 * 取消关联。
 * 旧实现无条件把 .apk 的默认值清空（注释写了「仅当仍指向我们自己」，但代码没做），
 * 用户卸载 ApkStart 时会把原本的 .apk 关联一起抹掉。现在：
 *  1) 有关联前记录 → 原样还原；
 *  2) 没有记录且当前默认值仍是我们的 → 才清空；
 *  3) 当前默认值是别人的 → 一个字节都不动。
 */
function unregisterAssociation() {
  reg(['delete', `${CLASSES}\\${EXT}\\OpenWithProgids`, '/v', PROGID, '/f']);
  reg(['delete', `${CLASSES}\\${PROGID}`, '/f']);

  const prev = readPrev();
  const current = regDefault(`${CLASSES}\\${EXT}`);
  let restored = '';
  if (prev) {
    reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', prev, '/f']);
    restored = prev;
  } else if (current === PROGID) {
    reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', '', '/f']);
  }
  try { execFileSync('reg', ['delete', STORE_KEY, '/v', PREV_VALUE, '/f'], { windowsHide: true, stdio: 'pipe' }); } catch (_) { /* ignore */ }
  notifyShell();
  return { ok: true, restored };
}

module.exports = { registerAssociation, unregisterAssociation, PROGID };
