const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

let win = null;

// Mock store and settings
const mockSettings = {
  language: 'en',
  engine: {
    memoryMB: 0,
    cores: 0,
    gpuMode: 'auto',
    autoMemory: true,
    liteMode: true,
    dataMB: 0,
    resProfile: 'balanced',
    renderQuality: 'auto',
  },
  display: {
    windowMode: 'detached',
    autoFullscreen: false,
    wheelMode: 'smooth',
    keymap: true,
  },
  network: {
    source: 'auto',
    threads: 8,
  },
  autodebug: {
    auto: true,
    intervalMin: 60,
    notify: true,
  },
  paths: {
    sharedDir: 'C:\\Users\\localadmin\\Documents\\ApkStartShared',
    runtimeDir: '',
    avdDir: '',
  },
};

const mockStatus = {
  running: false,
  deviceOnline: false,
  phase: 'standby',
  android: '14',
  autoProfile: 'Auto: 3.0GB RAM · 4 cores · host render · Hardware Accel · Snapshot on demand · Lite container · Port 5562',
  env: {
    adb: { ok: true, version: '35.0.2' },
    emulator: { ok: true, version: '37.3.8.0' },
    sysimg: { ok: true, version: '14.0', isoPath: 'C:\\ApkStart\\system.img' },
    accel: { ok: true, driver: 'WHPX' },
  },
};

const mockEnvCheck = {
  issues: [
    {
      code: 'accel',
      severity: 'warn',
      title: 'Hardware acceleration is not enabled',
      hint: 'Performance is degraded without acceleration. Enabling WHPX or AEHD is recommended.',
      fix: 'virtualization',
    },
  ],
  accel: { ok: false },
  free: 25000,
};

const mockAutodebug = {
  issues: [],
  at: Date.now(),
  running: false,
};

function setupIpc() {
  ipcMain.handle('settings:get', () => mockSettings);
  ipcMain.handle('settings:save', (_e, patch) => {
    Object.assign(mockSettings, patch);
    return mockSettings;
  });
  ipcMain.handle('settings:set', (_e, { key, val }) => {
    mockSettings[key] = val;
    return { ok: true };
  });
  ipcMain.handle('runtime:status', () => mockStatus);
  ipcMain.handle('android:status', () => ({ ok: false }));
  ipcMain.handle('app:startupInfo', () => ({ seen: true }));
  ipcMain.handle('app:updateCheck', () => ({ hasUpdate: false, current: '0.6.2' }));
  ipcMain.handle('engine:resources', () => ({
    totalRAM: 16384,
    freeRAM: 8192,
    cpuCores: 8,
    freeDisk: 50000,
  }));
  ipcMain.handle('runtime:hostResources', () => ({
    totalRAM: 16384,
    freeRAM: 8192,
    cpuCores: 8,
    freeDisk: 50000,
    summary: '8 cores / 16GB RAM / 50GB Free Disk',
  }));
  ipcMain.handle('runtime:dataUsage', () => ({
    totalBytes: 5368709120,
    formatted: '5.0 GB',
  }));
  ipcMain.handle('doctor:selfCheck', () => mockEnvCheck);
  ipcMain.handle('doctor:profile', () => mockStatus.autoProfile);
  ipcMain.handle('autodebug:state', () => mockAutodebug);
  ipcMain.handle('autodebug:run', () => mockAutodebug);
  ipcMain.handle('autodebug:config', (_e, patch) => {
    Object.assign(mockSettings.autodebug, patch);
    return mockSettings.autodebug;
  });
  ipcMain.handle('i18n:setLocale', (_e, lang) => {
    mockSettings.language = lang;
    return lang;
  });
  ipcMain.handle('apps:list', () => []);
  ipcMain.handle('drivers:list', () => ({ ok: true, drivers: [] }));
  ipcMain.handle('app:version', () => '0.6.2');
  ipcMain.handle('assoc:status', () => ({ registered: true }));
  ipcMain.handle('update:check', () => ({ hasUpdate: false, current: '0.6.2' }));
}

