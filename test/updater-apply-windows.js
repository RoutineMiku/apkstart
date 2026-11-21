'use strict';
/**
 * Windows Updater.apply 回归：验证「复制/安装失败不能被当成成功」。
 *
 * 只做真实 TEMP 假安装：真实 PowerShell 进程、真实文件复制/哈希/文件锁。
 * 所有 Start-Process / Wait-Process / Start-Sleep 在私有 PowerShell 进程内
 * 被同名函数遮蔽，绝不启动安装器、应用 exe、cmd.exe 或任何真实可执行文件。
 *
 * 覆盖：隐藏载荷文件/目录、安装器失败不自动重启、File.Replace 当前条目
 * 失败后的 backup 恢复，以及恢复失败时的 exit 3。Replace 故障是测试进程内
 * 的模拟状态，不是真实 OS error 1177 复现。
 *
 * 默认加载本 worktree 的 src/core/updater.js；设置
 * APKSTART_UPDATER_SOURCE=<absolute updater.js> 可对旧版本跑同一套断言（RED 证据）。
 *
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 测试环境不可用。
 * 证据（生成的 PS 脚本、trace、日志、前后哈希）保留在打印出的 TEMP 根目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const shaFile = (p) => (fs.existsSync(p) ? sha(fs.readFileSync(p)) : null);
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

if (process.platform !== 'win32') {
  console.log('[updater-apply-windows] skipped: Windows-only regression');
  process.exit(0);
}

const SOURCE = process.env.APKSTART_UPDATER_SOURCE
  || path.join(__dirname, '..', 'src', 'core', 'updater.js');
const psExe = path.join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const attribExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'attrib.exe');

if (!fs.existsSync(SOURCE)) {
  console.error(`[updater-apply-windows] updater source missing: ${SOURCE}`);
  process.exit(2);
}
if (!fs.existsSync(psExe)) {
  console.error(`[updater-apply-windows] Windows PowerShell missing: ${psExe}`);
  process.exit(2);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-updater-apply-test-'));
if (/[[\]?*]/.test(tempRoot)) {
  console.error(`[updater-apply-windows] TEMP path contains PowerShell wildcard characters: ${tempRoot}`);
  process.exit(2);
}

function writeFile(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

function listDirs(dir, prefix) {
  try {
    return fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort();
  } catch (_) {
    return [];
  }
}

function setHidden(p) {
  const r = spawnSync(attribExe, ['+H', p], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`attrib +H failed for ${p}: status=${r.status} stderr=${r.stderr}`);
  }
}

function isHidden(p) {
  const command = `[bool](([System.IO.File]::GetAttributes(${psq(p)})) -band [System.IO.FileAttributes]::Hidden)`;
  const r = spawnSync(psExe, ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`hidden attribute probe failed for ${p}: status=${r.status} stderr=${r.stderr}`);
  }
  return r.stdout.trim().toLowerCase() === 'true';
}

function walkRel(root, base = root) {
  const out = [];
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, ent.name);
    if (ent.isDirectory()) out.push(...walkRel(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

function treeHashes(root) {
  const out = {};
  try {
    for (const rel of walkRel(root)) out[rel] = shaFile(path.join(root, rel.split('/').join(path.sep)));
  } catch (_) { /* missing tree -> empty map */ }
  return out;
}

function readJsonVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch (_) { return null; }
}

function sameTree(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i] || a[ka[i]] !== b[kb[i]]) return false;
  return true;
}

/** 独立于被测脚本的树摘要：排序后的 "rel:sha256" 行 + 末尾换行。 */
function treeDigest(files) {
  const lines = Object.keys(files).sort().map((rel) => `${rel}:${files[rel]}`);
  return sha(`${lines.join('\n')}\n`);
}

function backupHashes(install) {
  const out = {};
  for (const d of listDirs(install, '.apkstart-backup-')) {
    const root = path.join(install, d);
    for (const rel of walkRel(root)) out[`${d}/${rel}`] = shaFile(path.join(root, rel));
  }
  return out;
}

function loadUpdater(sourceText, spawnImpl) {
  // apply(spawn:false) 不会碰下载/解压/版本比较；把这些依赖换成显式失败，
  // 这样测试既能加载候选源码，也能加载旧源码，而不依赖外部网络或 node_modules。
  const never = () => { throw new Error('unexpected out-of-scope dependency call'); };
  const deps = {
    fs,
    path,
    crypto,
    child_process: { spawn: spawnImpl || never },
    './download': {
      downloadAny: never,
      downloadAnyParallel: never,
      downloadMulti: never,
      sha256File: never,
    },
    './zip': { ZipFile: class { constructor() { never(); } }, resolveZipEntry: never },
    './version': { cmpVer: never },
    './sources': { Sources: class {} },
    './incremental': {
      isAuxAsset: never,
      parseManifest: never,
      chooseMode: never,
      verifyExtracted: never,
      MANIFEST_RE: /(?:)/,
      APP_PACK_RE: /(?:)/,
    },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', sourceText)((id) => {
    if (!Object.hasOwn(deps, id)) throw new Error(`Unexpected require: ${id}`);
    return deps[id];
  }, mod, mod.exports);
  if (typeof mod.exports.Updater !== 'function') throw new Error('Updater export missing');
  return mod.exports.Updater;
}

function zipFixture(name, { sameLength, hidden = false }) {
  const caseRoot = path.join(tempRoot, name);
  const install = path.join(caseRoot, 'install');
  const data = path.join(caseRoot, 'data');
  const version = '9.9.9';
  const versionDir = path.join(data, 'update', version);
  const payload = path.join(versionDir, 'payload');
  const exe = path.join(install, 'ApkStart.exe');
  const resource = path.join(install, 'resources', 'app', 'critical.txt');
  const extra = path.join(install, 'resources', 'extra.txt');
  const nested = path.join(install, 'locales', 'en-US.pak');
  const hiddenCfg = path.join(install, 'resources', 'app', '.hidden-cfg');
  const hiddenDir = path.join(install, 'hidden-dir');
  const hiddenDirSecret = path.join(install, 'hidden-dir', 'secret.txt');

  const oldExe = Buffer.from(`OLD-EXE-${'x'.repeat(64)}`);
  const newExe = sameLength
    ? Buffer.from(`NEW-EXE-${'y'.repeat(64)}`)
    : Buffer.from(`NEW-EXE-v2-${'z'.repeat(96)}`);
  const oldResource = Buffer.from('OLD RESOURCE - must stay coherent with the old exe');
  const newResource = Buffer.from('NEW RESOURCE - must be installed with the new exe');
  const oldExtra = Buffer.from('OLD EXTRA');
  const newExtra = Buffer.from('NEW EXTRA');
  const oldNested = Buffer.from('OLD NESTED');
  const newNested = Buffer.from('NEW NESTED');
  const oldHiddenCfg = Buffer.from('OLD HIDDEN CFG');
  const newHiddenCfg = Buffer.from('NEW HIDDEN CFG');
  const newHiddenDirSecret = Buffer.from('NEW HIDDEN DIR SECRET');

  writeFile(exe, oldExe);
  writeFile(resource, oldResource);
  writeFile(extra, oldExtra);
  writeFile(nested, oldNested);
  writeFile(path.join(payload, 'ApkStart.exe'), newExe);
  writeFile(path.join(payload, 'resources', 'app', 'critical.txt'), newResource);
  writeFile(path.join(payload, 'resources', 'extra.txt'), newExtra);
  writeFile(path.join(payload, 'locales', 'en-US.pak'), newNested);
  let hiddenCfgWasHidden = false;
  let hiddenDirWasHidden = false;
  if (hidden) {
    // 真实 Hidden 属性：文件在可见目录里，目录本身隐藏。默认 Get-ChildItem
    // 两者都看不到；带 -Force 才应完整枚举。
    writeFile(hiddenCfg, oldHiddenCfg);
    setHidden(hiddenCfg);
    const payloadHiddenCfg = path.join(payload, 'resources', 'app', '.hidden-cfg');
    const payloadHiddenDir = path.join(payload, 'hidden-dir');
    writeFile(payloadHiddenCfg, newHiddenCfg);
    setHidden(payloadHiddenCfg);
    writeFile(path.join(payloadHiddenDir, 'secret.txt'), newHiddenDirSecret);
    setHidden(payloadHiddenDir);
    hiddenCfgWasHidden = isHidden(payloadHiddenCfg);
    hiddenDirWasHidden = isHidden(payloadHiddenDir);
    if (!hiddenCfgWasHidden || !hiddenDirWasHidden) {
      throw new Error('fixture did not acquire real Hidden attributes');
    }
  }
  writeFile(path.join(payload, '.apkstart-ready'), JSON.stringify({ version, fixture: true }));

  return {
    mode: 'zip',
    caseRoot, install, data, version, versionDir, payload, exe, resource, extra, nested,
    hidden, hiddenCfg, hiddenDir, hiddenDirSecret,
    hiddenCfgWasHidden, hiddenDirWasHidden,
    oldExe, newExe, oldResource, newResource, oldExtra, newExtra, oldNested, newNested,
    oldHiddenCfg, newHiddenCfg, newHiddenDirSecret,
  };
}

function setupFixture(name) {
  const caseRoot = path.join(tempRoot, name);
  const install = path.join(caseRoot, 'install');
  const data = path.join(caseRoot, 'data');
  const version = '9.9.9';
  const versionDir = path.join(data, 'update', version);
  const exe = path.join(install, 'ApkStart.exe');
  const installer = path.join(versionDir, 'Setup.exe');
  const oldExe = Buffer.from(`OLD-EXE-${'x'.repeat(64)}`);

  writeFile(exe, oldExe);
  writeFile(installer, 'NON-EXECUTABLE installer fixture; must never be launched');
  return {
    mode: 'setup',
    caseRoot, install, data, version, versionDir, payload: installer, exe, oldExe,
  };
}

