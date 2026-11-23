'use strict';
/* 应用窗口标题栏：只有 旋转 / 最小化 / 最大化 / 关闭，其余设置都在 ApkStart 主界面 */
const api = window.apkstart;
const i18n = window.apkstartI18n;
const $ = (id) => document.getElementById(id);
let uiLanguage = 'en';

const SHELL_TEXT = {
  '应用': 'App',
  '横屏 / 竖屏（Ctrl+R）': 'Landscape / Portrait (Ctrl+R)',
  '最小化': 'Minimize',
  '最大化': 'Maximize',
  '关闭': 'Close',
  '正在启动安卓运行时…': 'Starting Android runtime…',
};

const shellTextState = new WeakMap();
let shellObserverStarted = false;
const shellObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type === 'characterData') translateShellText(mutation.target);
    else if (mutation.type === 'attributes') translateShellAttributes(mutation.target);
    else mutation.addedNodes.forEach(translateShellNode);
  }
});

function shellTranslation(source) {
  if (uiLanguage === 'zh-CN') return source;
  const trimmed = source.trim();
  const translated = i18n.translate(trimmed, uiLanguage)
    || i18n.translate(trimmed, 'en')
    || SHELL_TEXT[trimmed];
  if (translated) return source.replace(trimmed, translated);
  return source
    .replace('正在为《', 'Preparing ')
    .replace('》切换到横屏', ' for landscape')
    .replace('》切换到竖屏', ' for portrait')
    .replace('（重启安卓环境，约 ', ' (restarting Android, about ')
    .replace('秒，只需一次）…', ' seconds; this is a one-time step)…')
    .replace('重启安卓环境', 'Restarting Android');
}

function translateShellText(node) {
  if (node.parentElement && node.parentElement.closest('[data-no-localize]')) return;
  const current = node.nodeValue;
  const previous = shellTextState.get(node);
  const source = previous && current === previous.output ? previous.source : current;
  const output = shellTranslation(source);
  shellTextState.set(node, { source, output });
  if (output !== current) node.nodeValue = output;
}

function translateShellAttributes(el) {
  if (el.closest && el.closest('[data-no-localize]')) return;
  const state = shellTextState.get(el) || {};
  for (const attr of ['title', 'aria-label']) {
    if (!el.hasAttribute(attr)) continue;
    const current = el.getAttribute(attr);
    const previous = state[attr];
    const source = previous && current === previous.output ? previous.source : current;
    const output = shellTranslation(source);
    state[attr] = { source, output };
    if (output !== current) el.setAttribute(attr, output);
  }
  shellTextState.set(el, state);
}

function translateShellNode(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateShellText(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root !== document.body) return;
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) translateShellText(node);
  }
  if (root.nodeType === Node.ELEMENT_NODE) {
    translateShellAttributes(root);
    root.querySelectorAll('*').forEach((el) => {
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) translateShellText(node);
      }
      translateShellAttributes(el);
    });
  }
}

function localizeShell(language = uiLanguage) {
  uiLanguage = i18n.normalize(language);
  document.documentElement.lang = uiLanguage;
  document.documentElement.dir = i18n.direction(uiLanguage);
  translateShellNode(document.body);
  if (!shellObserverStarted) {
    shellObserver.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['title', 'aria-label'],
    });
    shellObserverStarted = true;
  }
}

async function refreshShellLanguage() {
  const settings = await api.getSettings();
  localizeShell(settings && settings.language);
}

window.addEventListener('focus', () => { refreshShellLanguage().catch(() => {}); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshShellLanguage().catch(() => {});
});

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
refreshShellLanguage().then(() => api.shell.state().then(applyState)).catch(() => {});
