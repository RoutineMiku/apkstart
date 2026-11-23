'use strict';

const api = window.apkstartSplash;
const i18n = window.apkstartI18n;
const $ = (id) => document.getElementById(id);
let splashLanguage = 'en';
const translatedText = new WeakMap();

function localizeTextNode(node) {
  const current = node.nodeValue;
  const previous = translatedText.get(node);
  const source = previous && current === previous.output ? previous.source : current;
  const key = source.trim().replace(/\s+/g, ' ');
  const leading = source.match(/^\s*/)[0];
  const trailing = source.match(/\s*$/)[0];
  const output = key && splashLanguage !== 'zh-CN'
    ? i18n.translate(key, splashLanguage) || i18n.translate(key, 'en') || source
    : source;
  const localized = output === source ? source : `${leading}${output}${trailing}`;
  translatedText.set(node, { source, output: localized });
  if (localized !== current) node.nodeValue = localized;
}

function localizeNode(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    localizeTextNode(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root !== document.body) return;
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) localizeTextNode(node);
  }
  if (root.nodeType === Node.ELEMENT_NODE) {
    root.querySelectorAll('*').forEach((el) => {
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) localizeTextNode(node);
      }
    });
  }
}

function applySplashLanguage(language) {
  splashLanguage = i18n.normalize(language);
  document.documentElement.lang = splashLanguage;
  document.documentElement.dir = i18n.direction(splashLanguage);
  localizeNode(document.body);
}

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type === 'characterData') localizeTextNode(mutation.target);
    else mutation.addedNodes.forEach(localizeNode);
  }
});
observer.observe(document.body, { subtree: true, childList: true, characterData: true });

api?.language?.().then(applySplashLanguage).catch(() => applySplashLanguage('en'));
api?.version?.().then((v) => { if ($('ver')) $('ver').textContent = v || ''; }).catch(() => {});

Promise.all([
  api?.isFirstRun?.().catch(() => false),
  api?.bundled?.().catch(() => false),
]).then(([first, bundled]) => {
  if (!first || !$('firstRun')) return;
  $('firstRun').hidden = false;
  if (bundled) {
    if ($('firstRunTitle')) $('firstRunTitle').textContent = '首次启动 · 本地准备中（无需联网）';
    if ($('firstRunList')) {
      $('firstRunList').innerHTML = [
        '<li>运行时组件已随安装包内置，不再下载任何东西</li>',
        '<li>把系统镜像展开到用户目录（约 1 分钟，只需一次）</li>',
        '<li>准备硬件加速与中文输入法</li>',
        '<li>完成后双击 APK 或桌面图标即可秒开应用</li>',
      ].join('');
    }
  }
}).catch(() => {});

api?.onProgress?.((p) => {
  if (!p) return;
  if (p.percent != null && $('progressBar')) {
    $('progressBar').style.width = Math.min(100, Math.max(0, p.percent)) + '%';
  }
  if (p.message && $('status')) {
    $('status').textContent = p.message;
  }
});

api?.onDone?.(() => {
  const splash = $('splash');
  if (splash) {
    splash.classList.add('out');
    setTimeout(() => { api?.close?.(); }, 520);
  }
});