function appFixture(name, { hidden = true } = {}) {
  const caseRoot = path.join(tempRoot, name);
  const install = path.join(caseRoot, 'install');
  const data = path.join(caseRoot, 'data');
  const userData = path.join(caseRoot, 'user-data');
  const version = '0.6.3';
  const oldVersion = '0.6.2';
  const versionDir = path.join(data, 'update', version);
  const payload = path.join(versionDir, 'app-payload');
  const appDst = path.join(install, 'resources', 'app');
  const appSrc = path.join(payload, 'resources', 'app');
  const exe = path.join(install, 'ApkStart.exe');
  const shellDll = path.join(install, 'ffmpeg.dll');
  const locales = path.join(install, 'locales', 'en-US.pak');
  const runtime = path.join(install, 'resources', 'runtime', 'node.txt');
  const sentinel = path.join(versionDir, 'diagnostic-sentinel.txt');

  // 旧 app 树 O：package.json 0.6.2 + 旧 JS + 新版本不再包含的 obsolete.js。
  writeFile(path.join(appDst, 'package.json'), JSON.stringify({ name: 'apkstart', version: oldVersion }, null, 2));
  writeFile(path.join(appDst, 'main.js'), 'OLD-MAIN-JS - must be restored byte for byte');
  writeFile(path.join(appDst, 'lib', 'shared.js'), 'OLD-SHARED-JS');
  writeFile(path.join(appDst, 'obsolete.js'), 'OLD-ONLY FILE - complete replacement must remove it');
  // 新 app 树 N：目标版本、新 JS、新目录；没有 obsolete.js，没有 exe。
  writeFile(path.join(appSrc, 'package.json'), JSON.stringify({ name: 'apkstart', version }, null, 2));
  writeFile(path.join(appSrc, 'main.js'), 'NEW-MAIN-JS - committed only after full verification');
  writeFile(path.join(appSrc, 'lib', 'shared.js'), 'NEW-SHARED-JS');
  writeFile(path.join(appSrc, 'lib', 'added.js'), 'NEW-ADDED-JS');
  writeFile(path.join(appSrc, 'assets', 'new-dir', 'data.txt'), 'NEW-DIR-DATA');
  let hiddenCfgWasHidden = false;
  let hiddenDirWasHidden = false;
  if (hidden) {
    // 真实 Hidden 属性：一个隐藏文件 + 一个隐藏父目录里的文件。默认枚举
    // 看不到它们；-Force 才应完整安装。
    writeFile(path.join(appSrc, '.hidden-cfg'), 'NEW-HIDDEN-CFG');
    setHidden(path.join(appSrc, '.hidden-cfg'));
    writeFile(path.join(appSrc, 'hidden-dir', 'secret.txt'), 'NEW-HIDDEN-DIR-SECRET');
    setHidden(path.join(appSrc, 'hidden-dir'));
    hiddenCfgWasHidden = isHidden(path.join(appSrc, '.hidden-cfg'));
    hiddenDirWasHidden = isHidden(path.join(appSrc, 'hidden-dir'));
    if (!hiddenCfgWasHidden || !hiddenDirWasHidden) {
      throw new Error('app fixture did not acquire real Hidden attributes');
    }
  }
  writeFile(path.join(payload, '.apkstart-ready'), JSON.stringify({ version, fixture: true }));
  writeFile(path.join(versionDir, 'app.zip'), 'fixture archive bytes, never executed');
  writeFile(sentinel, 'diagnostic sentinel - may be locked to block version-dir cleanup');

  // 外壳 / 运行时 / 用户数据哨兵：app 替换不得触碰。
  writeFile(exe, 'SHELL-EXE-SENTINEL');
  writeFile(shellDll, 'SHELL-DLL-SENTINEL');
  writeFile(locales, 'LOCALES-SENTINEL');
  writeFile(runtime, 'RUNTIME-SENTINEL');
  writeFile(path.join(userData, 'settings.json'), JSON.stringify({ fixture: true, avd: 'fixture-avd' }));

  const fx = {
    mode: 'app',
    caseRoot, install, data, userData, version, oldVersion, versionDir, payload,
    appDst, appSrc, exe, shellDll, locales, runtime, sentinel,
    hidden, hiddenCfgWasHidden, hiddenDirWasHidden,
  };
  // 期望树：直接按夹具内容独立计算，不读候选脚本的中间状态。
  fx.oldFiles = treeHashes(appDst);
  fx.newFiles = treeHashes(appSrc);
  return fx;
}

