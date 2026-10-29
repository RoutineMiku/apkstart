'use strict';
/**
 * .apk 文件关联（仅写 HKCU，不需要管理员权限）
 * 双击 apk → apkstart.exe "%1" → 自动安装 → 自动建桌面快捷方式
 */
const { execFileSync } = require('child_process');

const PROGID = 'ApkStart.apk';
const EXT = '.apk';

function reg(args) {
  try {
    execFileSync('reg', args, { windowsHide: true, stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
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
  const classes = 'HKCU\\Software\\Classes';
  const icon = iconPath || exePath;
  const command = `"${exePath}" ${extraArgs ? extraArgs + ' ' : ''}"%1"`;

  reg(['add', `${classes}\\${EXT}`, '/ve', '/d', PROGID, '/f']);
  reg(['add', `${classes}\\${EXT}\\OpenWithProgids`, '/v', PROGID, '/t', 'REG_NONE', '/f']);

  reg(['add', `${classes}\\${PROGID}`, '/ve', '/d', 'Android 应用包', '/f']);
  reg(['add', `${classes}\\${PROGID}`, '/v', 'FriendlyTypeName', '/d', 'Android 应用包', '/f']);
  reg(['add', `${classes}\\${PROGID}\\DefaultIcon`, '/ve', '/d', `"${icon}",0`, '/f']);
  reg(['add', `${classes}\\${PROGID}\\shell\\open`, '/ve', '/d', '安装到 ApkStart', '/f']);
  reg(['add', `${classes}\\${PROGID}\\shell\\open\\command`, '/ve', '/d', command, '/f']);

  notifyShell();
  return { ok: true, progId: PROGID };
}

function unregisterAssociation() {
  const classes = 'HKCU\\Software\\Classes';
  reg(['delete', `${classes}\\${EXT}\\OpenWithProgids`, '/v', PROGID, '/f']);
  reg(['delete', `${classes}\\${PROGID}`, '/f']);
  // 仅当 .apk 仍指向我们自己时才清掉默认值
  reg(['add', `${classes}\\${EXT}`, '/ve', '/d', '', '/f']);
  notifyShell();
  return { ok: true };
}

module.exports = { registerAssociation, unregisterAssociation, PROGID };
