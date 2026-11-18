'use strict';
/**
 * UI layout check per language (real Electron renderer, mocked main process — no Android runtime).
 *
 * Run: npm run test:ui-i18n   (= this script at 100%, 150% and 200% display scaling)
 *      or: npx electron test/ui-i18n-layout.js  with UI_DPR=1.5 for one scale factor
 * Output: test/out/i18n-layout/<lang>-<size>-<dpr>x-<view>.png + report-<dpr>x.json; exit code 1 on problems.
 *
 * For zh / en / vi, each with its own temporary APPDATA (never touches the real one):
 *   - main window: default size and minimum size (900x560)
 *   - views: welcome card, home (with long app names), settings dialog, language menu
 *   - app window title bar (shell.html) at its minimum width (320)
 *   - real device scale factor via --force-device-scale-factor (UI_DPR)
 * and reports text that is clipped (an element whose content overflows a box that hides it)
 * or controls pushed outside the window horizontally.
 *
 * This verifies layout only. IPC is mocked, so it says nothing about install / boot behaviour;
 * that still needs a manual smoke test on a real Android runtime.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out', 'i18n-layout');
const LANGS = (process.env.I18N_LANGS || 'zh,en,vi').split(',');
const DPR = Number(process.env.UI_DPR || 1);
app.commandLine.appendSwitch('force-device-scale-factor', String(DPR));
const CASES = [
  { name: 'default', width: 1140, height: 740 },
  { name: 'min', width: 900, height: 560 },
];

// One isolated data dir per language: APPDATA must be set before store.js is loaded
// (the renderer's preload loads it too and inherits this environment).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-ui-i18n-'));
function useDataDir(lang) {
  const dir = path.join(TMP, lang);
  fs.mkdirSync(path.join(dir, 'apkstart'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apkstart', 'settings.json'), JSON.stringify({ language: lang }));
  process.env.APPDATA = dir;
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
  return dir;
}

const LONG = 'Super Long Application Name For Layout Testing Purposes 超长应用名称';
function mockIpc() {
  const reply = {
    'app:info': { version: '0.5.0', dataDir: 'C:\\Users\\Someone\\AppData\\Roaming\\apkstart', runtimeDir: 'C:\\Users\\Someone\\AppData\\Roaming\\apkstart\\runtime' },
    'apps:list': [
      { package: 'com.example.verylongpackagename.withmanysegments', label: LONG, versionName: '12.34.567-beta', lastLaunchAt: Date.now() - 3600e3 },
      { package: 'com.example.game', label: '游戏 Game Trò chơi', versionName: '1.0', running: true, pinned: true },
      { package: 'com.example.short', label: 'A', versionName: '2.0' },
    ],
    'runtime:status': { ready: true, deviceOnline: true, android: '14', needsSetup: false, env: {} },
    'settings:get': () => require(path.join(ROOT, 'src', 'core', 'store')).getSettings(),
    'doctor:selfCheck': { issues: [
      { code: 'x', severity: 'error', title: 'Long issue title '.repeat(4), hint: 'Hint text '.repeat(12), fix: 'none' },
      { code: 'y', severity: 'warn', title: '提示 '.repeat(8), hint: '' },
    ] },
  };
  const channels = new Set();
  const src = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  for (const m of src.matchAll(/invoke\('([\w:.-]+)'/g)) channels.add(m[1]);
  for (const ch of channels) {
    try { ipcMain.removeHandler(ch); } catch (_) { /* ignore */ }
    ipcMain.handle(ch, () => {
      const r = reply[ch];
      // Unknown channels get an empty object: enough for the UI code paths to keep rendering
      return typeof r === 'function' ? r() : (r === undefined ? {} : r);
    });
  }
}