function controlPrelude(cfg) {
  const lines = [
    `$ErrorActionPreference = 'Stop'`,
    `$script:ProbeTrace = ${psq(cfg.traceFile)}`,
    `$script:ProbeInstallerExit = ${cfg.installerExit == null ? '$null' : cfg.installerExit}`,
    `$script:ProbeInstallerStartFails = $${cfg.installerStartFails ? 'true' : 'false'}`,
    `$script:ProbeAppLaunchFails = $${cfg.appLaunchFails ? 'true' : 'false'}`,
    `$script:ProbeCmdFallbackWorks = $${cfg.cmdFallbackWorks ? 'true' : 'false'}`,
    `function Write-ProbeEvent($name, $details) {`,
    `  $probeEventJson = @{ event = $name; details = $details } | ConvertTo-Json -Compress -Depth 6`,
    `  [System.IO.File]::AppendAllText($script:ProbeTrace, $probeEventJson + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))`,
    `}`,
    `function Get-ProbeTreeDigest([string]$root) {`,
    `  if (-not (Test-Path -LiteralPath $root)) { return 'MISSING' }`,
    `  $base = $root.TrimEnd('\\')`,
    `  $lines = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction Stop | Sort-Object FullName | ForEach-Object {`,
    `    $rel = $_.FullName.Substring($base.Length).TrimStart('\\').Replace('\\', '/')`,
    `    $rel + ':' + (HashFile $_.FullName)`,
    `  })`,
    `  $nl = [string][char]10`,
    `  $text = ($lines -join $nl) + $nl`,
    `  $s = [System.Security.Cryptography.SHA256]::Create()`,
    `  try { return [System.BitConverter]::ToString($s.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() }`,
    `}`,
    `$script:ProbeLaunchTreeRoot = ${cfg.launchTreeRoot ? psq(cfg.launchTreeRoot) : '$null'}`,
    `function Start-Process {`,
    `  [CmdletBinding()]`,
    `  param([string]$FilePath, [object[]]$ArgumentList, [string]$WorkingDirectory, [string]$WindowStyle, [switch]$PassThru, [switch]$Wait)`,
    `  $treeDigest = $null`,
    `  if ($script:ProbeLaunchTreeRoot) { try { $treeDigest = Get-ProbeTreeDigest $script:ProbeLaunchTreeRoot } catch { $treeDigest = 'ERROR' } }`,
    `  Write-ProbeEvent 'start-process-stub' @{ file = $FilePath; passThru = [bool]$PassThru; wait = [bool]$Wait; executed = $false; treeRoot = $script:ProbeLaunchTreeRoot; treeDigest = $treeDigest }`,
    `  if ($FilePath -ieq 'cmd.exe') {`,
    `    if (-not $script:ProbeCmdFallbackWorks) { Write-Error 'simulated cmd start failure'; return }`,
    `    Write-ProbeEvent 'cmd-start-stub' @{ executed = $false; simulated = $true }`,
    `    return`,
    `  }`,
    `  if ($PassThru -and $Wait) {`,
    `    if ($script:ProbeInstallerStartFails) { Write-Error 'simulated installer startup failure'; return }`,
    `    return [pscustomobject]@{ Id = -7; ExitCode = $script:ProbeInstallerExit }`,
    `  }`,
    `  if ($script:ProbeAppLaunchFails) { Write-Error 'simulated app launch failure'; return }`,
    `}`,
    `function Wait-Process {`,
    `  [CmdletBinding()]`,
    `  param([int]$Id, [int]$Timeout)`,
    `  Write-ProbeEvent 'wait-process-stub' @{ id = $Id; timeout = $Timeout }`,
    `}`,
    `function Start-Sleep {`,
    `  [CmdletBinding()]`,
    `  param([int]$Milliseconds, [int]$Seconds)`,
    `  Write-ProbeEvent 'sleep-stub' @{ milliseconds = $Milliseconds; seconds = $Seconds }`,
    `}`,
    `foreach ($name in @('Start-Process','Wait-Process','Start-Sleep')) {`,
    `  if ((Get-Command $name).CommandType -ne 'Function') { throw ('Control missing: ' + $name) }`,
    `}`,
    `Write-ProbeEvent 'controls-installed' @{ noExecutableLaunch = $true }`,
  ];
  if (cfg.replaceFault) {
    const relSuffix = `\\${String(cfg.replaceFault.rel).replace(/\//g, '\\')}`;
    lines.push(
      `$script:ProbeReplaceFaultSuffix = ${psq(relSuffix)}`,
      `$script:ProbeReplaceFaultMode = ${psq(cfg.replaceFault.mode || 'throw')}`,
      `$script:ProbeReplaceFaultDone = $false`,
      `$script:ProbeBackupLock = $null`,
      `function Invoke-ApkstartReplace([string]$Stage, [string]$Target, [string]$Backup) {`,
      `  if ((-not $script:ProbeReplaceFaultDone) -and $Target.EndsWith($script:ProbeReplaceFaultSuffix, [System.StringComparison]::OrdinalIgnoreCase)) {`,
      `    $script:ProbeReplaceFaultDone = $true`,
      `    Write-ProbeEvent 'replace-fault-injected' @{ target = $Target; backup = $Backup; mode = $script:ProbeReplaceFaultMode; simulated = $true; osError1177 = $false }`,
      `    if (Test-Path -LiteralPath $Target) { [System.IO.File]::Move($Target, $Backup) }`,
      `    if ($script:ProbeReplaceFaultMode -eq 'lock-backup') {`,
      `      $script:ProbeBackupLock = [System.IO.File]::Open($Backup, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)`,
      `    }`,
      `    throw 'simulated post-backup ReplaceFile failure: target renamed to backup, replacement not moved (documented ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 state; NOT a real OS error 1177 reproduction)'`,
      `  }`,
      `  [System.IO.File]::Replace($Stage, $Target, $Backup)`,
      `}`,
    );
  }
  if (cfg.lockPath) {
    lines.push(
      `$script:ProbeLock = [System.IO.File]::Open(${psq(cfg.lockPath)}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)`,
      `Write-ProbeEvent 'exclusive-lock-acquired' @{ path = ${psq(cfg.lockPath)}; share = 'None' }`,
    );
  }
  if (cfg.readLockPath) {
    // FileShare.Read：允许其他进程读取/哈希（旧树仍可逐字节验收），
    // 但拒绝 DELETE —— Windows 下目录换名会因此失败，是真实 OS 行为。
    lines.push(
      `$script:ProbeReadLock = [System.IO.File]::Open(${psq(cfg.readLockPath)}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)`,
      `Write-ProbeEvent 'read-lock-acquired' @{ path = ${psq(cfg.readLockPath)}; share = 'Read' }`,
    );
  }
  if (cfg.appVerifyFault) {
    // 只替换「提交后验证」这一个阶段：真实备份/提交/恢复仍由候选脚本执行。
    // 事件里记录故障发生时 D 的实际内容，用于证明「先改动、后回滚」。
    lines.push(
      `function Invoke-ApkstartAppVerify([string]$Root, [string]$Version, [hashtable]$Manifest) {`,
      `  $dExists = Test-Path -LiteralPath $Root`,
      `  $pkgVersion = $null`,
      `  $mainText = $null`,
      `  $fileCount = -1`,
      `  if ($dExists) {`,
      `    try { $pkgVersion = (Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version } catch { }`,
      `    try { $mainText = [System.IO.File]::ReadAllText((Join-Path $Root 'main.js')) } catch { }`,
      `    try { $fileCount = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction Stop).Count } catch { }`,
      `  }`,
      `  Write-ProbeEvent 'app-verify-fault-injected' @{ root = $Root; expectedVersion = $Version; dExists = $dExists; dPkgVersion = $pkgVersion; dMainText = $mainText; fileCount = $fileCount; simulated = $true }`,
      `  throw 'simulated post-commit app verification failure'`,
      `}`,
    );
  }
  if (cfg.appRestoreMoveFault) {
    // 只阻止「恢复换名」这一个必要操作；候选脚本自己的删除/校验代码仍真实执行。
    lines.push(
      `function Invoke-ApkstartAppRestoreMove([string]$Backup, [string]$Tree) {`,
      `  $treeExists = Test-Path -LiteralPath $Tree`,
      `  $backupExists = Test-Path -LiteralPath $Backup`,
      `  Write-ProbeEvent 'app-restore-move-fault-injected' @{ backup = $Backup; tree = $Tree; treeExists = $treeExists; backupExists = $backupExists; simulated = $true }`,
      `  throw 'simulated app restore move failure'`,
      `}`,
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

function readTrace(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch (_) { return { event: 'trace-parse-error', raw: line }; }
    });
}

function snapshot(fx) {
  const files = fx.mode === 'zip'
    ? {
      exe: shaFile(fx.exe),
      resource: shaFile(fx.resource),
      extra: shaFile(fx.extra),
      nested: shaFile(fx.nested),
      hiddenCfg: shaFile(fx.hiddenCfg),
      hiddenDirSecret: shaFile(fx.hiddenDirSecret),
    }
    : { exe: shaFile(fx.exe) };
  const state = {
    ...files,
    payloadPresent: fs.existsSync(fx.payload),
    versionDirPresent: fs.existsSync(fx.versionDir),
    stageDirs: listDirs(fx.install, '.apkstart-stage-'),
    backupDirs: listDirs(fx.install, '.apkstart-backup-'),
    backupFiles: backupHashes(fx.install),
  };
  if (fx.mode === 'app') {
    state.appFiles = treeHashes(fx.appDst);
    state.installedPkgVersion = readJsonVersion(fx.appDst);
    state.shell = {
      exe: shaFile(fx.exe),
      dll: shaFile(fx.shellDll),
      locales: shaFile(fx.locales),
      runtime: shaFile(fx.runtime),
    };
    state.userData = treeHashes(fx.userData);
    state.forceFullPresent = fs.existsSync(path.join(fx.versionDir, '.apkstart-force-full'));
    state.diagnosticSentinel = shaFile(fx.sentinel);
  }
  return state;
}

function runCase(Updater, fx, opts) {
  const evidence = path.join(fx.caseRoot, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });

  const updater = new Updater({
    currentVersion: '0.1.0', exePath: fx.exe, isPackaged: true, dataDir: fx.data,
  });
  const script = updater.apply(
    { mode: fx.mode, payload: fx.payload, version: fx.version },
    { spawn: false, waitPid: 424242 },
  );
  if (typeof script !== 'string') throw new Error('apply(spawn:false) did not return a script');

  const traceFile = path.join(evidence, 'controls.jsonl');
  const wrapper = controlPrelude({
    traceFile,
    lockPath: opts.lockPath || null,
    readLockPath: opts.readLockPath || null,
    installerExit: Object.hasOwn(opts, 'installerExit') ? opts.installerExit : 0,
    installerStartFails: !!opts.installerStartFails,
    appLaunchFails: !!opts.appLaunchFails,
    cmdFallbackWorks: opts.cmdFallbackWorks !== false,
    replaceFault: opts.replaceFault || null,
    launchTreeRoot: opts.launchTreeRoot || null,
    appVerifyFault: !!opts.appVerifyFault,
    appRestoreMoveFault: !!opts.appRestoreMoveFault,
  }) + script;

  const before = snapshot(fx);
  // 生产 helper 用 -EncodedCommand（避免中文路径按 GBK 解码）；测试包装脚本
  // 加上控制函数后超过 Windows 命令行上限，因此写带 BOM 的 .ps1 再用 -File。
  // 脚本内容与生产 helper 相同，只是执行通道不同。
  const controlled = `\uFEFF${wrapper}`;
  const controlledFile = path.join(evidence, 'controlled-execution.ps1');
  writeFile(path.join(evidence, 'production-apply.ps1'), script);
  writeFile(controlledFile, controlled);
  writeFile(path.join(evidence, 'before.json'), JSON.stringify(before, null, 2));

  const child = spawnSync(psExe, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', controlledFile,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    cwd: fx.caseRoot,
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
  });

  writeFile(path.join(evidence, 'powershell.stdout.log'), child.stdout || '');
  writeFile(path.join(evidence, 'powershell.stderr.log'), child.stderr || '');

  const trace = readTrace(traceFile);
  const after = snapshot(fx);
  const logFile = path.join(fx.data, 'update', 'update.log');
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';

  return {
    case: opts.name,
    expectation: opts.expectation,
    source: SOURCE,
    sourceSha256: sha(fs.readFileSync(SOURCE)),
    caseRoot: fx.caseRoot,
    evidence,
    paths: { install: fx.install, exe: fx.exe, payload: fx.payload, versionDir: fx.versionDir },
    fixture: {
      mode: fx.mode,
      oldExeLength: fx.oldExe ? fx.oldExe.length : null,
      newExeLength: fx.newExe ? fx.newExe.length : null,
      hidden: !!fx.hidden,
      hiddenCfgWasHidden: !!fx.hiddenCfgWasHidden,
      hiddenDirWasHidden: !!fx.hiddenDirWasHidden,
    },
    expectedTrees: fx.mode === 'app'
      ? { oldFiles: fx.oldFiles, newFiles: fx.newFiles, oldVersion: fx.oldVersion, newVersion: fx.version }
      : null,
    intended: fx.newExe
      ? {
        exe: sha(fx.newExe),
        resource: sha(fx.newResource),
        extra: sha(fx.newExtra),
        nested: sha(fx.newNested),
        hiddenCfg: fx.hidden ? sha(fx.newHiddenCfg) : null,
        hiddenDirSecret: fx.hidden ? sha(fx.newHiddenDirSecret) : null,
      }
      : {},
    before,
    after,
    powershell: {
      exitCode: child.status,
      signal: child.signal || null,
      error: child.error ? String(child.error.message) : null,
      stdoutSha256: sha(Buffer.from(child.stdout || '', 'utf8')),
      stderrSha256: sha(Buffer.from(child.stderr || '', 'utf8')),
    },
    trace: {
      all: trace,
      controlsPresent: trace.some((e) => e.event === 'controls-installed'),
      lockAcquired: trace.some((e) => e.event === 'exclusive-lock-acquired'),
      readLockAcquired: trace.some((e) => e.event === 'read-lock-acquired'),
      faultInjected: trace.some((e) => e.event === 'replace-fault-injected'),
      faultEvents: trace.filter((e) => e.event === 'replace-fault-injected'),
      appVerifyFault: trace.find((e) => e.event === 'app-verify-fault-injected') || null,
      appRestoreMoveFault: trace.find((e) => e.event === 'app-restore-move-fault-injected') || null,
      launchStubs: trace.filter((e) => e.event === 'start-process-stub'),
      realExeLaunches: trace.filter((e) => e.event === 'start-process-stub'
        && e.details && e.details.executed === true).length,
    },
    log,
    productionScriptSha256: sha(Buffer.from(script, 'utf8')),
    controlledScriptSha256: sha(Buffer.from(controlled, 'utf8')),
  };
}

function evaluate(raw, verify) {
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail: detail == null ? null : String(detail) });
  };
  verify(raw, check);
  raw.checks = checks;
  raw.passed = checks.every((c) => c.ok);
  writeFile(path.join(raw.evidence, 'result.json'), JSON.stringify(raw, null, 2));
  return raw;
}

function commonChecks(raw, check, { lockExpected = false } = {}) {
  check('controls installed inside private PowerShell', raw.trace.controlsPresent);
  check('no real executable launch', raw.trace.realExeLaunches === 0,
    `realExeLaunches=${raw.trace.realExeLaunches}`);
  check('PowerShell returned a real exit code', raw.powershell.exitCode !== null && !raw.powershell.error,
    `exit=${raw.powershell.exitCode} error=${raw.powershell.error}`);
  if (lockExpected) check('exclusive lock acquired before helper', raw.trace.lockAcquired);
}

