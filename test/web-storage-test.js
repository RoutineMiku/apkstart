'use strict';
/**
 * 网页存储/安装残留两块的安全测试（纯 Node，不依赖 Electron / adb / 网络）。
 *
 * 1) provision.js 的 AVD 路径矩阵：显式 avdDir 永远优先；空值走默认；
 *    路径归属用路径语义判断（DATA_DIR-old 兄弟目录、跨盘、大小写）。
 * 2) leftovers.js 的旧版快照清理：只删 <avdHome>/apkstart.avd/snapshots 的直接子项里
 *    名字命中旧版策略的真实目录；apkstart、无关目录、越界路径、链接/联接一律不删。
 *    受控目录链（avdHome / apkstart.avd / snapshots / 叶子）逐级核验；avdHome 本身是
 *    链接时按策略 A 跳过清理。删除前实测普通文件逻辑字节，不采信 item.size。
 *
 * 全部断言都跑在自建 fixture 上：路径矩阵用 mock fs（不落盘），
 * 快照用 os.tmpdir() 下的临时目录；绝不碰真实 %APPDATA%\apkstart 或真实 AVD。
 * 运行：node test/web-storage-test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
const win = path.win32;

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, message: e.message });
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

// ---------------------------------------------------------------- provision.js

const DATA_DIR = 'C:\\Users\\fixture\\AppData\\Roaming\\apkstart';
const PROVISION_SOURCE = fs.readFileSync(path.join(REPO, 'src', 'core', 'provision.js'), 'utf8');

/** 在 vm 里加载 provision.js，用 mock store + mock fs 拿 paths()，不产生任何真实 IO */
function provisionWith(settings) {
  const fakeFs = {
    mkdirSync() {},
    writeFileSync() {},
    rmSync() {},
    statSync() { throw new Error('ENOENT'); },
    existsSync() { return false; },
  };
  const deps = {
    fs: fakeFs,
    path: win,
    zlib: require('zlib'),
    child_process: {},
    './store': { DATA_DIR, getSettings: () => settings },
    './doctor': {},
    './download': {},
    './zip': {},
    './sources': { Sources: class {} },
    './version': { cmpVer: () => 0 },
  };
  const module = { exports: {} };
  vm.runInNewContext(PROVISION_SOURCE, {
    module,
    exports: module.exports,
    require: (n) => {
      if (n in deps) return deps[n];
      throw new Error('unaccounted dependency: ' + n);
    },
    process: { platform: 'win32', pid: 1, env: { SystemRoot: 'C:\\Windows' } },
    Buffer,
    console,
    setTimeout,
    clearTimeout,
    URL,
  }, { filename: 'provision.js' });
  return new module.exports.Provisioner('D:\\Program');
}

function avdHomeFor(dir, avdDir) {
  return provisionWith({ runtime: { dir, avdDir } }).paths().avdHome;
}

console.log('\n[provision.paths().avdHome]');

test('explicit avdDir wins with the default runtime under DATA_DIR', () => {
  const got = avdHomeFor('', 'D:\\ApkStartData');
  assert.strictEqual(got, 'D:\\ApkStartData');
});

test('explicit avdDir wins with an external runtime', () => {
  const got = avdHomeFor('D:\\Runtime', 'D:\\ApkStartData');
  assert.strictEqual(got, 'D:\\ApkStartData');
});

test('explicit avdDir wins even when runtime sits outside DATA_DIR', () => {
  const got = avdHomeFor('E:\\Elsewhere\\runtime', 'E:\\AvdStore');
  assert.strictEqual(got, 'E:\\AvdStore');
});

test('empty avdDir with default runtime keeps <runtime>/avd', () => {
  const got = avdHomeFor('', '');
  assert.strictEqual(got, win.join(DATA_DIR, 'runtime', 'avd'));
});

test('runtime exactly DATA_DIR counts as inside DATA_DIR', () => {
  const got = avdHomeFor(DATA_DIR, '');
  assert.strictEqual(got, win.join(DATA_DIR, 'avd'));
});

test('sibling prefix (DATA_DIR-old) is not a descendant', () => {
  const got = avdHomeFor(DATA_DIR + '-old\\runtime', '');
  assert.strictEqual(got, win.join(DATA_DIR, 'avd'));
  assert.notStrictEqual(got, win.join(DATA_DIR + '-old', 'runtime', 'avd'));
});

test('drive boundary: external drive runtime falls back to DATA_DIR/avd', () => {
  const got = avdHomeFor('D:\\Runtime', '');
  assert.strictEqual(got, win.join(DATA_DIR, 'avd'));
});