/** Runs in the page: list clipped text and controls outside the viewport. */
const PROBE = `(() => {
  const out = [];
  const W = document.documentElement.clientWidth;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || e.hidden) return false;
    }
    return true;
  };
  const label = (el) => (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : ''));
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    if (['SCRIPT','STYLE','svg','path','IMG','INPUT','SELECT','TEXTAREA','OPTION'].includes(el.tagName)) continue;
    const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').trim();
    if (!ownText) continue;
    const cs = getComputedStyle(el);
    // Ellipsis on purpose (app names, paths) is fine; only report hard clipping.
    const clipsX = cs.overflowX !== 'visible' && cs.textOverflow !== 'ellipsis';
    const clipsY = cs.overflowY !== 'visible';
    if (clipsX && el.scrollWidth > el.clientWidth + 1) out.push({ kind: 'clipped-x', el: label(el), text: ownText.slice(0, 60), over: el.scrollWidth - el.clientWidth });
    if (clipsY && cs.overflowY === 'hidden' && el.scrollHeight > el.clientHeight + 2) out.push({ kind: 'clipped-y', el: label(el), text: ownText.slice(0, 60), over: el.scrollHeight - el.clientHeight });
    // Buttons / badges: label wrapped onto more lines than the control is tall, or wider than the control
    if (el.matches('button, .btn, .tag, .ec-count, .status-chip') && cs.overflowY === 'visible'
        && (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 1)) {
      out.push({ kind: 'control-text-overflow', el: label(el), text: ownText.slice(0, 60), over: Math.max(el.scrollHeight - el.clientHeight, el.scrollWidth - el.clientWidth) });
    }
    const r = el.getBoundingClientRect();
    if (r.right > W + 1 && cs.position !== 'fixed') out.push({ kind: 'outside-window', el: label(el), text: ownText.slice(0, 60), over: Math.round(r.right - W) });
  }
  // Horizontal scrollbars inside scroll containers (long words / buttons that don't wrap)
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) {
      let widest = null; let wr = -1;
      for (const c of el.querySelectorAll('*')) { const r = c.getBoundingClientRect().right; if (visible(c) && r > wr) { wr = r; widest = c; } }
      out.push({ kind: 'h-scroll', el: label(el), text: widest ? label(widest) + ' ' + (widest.textContent || '').trim().slice(0, 50) : '', over: el.scrollWidth - el.clientWidth });
    }
  }
  if (document.documentElement.scrollWidth > W + 1) out.push({ kind: 'page-scroll-x', el: 'html', text: '', over: document.documentElement.scrollWidth - W });
  // Untranslated Chinese left in a non-Chinese UI (ignores user data such as app names)
  if (document.documentElement.dataset.lang !== 'zh') {
    const CJK = /[\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef]/;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const el = n.parentElement;
      if (!el || !visible(el) || !CJK.test(n.nodeValue)) continue;
      if (el.closest('.card .name, .card[title], #appName, #bootName, [data-user-text], .lang-menu')) continue;
      if (/语言|中文|日常MIKU|日本語|超长应用名称|游戏|提示/.test(n.nodeValue)) continue;
      out.push({ kind: 'untranslated', el: label(el), text: n.nodeValue.trim().slice(0, 60) });
    }
  }
  return out;
})()`;

async function capture(win, file) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(file, img.toPNG());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(win, expr, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await win.webContents.executeJavaScript(`!!(${expr})`).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}

/** The probe must catch a deliberately clipped element, or its "all clean" means nothing. */
async function probeSelfTest(win) {
  const hits = await win.webContents.executeJavaScript(`(() => {
    const d = document.createElement('div');
    d.id = '__probe_selftest';
    d.style.cssText = 'width:20px;overflow:hidden;white-space:nowrap;position:absolute;top:0;left:0';
    d.textContent = 'clipped text clipped text';
    document.body.appendChild(d);
    const r = ${PROBE};
    d.remove();
    return r.filter((p) => p.el === '#__probe_selftest').length;
  })()`);
  if (!hits) throw new Error('layout probe self-test failed: a clipped element was not detected');
}