// ---------------------------------------------------------------------------
// 生产调度回归：apply() 真实走 spawn 的通道。
// ROOT-R5-DISPATCH-PROBE 证明 app helper 编码后 >32000 字符，旧 -EncodedCommand
// 直传在真实安装路径下 spawn 调用数为 0。这里同时断言：
//   1) Node 侧捕获的 spawn 命令与脚本体量无关（只有定长 bootstrap）；
//   2) 捕获到的 bootstrap 文本原样执行：读文件、校验 SHA-256、解码、执行；
//   3) 真实完整 helper 在中文/空格/单引号/长路径夹具中复制成功；
//   4) 运行前替换 helper 字节 → 摘要拒绝执行，文件状态不变。
// 所有 Start-Process / Wait-Process / Start-Sleep 仍被桩遮蔽并记录。
// ---------------------------------------------------------------------------

function captureSpawn(calls) {
  return (exe, args, spawnOpts) => {
    calls.push({ exe, args, spawnOpts });
    return { pid: 7654321, on() { return this; }, unref() {} };
  };
}

function dispatchFixture(name, installName, dataName) {
  const caseRoot = path.join(tempRoot, name);
  const install = path.join(caseRoot, installName);
  const data = path.join(caseRoot, dataName);
  const version = '0.6.3';
  const oldVersion = '0.6.2';
  const versionDir = path.join(data, 'update', version);
  const payload = path.join(versionDir, 'app-payload');
  const appDst = path.join(install, 'resources', 'app');
  const appSrc = path.join(payload, 'resources', 'app');
  const exe = path.join(install, 'ApkStart.exe');

  writeFile(path.join(appDst, 'package.json'), JSON.stringify({ name: 'apkstart', version: oldVersion }));
  writeFile(path.join(appDst, 'main.js'), 'OLD-MAIN-JS');
  writeFile(path.join(appDst, 'obsolete.js'), 'OLD-ONLY FILE');
  writeFile(path.join(appSrc, 'package.json'), JSON.stringify({ name: 'apkstart', version }));
  writeFile(path.join(appSrc, 'main.js'), 'NEW-MAIN-JS - committed only after verification');
  writeFile(path.join(appSrc, 'lib', 'added.js'), 'NEW-ADDED-JS');
  writeFile(path.join(payload, '.apkstart-ready'), JSON.stringify({ version, fixture: true }));
  writeFile(exe, 'SHELL-EXE-SENTINEL');

  const fx = {
    mode: 'app', caseRoot, install, data, version, oldVersion, versionDir, payload,
    appDst, appSrc, exe,
  };
  fx.oldFiles = treeHashes(appDst);
  fx.newFiles = treeHashes(appSrc);
  return fx;
}

function runDispatchCase(spec, load) {
  const fx = dispatchFixture(spec.name, spec.installName, spec.dataName);
  const evidence = path.join(fx.caseRoot, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const job = { mode: 'app', payload: fx.payload, version: fx.version };
  const calls = [];
  const Updater = load(captureSpawn(calls));

  const script = new Updater({
    currentVersion: fx.oldVersion, exePath: fx.exe, isPackaged: true, dataDir: fx.data,
  }).apply(job, { spawn: false, waitPid: 424242 });
  const before = { tree: treeHashes(fx.appDst), exe: shaFile(fx.exe) };
  const launched = new Updater({
    currentVersion: fx.oldVersion, exePath: fx.exe, isPackaged: true, dataDir: fx.data,
  }).apply(job, { waitPid: 424242 });

  const helperDir = path.join(fx.data, 'update');
  const helperNames = fs.readdirSync(helperDir).filter((n) => /^apply-helper-.*\.ps1$/.test(n));
  const helperFile = helperNames.length === 1 ? path.join(helperDir, helperNames[0]) : null;
  const helperBytes = helperFile ? fs.readFileSync(helperFile) : null;

  const call = calls[0] || null;
  const argsJoined = call ? call.args.join(' ') : '';
  const encIndex = call ? call.args.indexOf('-EncodedCommand') : -1;
  const bootstrap = encIndex >= 0 ? Buffer.from(call.args[encIndex + 1], 'base64').toString('utf16le') : '';
  const digestMatch = /\$h = '([0-9a-f]{64})'/.exec(bootstrap);
  const digest = digestMatch ? digestMatch[1] : null;

  // 原样执行捕获到的 bootstrap：control prelude 只定义桩，bootstrap 本身
  // 取自生产的 spawn 参数，不是重写副本。
  const traceFile = path.join(evidence, 'controls.jsonl');
  const controlled = `\uFEFF${controlPrelude({
    traceFile,
    installerExit: 0,
    appLaunchFails: !!spec.appLaunchFails,
    cmdFallbackWorks: true,
  })}${bootstrap}`;
  const controlledFile = path.join(evidence, 'captured-bootstrap.ps1');
  writeFile(controlledFile, controlled);
  writeFile(path.join(evidence, 'production-apply.ps1'), script);
  writeFile(path.join(evidence, 'captured-spawn.json'), JSON.stringify({
    exe: call ? call.exe : null,
    args: call ? call.args : [],
    argsLength: argsJoined.length,
    wholeScriptEncodedChars: Buffer.from(script, 'utf16le').toString('base64').length,
    bootstrap,
  }, null, 2));
  writeFile(path.join(evidence, 'before.json'), JSON.stringify(before, null, 2));

  const child = spawnSync(psExe, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', controlledFile,
  ], {
    encoding: 'utf8', windowsHide: true, cwd: fx.caseRoot, timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  });
  writeFile(path.join(evidence, 'powershell.stdout.log'), child.stdout || '');
  writeFile(path.join(evidence, 'powershell.stderr.log'), child.stderr || '');

  const trace = readTrace(traceFile);
  const after = { tree: treeHashes(fx.appDst), exe: shaFile(fx.exe) };
  const logFile = path.join(fx.data, 'update', 'update.log');
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';

  const raw = {
    case: spec.name,
    expectation: spec.expectation,
    source: SOURCE,
    sourceSha256: sha(fs.readFileSync(SOURCE)),
    caseRoot: fx.caseRoot,
    evidence,
    paths: { install: fx.install, exe: fx.exe, payload: fx.payload, versionDir: fx.versionDir },
    fixture: { maxFixturePath: Math.max(fx.exe.length, path.join(fx.appSrc, 'lib', 'added.js').length) },
    dispatch: {
      launched,
      spawnCalls: calls.length,
      exe: call ? call.exe : null,
      argsLength: argsJoined.length,
      bootstrapChars: bootstrap.length,
      wholeScriptEncodedChars: Buffer.from(script, 'utf16le').toString('base64').length,
      helperFile,
      helperBytesSha256: helperBytes ? sha(helperBytes) : null,
      digest,
      helperNames,
    },
    before,
    after,
    powershell: {
      exitCode: child.status,
      signal: child.signal || null,
      error: child.error ? String(child.error.message) : null,
      stdout: child.stdout || '',
      stderr: child.stderr || '',
    },
    trace: {
      all: trace,
      controlsPresent: trace.some((e) => e.event === 'controls-installed'),
      waitStubs: trace.filter((e) => e.event === 'wait-process-stub'),
      launchStubs: trace.filter((e) => e.event === 'start-process-stub'),
      realExeLaunches: trace.filter((e) => e.event === 'start-process-stub'
        && e.details && e.details.executed === true).length,
    },
    log,
    script,
    controlled,
  };
  raw.checks = [];
  const check = (name, ok, detail) => {
    raw.checks.push({ name, ok: !!ok, detail: detail == null ? null : String(detail) });
  };

  check('apply() returned a full (non-throwing) helper script', typeof script === 'string' && script.length > 10000,
    `chars=${script.length}`);
  check('exactly one production spawn call', calls.length === 1, `calls=${calls.length}`);
  check('spawn uses Windows PowerShell', call && call.exe === psExe, call ? call.exe : 'no call');
  check('command line is bounded and independent of script size', call && argsJoined.length < 4096,
    `args=${argsJoined.length} wholeScriptEncoded=${Buffer.from(script, 'utf16le').toString('base64').length}`);
  check('command line stays below the Windows 32767 limit', call && argsJoined.length < 30000,
    `args=${argsJoined.length}`);
  check('bootstrap is short and does not embed the helper body',
    bootstrap.length > 0 && bootstrap.length < 3000 && !bootstrap.includes('$applyOk'),
    `bootstrapChars=${bootstrap.length}`);
  check('exactly one unique helper file written', helperNames.length === 1,
    helperNames.join(','));
  check('helper bytes are BOM + the tested script',
    helperBytes && helperBytes.toString('utf8') === `\uFEFF${script}`,
    helperFile || 'missing');
  check('bootstrap carries the helper sha256', digest && helperBytes && sha(helperBytes) === digest,
    `${digest} vs ${helperBytes ? sha(helperBytes) : null}`);
  check('fixture path is realistic and below MAX_PATH',
    !spec.longPath || (raw.fixture.maxFixturePath >= 190 && raw.fixture.maxFixturePath < 260),
    `maxFixturePath=${raw.fixture.maxFixturePath}`);
  check('controls installed inside private PowerShell', raw.trace.controlsPresent);
  check('wait is stubbed', raw.trace.waitStubs.length >= 1);
  check('no real executable launch', raw.trace.realExeLaunches === 0);
  check('helper exits 0 after verified app replacement', child.status === 0, `exit=${child.status}`);
  check('installed app tree equals verified new tree',
    sameTree(raw.after.tree, fx.newFiles),
    `after=${Object.keys(raw.after.tree).join(',')} new=${Object.keys(fx.newFiles).join(',')}`);
  check('obsolete old file removed', !Object.hasOwn(raw.after.tree, 'obsolete.js'));
  check('shell exe untouched', raw.after.exe === before.exe);
  check('bootstrap deleted the helper after verified read',
    helperFile !== null && !fs.existsSync(helperFile), helperFile || 'missing');
  check('diagnostic apply.log.ps1 retained', fs.existsSync(path.join(helperDir, 'apply.log.ps1')));
  check('exactly one app launch request through stub',
    raw.trace.launchStubs.filter((e) => e.details && e.details.file === fx.exe).length === 1);

  raw.passed = raw.checks.every((c) => c.ok);
  writeFile(path.join(evidence, 'result.json'), JSON.stringify(raw, null, 2));
  return raw;
}

