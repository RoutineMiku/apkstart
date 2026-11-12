'use strict';
/**
 * 把 Android Emulator 的 Qt 窗口打扮成「一个应用一个原生窗口」。
 *
 * 为什么不投屏：无头模式下 SurfaceFlinger 不出 VSYNC（实测 screenrecord 3 秒只有 2 帧），
 * 软件投屏既卡又吃 CPU。带窗口的模拟器本身就是原生 60fps + 原生鼠标键盘，
 * 这里只做「改标题 / 换图标 / 设尺寸 / 全屏」这几下 Win32 操作，成本近乎为零。
 *
 * PowerShell 是 Windows 自带组件，脚本为纯 ASCII，中文标题通过 UTF-8 JSON 传入，
 * 避免 Windows PowerShell 5.1 按 ANSI 读 .ps1 造成乱码。
 * 任何失败都静默降级：窗口照样能用，只是没有改名/全屏。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, 'win', 'windowctl.ps1');
const TIMEOUT = 8000;

function parseOut(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** @param {object} params { pid, action, title, icon, bounds } */
function call(params) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !fs.existsSync(SCRIPT) || !params || params.pid === undefined) {
      resolve(null);
      return;
    }
    const json = path.join(os.tmpdir(),
      `apkstart-wctl-${crypto.randomBytes(4).toString('hex')}.json`);
    try {
      fs.writeFileSync(json, JSON.stringify(params), 'utf8');
    } catch (_) { resolve(null); return; }

    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT, json,
    ], { timeout: TIMEOUT, windowsHide: true, maxBuffer: 1024 * 64 }, (err, stdout) => {
      try { fs.unlinkSync(json); } catch (_) { /* ignore */ }
      if (err) { resolve(null); return; }
      const r = parseOut(stdout);
      resolve(r.OK === '1' ? r : null);
    });
  });
}

/** 读取当前窗口位置，用于「记住每个应用的窗口大小」 */
async function getBounds(pid) {
  const r = await call({ pid, action: 'get' });
  if (!r || !Number(r.W) || !Number(r.H)) return null;
  return {
    x: Number(r.X) || 0, y: Number(r.Y) || 0,
    w: Number(r.W), h: Number(r.H),
    maximized: r.MAX === '1',
  };
}

/**
 * 让运行时窗口表现为当前应用。
 * @param {object} o { pid, label, icon, mode:'window'|'fullscreen', bounds, screen }
 */
async function present(o) {
  const { pid, label, icon, mode, bounds, screen } = o || {};
  // pid=0 是合法输入：复用别的进程拉起的模拟器时没有句柄，交给脚本按进程名找窗口
  if (pid === undefined || pid === null) return null;
  return call({
    pid,
    action: mode === 'fullscreen' ? 'fullscreen' : 'window',
    title: label || '',
    icon: icon && fs.existsSync(icon) ? icon : '',
    bounds: bounds || null,
    screen: mode === 'fullscreen' ? (screen || null) : null,
  });
}

async function focus(pid) { return call({ pid, action: 'focus' }); }

/** 通知资源管理器刷新图标/快捷方式，避免新建的桌面图标要按 F5 才出现 */
async function refreshShell() { return call({ pid: 0, action: 'refresh' }); }

module.exports = { call, getBounds, present, focus, refreshShell, SCRIPT };
