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
  stop: (pkg) => invoke('app:stop', pkg),
  uninstall: (pkg) => invoke('app:uninstall', pkg),
  createShortcut: (pkg) => invoke('app:shortcut', pkg),
  clearData: (pkg) => invoke('app:clearData', pkg),
  pin: (pkg, pinned) => invoke('app:pin', { pkg, pinned }),
  setAppOrientation: (pkg, orientation) => invoke('app:setOrientation', { pkg, orientation }),
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
  runtimeResetData: () => invoke('runtime:resetData'),
  runtimeRepairNetwork: () => invoke('runtime:repairNetwork'),
  runtimeCheckNetwork: () => invoke('runtime:checkNetwork'),
  leftoversScan: () => invoke('leftovers:scan'),
  leftoversClean: (items) => invoke('leftovers:clean', items),
  startupInfo: () => invoke('app:startupInfo'),
  dataInfo: () => invoke('runtime:dataInfo'),
  setDataSize: (gb) => invoke('runtime:setDataSize', gb),
  resources: () => invoke('engine:resources'),
  // 本机体检 / 自动配置
  preflightRun: () => invoke('preflight:run'),
  preflightApply: () => invoke('preflight:apply'),
  // 自动检测（自动 debug）：定时采集 + 判定，产出按分类归组的问题清单
  autodebugRun: () => invoke('autodebug:run'),
  autodebugState: () => invoke('autodebug:state'),
  autodebugConfig: (patch) => invoke('autodebug:config', patch || {}),
  // 自动检测的修复动作
  clearOrphans: () => invoke('app:clearOrphans'),
  clearSnapshot: () => invoke('app:clearSnapshot'),
  restartRuntime: () => invoke('runtime:restart'),
  // 驱动（兼容补丁）：列清单 / 导入 / 打开目录 / 导出本机模板 / 启用停用
  driversList: () => invoke('drivers:list'),
  driversImport: () => invoke('drivers:import'),
  driversOpenFolder: () => invoke('drivers:openFolder'),
  driversExportTemplate: () => invoke('drivers:exportTemplate'),
  driversSetEnabled: (id, enabled) => invoke('drivers:setEnabled', { id, enabled }),

  resetAndResize: (gb) => invoke('runtime:resetAndResize', gb),
  confirm: (opts) => invoke('app:confirm', opts || {}),
  displayState: () => invoke('display:state'),
  displaySet: (patch) => invoke('display:set', patch || {}),
  displayToggle: () => invoke('display:toggle'),
  rebuildShortcuts: () => invoke('shortcut:rebuild'),
  autoDeploy: (opts) => invoke('runtime:autoDeploy', opts || {}),
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
  // 打开「启用或关闭 Windows 功能」对话框（商店版只能引导用户自己去勾选）
  openWindowsFeatures: () => invoke('provision:openWindowsFeatures'),
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
  // 0.6.2 内置手册：传 { topic } / { issue } / { error } 都会定位到对应章节
  openManual: (payload) => invoke('manual:open', payload || {}),
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
    keyEvent: (key) => invoke('shell:keyEvent', key),
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

  // 按键映射（游戏键盘→触屏）
  keymap: {
    getPresets: () => invoke('keymap:getPresets'),
    getMap: (pkg) => invoke('keymap:getMap', pkg),
    setMap: (pkg, mappings) => invoke('keymap:setMap', pkg, mappings),
    setEnabled: (on) => invoke('keymap:setEnabled', on),
    isEnabled: () => invoke('keymap:isEnabled'),
    applyPreset: (pkg, presetId) => invoke('keymap:applyPreset', pkg, presetId),
  },

  pathForFile: (file) => webUtils.getPathForFile(file),

  on: (channel, cb) => {
    const allowed = [
      'install:start', 'install:progress', 'install:done', 'install:error',
      'app:launched', 'runtime:log', 'toast', 'ui:navigate', 'provision:progress',
      'update:progress', 'update:state', 'autodebug:state',
    ];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