function runTamperCase(spec, load) {
  const fx = dispatchFixture(spec.name, spec.installName, spec.dataName);
  const evidence = path.join(fx.caseRoot, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const job = { mode: 'app', payload: fx.payload, version: fx.version };
  const calls = [];
  const Updater = load(captureSpawn(calls));
  const before = { tree: treeHashes(fx.appDst), exe: shaFile(fx.exe) };

  new Updater({
    currentVersion: fx.oldVersion, exePath: fx.exe, isPackaged: true, dataDir: fx.data,
  }).apply(job, { waitPid: 424242 });

  const helperDir = path.join(fx.data, 'update');
  const helperNames = fs.readdirSync(helperDir).filter((n) => /^apply-helper-.*\.ps1$/.test(n));
  const helperFile = helperNames.length === 1 ? path.join(helperDir, helperNames[0]) : null;
  const originalBytes = helperFile ? fs.readFileSync(helperFile) : null;
  if (helperFile) fs.appendFileSync(helperFile, '\r\nWrite-Output "TAMPERED";\r\n');

  const call = calls[0] || null;
  const encIndex = call ? call.args.indexOf('-EncodedCommand') : -1;
  const bootstrap = encIndex >= 0 ? Buffer.from(call.args[encIndex + 1], 'base64').toString('utf16le') : '';

  const traceFile = path.join(evidence, 'controls.jsonl');
  const controlled = `\uFEFF${controlPrelude({ traceFile, installerExit: 0 })}${bootstrap}`;
  const controlledFile = path.join(evidence, 'captured-bootstrap.ps1');
  writeFile(controlledFile, controlled);
  writeFile(path.join(evidence, 'before.json'), JSON.stringify(before, null, 2));

  const child = spawnSync(psExe, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', controlledFile,
  ], {
    encoding: 'utf8', windowsHide: true, cwd: fx.caseRoot, timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  });
  writeFile(path.join(evidence, 'powershell.stdout.log'), child.stdout || '');
  writeFile(path.join(evidence, 'powershell.stderr.log'), child.stderr || '');

  const trace = readTrace(traceFile);
  const after = { tree: treeHashes(fx.appDst), exe: shaFile(fx.exe) };
  const raw = {
    case: spec.name,
    expectation: spec.expectation,
    source: SOURCE,
    sourceSha256: sha(fs.readFileSync(SOURCE)),
    caseRoot: fx.caseRoot,
    evidence,
    paths: { install: fx.install, exe: fx.exe, payload: fx.payload, versionDir: fx.versionDir },
    dispatch: {
      spawnCalls: calls.length,
      helperFile,
      originalSha256: originalBytes ? sha(originalBytes) : null,
      tamperedSha256: helperFile ? sha(fs.readFileSync(helperFile)) : null,
      argsLength: call ? call.args.join(' ').length : 0,
    },
    before,
    after,
    powershell: {
      exitCode: child.status,
      signal: child.signal || null,
      error: child.error ? String(child.error.message) : null,
      stdout: child.stdout || '',
      stderr: child.stderr || '',
    },
    trace: {
      all: trace,
      controlsPresent: trace.some((e) => e.event === 'controls-installed'),
      waitStubs: trace.filter((e) => e.event === 'wait-process-stub'),
      launchStubs: trace.filter((e) => e.event === 'start-process-stub'),
    },
  };
  const check = (name, ok, detail) => {
    raw.checks.push({ name, ok: !!ok, detail: detail == null ? null : String(detail) });
  };
  raw.checks = [];
  check('helper was tampered after apply()', raw.dispatch.originalSha256 !== raw.dispatch.tamperedSha256);
  check('matched bootstrap refuses tampered bytes',
    `${child.stdout || ''}${child.stderr || ''}`.includes('digest mismatch'),
    `exit=${child.status}`);
  check('tampered dispatch exits non-zero', child.status !== 0, `exit=${child.status}`);
  check('no helper body executed after tamper', raw.trace.waitStubs.length === 0
    && raw.trace.launchStubs.length === 0);
  check('installed tree unchanged after refused dispatch',
    sameTree(raw.after.tree, before.tree) && raw.after.exe === before.exe);
  check('tampered helper is not executed and remains for diagnosis',
    helperFile !== null && fs.existsSync(helperFile));
  raw.passed = raw.checks.every((c) => c.ok);
  writeFile(path.join(evidence, 'result.json'), JSON.stringify(raw, null, 2));
  return raw;
}

const dispatchSpecs = [
  {
    name: 'dispatch-long-quote-space',
    expectation: 'production channel executes the full helper with a long path containing a single quote and spaces',
    installName: `Owner's apps ${'x'.repeat(100)}`,
    dataName: `data ${'d'.repeat(50)}`,
    longPath: true,
  },
  {
    name: 'dispatch-chinese-quote-space',
    expectation: 'production channel executes the full helper with Chinese, spaces and a single quote in paths',
    installName: `所有者's 应用 ${'z'.repeat(80)}`,
    dataName: `数据 目录's ${'q'.repeat(40)}`,
    longPath: true,
  },
  {
    name: 'dispatch-plain-short',
    expectation: 'production channel executes the full helper on a short plain path',
    installName: 'install',
    dataName: 'data',
  },
  {
    name: 'dispatch-tampered-helper',
    kind: 'tamper',
    expectation: 'negative: bytes replaced after generation are refused by the digest check',
    installName: `tamper's apps ${'t'.repeat(60)}`,
    dataName: `tamper data ${'v'.repeat(20)}`,
  },
];

const cases = [];

{
  const fx = zipFixture('zip-locked-target-resource', { sameLength: true });
  cases.push({
    name: 'zip-locked-target-resource',
    expectation: 'negative: locked non-EXE resource must fail and roll back',
    fixture: fx,
    lockPath: fx.resource,
    verify: (raw, check) => {
      commonChecks(raw, check, { lockExpected: true });
      check('helper exit code is 1 (apply failed)', raw.powershell.exitCode === 1,
        `exit=${raw.powershell.exitCode}`);
      check('installed exe rolled back to old bytes', raw.after.exe === raw.before.exe,
        `${raw.after.exe} != ${raw.before.exe}`);
      check('locked resource still old bytes', raw.after.resource === raw.before.resource,
        `${raw.after.resource} != ${raw.before.resource}`);
      check('other installed file rolled back', raw.after.extra === raw.before.extra,
        `${raw.after.extra} != ${raw.before.extra}`);
      check('nested installed file rolled back', raw.after.nested === raw.before.nested,
        `${raw.after.nested} != ${raw.before.nested}`);
      check('payload preserved for recovery', raw.after.payloadPresent === true);
      check('version dir preserved for recovery', raw.after.versionDirPresent === true);
      check('staging dir cleaned', raw.after.stageDirs.length === 0, raw.after.stageDirs.join(','));
      check('backup dir preserved', raw.after.backupDirs.length >= 1, raw.after.backupDirs.join(','));
      check('log records commit failure and rollback',
        /commit failed for/.test(raw.log) && /rolling back already replaced files/.test(raw.log));
      check('log records preserved payload and backups',
        /apply failed; keeping payload at/.test(raw.log) && /backups at/.test(raw.log));
    },
  });
}

{
  const fx = zipFixture('zip-locked-payload-source', { sameLength: true });
  cases.push({
    name: 'zip-locked-payload-source',
    expectation: 'negative: copy/read error must fail without touching installed files',
    fixture: fx,
    lockPath: path.join(fx.payload, 'resources', 'app', 'critical.txt'),
    verify: (raw, check) => {
      commonChecks(raw, check, { lockExpected: true });
      check('helper exit code is 1 (copy failed)', raw.powershell.exitCode === 1,
        `exit=${raw.powershell.exitCode}`);
      check('installed exe untouched', raw.after.exe === raw.before.exe);
      check('installed resource untouched', raw.after.resource === raw.before.resource);
      check('installed extra untouched', raw.after.extra === raw.before.extra);
      check('installed nested untouched', raw.after.nested === raw.before.nested);
      check('payload preserved', raw.after.payloadPresent === true);
      check('version dir preserved', raw.after.versionDirPresent === true);
      check('staging dir cleaned', raw.after.stageDirs.length === 0, raw.after.stageDirs.join(','));
      check('log records staging failure',
        /stage read failed|stage copy failed/.test(raw.log)
        && /apply failed during staging/.test(raw.log));
    },
  });
}

{
  const fx = zipFixture('zip-locked-target-exe', { sameLength: true });
  cases.push({
    name: 'zip-locked-target-exe-same-length',
    expectation: 'negative: old same-length EXE must not be accepted as new',
    fixture: fx,
    lockPath: fx.exe,
    verify: (raw, check) => {
      commonChecks(raw, check, { lockExpected: true });
      check('fixture old/new EXE differ in bytes but share length',
        raw.fixture.oldExeLength === raw.fixture.newExeLength
        && raw.before.exe !== raw.intended.exe,
        `oldLen=${raw.fixture.oldExeLength} newLen=${raw.fixture.newExeLength}`);
      check('helper exit code is 1 (same-length old EXE rejected)',
        raw.powershell.exitCode === 1, `exit=${raw.powershell.exitCode}`);
      check('installed exe remains old bytes', raw.after.exe === raw.before.exe,
        `${raw.after.exe} != ${raw.before.exe}`);
      check('new exe was never accepted', raw.after.exe !== raw.intended.exe);
      check('payload preserved', raw.after.payloadPresent === true);
      check('version dir preserved', raw.after.versionDirPresent === true);
      check('staging dir cleaned', raw.after.stageDirs.length === 0, raw.after.stageDirs.join(','));
      check('log records commit failure for the EXE', /commit failed for ApkStart\.exe/.test(raw.log));
    },
  });
}