test('case boundary: same directory with different case still counts as inside', () => {
  const casedRoot = DATA_DIR.toUpperCase() + '\\RUN TIME';
  const got = avdHomeFor(casedRoot, '');
  // 没判成「在数据目录内」时会把 AVD 丢到 DATA_DIR/avd；这里必须留在 runtime 子树里，
  // 且大小写差异不能改变归属。
  assert.strictEqual(got.toLowerCase(), win.join(casedRoot, 'avd').toLowerCase(), `got ${got}`);
  assert.notStrictEqual(got.toLowerCase(), win.join(DATA_DIR, 'avd').toLowerCase());
});

test('whitespace-only avdDir behaves like empty', () => {
  assert.strictEqual(avdHomeFor('', '   '), win.join(DATA_DIR, 'runtime', 'avd'));
  assert.strictEqual(avdHomeFor('D:\\Runtime', ' \t '), win.join(DATA_DIR, 'avd'));
});

test('explicit avdDir is trimmed before use', () => {
  assert.strictEqual(avdHomeFor('D:\\Runtime', '  D:\\ApkStartData  '), 'D:\\ApkStartData');
});

// ---------------------------------------------------------------- leftovers.js

const leftovers = require('../src/core/leftovers.js');
const LEFTOVERS_SOURCE = fs.readFileSync(path.join(REPO, 'src', 'core', 'leftovers.js'), 'utf8');

/** 用给定 fs 桩加载真实 leftovers.js（用于「关键 API 失败必须拒绝」的断言，不碰真实磁盘） */
function leftoversWithFs(fakeFs) {
  const deps = {
    fs: fakeFs,
    path,
    os: { homedir: () => path.join(tmpRoot, 'home'), tmpdir: () => path.join(tmpRoot, 'temp') },
    child_process: { execFileSync: () => '' },
  };
  const module = { exports: {} };
  vm.runInNewContext(LEFTOVERS_SOURCE, {
    module,
    exports: module.exports,
    require: (n) => {
      if (n in deps) return deps[n];
      throw new Error('unaccounted dependency: ' + n);
    },
    process: { platform: 'win32', env: {} },
    Buffer,
    console,
  }, { filename: 'leftovers.js' });
  return module.exports;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-web-storage-test-'));
const avdHome = path.join(tmpRoot, 'avd');
const snapRoot = path.join(avdHome, 'apkstart.avd', 'snapshots');
const installDir = path.join(tmpRoot, 'install');
const dataDir = path.join(tmpRoot, 'nodata');

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

function writeFixture(p, text) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, text || 'x');
}

function mkSnapshots() {
  writeFixture(path.join(snapRoot, 'default_boot', 'ram.img'), 'legacy snapshot payload');
  writeFixture(path.join(snapRoot, 'default_boot.stale-7', 'ram.img'), 'stale snapshot payload');
  writeFixture(path.join(snapRoot, 'apkstart', 'ram.img'), 'current snapshot, must stay');
  writeFixture(path.join(snapRoot, 'unrelated_notes', 'notes.txt'), 'unrelated dir, must stay');
}

/** 独立的小 AVD 树：<tmpRoot>/case-<name>/avd/apkstart.avd/snapshots */
function fixtureTree(name) {
  const base = path.join(tmpRoot, 'case-' + name);
  const home = path.join(base, 'avd');
  const snap = path.join(home, 'apkstart.avd', 'snapshots');
  mkdirp(snap);
  return { base, home, snap, opts: { installDir, avdHome: home } };
}

function snapshotItems() {
  const scan = leftovers.scan({ installDir, dataDir, avdHome });
  return { scan, items: scan.items.filter((x) => x.kind === 'snapshot') };
}

function byName(items) {
  return items.map((x) => path.basename(x.path)).sort();
}

let tmpReady = true;
try {
  mkSnapshots();
  mkdirp(installDir);
  mkdirp(dataDir);
} catch (e) {
  tmpReady = false;
  console.error('fixture setup failed: ' + e.message);
}

console.log('\n[leftovers.scanSnapshots]');