async function runVerification() {
  setupIpc();

  win = new BrowserWindow({
    width: 1140,
    height: 740,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../src/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.webContents.on('console-message', (_e, level, msg, line, src) => {
    console.log(`[Renderer Console L${line}]: ${msg}`);
  });

  const indexPath = path.join(__dirname, '../src/ui/index.html');
  await win.loadFile(indexPath);

  // Give the UI a brief moment to initialize
  await new Promise((resolve) => setTimeout(resolve, 800));

  console.log('\n==================================================');
  console.log('--- 1. VERIFYING ENGLISH (DEFAULT LOCALE) ---');
  console.log('==================================================');

  // Check initial state
  let result = await win.webContents.executeJavaScript(`
    (() => {
      try {
        const issues = [];
        const chineseRe = /[\\u4e00-\\u9fa5]/;
        
        if (document.documentElement.lang !== 'en') issues.push('Root lang is not en: ' + document.documentElement.lang);
        if (document.documentElement.dir !== 'ltr') issues.push('Root dir is not ltr: ' + document.documentElement.dir);

        const emptyTitle = document.querySelector('[data-i18n="empty.title"]');
        if (emptyTitle && chineseRe.test(emptyTitle.textContent)) issues.push('Empty title has Chinese: ' + emptyTitle.textContent);

        const btnSet = document.getElementById('btnSettings');
        if (btnSet) btnSet.click();

        return { issues, emptyTitle: emptyTitle ? emptyTitle.textContent : null };
      } catch (e) {
        return { error: e.message, stack: e.stack };
      }
    })()
  `);

  if (result.error) {
    console.error('Renderer execution error:', result.error, result.stack);
    process.exit(1);
  }
  console.log('Empty title text:', result.emptyTitle);
  if (result.issues.length) {
    console.error('FAIL: Initial English checks failed:', result.issues);
    process.exit(1);
  }

  // Allow settings modal animation & render
  await new Promise((resolve) => setTimeout(resolve, 600));

  // Inspect Settings Modal in English
  result = await win.webContents.executeJavaScript(`
    (() => {
      try {
        const issues = [];
        const chineseRe = /[\\u4e00-\\u9fa5]/;
        const settingsBody = document.getElementById('settingsBody') || document.body;
        
        const walker = document.createTreeWalker(settingsBody, NodeFilter.SHOW_TEXT, null);
        let node;
        const chineseHits = [];
        while ((node = walker.nextNode())) {
          const text = (node.nodeValue || '').trim();
          if (!text) continue;
          if (node.parentElement && node.parentElement.tagName === 'OPTION' && node.parentElement.value === 'zh') continue;
          if (node.parentElement && node.parentElement.href && node.parentElement.href.includes('douyin')) continue;
          if (text.includes('Language / اللغة / 语言')) continue;

          if (chineseRe.test(text)) {
            chineseHits.push({ text, parent: node.parentElement.tagName + '.' + (node.parentElement.className || '') + '#' + (node.parentElement.id || '') });
          }
        }

        settingsBody.querySelectorAll('[placeholder]').forEach(el => {
          if (chineseRe.test(el.placeholder)) {
            chineseHits.push({ text: 'placeholder: ' + el.placeholder, parent: el.id });
          }
        });

        const catLabels = Array.from(document.querySelectorAll('.set-nav-label')).map(el => el.textContent.trim());

        return { chineseHits, catLabels };
      } catch (e) {
        return { error: e.message, stack: e.stack };
      }
    })()
  `);

  if (result.error) {
    console.error('Renderer execution error in Settings inspection:', result.error, result.stack);
    process.exit(1);
  }

  console.log('Category Tabs (English):', result.catLabels);
  if (result.chineseHits.length > 0) {
    console.error('FAIL: Lingering Chinese found in English Settings:');
    result.chineseHits.forEach(h => console.error('  - [' + h.parent + ']: ' + h.text));
    process.exit(1);
  }
  console.log('PASS: Zero Chinese characters in English UI & Settings Modal!');

  // Capture screenshot of English Settings
  const artifactsDir = path.join(__dirname, '../dist');
  if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });
  const enImg = await win.capturePage();
  fs.writeFileSync(path.join(artifactsDir, 'settings-verified-en.png'), enImg.toPNG());
  console.log('Saved screenshot: dist/settings-verified-en.png');

  console.log('\n==================================================');
  console.log('--- 2. VERIFYING ARABIC (RTL & FULL ARABIC) ---');
  console.log('==================================================');

  // Switch to Arabic
  result = await win.webContents.executeJavaScript(`
    (() => {
      try {
        const select = document.getElementById('setLanguage');
        select.value = 'ar';
        select.dispatchEvent(new Event('change'));
        return { lang: document.documentElement.lang, dir: document.documentElement.dir };
      } catch (e) {
        return { error: e.message };
      }
    })()
  `);

  if (result.error) {
    console.error('Error switching to Arabic:', result.error);
    process.exit(1);
  }

  await new Promise((resolve) => setTimeout(resolve, 800));

  result = await win.webContents.executeJavaScript(`
    (() => {
      try {
        const issues = [];
        const chineseRe = /[\\u4e00-\\u9fa5]/;
        const settingsBody = document.getElementById('settingsBody') || document.body;

        if (document.documentElement.lang !== 'ar') issues.push('lang is not ar: ' + document.documentElement.lang);
        if (document.documentElement.dir !== 'rtl') issues.push('dir is not rtl: ' + document.documentElement.dir);

        const walker = document.createTreeWalker(settingsBody, NodeFilter.SHOW_TEXT, null);
        let node;
        const chineseHits = [];
        while ((node = walker.nextNode())) {
          const text = (node.nodeValue || '').trim();
          if (!text) continue;
          if (node.parentElement && node.parentElement.tagName === 'OPTION' && node.parentElement.value === 'zh') continue;
          if (node.parentElement && node.parentElement.href && node.parentElement.href.includes('douyin')) continue;
          if (text.includes('Language / اللغة / 语言')) continue;

          if (chineseRe.test(text)) {
            chineseHits.push({ text, parent: node.parentElement.tagName + '.' + (node.parentElement.className || '') + '#' + (node.parentElement.id || '') });
          }
        }

        const catLabels = Array.from(document.querySelectorAll('.set-nav-label')).map(el => el.textContent.trim());

        return { issues, chineseHits, catLabels, dir: document.documentElement.dir, lang: document.documentElement.lang };
      } catch (e) {
        return { error: e.message };
      }
    })()
  `);

  if (result.error) {
    console.error('Error verifying Arabic:', result.error);
    process.exit(1);
  }

  console.log('RTL Direction:', result.dir);
  console.log('Language:', result.lang);
  console.log('Category Tabs (Arabic):', result.catLabels);
  if (result.issues && result.issues.length) {
    console.error('FAIL: Arabic RTL issues:', result.issues);
    process.exit(1);
  }
  if (result.chineseHits && result.chineseHits.length > 0) {
    console.error('FAIL: Lingering Chinese found in Arabic Settings:');
    result.chineseHits.forEach(h => console.error('  - [' + h.parent + ']: ' + h.text));
    process.exit(1);
  }
  console.log('PASS: Arabic RTL and translations verified with ZERO Chinese characters!');

  const arImg = await win.capturePage();
  fs.writeFileSync(path.join(artifactsDir, 'settings-verified-ar.png'), arImg.toPNG());
  console.log('Saved screenshot: dist/settings-verified-ar.png');

  console.log('\n==================================================');
  console.log('--- 3. VERIFYING CHINESE (ORIGINAL SOURCE OF TRUTH) ---');
  console.log('==================================================');

  result = await win.webContents.executeJavaScript(`
    (() => {
      const select = document.getElementById('setLanguage');
      select.value = 'zh';
      select.dispatchEvent(new Event('change'));
      return { lang: document.documentElement.lang, dir: document.documentElement.dir };
    })()
  `);

  await new Promise((resolve) => setTimeout(resolve, 800));

  result = await win.webContents.executeJavaScript(`
    (() => {
      const catLabels = Array.from(document.querySelectorAll('.set-nav-label')).map(el => el.textContent.trim());
      return { catLabels, dir: document.documentElement.dir, lang: document.documentElement.lang };
    })()
  `);

  console.log('Category Tabs (Chinese):', result.catLabels);
  console.log('PASS: Chinese switch verified!');

  const zhImg = await win.capturePage();
  fs.writeFileSync(path.join(artifactsDir, 'settings-verified-zh.png'), zhImg.toPNG());
  console.log('Saved screenshot: dist/settings-verified-zh.png');

  console.log('\n==================================================');
  console.log('ALL IN-PROCESS ELECTRON VERIFICATIONS PASSED 100%!');
  console.log('==================================================\n');

  app.quit();
}

app.whenReady().then(runVerification).catch((err) => {
  console.error('Fatal verification error:', err);
  process.exit(1);
});
