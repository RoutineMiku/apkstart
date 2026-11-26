'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const appI18n = require('./core/i18n');

try {
  const boot = ipcRenderer.sendSync('i18n:bootstrap');
  appI18n.setLanguage((boot && boot.lang) || 'zh');
} catch (_) { /* 按中文 */ }
const langListeners = new Set();
ipcRenderer.on('i18n:lang', (_e, next) => {
  appI18n.setLanguage(next);
  for (const cb of [...langListeners]) {
    try { cb(next); } catch (_) { /* ignore */ }
  }
});

contextBridge.exposeInMainWorld('apkstartSplash', {
  i18n: {
    getLanguage: () => appI18n.getLanguage(),
    t: (text, vars) => appI18n.t(text, vars),
    lookup: (text) => appI18n.lookup(text),
    onLanguageChange: (cb) => {
      if (typeof cb === 'function') langListeners.add(cb);
    },
  },
  version: () => ipcRenderer.invoke('splash:version'),
  getI18n: () => ipcRenderer.invoke('i18n:get'),
  isFirstRun: () => ipcRenderer.invoke('splash:isFirstRun'),
  // 运行组件是随包带来的（完整版 / 商店 MSIX 版）还是需要联网下载（轻量版）。
  // 开机动画据此换掉「下载 xx MB」那套文案 —— 明明已经内置了还写「正在下载」，
  // 用户会以为装完还要再下一遍。
  bundled: () => ipcRenderer.invoke('splash:bundled'),
  onProgress: (cb) => { ipcRenderer.on('splash:progress', (_e, p) => cb(p)); },
  onDone: (cb) => { ipcRenderer.on('splash:done', () => cb()); },
  close: () => ipcRenderer.send('splash:close'),
});