test('snapshot entries carry their own kind and follow the legacy policy', () => {
  assert.ok(tmpReady, 'fixture missing');
  const { items, scan } = snapshotItems();
  assert.deepStrictEqual(byName(items), ['default_boot', 'default_boot.stale-7']);
  for (const it of items) {
    assert.strictEqual(it.kind, 'snapshot', `kind should be snapshot, got ${it.kind}`);
    assert.strictEqual(path.dirname(it.path), snapRoot, 'snapshot must be a direct child of the snapshot root');
  }
  // 当前快照和无关目录都不该作为可清理项上报
  const scanned = scan.items.map((x) => path.basename(x.path));
  assert.ok(!scanned.includes('apkstart'), 'current snapshot must not be offered for cleaning');
  assert.ok(!scanned.includes('unrelated_notes'), 'unrelated directory must not be offered for cleaning');
});

test('missing avdHome yields no snapshot items', () => {
  assert.deepStrictEqual(leftovers.scan({ installDir, dataDir, avdHome: '' }).items.filter((x) => x.kind === 'snapshot'), []);
});

console.log('\n[leftovers.clean snapshot positive path]');

test('a scanned legacy snapshot is actually deleted and its neighbours are preserved', () => {
  assert.ok(tmpReady, 'fixture missing');
  const { items } = snapshotItems();
  const r = leftovers.clean(items, { installDir, avdHome });
  const removedNames = r.removed.map((p) => path.basename(p)).sort();
  assert.deepStrictEqual(removedNames, ['default_boot', 'default_boot.stale-7'], JSON.stringify(r));
  assert.strictEqual(fs.existsSync(path.join(snapRoot, 'default_boot')), false);
  assert.strictEqual(fs.existsSync(path.join(snapRoot, 'default_boot.stale-7')), false);
  assert.ok(fs.existsSync(path.join(snapRoot, 'apkstart', 'ram.img')), 'current snapshot must survive');
  assert.ok(fs.existsSync(path.join(snapRoot, 'unrelated_notes', 'notes.txt')), 'unrelated dir must survive');
  assert.ok(r.freedBytes > 0, 'freedBytes should account for the removed snapshot payloads');
});

console.log('\n[leftovers.clean preservation controls]');

function refuseCase(name, itemPath, opts, stillExists) {
  test(name, () => {
    assert.ok(tmpReady, 'fixture missing');
    const r = leftovers.clean([{ kind: 'snapshot', path: itemPath, size: 1 }], Object.assign({ installDir }, opts));
    assert.deepStrictEqual(r.removed, [], 'nothing may be removed: ' + JSON.stringify(r));
    assert.strictEqual(r.failed.length, 1, 'the item must be reported as refused: ' + JSON.stringify(r));
    assert.ok(fs.existsSync(stillExists), 'the target must still exist: ' + stillExists);
  });
}

// 恢复一份 default_boot，供后面的拒绝用例使用
mkdirp(path.join(snapRoot, 'default_boot'));
writeFixture(path.join(snapRoot, 'default_boot', 'ram.img'), 'restored');

const otherAvd = path.join(tmpRoot, 'other-avd');
const otherLegacy = path.join(otherAvd, 'apkstart.avd', 'snapshots', 'default_boot');
writeFixture(path.join(otherLegacy, 'ram.img'), 'not ours');

refuseCase('crafted out-of-root path under another AVD root is refused',
  otherLegacy, { avdHome }, otherLegacy);

// <avdHome>/default_boot：从 snapshots 根往上跳两层才能到，必须拒绝
writeFixture(path.join(avdHome, 'default_boot', 'ram.img'), 'outside the snapshot root');

refuseCase('parent traversal out of the snapshot root is refused',
  path.join(snapRoot, '..', '..', 'default_boot'), { avdHome },
  path.join(avdHome, 'default_boot'));

refuseCase('the current apkstart snapshot is refused', path.join(snapRoot, 'apkstart'), { avdHome },
  path.join(snapRoot, 'apkstart'));

refuseCase('an unrelated directory name is refused', path.join(snapRoot, 'unrelated_notes'), { avdHome },
  path.join(snapRoot, 'unrelated_notes'));

refuseCase('a snapshot item without avdHome is refused', path.join(snapRoot, 'default_boot'), {},
  path.join(snapRoot, 'default_boot'));

test('generic dir deletion still requires ApkStart.exe (unchanged)', () => {
  assert.ok(tmpReady, 'fixture missing');
  const plain = path.join(tmpRoot, 'plain-dir');
  writeFixture(path.join(plain, 'keep.txt'), 'keep');
  const r = leftovers.clean([{ kind: 'dir', path: plain, size: 1 }], { installDir, avdHome });
  assert.deepStrictEqual(r.removed, []);
  assert.ok(fs.existsSync(path.join(plain, 'keep.txt')), 'plain dir must survive');
});