function log(lang, label, problems) {
  console.log(`${problems.length ? '✗' : '✓'} [${lang}] ${label}${problems.length ? ` — ${problems.length} problem(s)` : ''}`);
  for (const p of problems.slice(0, 8)) console.log(`    ${p.kind} ${p.el} ${p.over ? `+${p.over}px ` : ''}"${p.text}"`);
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const report = [];
  for (const lang of LANGS) {
    useDataDir(lang);
    mockIpc();
    for (const c of CASES) {
      const win = new BrowserWindow({
        width: c.width, height: c.height, show: false, frame: false,
        webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, sandbox: false },
      });
      await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
      // Hidden windows don't advance CSS transitions/animations: make them finish instantly so captures show the end state
      await win.webContents.insertCSS('*, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; animation-duration: 1ms !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; }');
      const dpr = await win.webContents.executeJavaScript('window.devicePixelRatio');
      if (Math.abs(dpr - DPR) > 0.01) throw new Error(`devicePixelRatio ${dpr}, expected ${DPR}`);
      if (lang === LANGS[0] && c === CASES[0]) await probeSelfTest(win);
      const langOk = await waitFor(win, `document.documentElement.dataset.lang === ${JSON.stringify(lang)}`);
      if (!langOk) throw new Error(`[${lang}] page did not load in ${lang}`);
      const views = [
        ['welcome', '', "!document.getElementById('welcomeMask').hidden"],
        ['home', "document.getElementById('welcomeMask').hidden = true", "document.querySelectorAll('.card').length >= 4"],
        ['settings', 'openSettings()', "document.getElementById('settingsMask').classList.contains('on')"],
        ['langmenu', "closeSettings(); document.getElementById('btnLang').click()", "document.getElementById('langMenu').classList.contains('on')"],
      ];
      for (const [view, js, ready] of views) {
        if (js) await win.webContents.executeJavaScript(`Promise.resolve().then(() => { ${js} }).catch((e) => console.error(e))`);
        const shown = await waitFor(win, ready);
        await sleep(350); // let transitions finish before measuring / capturing
        const problems = shown ? await win.webContents.executeJavaScript(PROBE) : [{ kind: 'view-not-shown', el: view, text: ready }];
        await capture(win, path.join(OUT, `${lang}-${c.name}-${DPR}x-${view}.png`));
        report.push({ lang, case: c.name, dpr: DPR, view, problems });
        log(lang, `${c.name} ${DPR}x ${view}`, problems);
        if (view === 'settings' && shown) {
          // The settings dialog scrolls: capture every page so reviewers can eyeball all of it
          for (let page = 1; page <= 12; page++) {
            const more = await win.webContents.executeJavaScript(`(() => {
              const b = document.querySelector('#settingsMask .modal-body');
              if (!b) return false;
              const before = b.scrollTop;
              b.scrollTop += b.clientHeight - 40;
              return b.scrollTop > before;
            })()`);
            if (!more) break;
            await sleep(120);
            await capture(win, path.join(OUT, `${lang}-${c.name}-${DPR}x-settings-p${page + 1}.png`));
          }
          // The settings dialog is split into categories (left nav): only one is visible at a time,
          // so probe each of them, not just the one that happens to be open.
          const cats = await win.webContents.executeJavaScript(
            "Array.from(document.querySelectorAll('#setNav .set-nav-item')).map((b) => b.dataset.cat)",
          );
          for (const cat of cats) {
            await win.webContents.executeJavaScript(`(() => {
              const b = document.querySelector('#setNav .set-nav-item[data-cat="${cat}"]');
              if (b) b.click();
              const body = document.querySelector('#settingsMask .modal-body');
              if (body) body.scrollTop = 0;
            })()`);
            await sleep(200);
            const catProblems = await win.webContents.executeJavaScript(PROBE);
            await capture(win, path.join(OUT, `${lang}-${c.name}-${DPR}x-settings-cat-${cat}.png`));
            report.push({ lang, case: c.name, dpr: DPR, view: `settings/${cat}`, problems: catProblems });
            log(lang, `${c.name} ${DPR}x settings/${cat}`, catProblems);
          }
        }
      }
      win.destroy();
    }
    // App window title bar at its minimum width
    {
      const win = new BrowserWindow({
        width: 320, height: 480, show: false, frame: false,
        webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, sandbox: false },
      });
      await win.loadFile(path.join(ROOT, 'src', 'ui', 'shell.html'));
      await sleep(400);
      const problems = await win.webContents.executeJavaScript(PROBE);
      await capture(win, path.join(OUT, `${lang}-shell-${DPR}x.png`));
      report.push({ lang, case: 'shell-min', dpr: DPR, view: 'shell', problems });
      log(lang, `shell 320px ${DPR}x`, problems);

      // Live language switch: the shell hosts the running Android display, so it must
      // re-translate in place (no reload) when the main process sends i18n:changed.
      const other = lang === 'zh' ? 'en' : 'zh';
      const before = await win.webContents.executeJavaScript("[performance.timeOrigin, document.getElementById('btnRotate').getAttribute('title')]");
      win.webContents.send('i18n:changed', other);
      const switched = await waitFor(win, `document.documentElement.dataset.lang === '${other}'`);
      const after = await win.webContents.executeJavaScript("[performance.timeOrigin, document.getElementById('btnRotate').getAttribute('title')]");
      const live = [];
      if (!switched) live.push({ kind: 'live-switch', el: 'html', text: `lang not ${other}` });
      if (after[0] !== before[0]) live.push({ kind: 'live-switch', el: 'document', text: 'shell was reloaded' });
      if (after[1] === before[1]) live.push({ kind: 'live-switch', el: '#btnRotate', text: `title not re-translated: ${after[1]}` });
      report.push({ lang, case: 'shell-live-switch', dpr: DPR, view: 'shell', problems: live });
      log(lang, `shell live switch → ${other} (no reload)`, live);
      win.destroy();
    }
  }
  fs.writeFileSync(path.join(OUT, `report-${DPR}x.json`), JSON.stringify(report, null, 2));
  const bad = report.filter((r) => r.problems.length).length;
  console.log(`\n${report.length - bad} clean, ${bad} with problems — screenshots in ${path.relative(ROOT, OUT)}`);
  return bad;
}

// Windows are created and destroyed one after another: don't quit when the last one closes.
app.on('window-all-closed', () => {});
app.whenReady().then(run).then((bad) => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  app.exit(bad ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(2); });