{
  const fx = zipFixture('zip-replace-partial-recovery', { sameLength: false });
  cases.push({
    name: 'zip-replace-partial-recovery',
    expectation: 'negative: simulated post-backup ReplaceFile failure is recovered from the backup',
    fixture: fx,
    replaceFault: { rel: 'locales/en-US.pak', mode: 'throw' },
    verify: (raw, check) => {
      commonChecks(raw, check);
      check('fault injection executed inside helper', raw.trace.faultInjected === true);
      check('fault event is explicitly simulated, not OS error1177',
        raw.trace.faultEvents.length === 1
        && raw.trace.faultEvents[0].details.simulated === true
        && raw.trace.faultEvents[0].details.osError1177 === false);
      check('helper exit code is 1 (commit failed after recovery)', raw.powershell.exitCode === 1,
        `exit=${raw.powershell.exitCode}`);
      check('current failed target restored to old bytes', raw.after.nested === raw.before.nested,
        `${raw.after.nested} != ${raw.before.nested}`);
      check('earlier committed exe rolled back', raw.after.exe === raw.before.exe,
        `${raw.after.exe} != ${raw.before.exe}`);
      check('not-yet-committed files untouched', raw.after.resource === raw.before.resource
        && raw.after.extra === raw.before.extra);
      check('payload preserved', raw.after.payloadPresent === true);
      check('version dir preserved', raw.after.versionDirPresent === true);
      check('staging dir cleaned', raw.after.stageDirs.length === 0, raw.after.stageDirs.join(','));
      check('backup dir preserved', raw.after.backupDirs.length >= 1, raw.after.backupDirs.join(','));
      check('backup contains pre-update exe and nested bytes',
        Object.values(raw.after.backupFiles).includes(raw.before.exe)
        && Object.values(raw.after.backupFiles).includes(raw.before.nested));
      check('log records current-file restore from backup',
        /restored current file from backup after failed replace: locales\\en-US\.pak/.test(raw.log));
      check('log has no rollback failure', /rollback FAILED/.test(raw.log) === false);
      check('old app relaunch attempted after verified rollback',
        raw.trace.launchStubs.some((e) => e.details.file === raw.paths.exe));
      check('log records applyOk=False', /applyOk=False/.test(raw.log));
    },
  });
}

{
  const fx = zipFixture('zip-rollback-failure-exit3', { sameLength: false });
  cases.push({
    name: 'zip-rollback-failure-exit3',
    expectation: 'negative: unrecoverable current-file state exits 3 and never relaunches',
    fixture: fx,
    replaceFault: { rel: 'locales/en-US.pak', mode: 'lock-backup' },
    verify: (raw, check) => {
      commonChecks(raw, check);
      check('fault injection executed inside helper', raw.trace.faultInjected === true);
      check('helper exit code is 3 (rollback failed)', raw.powershell.exitCode === 3,
        `exit=${raw.powershell.exitCode}`);
      check('earlier committed exe rolled back', raw.after.exe === raw.before.exe,
        `${raw.after.exe} != ${raw.before.exe}`);
      check('not-yet-committed files untouched', raw.after.resource === raw.before.resource
        && raw.after.extra === raw.before.extra);
      check('current failed target is missing, not silently accepted', raw.after.nested === null,
        `nested=${raw.after.nested}`);
      check('payload preserved', raw.after.payloadPresent === true);
      check('version dir preserved', raw.after.versionDirPresent === true);
      check('staging dir cleaned', raw.after.stageDirs.length === 0, raw.after.stageDirs.join(','));
      check('backup dir preserved', raw.after.backupDirs.length >= 1, raw.after.backupDirs.join(','));
      check('backup contains pre-update exe and nested bytes',
        Object.values(raw.after.backupFiles).includes(raw.before.exe)
        && Object.values(raw.after.backupFiles).includes(raw.before.nested));
      check('log records current-file recovery failure',
        /current-file recovery FAILED for locales\\en-US\.pak/.test(raw.log));
      check('log records rollbackFailed=True', /rollbackFailed=True/.test(raw.log));
      check('no relaunch attempted', raw.trace.launchStubs.length === 0,
        `launchStubs=${raw.trace.launchStubs.length}`);
      check('log records relaunch skipped', /relaunch skipped: rollback failed/.test(raw.log));
      check('log records exit=3', /exit=3/.test(raw.log));
    },
  });
}

{
  const fx = zipFixture('zip-positive-multi-file', { sameLength: false });
  cases.push({
    name: 'zip-positive-multi-file',
    expectation: 'positive: verified multi-file copy succeeds and cleans up',
    fixture: fx,
    verify: (raw, check) => {
      commonChecks(raw, check);
      check('helper exit code is 0', raw.powershell.exitCode === 0, `exit=${raw.powershell.exitCode}`);
      check('installed exe updated', raw.after.exe === raw.intended.exe);
      check('installed resource updated', raw.after.resource === raw.intended.resource);
      check('installed extra updated', raw.after.extra === raw.intended.extra);
      check('installed nested updated', raw.after.nested === raw.intended.nested);
      check('payload removed after verified success', raw.after.payloadPresent === false);
      check('version dir removed after verified success', raw.after.versionDirPresent === false);
      check('staging dir cleaned', raw.after.stageDirs.length === 0, raw.after.stageDirs.join(','));
      check('backup dir cleaned', raw.after.backupDirs.length === 0, raw.after.backupDirs.join(','));
      check('log records relaunch and completion',
        /relaunched via Start-Process/.test(raw.log) && /updater done/.test(raw.log));
    },
  });
}

{
  const fx = zipFixture('zip-hidden-payload', { sameLength: false, hidden: true });
  cases.push({
    name: 'zip-hidden-payload',
    expectation: 'positive: hidden payload file and hidden payload directory are installed',
    fixture: fx,
    verify: (raw, check) => {
      commonChecks(raw, check);
      check('fixture hidden file had real Hidden attribute', fx.hidden && fx.hiddenCfgWasHidden);
      check('fixture hidden directory had real Hidden attribute', fx.hidden && fx.hiddenDirWasHidden);
      check('helper exit code is 0', raw.powershell.exitCode === 0, `exit=${raw.powershell.exitCode}`);
      check('hidden file updated to payload bytes', raw.after.hiddenCfg === raw.intended.hiddenCfg,
        `${raw.after.hiddenCfg} != ${raw.intended.hiddenCfg}`);
      check('file inside hidden directory installed',
        raw.after.hiddenDirSecret === raw.intended.hiddenDirSecret,
        `${raw.after.hiddenDirSecret} != ${raw.intended.hiddenDirSecret}`);
      check('all visible files updated', raw.after.exe === raw.intended.exe
        && raw.after.resource === raw.intended.resource
        && raw.after.extra === raw.intended.extra
        && raw.after.nested === raw.intended.nested);
      check('payload removed after verified success', raw.after.payloadPresent === false);
      check('version dir removed after verified success', raw.after.versionDirPresent === false);
      check('log claims complete six-file payload',
        /apply verified: 6 files staged and committed with SHA256 verification/.test(raw.log));
    },
  });
}

{
  const fx = setupFixture('setup-installer-1603');
  cases.push({
    name: 'setup-installer-1603',
    expectation: 'negative: installer non-zero exit must prevent success cleanup',
    fixture: fx,
    installerExit: 1603,
    verify: (raw, check) => {
      commonChecks(raw, check);
      check('helper exit code is 1 (installer failure)', raw.powershell.exitCode === 1,
        `exit=${raw.powershell.exitCode}`);
      check('installed exe untouched (installer never executed)', raw.after.exe === raw.before.exe);
      check('installer payload preserved', raw.after.payloadPresent === true);
      check('version dir preserved', raw.after.versionDirPresent === true);
      check('log records installer exit 1603', /installer reported failure exit 1603/.test(raw.log));
      check('log records no success cleanup', /installer did not report success/.test(raw.log));
      check('installer stub called once with PassThru/Wait',
        raw.trace.launchStubs.filter((e) => e.details.passThru && e.details.wait).length === 1);
      check('no app relaunch attempted',
        raw.trace.launchStubs.filter((e) => !e.details.passThru && !e.details.wait).length === 0);
      check('log records relaunch suppressed',
        /relaunch skipped: installer did not report success/.test(raw.log));
    },
  });
}

{
  const fx = setupFixture('setup-installer-startup-failure');
  cases.push({
    name: 'setup-installer-startup-failure',
    expectation: 'negative: installer startup failure must prevent success cleanup',
    fixture: fx,
    installerStartFails: true,
    verify: (raw, check) => {
      commonChecks(raw, check);
      check('helper exit code is 1 (installer startup failure)', raw.powershell.exitCode === 1,
        `exit=${raw.powershell.exitCode}`);
      check('installed exe untouched', raw.after.exe === raw.before.exe);
      check('installer payload preserved', raw.after.payloadPresent === true);
      check('version dir preserved', raw.after.versionDirPresent === true);
      check('log records installer start failure',
        /installer start failed: simulated installer startup failure/.test(raw.log));
      check('installer stub called once with PassThru/Wait',
        raw.trace.launchStubs.filter((e) => e.details.passThru && e.details.wait).length === 1);
      check('no app relaunch attempted',
        raw.trace.launchStubs.filter((e) => !e.details.passThru && !e.details.wait).length === 0);
      check('log records relaunch suppressed',
        /relaunch skipped: installer did not report success/.test(raw.log));
    },
  });
}

{
  const fx = setupFixture('setup-installer-null-exit');
  cases.push({
    name: 'setup-installer-null-exit',
    expectation: 'negative: missing installer exit code must prevent cleanup and relaunch',
    fixture: fx,
    installerExit: null,
    verify: (raw, check) => {
      commonChecks(raw, check);
      check('helper exit code is 1 (missing exit code)', raw.powershell.exitCode === 1,
        `exit=${raw.powershell.exitCode}`);
      check('installed exe untouched', raw.after.exe === raw.before.exe);
      check('installer payload preserved', raw.after.payloadPresent === true);
      check('version dir preserved', raw.after.versionDirPresent === true);
      check('log records missing exit code',
        /installer exit code missing; treating as failure/.test(raw.log));
      check('installer stub called once with PassThru/Wait',
        raw.trace.launchStubs.filter((e) => e.details.passThru && e.details.wait).length === 1);
      check('no app relaunch attempted',
        raw.trace.launchStubs.filter((e) => !e.details.passThru && !e.details.wait).length === 0);
      check('log records relaunch suppressed',
        /relaunch skipped: installer did not report success/.test(raw.log));
    },
  });
}