test('a symlink/junction inside snapshots is refused and its target survives', () => {
  assert.ok(tmpReady, 'fixture missing');
  const target = path.join(tmpRoot, 'valuable');
  writeFixture(path.join(target, 'keep.txt'), 'do not delete me');
  const linkPath = path.join(snapRoot, 'default_boot');
  // 先把同名普通目录换成链接：扫描/清理都只能看到链接本身
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(target, linkPath, 'junction');
  try {
    const { items } = snapshotItems();
    assert.ok(!items.some((x) => x.path === linkPath), 'scan must not offer a link as a cleanable snapshot');
    const r = leftovers.clean([{ kind: 'snapshot', path: linkPath, size: 1 }], { installDir, avdHome });
    assert.deepStrictEqual(r.removed, [], 'a link must never be removed: ' + JSON.stringify(r));
    assert.strictEqual(r.failed.length, 1);
    assert.ok(fs.existsSync(path.join(target, 'keep.txt')), 'the link target and its contents must survive');
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), 'the link itself must survive too');
  } finally {
    try { fs.rmSync(linkPath, { recursive: false, force: true }); } catch (_) { /* 清不掉也留着，teardown 再试 */ }
  }
});

console.log('\n[leftovers.clean preserved chains and measured bytes]');

test('ancestor snapshots junction is refused and its external fixture survives', () => {
  assert.ok(tmpReady, 'fixture missing');
  const c = fixtureTree('snapshot-root-junction');
  const outside = path.join(c.base, 'outside');
  writeFixture(path.join(outside, 'default_boot', 'keep.txt'), '123456789');
  fs.rmSync(c.snap, { recursive: true, force: true });
  fs.symlinkSync(outside, c.snap, 'junction');
  try {
    const target = path.join(c.snap, 'default_boot');
    const r = leftovers.clean([{ kind: 'snapshot', path: target, size: 1 }], c.opts);
    assert.deepStrictEqual(r.removed, [], 'nothing may be removed: ' + JSON.stringify(r));
    assert.strictEqual(r.failed.length, 1);
    assert.ok(fs.existsSync(path.join(outside, 'default_boot', 'keep.txt')), 'external canary must survive');
    assert.ok(fs.lstatSync(c.snap).isSymbolicLink(), 'the junction itself must survive');
    const scanned = leftovers.scan({ installDir, dataDir, avdHome: c.home }).items
      .filter((x) => x.kind === 'snapshot');
    assert.deepStrictEqual(scanned, [], 'a redirected snapshot root must not be offered for cleaning');
  } finally {
    fs.rmSync(c.snap, { recursive: false, force: true });
  }
});

test('ancestor apkstart.avd junction is refused and its external fixture survives', () => {
  assert.ok(tmpReady, 'fixture missing');
  const c = fixtureTree('avd-dir-junction');
  const outside = path.join(c.base, 'outside');
  writeFixture(path.join(outside, 'snapshots', 'default_boot', 'keep.txt'), '123456789');
  const avdDir = path.join(c.home, 'apkstart.avd');
  fs.rmSync(avdDir, { recursive: true, force: true });
  fs.symlinkSync(outside, avdDir, 'junction');
  try {
    const target = path.join(avdDir, 'snapshots', 'default_boot');
    const r = leftovers.clean([{ kind: 'snapshot', path: target, size: 1 }], c.opts);
    assert.deepStrictEqual(r.removed, [], 'nothing may be removed: ' + JSON.stringify(r));
    assert.strictEqual(r.failed.length, 1);
    assert.ok(fs.existsSync(path.join(outside, 'snapshots', 'default_boot', 'keep.txt')), 'external canary must survive');
    assert.ok(fs.lstatSync(avdDir).isSymbolicLink(), 'the junction itself must survive');
  } finally {
    fs.rmSync(avdDir, { recursive: false, force: true });
  }
});

