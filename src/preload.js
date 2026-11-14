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
  openDir: () => invoke('dialog:openDir'),

  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  restoreSystemApps: () => invoke('settings:restoreSystem'),
  refreshPointerMapping: () => invoke('settings:refreshPointer'),
  restoreMouseHook: () => invoke('settings:unhook'),

  runtimeStatus: () => invoke('runtime:status'),
  runtimeProbe: () => invoke('runtime:probe'),
  runtimeStart: () => invoke('runtime:start'),
  runtimeStop: () => invoke('runtime:stop'),
  runtimeLog: () => invoke('runtime:log'),
  doctorProfile: () => invoke('doctor:profile'),
  doctorReport: () => invoke('doctor:report'),
  vcRedist: () => invoke('runtime:vcRedist'),
  installVcRedist: () => invoke('runtime:installVcRedist'),
  runtimeUsage: () => invoke('runtime:usage'),
  runtimeCleanup: (opts) => invoke('runtime:cleanup', opts || {}),
  dataInfo: () => invoke('runtime:dataInfo'),
  setDataSize: (gb) => invoke('runtime:setDataSize', gb),
  confirm: (opts) => invoke('app:confirm', opts || {}),
  displayState: () => invoke('display:state'),
  displaySet: (patch) => invoke('display:set', patch || {}),
  displayToggle: () => invoke('display:toggle'),
  rebuildShortcuts: () => invoke('shortcut:rebuild'),
  autoDeploy: () => invoke('runtime:autoDeploy'),
  startInstaller: () => invoke('runtime:startInstaller'),
  markInstalled: () => invoke('runtime:markInstalled'),
  resetInstall: () => invoke('runtime:resetInstall'),

  provisionCheck: () => invoke('provision:check'),
  provisionProbeSources: () => invoke('provision:probeSources'),
  installAdb: () => invoke('provision:installAdb'),
  installQemu: () => invoke('provision:installQemu'),
  installEmulator: () => invoke('provision:installEmulator'),
  installSysimg: () => invoke('provision:installSysimg'),
  installPlayImage: () => invoke('provision:installPlayImage'),
  installAehd: () => invoke('provision:installAehd'),
  enableAccel: () => invoke('provision:enableAccel'),
  enableVirtualization: () => invoke('provision:enableVirtualization'),
  downloadIso: () => invoke('provision:downloadIso'),
  createDisk: (gb) => invoke('provision:createDisk', gb),
  importIso: () => invoke('provision:importIso'),
  importDisk: () => invoke('provision:importDisk'),

  selfCheck: () => invoke('doctor:selfCheck'),
  clearLocks: () => invoke('app:clearLocks'),
  removeSelf: () => invoke('app:removeSelf'),
  setSharedDir: (dir) => invoke('settings:setSharedDir', dir),

  // 在线更新（GitHub Releases）
  updateCheck: (opts) => invoke('app:updateCheck', opts || {}),
  updateApply: () => invoke('app:updateApply'),
  updateCancel: () => invoke('app:updateCancel'),
  updateOpenRelease: (url) => invoke('app:updateOpen', url),
  restartApp: () => invoke('app:restart'),

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
  bringAppToFront: () => invoke('app:foreground'),

  // 应用窗口（只有 旋转 / 最小化 / 最大化 / 关闭）用到的接口
  shell: {
    state: () => invoke('shell:state'),
    minimize: () => invoke('shell:minimize'),
    maximize: () => invoke('shell:maximize'),
    close: () => invoke('shell:close'),
    rotate: () => invoke('shell:rotate'),
    back: () => invoke('shell:back'),
    forward: () => invoke('shell:forward'),
    onState: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('shell:state', handler);
      return () => ipcRenderer.removeListener('shell:state', handler);
    },
  },

  // 安卓系统设置（WiFi / 音量 / 显示 / 动画 / 权限 …）
  android: {
    status: () => invoke('android:status'),
    set: (key, value) => invoke('android:set', { key, value }),
    open: (action) => invoke('android:open', action),
    tune: (pkg) => invoke('android:tune', pkg),
    permissions: (pkg) => invoke('android:permissions', pkg),
    grantAll: (pkg) => invoke('android:grantAll', pkg),
  },

  pathForFile: (file) => webUtils.getPathForFile(file),

  on: (channel, cb) => {
    const allowed = [
      'install:start', 'install:progress', 'install:done', 'install:error',
      'app:launched', 'runtime:log', 'toast', 'ui:navigate', 'provision:progress',
      'update:progress', 'update:state',
    ];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
