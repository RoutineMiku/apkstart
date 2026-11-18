'use strict';
/**
 * Language smoke test against the REAL app (electron .), each scenario in its own temporary APPDATA.
 * No Android runtime is deployed in those data dirs, so this covers startup, persistence and the
 * language switch of the real main process / tray / windows — not installing or booting Android.
 *
 * Run: node test/i18n-app-smoke.js   (needs the Electron binary: plain `npm ci`, no ELECTRON_SKIP_BINARY_DOWNLOAD)
 *
 * Scenarios
 *   fresh    : no data dir            → OS language (fallback English) chosen and written to settings.json
 *   upgrade  : settings.json + apps.json from a Chinese-only version, no `language`
 *              → stays Chinese, every other setting and apps.json untouched
 *   switch   : switch to Tiếng Việt through the real IPC (same call as the UI) → main window reloads in vi,
 *              settings saved, other settings untouched; restart → still vi
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require('electron');
const OUT = path.join(__dirname, 'out', 'i18n-app-smoke');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-i18n-smoke-'));
let port = 9400 + Math.floor(Math.random() * 400);

let passed = 0;
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/** Minimal CDP client over the page's WebSocket (Node >= 22 has a global WebSocket). */
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  return { send, evaluate, close: () => ws.close() };
}

async function mainPage(timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      const p = list.find((x) => x.type === 'page' && /\/ui\/index\.html$/.test(x.url));
      if (p) return p;
    } catch (_) { /* not up yet */ }
    await sleep(300);
  }
  throw new Error('main window did not appear');
}

async function waitEval(page, expr, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await page.evaluate(expr); if (v) return v; } catch (_) { /* reloading */ }
    await sleep(250);
  }
  return null;
}

function start(appData) {
  port++;
  const env = { ...process.env, APPDATA: appData, APKSTART_NO_SHELL_PROBE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`], { cwd: ROOT, env, stdio: 'ignore' });
  return child;
}

function stop(child) {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) { try { child.kill(); } catch (__) { /* gone */ } }
}

async function withApp(appData, fn) {
  const child = start(appData);
  try {
    const target = await mainPage();
    const page = await cdp(target.webSocketDebuggerUrl);
    try { return await fn(page); } finally { page.close(); }
  } finally {
    stop(child);
    await sleep(1500);
  }
}

async function shot(page, file) {
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  if (r.result && r.result.data) fs.writeFileSync(path.join(OUT, file), Buffer.from(r.result.data, 'base64'));
}

const settingsOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'apkstart', 'settings.json'), 'utf8').replace(/^﻿/, ''));
function dataDir(name, files = {}) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, 'apkstart'), { recursive: true });
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'apkstart', f), JSON.stringify(c, null, 2));
  return dir;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const osLang = require('../src/i18n').resolveInitialLanguage({ systemLocales: [Intl.DateTimeFormat().resolvedOptions().locale] }).lang;

  console.log('\n[fresh install]');
  const fresh = path.join(TMP, 'fresh'); // does not exist at all
  await withApp(fresh, async (page) => {
    const lang = await waitEval(page, 'document.documentElement.dataset.lang');
    check(`UI language follows the OS (${osLang})`, lang === osLang, `got ${lang}`);
    check('language written to settings.json', settingsOf(fresh).language === osLang, JSON.stringify(settingsOf(fresh).language));
    await shot(page, 'fresh.png');
  });

  console.log('\n[upgrade from a Chinese-only version]');
  const oldSettings = { engine: { memoryMB: 4096, resourceMode: 'smooth', prewarm: false }, runtime: { mirrorPrefix: 'https://mirror.example/' }, autoDeploy: false, createShortcutOnInstall: false };
  // createShortcutOnInstall: false keeps the app from (re)creating real Desktop / Start Menu
  // shortcuts for the fixture app at startup: a test must not write outside its own data dir.
  const apps = { apps: [{ package: 'com.example.demo', label: '示例应用', versionName: '1.0' }] };
  const up = dataDir('upgrade', { 'settings.json': oldSettings, 'apps.json': apps });
  // Compare content, not bytes: the app itself may re-serialise apps.json (formatting only).
  const readApps = () => JSON.stringify(JSON.parse(fs.readFileSync(path.join(up, 'apkstart', 'apps.json'), 'utf8')));
  const appsBefore = readApps();
  await withApp(up, async (page) => {
    const lang = await waitEval(page, 'document.documentElement.dataset.lang');
    check('UI stays Chinese', lang === 'zh', `got ${lang}`);
    const s = settingsOf(up);
    check('settings.json language = zh', s.language === 'zh', JSON.stringify(s.language));
    check('other settings untouched', s.engine.memoryMB === 4096 && s.engine.resourceMode === 'smooth' && s.runtime.mirrorPrefix === oldSettings.runtime.mirrorPrefix && s.autoDeploy === false);
    await shot(page, 'upgrade-zh.png');

    console.log('\n[switch language → vi]');
    const before = await page.evaluate('performance.timeOrigin');
    const r = await page.evaluate("window.apkstart.setLanguage('vi')");
    check('setLanguage IPC ok', r && r.ok === true, JSON.stringify(r));
    const reloaded = await waitEval(page, `performance.timeOrigin !== ${before} && document.documentElement.dataset.lang === 'vi' && document.readyState === 'complete'`);
    check('main window reloaded in Vietnamese', !!reloaded);
    const title = await waitEval(page, "document.getElementById('btnInstall') && document.getElementById('btnInstall').textContent.trim()");
    check('visible text translated', !!title && !/[一-鿿]/.test(title), title);
    const s2 = settingsOf(up);
    check('switch persisted, other settings untouched', s2.language === 'vi' && s2.engine.memoryMB === 4096 && s2.autoDeploy === false);
    check('installed-app list unchanged by the switch', readApps() === appsBefore, readApps());
    const bad = await page.evaluate("window.apkstart.setLanguage('xx')");
    check('unsupported language rejected (not silently mapped)', bad && bad.ok === false && settingsOf(up).language === 'vi', JSON.stringify(bad));
    await sleep(800);
    await shot(page, 'switched-vi.png');
  });

  console.log('\n[restart after switching]');
  await withApp(up, async (page) => {
    const lang = await waitEval(page, 'document.documentElement.dataset.lang');
    check('still Vietnamese after restart', lang === 'vi', `got ${lang}`);
    await shot(page, 'restart-vi.png');
  });
  check('installed-app list unchanged across all runs', readApps() === appsBefore, readApps());
}

main().catch((e) => { failed++; console.error(e); }).finally(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* files may still be locked */ }
  console.log(`\n结果：${passed} 通过，${failed} 失败  (screenshots: ${path.relative(ROOT, OUT)})`);
  process.exit(failed ? 1 : 0);
});
