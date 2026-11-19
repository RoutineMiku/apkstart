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

const i18n = window.apkstartI18n || (api && api.i18n);

function applyLanguage(lang) {
  if (!i18n) return;
  i18n.translateDOM(document, lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = (lang === 'ar' ? 'rtl' : 'ltr');
}

if (api && api.getSettings) {
  api.getSettings().then((s) => {
    if (s && s.language) applyLanguage(s.language);
  }).catch(() => {});
}

function applyState(s) {
  if (!s) return;
  const defaultLabel = i18n ? i18n.t('common.app') : 'App';
  $('appName').textContent = s.label || defaultLabel;
  $('bootName').textContent = s.label || '';
  const icon = s.iconUrl || '';
  if (icon) {
    $('appIcon').src = icon;
    $('bootIcon').src = icon;
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