{
  const fx = setupFixture('setup-positive-exit0');
  cases.push({
    name: 'setup-positive-exit0',
    expectation: 'positive: installer exit 0 is documented success and cleans up',
    fixture: fx,
    installerExit: 0,
    verify: (raw, check) => {
      commonChecks(raw, check);
      check('helper exit code is 0', raw.powershell.exitCode === 0, `exit=${raw.powershell.exitCode}`);
      check('installer payload removed', raw.after.payloadPresent === false);
      check('version dir removed', raw.after.versionDirPresent === false);
      check('log records installer exit 0', /installer exit 0/.test(raw.log));
      check('installer stub called with PassThru/Wait',
        raw.trace.launchStubs.filter((e) => e.details.passThru && e.details.wait).length === 1);
      check('app relaunch stub called without PassThru/Wait',
        raw.trace.launchStubs.some((e) => !e.details.passThru && !e.details.wait
          && e.details.file !== 'cmd.exe'));
    },
  });
}

{
  const fx = zipFixture('zip-relaunch-fallback-failure', { sameLength: false });
  cases.push({
    name: 'zip-relaunch-fallback-failure',
    expectation: 'negative: apply success + restart failure must not report exit 0',
    fixture: fx,
    appLaunchFails: true,
    cmdFallbackWorks: false,
    verify: (raw, check) => {
      commonChecks(raw, check);
      check('helper exit code is 2 (applied but restart failed)', raw.powershell.exitCode === 2,
        `exit=${raw.powershell.exitCode}`);
      check('installed exe updated', raw.after.exe === raw.intended.exe);
      check('payload removed after verified apply', raw.after.payloadPresent === false);
      check('version dir removed after verified apply', raw.after.versionDirPresent === false);
      check('log records primary launch failure',
        /Start-Process failed: simulated app launch failure/.test(raw.log));
      check('log records cmd fallback failure',
        /cmd start failed: simulated cmd start failure/.test(raw.log));
      check('log records applyOk=True relaunchOk=False',
        /applyOk=True/.test(raw.log) && /relaunchOk=False/.test(raw.log));
      check('log records exit=2', /exit=2/.test(raw.log));
      check('both launch attempts were stubbed, not executed',
        raw.trace.launchStubs.some((e) => e.details.file === raw.paths.exe)
        && raw.trace.launchStubs.some((e) => e.details.file === 'cmd.exe'));
    },
  });
}

{
  const fx = zipFixture('zip-relaunch-fallback-success', { sameLength: false });
  cases.push({
    name: 'zip-relaunch-fallback-success',
    expectation: 'positive: cmd start fallback is distinguishable and succeeds',
    fixture: fx,
    appLaunchFails: true,
    cmdFallbackWorks: true,
    verify: (raw, check) => {
      commonChecks(raw, check);
      check('helper exit code is 0 (fallback restart succeeded)', raw.powershell.exitCode === 0,
        `exit=${raw.powershell.exitCode}`);
      check('installed exe updated', raw.after.exe === raw.intended.exe);
      check('payload removed', raw.after.payloadPresent === false);
      check('version dir removed', raw.after.versionDirPresent === false);
      check('log records primary launch failure and fallback success',
        /Start-Process failed/.test(raw.log) && /relaunched via cmd start/.test(raw.log));
    },
  });
}

// ---------------------------------------------------------------------------
// app 模式七场景：完整替换 resources/app，外壳/运行时/用户数据不动。
// ---------------------------------------------------------------------------

{
  const fx = appFixture('app-A01-success-hidden-obsolete');
  cases.push({
    name: 'app-A01-success-hidden-obsolete',
    expectation: 'positive: complete new app tree, hidden files, obsolete removal, exit 0',
    fixture: fx,
    verify: (raw, check) => {
      commonChecks(raw, check);
      check('fixture hidden file had real Hidden attribute', fx.hiddenCfgWasHidden);
      check('fixture hidden directory had real Hidden attribute', fx.hiddenDirWasHidden);
      check('helper exit code is 0', raw.powershell.exitCode === 0, `exit=${raw.powershell.exitCode}`);
      check('installed tree exactly equals new payload tree',
        sameTree(raw.after.appFiles, raw.expectedTrees.newFiles));
      check('old-only obsolete.js removed by complete replacement',
        !Object.hasOwn(raw.after.appFiles, 'obsolete.js'));
      check('hidden file content installed',
        raw.after.appFiles['.hidden-cfg'] === raw.expectedTrees.newFiles['.hidden-cfg']);
      check('file inside hidden parent directory installed',
        raw.after.appFiles['hidden-dir/secret.txt'] === raw.expectedTrees.newFiles['hidden-dir/secret.txt']);
      check('installed package version observed as 0.6.3', raw.after.installedPkgVersion === '0.6.3');
      check('shell/runtime/locales sentinels unchanged',
        JSON.stringify(raw.after.shell) === JSON.stringify(raw.before.shell));
      check('user data unchanged', sameTree(raw.after.userData, raw.before.userData));
      check('payload removed after verified success', raw.after.payloadPresent === false);
      check('version dir removed after verified success', raw.after.versionDirPresent === false);
      check('staging dir cleaned', raw.after.stageDirs.length === 0, raw.after.stageDirs.join(','));
      check('backup dir cleaned', raw.after.backupDirs.length === 0, raw.after.backupDirs.join(','));
      check('no force-full marker on success', raw.after.forceFullPresent === false);
      check('exactly one app launch request',
        raw.trace.launchStubs.filter((e) => e.details.file === raw.paths.exe).length === 1);
      check('no cmd fallback and no installer request',
        raw.trace.launchStubs.filter((e) => e.details.file === 'cmd.exe').length === 0
        && raw.trace.launchStubs.filter((e) => e.details.passThru).length === 0);
      check('log records applyOk=True and exit=0',
        /applyOk=True/.test(raw.log) && /exit=0/.test(raw.log));
      check('log records verified byte commit', /app apply verified: \d+ files committed/.test(raw.log));
    },
  });
}

{
  const fx = appFixture('app-A02-source-copy-fails');
  cases.push({
    name: 'app-A02-source-copy-fails',
    expectation: 'negative: required non-package file cannot be copied; old tree intact, exit 1',
    fixture: fx,
    lockPath: path.join(fx.appSrc, 'main.js'),
    verify: (raw, check) => {
      commonChecks(raw, check, { lockExpected: true });
      check('helper exit code is 1', raw.powershell.exitCode === 1, `exit=${raw.powershell.exitCode}`);
      check('installed tree fully unchanged (old bytes)',
        sameTree(raw.after.appFiles, raw.expectedTrees.oldFiles));
      check('installed package version still 0.6.2', raw.after.installedPkgVersion === '0.6.2');
      check('shell/runtime untouched', JSON.stringify(raw.after.shell) === JSON.stringify(raw.before.shell));
      check('user data untouched', sameTree(raw.after.userData, raw.before.userData));
      check('payload preserved', raw.after.payloadPresent === true);
      check('version dir preserved', raw.after.versionDirPresent === true);
      check('force-full marker written', raw.after.forceFullPresent === true);
      check('staging dir cleaned', raw.after.stageDirs.length === 0, raw.after.stageDirs.join(','));
      check('no fake backup created', raw.after.backupDirs.length === 0, raw.after.backupDirs.join(','));
      check('staging failure reached the locked source',
        /app stage read failed for main\.js|app staging FAILED for main\.js/.test(raw.log));
      check('old tree verified unchanged before relaunch',
        /installed tree verified unchanged; old-version relaunch allowed/.test(raw.log));
      check('exactly one old-version app launch request',
        raw.trace.launchStubs.filter((e) => e.details.file === raw.paths.exe).length === 1);
      check('no installer / cmd request',
        raw.trace.launchStubs.filter((e) => e.details.passThru || e.details.file === 'cmd.exe').length === 0);
    },
  });
}

{
  const fx = appFixture('app-A03-backup-fails');
  cases.push({
    name: 'app-A03-backup-fails',
    expectation: 'negative: real rename block prevents backup before changing old tree; exit 1',
    fixture: fx,
    // FileShare.Read：允许逐字节读取旧树，但拒绝 DELETE/rename。
    readLockPath: path.join(fx.appDst, 'main.js'),
    verify: (raw, check) => {
      commonChecks(raw, check);
      check('real read-share lock acquired before helper', raw.trace.readLockAcquired === true);
      check('helper exit code is 1', raw.powershell.exitCode === 1, `exit=${raw.powershell.exitCode}`);
      check('old tree intact (never moved)', sameTree(raw.after.appFiles, raw.expectedTrees.oldFiles));
      check('installed package version still 0.6.2', raw.after.installedPkgVersion === '0.6.2');
      check('shell/runtime untouched', JSON.stringify(raw.after.shell) === JSON.stringify(raw.before.shell));
      check('payload/version dir preserved', raw.after.payloadPresent === true
        && raw.after.versionDirPresent === true);
      check('force-full marker written', raw.after.forceFullPresent === true);
      check('staging dir cleaned', raw.after.stageDirs.length === 0, raw.after.stageDirs.join(','));
      check('no backup directory claimed', raw.after.backupDirs.length === 0, raw.after.backupDirs.join(','));
      check('backup failure actually reached rename', /app backup failed:/.test(raw.log));
      check('helper refused to change tree after backup failure',
        /app backup did not complete; installed tree untouched/.test(raw.log));
      check('old tree verified unchanged before relaunch',
        /installed tree verified unchanged; old-version relaunch allowed/.test(raw.log));
      check('exactly one old-version app launch request',
        raw.trace.launchStubs.filter((e) => e.details.file === raw.paths.exe).length === 1);
    },
  });
}

