'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 界面语言：与主窗口共用 src/i18n（i18n-dom.js 读取 window.apkstart.i18n）。
// 按与 preload.js 相同的规则解析（主进程启动时已把结果写回设置）。
const i18n = require('./i18n');
i18n.getLang();
contextBridge.exposeInMainWorld('apkstart', {
  i18n: {
    lang: i18n.getLang(),
    tag: i18n.localeTag(),
    languages: i18n.LANGUAGES.map((l) => ({ ...l })),
    t: (src, vars) => i18n.t(src, vars),
    tHtml: (src, vars) => i18n.tHtml(src, vars),
    getLang: () => i18n.getLang(),
  },
});

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
