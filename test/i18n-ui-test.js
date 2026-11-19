'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getCatalog } = require('../src/core/i18n');
const sourceRoot = process.env.APKSTART_UI_SOURCE || path.join(__dirname, '../src');
let locale = 'pt-BR';
let bundled = false;
const manualRequests = [];
ipcMain.handle('test:manual', (_event, payload) => { manualRequests.push(payload); return { ok: true }; });
ipcMain.handle('test:language', () => locale);
ipcMain.handle('test:bundled', () => bundled);
ipcMain.handle('test:setLanguage', (_event, value) => { locale = value; });
const out = path.join(__dirname, 'out', 'i18n');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1120, height: 800, show: true, webPreferences: { preload: path.join(__dirname, 'i18n-ui-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
  const waitReady = () => win.webContents.executeJavaScript(`new Promise((resolve, reject) => { let tries = 0; const tick = () => { if (window.i18n && document.documentElement.lang === '${locale}' && document.querySelector('.card')) resolve(true); else if (++tries > 100) reject(new Error('UI did not initialize')); else setTimeout(tick, 50); }; tick(); })`);
  try {
    await win.loadFile(path.join(sourceRoot, 'ui/index.html'));
    for (const next of ['pt-BR', 'en', 'zh-CN', 'pt-BR']) {
      if (locale !== next) {
        const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
        await win.webContents.executeJavaScript(`document.getElementById('setLanguage').value = '${next}'; document.getElementById('setLanguage').dispatchEvent(new Event('change')); true;`);
        await loaded;
      }
      await waitReady();
      await win.webContents.executeJavaScript('openSettings()');
      await win.webContents.executeJavaScript("switchSettingsCat('basic')");
      const result = await win.webContents.executeJavaScript(`({lang: document.documentElement.lang, language: document.getElementById('setLanguage').value, title: document.querySelector('.modal-head h2').textContent, horizontalOverflow: document.querySelector('.modal-body').scrollWidth > document.querySelector('.modal-body').clientWidth, untranslated: [...document.querySelectorAll('[data-i18n]')].filter(el => el.textContent === el.dataset.i18n).length })`);
      assert.equal(result.lang, next);
      assert.equal(result.language, next);
      assert.equal(result.title, getCatalog(next).m0390);
      assert.equal(result.untranslated, 0);
      const priority = await win.webContents.executeJavaScript(`({ value: document.getElementById('setPriorityMode').value, label: document.querySelector('#setPriorityMode option[value="game"]').textContent, note: document.querySelector('[data-i18n="settings.gamePriorityNote"]').textContent })`);
      assert.equal(priority.value, 'game');
      assert.equal(priority.label, getCatalog(next)['settings.gamePriority']);
      assert.equal(priority.note, getCatalog(next)['settings.gamePriorityNote']);
      const labels = await win.webContents.executeJavaScript(`(() => {
        showMenu(20, 20, 'org.example.app');
        const result = {
          open: document.querySelector('#ctxmenu [data-act="open"] span').textContent,
          stop: document.querySelector('#ctxmenu [data-act="stop"] span').textContent,
          engine: document.getElementById('setEngineLabel').value,
          dataNote: document.getElementById('dataNote').textContent,
        };
        hideMenu();
        return result;
      })()`);
      assert.equal(labels.open, getCatalog(next).m0105);
      assert.equal(labels.stop, getCatalog(next)['v058.m0052']);
      assert.equal(labels.engine, getCatalog(next)['v058.m0215']);
      assert.ok(labels.dataNote.includes(getCatalog(next)['v058.m0097']));
      const categories = await win.webContents.executeJavaScript(`(() => {
        document.querySelector('#setNav [data-cat="diag"]').click();
        const diagVisible = !document.getElementById('autodebugGroup').hidden;
        const heading = document.querySelector('#autodebugList .dbg-group-title').textContent;
        const fixCode = document.querySelector('#autodebugList .dbg-fix').dataset.code;
        document.querySelector('#autodebugList .dbg-help').click();
        const search = document.getElementById('setSearch');
        search.value = document.querySelector('#languageGroup .group-title').textContent;
        search.dispatchEvent(new Event('input'));
        const languageFound = !document.getElementById('languageGroup').hidden;
        document.getElementById('btnClearSearch').click();
        switchSettingsCat('basic');
        return { diagVisible, heading, fixCode, languageFound };
      })()`);
      assert.equal(categories.diagVisible, true);
      assert.ok(categories.heading.startsWith(getCatalog(next)['v062.m0037']));
      assert.equal(categories.fixCode, 'device.unauthorized');
      assert.equal(categories.languageFound, true);
      assert.equal(manualRequests.at(-1).issue, 'device.unauthorized');
      await new Promise(r => setTimeout(r, 600));
      fs.writeFileSync(path.join(out, `${next}-settings.png`), (await win.webContents.capturePage()).toPNG());
      console.log(next, JSON.stringify(result));
      assert.equal(result.horizontalOverflow, false, `${next}: settings overflow`);
      await win.webContents.executeJavaScript("focusGroup(document.getElementById('perfGroup')); true;");
      await new Promise(r => setTimeout(r, 300));
      fs.writeFileSync(path.join(out, `${next}-performance.png`), (await win.webContents.capturePage()).toPNG());
    }
    await win.webContents.executeJavaScript("closeSettings(); launchApp('org.example.app')");
    const toast = await win.webContents.executeJavaScript("document.querySelector('.t-title-text').textContent");
    assert.equal(toast, getCatalog('pt-BR').m0097);
    const splash = new BrowserWindow({ width: 480, height: 360, show: false, webPreferences: {
      preload: path.join(__dirname, 'i18n-ui-preload.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: false, additionalArguments: ['--splash-test'],
    } });
    splash.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
    for (const next of ['pt-BR', 'en', 'zh-CN']) {
      locale = next;
      for (const isBundled of [false, true]) {
        bundled = isBundled;
        await splash.loadFile(path.join(sourceRoot, 'ui/splash.html'));
        await splash.webContents.executeJavaScript(`window.i18n.ready.then(() => new Promise((resolve, reject) => {
          let tries = 0;
          const tick = () => {
            if (!document.getElementById('firstRun').hidden) resolve(true);
            else if (++tries > 100) reject(new Error('Splash did not initialize'));
            else setTimeout(tick, 20);
          }; tick();
        }))`);
        const result = await splash.webContents.executeJavaScript(`({
          lang: document.documentElement.lang,
          title: document.getElementById('firstRunTitle').textContent,
          items: document.querySelectorAll('#firstRunList li').length,
        })`);
        assert.equal(result.lang, next);
        assert.equal(result.title, getCatalog(next)[isBundled ? 'v058.m0148' : 'v058.m0220']);
        assert.equal(result.items, 4);
      }
    }
    splash.destroy();
    assert.deepEqual(errors, []);
    console.log('UI language persistence, settings, context menus, app launch and bundled/download splash translations passed');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});

