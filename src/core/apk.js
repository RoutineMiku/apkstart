'use strict';
/**
 * APK 元信息提取：包名 / 版本 / 应用名 / 启动 Activity / 图标 / ABI
 * 全部离线完成，不需要 aapt、不需要 adb、不需要联网。
 */
const fs = require('fs');
const path = require('path');
const { ZipArchive } = require('./zip');
const { parseAxml, attr, attrValue, children, ANDROID_NS } = require('./axml');
const { ResTable } = require('./arsc');

const LAUNCHER_ACTIONS = ['android.intent.action.MAIN'];
const LAUNCHER_CATS = ['android.intent.category.LAUNCHER'];

function isLauncherActivity(node) {
  const filters = children(node, 'intent-filter');
  for (const f of filters) {
    const actions = children(f, 'action').map((a) => attrValue(a, 'name'));
    const cats = children(f, 'category').map((c) => attrValue(c, 'name'));
    const hasMain = actions.some((a) => LAUNCHER_ACTIONS.includes(a));
    const hasLauncher = cats.some((c) => LAUNCHER_CATS.includes(c));
    if (hasMain && hasLauncher) return true;
  }
  return false;
}

function pickIconFromZip(zip) {
  // 兜底：在 res/ 里找最大的、名字像图标的 png
  const candidates = zip.names().filter((n) => /^res\/.*\.(png|webp)$/i.test(n));
  const scored = candidates.map((n) => {
    const e = zip.entries.get(n);
    let s = e.uncompSize;
    if (/ic_launcher|app_icon|ic_app/i.test(n)) s *= 6;
    if (/_round|_foreground|_background/i.test(n)) s *= 0.4;
    if (/xxxhdpi/i.test(n)) s *= 1.6;
    else if (/xxhdpi/i.test(n)) s *= 1.4;
    else if (/xhdpi/i.test(n)) s *= 1.2;
    if (/\//.test(n.split('/')[1] || '')) { /* noop */ }
    return { n, s };
  }).sort((a, b) => b.s - a.s);
  for (const c of scored.slice(0, 30)) {
    try {
      const data = zip.read(c.n);
      if (data && data.length > 100) return { data, file: c.n };
    } catch (_) { /* ignore */ }
  }
  return null;
}

/** 从自适应图标 XML 里找出可用的前景/背景位图 */
function iconFromAdaptiveXml(zip, xmlBuffer, res) {
  let root;
  try {
    root = parseAxml(xmlBuffer);
  } catch (_) {
    return null;
  }
  const order = ['foreground', 'background', 'monochrome'];
  for (const key of order) {
    const node = root.children.find((c) => c.name === key) || (root.name === key ? root : null);
    if (!node) continue;
    const a = attr(node, 'drawable');
    if (!a) continue;
    let file = null;
    if (a.refId && res) file = res.resolve(a.refId, 'file');
    else if (typeof a.typed === 'string') file = a.typed;
    if (!file || !/\.(png|webp)$/i.test(file)) continue;
    if (!zip.has(file)) continue;
    const data = zip.read(file);
    if (data && data.length > 100) return { data, file };
  }
  return null;
}

function parseApk(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size < 1024) throw new Error('文件过小，不是有效的 APK');
  const buf = fs.readFileSync(filePath);
  const zip = new ZipArchive(buf);

  if (!zip.has('AndroidManifest.xml')) {
    throw new Error('缺少 AndroidManifest.xml：这不是单个 APK（可能是 .apks/.xapk 拆分包）');
  }

  const manifestBuf = zip.read('AndroidManifest.xml');
  const manifest = parseAxml(manifestBuf);

  const packageName = attrValue(manifest, 'package', null) || attrValue(manifest, 'package');
  if (!packageName) throw new Error('清单中未找到 package 名');

  const versionName = attrValue(manifest, 'versionName') || '1.0';
  const versionCodeRaw = attrValue(manifest, 'versionCode');
  const versionCode = typeof versionCodeRaw === 'number' ? versionCodeRaw : 0;

  const usesSdk = children(manifest, 'uses-sdk')[0];
  const minSdk = usesSdk ? (attrValue(usesSdk, 'minSdkVersion') | 0) : 0;
  const targetSdk = usesSdk ? (attrValue(usesSdk, 'targetSdkVersion') | 0) : 0;

  const app = children(manifest, 'application')[0] || { children: [], attrs: [] };

  // ---- 资源表（用于解析 @0x7f 引用）----
  let res = null;
  if (zip.has('resources.arsc')) {
    try { res = new ResTable(zip.read('resources.arsc')); } catch (_) { res = null; }
  }

  // ---- 应用名 ----
  let label = null;
  const labelAttr = attr(app, 'label');
  if (labelAttr) {
    if (labelAttr.refId && res) label = res.resolve(labelAttr.refId, 'string');
    else if (typeof labelAttr.typed === 'string') label = labelAttr.typed;
  }
  if (!label || typeof label !== 'string') {
    label = packageName.split('.').pop();
    label = label.charAt(0).toUpperCase() + label.slice(1);
  }

  // ---- 启动 Activity ----
  let launchActivity = null;
  const acts = children(app, 'activity').concat(children(app, 'activity-alias'));
  const launcher = acts.find(isLauncherActivity);
  if (launcher) {
    const n = attrValue(launcher, 'name');
    const target = attrValue(launcher, 'targetActivity');
    if (n) {
      if (n.startsWith('.')) launchActivity = packageName + n;
      else if (!n.includes('.')) launchActivity = `${packageName}.${n}`;
      else launchActivity = n;
      if (launcher.name === 'activity-alias' && target) {
        launchActivity = target.startsWith('.') ? packageName + target : target;
      }
    }
  }

  // ---- 图标 ----
  let icon = null;
  const iconAttr = attr(app, 'icon') || attr(app, 'roundIcon');
  if (iconAttr) {
    let file = null;
    if (iconAttr.refId && res) file = res.resolve(iconAttr.refId, 'file');
    else if (typeof iconAttr.typed === 'string') file = iconAttr.typed;

    if (file && zip.has(file)) {
      if (/\.xml$/i.test(file)) {
        icon = iconFromAdaptiveXml(zip, zip.read(file), res);
      } else {
        icon = { data: zip.read(file), file };
      }
    }
  }
  if (!icon) icon = pickIconFromZip(zip);

  // ---- ABI（判断 x86 运行时能否直接跑 ARM 原生库）----
  const abis = [...new Set(zip.names()
    .filter((n) => n.startsWith('lib/'))
    .map((n) => n.split('/')[1])
    .filter(Boolean))];

  return {
    ok: true,
    filePath,
    sizeBytes: stat.size,
    package: packageName,
    label: String(label).replace(/\s+/g, ' ').trim().slice(0, 60),
    versionName: String(versionName),
    versionCode,
    minSdk,
    targetSdk,
    launchActivity,
    abis,
    iconPng: icon ? icon.data : null,
    iconFile: icon ? icon.file : null,
  };
}

/** 轻量校验：只看头部是不是 PK\x03\x04 */
function quickCheck(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    fs.closeSync(fd);
    return b[0] === 0x50 && b[1] === 0x4b;
  } catch (_) {
    return false;
  }
}

module.exports = { parseApk, quickCheck };
