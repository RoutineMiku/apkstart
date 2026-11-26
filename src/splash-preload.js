'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 界面语言：同步拿一次主进程决定的语言，页面里的 ui/i18n-dom.js 用它翻译文字
try {
  const i18n = require('./i18n');
  const lang = ipcRenderer.sendSync('i18n:get');
  i18n.setLang(lang);
  contextBridge.exposeInMainWorld('apkstartI18n', { lang: i18n.getLang(), t: (s) => i18n.t(String(s)) });
} catch (_) { /* 翻译不可用时界面保持中文 */ }

contextBridge.exposeInMainWorld('apkstartSplash', {
  version: () => ipcRenderer.invoke('splash:version'),
  isFirstRun: () => ipcRenderer.invoke('splash:isFirstRun'),
  // 运行组件是随包带来的（完整版 / 商店 MSIX 版）还是需要联网下载（轻量版）。
  // 开机动画据此换掉「下载 xx MB」那套文案 —— 明明已经内置了还写「正在下载」，
  // 用户会以为装完还要再下一遍。
  bundled: () => ipcRenderer.invoke('splash:bundled'),
  onProgress: (cb) => { ipcRenderer.on('splash:progress', (_e, p) => cb(p)); },
  onDone: (cb) => { ipcRenderer.on('splash:done', () => cb()); },
  close: () => ipcRenderer.send('splash:close'),
});