test('avdHome itself being a junction follows policy A: skip cleanup and keep data', () => {
  assert.ok(tmpReady, 'fixture missing');
  const base = path.join(tmpRoot, 'case-avd-home-junction');
  const real = path.join(base, 'real-avd');
  const canary = path.join(real, 'apkstart.avd', 'snapshots', 'default_boot', 'keep.txt');
  writeFixture(canary, '123456789');
  const linkedHome = path.join(base, 'avd');
  fs.symlinkSync(real, linkedHome, 'junction');
  try {
    const target = path.join(linkedHome, 'apkstart.avd', 'snapshots', 'default_boot');
    const r = leftovers.clean([{ kind: 'snapshot', path: target, size: 1 }],
      { installDir, avdHome: linkedHome });
    assert.deepStrictEqual(r.removed, [], 'nothing may be removed: ' + JSON.stringify(r));
    assert.strictEqual(r.failed.length, 1);
    assert.match(r.failed[0].reason, /链接/, 'the reason must name the link policy: ' + r.failed[0].reason);
    assert.ok(fs.existsSync(canary), 'the link target and its contents must survive');
    assert.ok(fs.lstatSync(linkedHome).isSymbolicLink(), 'the root link itself must survive');
    const scanned = leftovers.scan({ installDir, dataDir, avdHome: linkedHome }).items
      .filter((x) => x.kind === 'snapshot');
    assert.deepStrictEqual(scanned, [], 'policy A must not offer snapshots under a linked root');
  } finally {
    fs.rmSync(linkedHome, { recursive: false, force: true });
  }
});

test('an ordinary file with a legacy snapshot name is preserved', () => {
  assert.ok(tmpReady, 'fixture missing');
  const c = fixtureTree('ordinary-file');
  const file = path.join(c.snap, 'default_boot');
  fs.writeFileSync(file, '123456789');
  const r = leftovers.clean([{ kind: 'snapshot', path: file, size: 1 }], c.opts);
  assert.deepStrictEqual(r.removed, [], 'a file must never be removed: ' + JSON.stringify(r));
  assert.strictEqual(r.failed.length, 1);
  assert.ok(fs.existsSync(file), 'the ordinary file must survive');
});

test('a snapshot replaced by a file after scan is refused at clean time', () => {
  assert.ok(tmpReady, 'fixture missing');
  const c = fixtureTree('scan-then-file');
  const target = path.join(c.snap, 'default_boot');
  writeFixture(path.join(target, 'ram.img'), 'old payload');
  const scanned = leftovers.scan({ installDir, dataDir, avdHome: c.home }).items
    .filter((x) => x.kind === 'snapshot');
  assert.strictEqual(scanned.length, 1);
  fs.rmSync(target, { recursive: true, force: true });
  fs.writeFileSync(target, 'now a plain file');
  const r = leftovers.clean(scanned, c.opts);
  assert.deepStrictEqual(r.removed, [], 'a stale item must not be deleted: ' + JSON.stringify(r));
  assert.strictEqual(r.failed.length, 1);
  assert.ok(fs.existsSync(target), 'the replacement file must survive');
});

test('a snapshot replaced by a junction after scan is refused at clean time', () => {
  assert.ok(tmpReady, 'fixture missing');
  const c = fixtureTree('scan-then-link');
  const target = path.join(c.snap, 'default_boot');
  writeFixture(path.join(target, 'ram.img'), 'old payload');
  const scanned = leftovers.scan({ installDir, dataDir, avdHome: c.home }).items
    .filter((x) => x.kind === 'snapshot');
  assert.strictEqual(scanned.length, 1);
  const outside = path.join(c.base, 'outside');
  writeFixture(path.join(outside, 'keep.txt'), 'do not delete me');
  fs.rmSync(target, { recursive: true, force: true });
  fs.symlinkSync(outside, target, 'junction');
  try {
    const r = leftovers.clean(scanned, c.opts);
    assert.deepStrictEqual(r.removed, [], 'a stale link must not be deleted: ' + JSON.stringify(r));
    assert.strictEqual(r.failed.length, 1);
    assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), 'the junction target must survive');
    assert.ok(fs.lstatSync(target).isSymbolicLink(), 'the junction itself must survive');
  } finally {
    fs.rmSync(target, { recursive: false, force: true });
  }
});

test('freedBytes is measured from the filesystem, never copied from item.size', () => {
  assert.ok(tmpReady, 'fixture missing');
  const c = fixtureTree('forged-size');
  const target = path.join(c.snap, 'default_boot');
  mkdirp(target);
  fs.writeFileSync(path.join(target, 'fixture.bin'), Buffer.alloc(9, 0x61));
  const r = leftovers.clean([{ kind: 'snapshot', path: target, size: 999999999 }], c.opts);
  assert.deepStrictEqual(r.removed, [target]);
  assert.strictEqual(r.freedBytes, 9, 'logical bytes of the fixture must be measured: ' + JSON.stringify(r));
});