{
  const fx = appFixture('app-A04-post-change-rollback-ok');
  cases.push({
    name: 'app-A04-post-change-rollback-ok',
    expectation: 'negative: failure after commit restores the complete old tree; exit 1',
    fixture: fx,
    appVerifyFault: true,
    launchTreeRoot: fx.appDst,
    verify: (raw, check) => {
      commonChecks(raw, check);
      const fault = raw.trace.appVerifyFault;
      check('post-commit verification fault reached', !!fault);
      check('proof the installed tree had already changed before rollback',
        !!fault && fault.details.dExists === true
        && fault.details.dPkgVersion === '0.6.3'
        && /^NEW-MAIN-JS/.test(String(fault.details.dMainText || '')),
        fault ? JSON.stringify(fault.details) : 'no fault event');
      check('helper exit code is 1', raw.powershell.exitCode === 1, `exit=${raw.powershell.exitCode}`);
      check('installed tree fully restored to old bytes',
        sameTree(raw.after.appFiles, raw.expectedTrees.oldFiles));
      check('installed package version back to 0.6.2', raw.after.installedPkgVersion === '0.6.2');
      check('payload/version dir preserved', raw.after.payloadPresent === true
        && raw.after.versionDirPresent === true);
      check('force-full marker written', raw.after.forceFullPresent === true);
      check('staging dir cleaned', raw.after.stageDirs.length === 0, raw.after.stageDirs.join(','));
      check('backup consumed by verified rename restore', raw.after.backupDirs.length === 0,
        raw.after.backupDirs.join(','));
      check('shell/runtime untouched', JSON.stringify(raw.after.shell) === JSON.stringify(raw.before.shell));
      check('user data untouched', sameTree(raw.after.userData, raw.before.userData));
      check('log records post-commit failure and verified restore',
        /app post-commit verification FAILED/.test(raw.log)
        && /app rollback verified: pre-change bytes restored/.test(raw.log));
      check('log records applyOk=False exit=1',
        /applyOk=False/.test(raw.log) && /exit=1/.test(raw.log));
      const launchIndex = raw.trace.all.findIndex((e) => e.event === 'start-process-stub'
        && e.details.file === raw.paths.exe);
      const faultIndex = raw.trace.all.findIndex((e) => e.event === 'app-verify-fault-injected');
      check('old-version relaunch requested only after rollback',
        launchIndex > faultIndex && launchIndex > 0, `faultIndex=${faultIndex} launchIndex=${launchIndex}`);
      check('exactly one old-version app launch request',
        raw.trace.launchStubs.filter((e) => e.details.file === raw.paths.exe).length === 1);
      const launch = raw.trace.launchStubs.find((e) => e.details.file === raw.paths.exe);
      check('old tree was already restored at launch-request time',
        !!launch && launch.details.treeDigest === treeDigest(raw.expectedTrees.oldFiles),
        launch ? `digest=${launch.details.treeDigest} expected=${treeDigest(raw.expectedTrees.oldFiles)}` : 'no launch');
    },
  });
}

{
  const fx = appFixture('app-A05-rollback-fails');
  cases.push({
    name: 'app-A05-rollback-fails',
    expectation: 'negative: restore cannot complete; UNKNOWN install state, exit 3, no relaunch',
    fixture: fx,
    appVerifyFault: true,
    appRestoreMoveFault: true,
    verify: (raw, check) => {
      commonChecks(raw, check);
      check('post-commit verification fault reached', !!raw.trace.appVerifyFault);
      check('restore-move fault reached', !!raw.trace.appRestoreMoveFault);
      check('restore move ran only after the changed tree was removed',
        !!raw.trace.appRestoreMoveFault
        && raw.trace.appRestoreMoveFault.details.treeExists === false
        && raw.trace.appRestoreMoveFault.details.backupExists === true,
        raw.trace.appRestoreMoveFault ? JSON.stringify(raw.trace.appRestoreMoveFault.details) : 'no event');
      check('helper exit code is 3', raw.powershell.exitCode === 3, `exit=${raw.powershell.exitCode}`);
      check('installed app tree is absent -> verified state UNKNOWN',
        raw.after.installedPkgVersion === null && Object.keys(raw.after.appFiles).length === 0);
      check('backup retained with the complete old tree',
        raw.after.backupDirs.length >= 1 && (() => {
          const tree = {};
          for (const [k, v] of Object.entries(raw.after.backupFiles)) tree[k.replace(/^[^/]+\//, '')] = v;
          return sameTree(tree, raw.expectedTrees.oldFiles);
        })(), raw.after.backupDirs.join(','));
      check('payload/version dir preserved for diagnosis', raw.after.payloadPresent === true
        && raw.after.versionDirPresent === true);
      check('force-full marker written', raw.after.forceFullPresent === true);
      check('zero launch calls (app/cmd/installer)', raw.trace.launchStubs.length === 0,
        `launchStubs=${raw.trace.launchStubs.length}`);
      check('log records rollback failure and exit=3',
        /app rollback FAILED; install state uncertain/.test(raw.log)
        && /rollbackFailed=True/.test(raw.log) && /exit=3/.test(raw.log));
      check('log records relaunch suppression', /relaunch skipped: rollback failed/.test(raw.log));
      check('log never claims success', !/app apply verified/.test(raw.log));
    },
  });
}

{
  const fx = appFixture('app-A06-launch-fails');
  cases.push({
    name: 'app-A06-launch-fails',
    expectation: 'negative: verified replacement but both launch requests fail; exit 2',
    fixture: fx,
    appLaunchFails: true,
    cmdFallbackWorks: false,
    verify: (raw, check) => {
      commonChecks(raw, check);
      check('helper exit code is 2', raw.powershell.exitCode === 2, `exit=${raw.powershell.exitCode}`);
      check('installed tree exactly equals new payload tree',
        sameTree(raw.after.appFiles, raw.expectedTrees.newFiles));
      check('installed package version observed as 0.6.3', raw.after.installedPkgVersion === '0.6.3');
      check('payload/version dir cleaned after verified apply', raw.after.payloadPresent === false
        && raw.after.versionDirPresent === false);
      check('backup/staging cleaned', raw.after.stageDirs.length === 0 && raw.after.backupDirs.length === 0);
      check('shell/runtime untouched', JSON.stringify(raw.after.shell) === JSON.stringify(raw.before.shell));
      check('both launch paths were requested and stubbed',
        raw.trace.launchStubs.some((e) => e.details.file === raw.paths.exe)
        && raw.trace.launchStubs.some((e) => e.details.file === 'cmd.exe'));
      check('replacement was not rolled back after launch failure',
        /app apply verified/.test(raw.log) && !/app rollback/.test(raw.log));
      check('log records applyOk=True relaunchOk=False exit=2',
        /applyOk=True/.test(raw.log) && /relaunchOk=False/.test(raw.log) && /exit=2/.test(raw.log));
    },
  });
}

{
  const fx = appFixture('app-A07-cleanup-blocked');
  cases.push({
    name: 'app-A07-cleanup-blocked',
    expectation: 'positive: verified replacement; blocked cleanup warns with residual path, exit 0',
    fixture: fx,
    // 只锁版本目录中的诊断哨兵：它不参与 payload 复制，只会阻止 V 的清理。
    readLockPath: fx.sentinel,
    verify: (raw, check) => {
      commonChecks(raw, check);
      check('cleanup lock acquired before helper', raw.trace.readLockAcquired === true);
      check('helper exit code is 0', raw.powershell.exitCode === 0, `exit=${raw.powershell.exitCode}`);
      check('installed tree exactly equals new payload tree',
        sameTree(raw.after.appFiles, raw.expectedTrees.newFiles));
      check('installed package version observed as 0.6.3', raw.after.installedPkgVersion === '0.6.3');
      check('version dir retained with locked sentinel', raw.after.versionDirPresent === true);
      check('locked sentinel bytes unchanged', raw.after.diagnosticSentinel === raw.before.diagnosticSentinel);
      check('cleanup failure is a warning, not a rollback',
        /version dir cleanup failed/.test(raw.log) && !/app rollback/.test(raw.log)
        && /exit=0/.test(raw.log));
      check('log names the residual version dir path',
        raw.log.includes(`residual path ${fx.versionDir}`));
      check('no force-full marker for cleanup-only failure', raw.after.forceFullPresent === false);
      check('backup/staging cleaned', raw.after.stageDirs.length === 0 && raw.after.backupDirs.length === 0);
      check('shell/runtime/user data untouched',
        JSON.stringify(raw.after.shell) === JSON.stringify(raw.before.shell)
        && sameTree(raw.after.userData, raw.before.userData));
      check('exactly one app launch request',
        raw.trace.launchStubs.filter((e) => e.details.file === raw.paths.exe).length === 1);
    },
  });
}

try {
  const sourceText = fs.readFileSync(SOURCE, 'utf8');
  const Updater = loadUpdater(sourceText);
  const results = cases.map((c) => evaluate(runCase(Updater, c.fixture, c), c.verify));
  const loadWithSpawn = (spawnImpl) => loadUpdater(sourceText, spawnImpl);
  for (const spec of dispatchSpecs) {
    results.push(spec.kind === 'tamper'
      ? runTamperCase(spec, loadWithSpawn)
      : runDispatchCase(spec, loadWithSpawn));
  }
  const failed = results.filter((r) => !r.passed);
  const report = {
    status: failed.length ? 'FAIL' : 'PASS',
    source: SOURCE,
    sourceSha256: sha(fs.readFileSync(SOURCE)),
    tempRoot,
    caseCount: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    cases: results.map((r) => ({
      case: r.case,
      expectation: r.expectation,
      passed: r.passed,
      exitCode: r.powershell.exitCode,
      evidence: r.evidence,
      failedChecks: r.checks.filter((c) => !c.ok),
    })),
  };
  writeFile(path.join(tempRoot, 'report.json'), JSON.stringify(report, null, 2));

  for (const r of results) {
    console.log(`${r.passed ? '  PASS' : '  FAIL'} ${r.case} (helper exit ${r.powershell.exitCode})`);
    for (const c of r.checks) {
      if (!c.ok) console.log(`         - ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
    }
  }
  console.log(`\n[updater-apply-windows] ${report.passed}/${report.caseCount} cases passed`);
  console.log(`[updater-apply-windows] source: ${SOURCE}`);
  console.log(`[updater-apply-windows] evidence: ${tempRoot}`);
  process.exit(failed.length ? 1 : 0);
} catch (error) {
  const report = {
    status: 'ERROR',
    source: SOURCE,
    tempRoot,
    error: error.message,
    stack: error.stack,
  };
  writeFile(path.join(tempRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.error(`[updater-apply-windows] ${error.stack || error.message}`);
  process.exit(2);
}
