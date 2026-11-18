'use strict';
/**
 * i18n tests (pure Node, no Electron / adb / network).
 *
 *  - language selection: saved setting wins, upgrading users keep Chinese, new users follow the OS
 *  - persistence across restarts and upgrades, each scenario in its own temporary APPDATA
 *  - fallback chain for missing translations (vi → en → Chinese source)
 *  - interpolation: {placeholders}, HTML escaping in tHtml()
 *  - dictionaries: en ⇔ vi key parity, placeholders / HTML tags consistent, no key used in code is missing
 *  - stable codes: install errors keep their INSTALL_FAILED_* code and tag in every language
 *
 * Run: node test/i18n-test.js (part of npm test)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const i18n = require('../src/i18n');
const checker = require('../tools/check-i18n');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-i18n-test-'));
let tmpSeq = 0;
/** A fresh, isolated APPDATA directory (optionally pre-seeded with apkstart files). */
function freshAppData(files = {}) {
  const dir = path.join(TMP_ROOT, `appdata-${++tmpSeq}`);
  const data = path.join(dir, 'apkstart');
  fs.mkdirSync(data, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(data, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

/**
 * Simulate one app start in a separate process with its own APPDATA and OS locale:
 * the same resolve-and-persist step main.js runs in app.whenReady().
 */
function startApp(appData, { locales = [], switchTo = null } = {}) {
  const script = `
    const i18n = require(${JSON.stringify(path.join(ROOT, 'src', 'i18n'))});
    const store = require(${JSON.stringify(path.join(ROOT, 'src', 'core', 'store'))});
    const saved = store.getSettings().language;
    const r = i18n.resolveInitialLanguage({ saved, existingUser: store.existingUser, systemLocales: ${JSON.stringify(locales)} });
    i18n.setLang(r.lang);
    if (r.source !== 'saved') store.saveSettings({ language: r.lang });
    ${switchTo ? `store.saveSettings({ language: ${JSON.stringify(switchTo)} }); i18n.setLang(${JSON.stringify(switchTo)});` : ''}
    process.stdout.write(JSON.stringify({ lang: i18n.getLang(), source: r.source, settings: store.getSettings() }));
  `;
  const env = { ...process.env, APPDATA: appData, LANG: '', LC_ALL: '', LC_MESSAGES: '' };
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' }));
}

const settingsOf = (appData) => JSON.parse(fs.readFileSync(path.join(appData, 'apkstart', 'settings.json'), 'utf8'));

console.log('\n[i18n] language selection');

test('resolveInitialLanguage: a saved language always wins', () => {
  for (const l of ['en', 'vi', 'zh']) {
    const r = i18n.resolveInitialLanguage({ saved: l, existingUser: true, systemLocales: ['fr-FR'] });
    eq(r.lang, l); eq(r.source, 'saved');
  }
});

test('resolveInitialLanguage: upgrading user without a saved language keeps Chinese', () => {
  const r = i18n.resolveInitialLanguage({ saved: '', existingUser: true, systemLocales: ['en-US'] });
  eq(r.lang, 'zh'); eq(r.source, 'upgrade');
});

test('resolveInitialLanguage: new user follows the first supported OS language', () => {
  eq(i18n.resolveInitialLanguage({ systemLocales: ['vi-VN', 'en-US'] }).lang, 'vi');
  eq(i18n.resolveInitialLanguage({ systemLocales: ['zh-Hans-CN'] }).lang, 'zh');
  eq(i18n.resolveInitialLanguage({ systemLocales: ['zh-TW'] }).lang, 'zh');
  eq(i18n.resolveInitialLanguage({ systemLocales: ['fr-FR', 'en-GB'] }).lang, 'en');
  eq(i18n.resolveInitialLanguage({ systemLocales: ['fr-FR', 'de-DE'] }).lang, 'en', 'unsupported OS language → English');
  eq(i18n.resolveInitialLanguage({}).lang, 'en');
});

test('resolveInitialLanguage: an invalid saved value is ignored, not trusted', () => {
  eq(i18n.resolveInitialLanguage({ saved: 'xx', existingUser: false, systemLocales: ['vi'] }).lang, 'vi');
  eq(i18n.resolveInitialLanguage({ saved: 'vi-VN', existingUser: true }).lang, 'zh', 'only exact codes count as a choice');
});

console.log('\n[i18n] persistence (isolated APPDATA per scenario)');

test('fresh install: OS language picked and persisted; restart keeps it even if the OS language changes', () => {
  const dir = freshAppData();
  const first = startApp(dir, { locales: ['vi-VN'] });
  eq(first.lang, 'vi'); eq(first.source, 'system');
  eq(settingsOf(dir).language, 'vi');
  const again = startApp(dir, { locales: ['en-US'] });
  eq(again.lang, 'vi', 'restart must not re-detect'); eq(again.source, 'saved');
});

test('upgrade from a Chinese-only version: language stays Chinese, every other setting untouched', () => {
  const old = {
    engine: { memoryMB: 4096, resourceMode: 'smooth', keymaps: { 'com.game': [{ key: 'w', action: 'tap', x: 0.1, y: 0.7 }] } },
    runtime: { dir: 'D:\\ApkStartRuntime', mirrorPrefix: 'https://mirror.example/' },
    autoStart: true,
  };
  const apps = { apps: [{ package: 'com.example', label: '示例', versionName: '1.0' }] };
  const dir = freshAppData({ 'settings.json': old, 'apps.json': apps });
  const r = startApp(dir, { locales: ['en-US'] });
  eq(r.lang, 'zh'); eq(r.source, 'upgrade');
  const s = settingsOf(dir);
  eq(s.language, 'zh');
  eq(s.engine.memoryMB, 4096); eq(s.engine.resourceMode, 'smooth');
  eq(JSON.stringify(s.engine.keymaps), JSON.stringify(old.engine.keymaps));
  eq(s.runtime.dir, old.runtime.dir); eq(s.runtime.mirrorPrefix, old.runtime.mirrorPrefix);
  eq(s.autoStart, true);
  eq(fs.readFileSync(path.join(dir, 'apkstart', 'apps.json'), 'utf8'), JSON.stringify(apps, null, 2), 'apps.json must not be rewritten');
});

test('upgrade where only apps.json exists (settings never saved) still counts as an existing user', () => {
  const dir = freshAppData({ 'apps.json': { apps: [] } });
  eq(startApp(dir, { locales: ['en-US'] }).lang, 'zh');
});

test('settings.json with a BOM is still read (no silent reset to defaults)', () => {
  const dir = freshAppData({ 'settings.json': `\ufeff${JSON.stringify({ language: 'vi', engine: { memoryMB: 3072 } })}` });
  const r = startApp(dir);
  eq(r.lang, 'vi'); eq(r.settings.engine.memoryMB, 3072);
});

test('switching language persists across restart and keeps other settings', () => {
  const dir = freshAppData({ 'settings.json': { language: 'zh', engine: { memoryMB: 2048 } } });
  eq(startApp(dir, { switchTo: 'en' }).lang, 'en');
  const r = startApp(dir, { locales: ['vi-VN'] });
  eq(r.lang, 'en'); eq(r.settings.engine.memoryMB, 2048);
});

console.log('\n[i18n] lookup, fallback, interpolation');

test('Chinese returns the source text; English / Vietnamese translate', () => {
  const key = '安装完成';
  assert(i18n.DICTS.en[key] && i18n.DICTS.vi[key], 'fixture key must exist in both dictionaries');
  i18n.setLang('zh'); eq(i18n.t(key), key);
  i18n.setLang('en'); eq(i18n.t(key), i18n.DICTS.en[key]);
  i18n.setLang('vi'); eq(i18n.t(key), i18n.DICTS.vi[key]);
});

test('fallback chain: vi missing → en; both missing → Chinese source; empty string counts as missing', () => {
  const k1 = '__测试_仅英文__';
  const k2 = '__测试_都没有__';
  i18n.DICTS.en[k1] = 'English only';
  i18n.DICTS.vi[k2] = '';
  try {
    i18n.setLang('vi');
    eq(i18n.t(k1), 'English only');
    eq(i18n.t(k2), k2);
    i18n.setLang('en');
    eq(i18n.t(k2), k2);
  } finally {
    delete i18n.DICTS.en[k1];
    delete i18n.DICTS.vi[k2];
  }
});

test('placeholders: substituted, unknown ones left intact, values never re-interpreted', () => {
  i18n.setLang('zh');
  eq(i18n.t('{n} 分钟前', { n: 5 }), '5 分钟前');
  eq(i18n.format('a {x} b {y}', { x: '{y}' }), 'a {y} b {y}', 'a value that looks like a placeholder is not expanded again');
  eq(i18n.format('a {x}', {}), 'a {x}');
});

test('tHtml escapes interpolated values but keeps the dictionary markup', () => {
  const key = '发现新版本 <b>{tag}</b>，可在「设置 → 软件更新」一键更新';
  for (const l of ['zh', 'en', 'vi']) {
    i18n.setLang(l);
    const out = i18n.tHtml(key, { tag: '<img src=x onerror=alert(1)>"&\'' });
    assert(out.includes('<b>') && out.includes('</b>'), `[${l}] markup from the dictionary kept`);
    assert(!out.includes('<img'), `[${l}] value must be escaped: ${out}`);
    assert(out.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;&#39;'), `[${l}] escaped form present`);
  }
});

console.log('\n[i18n] dictionaries');

test('en ⇔ vi: same keys, same placeholders, same HTML tags, no empty values', () => {
  const problems = checker.checkDicts({ en: i18n.DICTS.en, vi: i18n.DICTS.vi });
  assert(!problems.length, `${problems.length} problem(s):\n      ${problems.slice(0, 10).join('\n      ')}`);
});

test('every t() / tHtml() key and static HTML text in src/ has a translation', () => {
  const keys = new Map();
  const strays = [];
  for (const f of checker.walk(checker.SRC)) {
    if (f.includes(`${path.sep}i18n${path.sep}`)) continue;
    if (f.endsWith('.js')) checker.jsKeys(f, keys, strays);
    else if (f.endsWith('.html')) checker.htmlKeys(f, keys);
  }
  assert(keys.size > 500, `expected the full key set, got ${keys.size}`);
  for (const l of ['en', 'vi']) {
    const miss = [...keys.entries()].filter(([k]) => !(k in i18n.DICTS[l]));
    assert(!miss.length, `[${l}] ${miss.length} missing, e.g. ${miss.slice(0, 3).map(([k, w]) => `${w} ${k.slice(0, 40)}`).join(' | ')}`);
  }
});

test('English translations contain no Chinese (apart from a few deliberate names)', () => {
  const CJK = /[　-〿一-鿿＀-￯]/;
  const allowed = /日常MIKU|日本語|语言/;
  const bad = Object.entries(i18n.DICTS.en).filter(([, v]) => CJK.test(v.replace(new RegExp(allowed.source, 'g'), '')));
  assert(!bad.length, `untranslated: ${bad.slice(0, 5).map(([k]) => k.slice(0, 30)).join(' | ')}`);
});

console.log('\n[i18n] stable codes, not translated text');

test('install errors: message localised, INSTALL_FAILED_* tag kept verbatim in every language', () => {
  const { friendlyInstallError } = require('../src/core/adb');
  const raw = 'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE: not enough space]';
  const seen = new Set();
  for (const l of ['zh', 'en', 'vi']) {
    i18n.setLang(l);
    const msg = friendlyInstallError(raw);
    assert(msg.includes('INSTALL_FAILED_INSUFFICIENT_STORAGE'), `[${l}] code tag missing: ${msg}`);
    seen.add(msg);
  }
  eq(seen.size, 3, 'each language produces its own text');
});

test('emulator log lines (input to doctor.diagnose) do not depend on the UI language', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'emulator.js'), 'utf8');
  assert(/describeExitCode\(code, \{ raw: true \}\)/.test(src), 'exit-code meaning written to the log must be the raw (untranslated) text');
  const doctor = require('../src/core/doctor');
  for (const l of ['zh', 'en', 'vi']) {
    i18n.setLang(l);
    eq(doctor.diagnose(['disk check: not enough space for AVD (C:\\x): free 100MB < 2500MB']).code, 'DISK_FULL', `[${l}]`);
  }
});

i18n.setLang('zh');
try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) { /* ignore */ }
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
