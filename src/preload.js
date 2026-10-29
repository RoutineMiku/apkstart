'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('apkstart', {
  info: () => invoke('app:info'),
  listApps: () => invoke('apps:list'),
  pickApk: () => invoke('apk:pick'),
  parseApk: (p) => invoke('apk:parse', p),
  installApk: (p) => invoke('apk:install', p),
  launch: (pkg) => invoke('app:launch', pkg),
  uninstall: (pkg) => invoke('app:uninstall', pkg),
  createShortcut: (pkg) => invoke('app:shortcut', pkg),
  clearData: (pkg) => invoke('app:clearData', pkg),
  pin: (pkg, pinned) => invoke('app:pin', { pkg, pinned }),
  revealApk: (pkg) => invoke('app:revealApk', pkg),
  revealApkDir: () => invoke('apk:reveal'),

  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),

  runtimeStatus: () => invoke('runtime:status'),
  runtimeProbe: () => invoke('runtime:probe'),
  runtimeStart: () => invoke('runtime:start'),
  runtimeStop: () => invoke('runtime:stop'),
  runtimeLog: () => invoke('runtime:log'),
  startInstaller: () => invoke('runtime:startInstaller'),
  markInstalled: () => invoke('runtime:markInstalled'),
  resetInstall: () => invoke('runtime:resetInstall'),

  provisionCheck: () => invoke('provision:check'),
  provisionProbeSources: () => invoke('provision:probeSources'),
  installAdb: () => invoke('provision:installAdb'),
  installQemu: () => invoke('provision:installQemu'),
  downloadIso: () => invoke('provision:downloadIso'),
  createDisk: (gb) => invoke('provision:createDisk', gb),
  importIso: () => invoke('provision:importIso'),
  importDisk: () => invoke('provision:importDisk'),

  assocStatus: () => invoke('assoc:status'),
  assocRegister: () => invoke('assoc:register'),
  assocUnregister: () => invoke('assoc:unregister'),

  syncShared: () => invoke('share:sync'),
  openSharedDir: () => invoke('share:open'),

  openExternal: (url) => invoke('shell:open', url),
  winMinimize: () => invoke('window:minimize'),
  winMaximize: () => invoke('window:maximize'),
  winClose: () => invoke('window:close'),
  winHide: () => invoke('window:hide'),

  pathForFile: (file) => webUtils.getPathForFile(file),

  on: (channel, cb) => {
    const allowed = [
      'install:start', 'install:progress', 'install:done', 'install:error',
      'app:launched', 'runtime:log', 'toast', 'ui:navigate', 'provision:progress',
    ];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
