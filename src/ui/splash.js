'use strict';
/* ApkStart 开机动画脚本：接收主进程的进度更新，控制淡出 */

const api = window.apkstartSplash;
const i18n = window.apkstartI18n || (api && api.i18n);
if (!api) { /* preload 未注入时静默退出 */ }

const $ = (id) => document.getElementById(id);

// 语言与 RTL 初始化
api?.locale?.().then((loc) => {
  const lang = loc || 'en';
  if (i18n) i18n.translateDOM(document, lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = (lang === 'ar' ? 'rtl' : 'ltr');
}).catch(() => {});

// 版本号
api?.version?.().then((v) => { if ($('ver')) $('ver').textContent = v || ''; }).catch(() => {});

// 首次安装标记 + 组件是否随包自带
Promise.all([
  api?.isFirstRun?.().catch(() => false),
  api?.bundled?.().catch(() => false),
  api?.locale?.().catch(() => 'en'),
]).then(([first, bundled, loc]) => {
  if (!first || !$('firstRun')) return;
  $('firstRun').hidden = false;
  const lang = loc || 'en';
  // 内置运行时（完整版安装包 / 微软商店 MSIX 版）：一个字都不该提「下载」。
  // 用户抱怨的就是「装了 850MB 还在下镜像」，实际那只是把包里的压缩镜像
  // 展开到用户目录，不需要联网。
  if (bundled) {
    if ($('firstRunTitle')) {
      $('firstRunTitle').textContent = i18n ? i18n.t('splash.firstRunBundledTitle', null, lang) : '首次启动 · 本地准备中（无需联网）';
    }
    if ($('firstRunList')) {
      $('firstRunList').innerHTML = [
        `<li>${i18n ? i18n.t('splash.firstRunBundledStep1', null, lang) : '运行时组件已随安装包内置，不再下载任何东西'}</li>`,
        `<li>${i18n ? i18n.t('splash.firstRunBundledStep2', null, lang) : '把系统镜像展开到用户目录（约 1 分钟，只需一次）'}</li>`,
        `<li>${i18n ? i18n.t('splash.firstRunBundledStep3', null, lang) : '准备硬件加速与中文输入法'}</li>`,
        `<li>${i18n ? i18n.t('splash.firstRunBundledStep4', null, lang) : '完成后双击 APK 或桌面图标即可秒开应用'}</li>`,
      ].join('');
    }
  }
}).catch(() => {});

// 进度更新
api?.onProgress?.((p) => {
  if (!p) return;
  if (p.percent != null && $('progressBar')) {
    $('progressBar').style.width = Math.min(100, Math.max(0, p.percent)) + '%';
  }
  if (p.message && $('status')) {
    $('status').textContent = p.message;
  }
});

// 完成 → 淡出
api?.onDone?.(() => {
  const splash = $('splash');
  if (splash) {
    splash.classList.add('out');
    setTimeout(() => { api?.close?.(); }, 520);
  }
});
