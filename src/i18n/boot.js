'use strict';
// 渲染进程入口：preload 已经按设置算好了语言（主窗口 / 壳窗口是 window.apkstart.lang，
// 开机动画是 window.apkstartSplash.lang），这里只负责接管 DOM。
// 必须放在 i18n.js / es.js 之后、页面自己的脚本之前加载。
(function () {
  const bridge = window.apkstart || window.apkstartSplash;
  const lang = (bridge && bridge.lang) || 'zh-CN';
  if (window.ApkI18n) window.ApkI18n.installDom(lang, document);
})();
