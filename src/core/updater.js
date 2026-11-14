'use strict';
/**
 * 在线更新：从 GitHub Releases（RoutineMiku/apkstart）取最新版本，下载并原地替换。
 *
 * 三个形态都要照顾到：
 *   - 安装版（NSIS）：下载 `ApkStart-x.y.z-Setup.exe`，静默安装（/S）；
 *   - 轻量版（便携 zip，运行时按需下载）：下载 `ApkStart-vX-win64-portable.zip`，
 *     解压后覆盖程序目录 —— 运行时目录（%APPDATA%\apkstart\runtime）与已装应用、
 *     快照全都在用户目录里，替换程序文件不会动它们；
 *   - 完整版（便携但带 runtime）：同轻量版，只是目录里多了 resources\runtime。
 *
 * 替换不能在本进程里做（exe 正被占用），所以生成一段 PowerShell 脚本，
 * 用 EncodedCommand 交给独立进程：等本进程退出 → 复制文件 → 重新拉起。
 * 用 base64 传脚本而不是写 .ps1 文件，是为了绕开「路径含中文时脚本被按 GBK 解码」
 * 这类老问题（PowerShell 5.1 读无 BOM 脚本会按 ANSI 解释）。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { download } = require('./download');
const { ZipFile } = require('./zip');

const OWNER = 'RoutineMiku';
const REPO = 'apkstart';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

/** v0.3.2 / 0.3.2-preview 归一化成可比较的数字数组 */
function parseVer(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((x) => (/^\d+$/.test(x) ? Number(x) : x))
    .filter((x) => x !== '');
}

function cmpVer(a, b) {
  const A = parseVer(a);
  const B = parseVer(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i += 1) {
    const x = A[i];
    const y = B[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1;
    } else {
      const sx = String(x);
      const sy = String(y);
      if (sx !== sy) return sx < sy ? -1 : 1;
    }
  }
  return 0;
}

