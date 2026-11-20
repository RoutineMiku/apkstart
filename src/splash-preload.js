'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 界面语言：和主窗口的 preload 一样同步算好，开机动画也跟着设置切换
let uiLang = 'zh-CN';
try {
  const i18n = require('./i18n/i18n');
  const store = require('./core/store');
  uiLang = i18n.resolveLang(store.getSettings().uiLang, navigator.languages);
} catch (_) { /* 读不到设置就保持中文 */ }

contextBridge.exposeInMainWorld('apkstartSplash', {
  lang: uiLang,
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