test('an empty legacy directory is removed successfully with zero bytes', () => {
  assert.ok(tmpReady, 'fixture missing');
  const c = fixtureTree('empty-dir');
  const target = path.join(c.snap, 'default_boot.stale-3');
  mkdirp(target);
  const r = leftovers.clean([{ kind: 'snapshot', path: target, size: 999 }], c.opts);
  assert.deepStrictEqual(r.removed, [target]);
  assert.strictEqual(r.freedBytes, 0);
  assert.strictEqual(fs.existsSync(target), false);
});

test('a snapshot that vanished after scan is skipped without a false success', () => {
  assert.ok(tmpReady, 'fixture missing');
  const c = fixtureTree('vanished');
  const target = path.join(c.snap, 'default_boot');
  mkdirp(target);
  const scanned = leftovers.scan({ installDir, dataDir, avdHome: c.home }).items
    .filter((x) => x.kind === 'snapshot');
  assert.strictEqual(scanned.length, 1);
  fs.rmSync(target, { recursive: true, force: true });
  const r = leftovers.clean(scanned, c.opts);
  assert.deepStrictEqual(r.removed, []);
  assert.strictEqual(r.failed.length, 1);
  assert.strictEqual(r.freedBytes, 0);
});

test('a link nested inside a legacy snapshot is not followed; the target survives', () => {
  assert.ok(tmpReady, 'fixture missing');
  const c = fixtureTree('nested-link');
  const target = path.join(c.snap, 'default_boot');
  mkdirp(target);
  const outside = path.join(c.base, 'outside');
  writeFixture(path.join(outside, 'keep.txt'), 'do not delete me');
  fs.symlinkSync(outside, path.join(target, 'nested'), 'junction');
  const r = leftovers.clean([{ kind: 'snapshot', path: target, size: 1 }], c.opts);
  assert.deepStrictEqual(r.removed, [], 'a nested link must not be traversed or deleted: ' + JSON.stringify(r));
  assert.strictEqual(r.failed.length, 1);
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), 'the nested link target must survive');
});

test('missing lstatSync refuses instead of treating the target as "not a link"', () => {
  const removes = [];
  const r = leftoversWithFs({
    rmSync(p) { removes.push(p); },
    existsSync() { return true; },
  }).clean([{ kind: 'snapshot', path: 'C:\\Avd\\apkstart.avd\\snapshots\\default_boot', size: 1 }],
    { installDir: 'C:\\Program', avdHome: 'C:\\Avd' });
  assert.strictEqual(r.removed.length, 0);
  assert.strictEqual(r.failed.length, 1);
  assert.deepStrictEqual(removes, [], 'no removal may be attempted without lstat');
});

test('a realpath failure refuses instead of falling back to the lexical path', () => {
  const removes = [];
  const dirStat = () => ({ isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false });
  const r = leftoversWithFs({
    lstatSync: dirStat,
    readdirSync: () => [],
    realpathSync() { throw Object.assign(new Error('EIO'), { code: 'EIO' }); },
    rmSync(p) { removes.push(p); },
    existsSync() { return true; },
  }).clean([{ kind: 'snapshot', path: 'C:\\Avd\\apkstart.avd\\snapshots\\default_boot', size: 1 }],
    { installDir: 'C:\\Program', avdHome: 'C:\\Avd' });
  assert.strictEqual(r.removed.length, 0);
  assert.strictEqual(r.failed.length, 1);
  assert.deepStrictEqual(removes, [], 'no removal may be attempted when realpath fails');
});

test('a leaf whose realpath escapes the snapshot root is refused', () => {
  const removes = [];
  const dirStat = () => ({ isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false });
  const r = leftoversWithFs({
    lstatSync: dirStat,
    readdirSync: () => [],
    realpathSync(p) {
      return p === 'C:\\Avd\\apkstart.avd\\snapshots\\default_boot'
        ? 'C:\\Elsewhere\\default_boot'
        : p;
    },
    rmSync(p) { removes.push(p); },
    existsSync() { return true; },
  }).clean([{ kind: 'snapshot', path: 'C:\\Avd\\apkstart.avd\\snapshots\\default_boot', size: 1 }],
    { installDir: 'C:\\Program', avdHome: 'C:\\Avd' });
  assert.strictEqual(r.removed.length, 0);
  assert.strictEqual(r.failed.length, 1);
  assert.deepStrictEqual(removes, [], 'a realpath outside the root must never be deleted');
});

// ---------------------------------------------------------------- teardown

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* 临时目录清理失败不影响结论 */ }

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error(`  - ${f.name}: ${f.message}`);
  process.exitCode = 1;
}