function httpJson(url, timeout = 12000, redirect = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'ApkStart-Updater',
        Accept: 'application/vnd.github+json',
      },
      timeout,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirect < 3) {
        res.resume();
        httpJson(res.headers.location, timeout, redirect + 1).then(resolve, reject);
        return;
      }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; if (d.length > 4 * 1024 * 1024) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('GitHub 返回的不是 JSON')); }
        } else {
          reject(new Error(`GitHub ${res.statusCode}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('连接 GitHub 超时')));
    req.on('error', reject);
  });
}

/** PowerShell 单引号字符串：内部的 ' 要写成 '' */
function psq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

class Updater {
  /**
   * @param {{currentVersion:string, exePath:string, isPackaged:boolean, dataDir:string,
   *          onProgress?:Function}} o
   */
  constructor(o) {
    this.current = o.currentVersion || '0.0.0';
    this.exePath = o.exePath;
    this.installDir = path.dirname(o.exePath || '');
    this.isPackaged = !!o.isPackaged;
    this.dataDir = o.dataDir;
    this.onProgress = o.onProgress || (() => {});
    this.latest = null;
    this._last = null;
  }

  /** 安装形态：安装版（有卸载器）还是便携包 */
  get flavor() {
    try {
      const un = fs.readdirSync(this.installDir).find((n) => /^Uninstall .*\.exe$/i.test(n));
      if (un) return 'setup';
    } catch (_) { /* ignore */ }
    return 'portable';
  }

  get updateDir() {
    return path.join(this.dataDir, 'update');
  }

  /** 拉取最新 release（含预发布兜底），并挑出与当前形态匹配的资产 */
  async check() {
    const rel = await httpJson(`${API}/releases/latest`).catch(async (e) => {
      // 仓库只有预发布 / 尚未打正式 release 时 /latest 会 404
      if (!/404/.test(e.message)) throw e;
      const list = await httpJson(`${API}/releases?per_page=10`);
      const first = (Array.isArray(list) ? list : []).find((r) => r && !r.draft);
      if (!first) throw new Error('GitHub 上还没有任何发布版本');
      return first;
    });

    const tag = String(rel.tag_name || rel.name || '');
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const pick = (re) => assets.find((a) => re.test(String(a.name || '')));

    const wantSetup = this.flavor === 'setup';
    const asset = wantSetup
      ? (pick(/Setup\.exe$/i) || pick(/win.*\.exe$/i))
      : (pick(/portable.*\.zip$/i) || pick(/win64.*\.zip$/i) || pick(/\.zip$/i));

    this.latest = {
      version: tag.replace(/^v/i, ''),
      tag,
      name: rel.name || tag,
      notes: rel.body || '',
      htmlUrl: rel.html_url || `https://github.com/${OWNER}/${REPO}/releases`,
      publishedAt: rel.published_at || '',
      asset: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url } : null,
      assets: assets.map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
      flavor: this.flavor,
      hasUpdate: cmpVer(tag, this.current) > 0,
      current: this.current,
      canAutoApply: !!asset,
    };
    this._last = this.latest;
    return this.latest;
  }

  /**
   * 下载并准备好「载荷」：便携版解压到 update/<ver>/payload，安装版直接留 Setup.exe。
   * @returns {Promise<{mode:'zip'|'setup', payload:string, version:string}>}
   */
  async prepare(info) {
    const it = info || this.latest;
    if (!it || !it.asset) throw new Error('这个版本没有可自动安装的安装包，请到 GitHub 发布页手动下载');
    const dir = path.join(this.updateDir, it.version);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, it.asset.name);
    const total = it.asset.size || 0;

    this.onProgress({ stage: 'download', percent: 1, message: `正在下载 ${it.asset.name}…` });
    await download(it.asset.url, file, {
      onProgress: (pr) => {
        const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
        this.onProgress({
          stage: 'download',
          percent: Math.max(1, Math.min(99, pct)),
          message: `下载中 ${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`,
          speed: pr.speed,
        });
      },
    });

    if (/\.zip$/i.test(file)) {
      const out = path.join(dir, 'payload');
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      await this._extract(file, out);
      this.onProgress({ stage: 'ready', percent: 100, message: '更新包已解压完成' });
      return { mode: 'zip', payload: out, version: it.version };
    }
    this.onProgress({ stage: 'ready', percent: 100, message: '安装包已下载完成' });
    return { mode: 'setup', payload: file, version: it.version };
  }

  async _extract(zipPath, dest) {
    const zf = new ZipFile(zipPath);
    try {
      const names = zf.names().filter((n) => !n.endsWith('/'));
      let i = 0;
      for (const n of names) {
        i += 1;
        const target = path.join(dest, n.replace(/\\/g, '/'));
        if (!target.startsWith(path.resolve(dest))) continue;   // 防 zip-slip
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await zf.pipeTo(n, fs.createWriteStream(target));
        if (i % 20 === 0) {
          this.onProgress({
            stage: 'extract',
            percent: Math.min(99, Math.round((i / names.length) * 100)),
            message: `正在解压 ${i}/${names.length}`,
          });
        }
      }
    } finally {
      try { zf.close(); } catch (_) { /* ignore */ }
    }
  }

  /**
   * 生成并启动「替换 + 重启」脚本，然后调用方负责退出应用。
   * @param {{mode:'zip'|'setup', payload:string, version:string}} job
   * @param {{waitPid?:number, spawn?:boolean}} [opts] 测试时可指定别的 pid / 不真启动
   */
  apply(job, opts = {}) {
    const exe = this.exePath;
    const dir = this.installDir;
    const logFile = path.join(this.updateDir, 'update.log');
    fs.mkdirSync(this.updateDir, { recursive: true });
    const waitPid = opts.waitPid || process.pid;

    const lines = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$log = ${psq(logFile)}`,
      `function Note($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }`,
      `Note 'updater start'`,
      // 等本进程真正退出（最多 90 秒），否则 exe/dll 仍被占用
      `try { Wait-Process -Id ${waitPid} -Timeout 90 } catch { }`,
      `Start-Sleep -Milliseconds 700`,
    ];

    if (job.mode === 'zip') {
      lines.push(
        `$src = ${psq(job.payload)}`,
        `$dst = ${psq(dir)}`,
        `$ok = $false`,
        `for ($i = 1; $i -le 12; $i++) {`,
        `  Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force`,
        `  $probe = Join-Path $dst ${psq(path.basename(exe))}`,
        `  if (Test-Path $probe) { $ok = $true; Note "copy pass $i ok"; break }`,
        `  Note "copy pass $i failed, retry"; Start-Sleep -Milliseconds 600`,
        `}`,
        `if (-not $ok) { Note 'copy failed' }`,
        // 新版本里已经删掉的文件不会因为覆盖而消失，但保留它们无害；
        // 只清掉本次的解压目录，避免白占几百 MB。
        `Remove-Item -Path $src -Recurse -Force`,
      );
    } else {
      lines.push(
        `Note 'run installer'`,
        `$p = Start-Process -FilePath ${psq(job.payload)} -ArgumentList '/S' -PassThru -Wait`,
        `Note ("installer exit " + $p.ExitCode)`,
        `Start-Sleep -Milliseconds 800`,
      );
    }

    lines.push(
      `if (Test-Path ${psq(exe)}) { Start-Process -FilePath ${psq(exe)}; Note 'relaunched' }`,
      `Note 'updater done'`,
      `Start-Sleep -Milliseconds 400`,
      `Remove-Item -Path ${psq(path.join(this.updateDir, job.version))} -Recurse -Force`,
      // 收尾的清理语句失败（目录已被删/被杀软占用）不应该让调用方以为更新失败
      `exit 0`,
    );

    const script = lines.join('\r\n');
    fs.writeFileSync(path.join(this.updateDir, 'apply.log.ps1'), script, 'utf8');
    if (opts.spawn === false) return script;
    // -EncodedCommand 走 UTF-16LE base64：脚本里出现中文路径也不会被 GBK 解码搞坏
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-EncodedCommand', b64,
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  }

  /** 打不开 UI 的场景（或没有可自动安装的资产）时，把发布页丢给浏览器 */
  static repoUrl() {
    return `https://github.com/${OWNER}/${REPO}/releases`;
  }
}

module.exports = { Updater, cmpVer, OWNER, REPO };
