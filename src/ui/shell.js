'use strict';
/* 应用窗口标题栏：只有 旋转 / 最小化 / 最大化 / 关闭，其余设置都在 ApkStart 主界面 */
const api = window.apkstart;
const $ = (id) => document.getElementById(id);

const btn = {
  rotate: $('btnRotate'),
  min: $('btnMin'),
  max: $('btnMax'),
  close: $('btnClose'),
};

btn.rotate.addEventListener('click', () => api.shell.rotate());
btn.min.addEventListener('click', () => api.shell.minimize());
btn.max.addEventListener('click', () => api.shell.maximize());
btn.close.addEventListener('click', () => api.shell.close());

// 标题栏上右键不要弹出 Chromium 的网页菜单；画面区域的右键已由主进程
// 拦下并映射成「安卓返回」，这里补掉外壳这一圈。
window.addEventListener('contextmenu', (e) => e.preventDefault());

// Ctrl+R 旋转，F11 最大化（和 Windows 习惯一致）
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); api.shell.rotate(); }
  else if (e.key === 'F11') { e.preventDefault(); api.shell.maximize(); }
  else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); api.shell.back(); }
  else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); api.shell.forward(); }
  else {
    // 其余按键转发给主进程的按键映射引擎（游戏手柄/键盘→触屏）
    api.shell.keyEvent(e.key).catch(() => {});
  }
});

function applyState(s) {
  if (!s) return;
  $('appName').textContent = s.label || '应用';
  $('bootName').textContent = s.label || '';
  const icon = s.iconUrl || '';
  // 品牌兜底图：应用图标解不出来（ICO/WebP 解码失败、file URL 被 CSP 拦）时
  // 至少显示一个完整 logo，绝不留一块空白让启动动画看起来「图标缺了一块」。
  const FALLBACK = 'assets/logo-128.png';
  const bootIcon = $('bootIcon');
  const appIcon = $('appIcon');
  if (bootIcon) {
    bootIcon.onerror = () => { if (bootIcon.src.indexOf('logo-128') < 0) bootIcon.src = FALLBACK; };
    bootIcon.src = icon || FALLBACK;
  }
  if (appIcon) {
    appIcon.onerror = () => { if (appIcon.src.indexOf('logo-128') < 0) appIcon.src = FALLBACK; };
    appIcon.src = icon || FALLBACK;
  }
  $('bootTip').textContent = s.tip || '';
  if (s.ready) {
    const boot = $('boot');
    if (boot) {
      boot.classList.add('out');
      setTimeout(() => { boot.style.display = 'none'; }, 420);
    }
    document.body.style.background = '#0b0c0e';
  }
}

api.shell.onState(applyState);
api.shell.state().then(applyState).catch(() => {});
