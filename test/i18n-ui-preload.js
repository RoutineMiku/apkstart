'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const settings = structuredClone(require('../src/core/store').DEFAULT_SETTINGS);
settings.engine.priorityMode = 'game';
settings.engine.gpuPreference = 'discrete';
const { getCatalog, setLanguage, getLanguage, lookup, t, normalizeLang } = require('../src/core/i18n');
const langListeners = new Set();
ipcRenderer.on('i18n:lang', (_event, lang) => { setLanguage(lang); for (const cb of langListeners) cb(lang); });
const api = {};
for (const match of fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8').matchAll(/^  (\w+): /gm)) {
  api[match[1]] = async () => ({ ok: true });
}
api.getI18n = async () => {
  const locale = await ipcRenderer.invoke('test:language');
  setLanguage(locale);
  return { locale, preference: normalizeLang(locale), messages: getCatalog(locale) };
};
api.getSettings = async () => ({ ...settings, uiLanguage: normalizeLang(await ipcRenderer.invoke('test:language')) });
api.setSettings = async (patch) => { if (patch.uiLanguage) await ipcRenderer.invoke('test:setLanguage', patch.uiLanguage); return { ...settings, ...patch }; };
api.i18n = { lookup, t, getLanguage, onLanguageChange: (cb) => { langListeners.add(cb); return () => langListeners.delete(cb); } };
api.listApps = async () => [{ package: 'org.example.app', label: 'Sample app', versionName: '1.0', running: true, installedAt: Date.now() }];
api.runtimeStatus = async () => ({ adbOk: false, env: {}, phase: 'stopped' });
api.startupInfo = async () => ({ smoke: true, version: '0.4.2-i18n.1' });
api.info = async () => ({ version: '0.4.2-i18n.1', dataDir: 'F:\\Test', runtimeDir: 'F:\\Test\\runtime' });
api.doctorProfile = async () => ({});
api.runtimeUsage = async () => ({ totalText: '0 MB', reclaimable: 0, count: 0 });
api.dataInfo = async () => ({ imageGB: 6, freeDiskMB: 20480, overlay: true, pendingGB: 12, configuredGB: 12 });
api.resources = async () => ({ host: { totalMB: 16384, cores: 8 }, limits: { maxMB: 12288, maxGB: 64 }, freeMB: 81920 });
api.driversList = async () => ({ drivers: [], errors: [], host: {} });
api.gpuStatus = async () => ({ supported: true, mode: 'discrete', applied: 'discrete' });
api.selfCheck = async () => ({ issues: [] });
api.autodebugState = async () => ({ at: Date.now(), issues: [{
  code: 'device.unauthorized', category: 'device', severity: 'error',
  title: 'Test issue', hint: 'Test hint', fix: 'restartRuntime',
}] });
api.autodebugRun = api.autodebugState;
api.openManual = (payload) => ipcRenderer.invoke('test:manual', payload);
api.on = () => () => {};
api.android = { status: async () => ({ ok: false }), set: async () => ({ ok: true }) };
api.shell = { onState: () => () => {}, state: async () => ({ label: '', tip: '' }), minimize: () => {}, maximize: () => {}, close: () => {}, rotate: () => {} };
if (process.argv.includes('--splash-test')) {
  contextBridge.exposeInMainWorld('apkstartSplash', {
    getI18n: api.getI18n,
    version: async () => '0.5.8',
    isFirstRun: async () => true,
    bundled: () => ipcRenderer.invoke('test:bundled'),
    onProgress: () => {}, onDone: () => {}, close: () => {},
  });
} else {
  contextBridge.exposeInMainWorld('apkstart', api);
}
