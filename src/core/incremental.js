'use strict';
/**
 * 增量更新（代码层）的纯逻辑：清单解析、模式选择、本地/落盘文件校验。
 *
 * 背景：便携包 ~99MB，其中绝大部分是 Electron 外壳（ApkStart.exe 180MB 未压缩、
 * dll、locales），这些只有升级 Electron 才会变；真正每次发版都变的是
 * `resources/app/**`（我们的 JS / 资源 / node_modules）。以前每次升级都要把
 * 整个 99MB 外壳重新下一遍。现在每次发版额外发布两个 tiny 资产：
 *   - `ApkStart-vX-manifest.json`：列出 app 层每个文件的 sha256 / size，以及
 *     这次发版依赖的 Electron 版本；
 *   - `ApkStart-vX-app.zip`：整个 app 层（通常几 MB）。
 * 客户端只要本机 Electron 版本一致，就只下这两个小文件，逐文件校验后覆盖
 * `resources/app`；任何一步不满足就退回完整包，绝不让用户更新到坏状态。
 *
 * 本文件不 require electron，CI 里可以直接 require 做单测。
 */
const path = require('path');
const { sha256File } = require('./download');

const APP_DIR = 'resources/app';
const MANIFEST_RE = /-manifest\.json$/i;
const APP_PACK_RE = /-app\.zip$/i;

/** 统一成正斜杠、去掉 ./ 前缀，清单与 zip 条目都按这个形式比对 */
function norm(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

/** 清单格式校验。宁可判为「不可用」退回完整包，也不要拿一份残缺清单去覆盖文件。 */
function parseManifest(text) {
  let m;
  try { m = JSON.parse(text); } catch (_) { throw new Error('增量清单不是合法 JSON'); }
  if (!m || m.schema !== 1) throw new Error('增量清单版本不支持');
  if (!m.version || !m.electronVersion) throw new Error('增量清单缺少版本信息');
  if (!m.app || !m.app.asset || !m.app.sha256 || !m.app.files
      || typeof m.app.files !== 'object' || !Object.keys(m.app.files).length) {
    throw new Error('增量清单缺少代码包信息');
  }
  return m;
}

/** 这些资产是「辅助资产」，不能当成完整安装包去解压覆盖程序目录 */
function isAuxAsset(name) {
  const s = String(name || '');
  return /runtime/i.test(s) || APP_PACK_RE.test(s) || MANIFEST_RE.test(s);
}

/**
 * 决定这次更新走增量还是完整包。
 * 只看不依赖网络的条件：安装形态、Electron 版本、清单声明的代码包在不在资产里。
 */
function chooseMode({ flavor, electronVersion, manifest, assets = [], current = '' }) {
  if (flavor !== 'portable') return { mode: 'full', reason: '安装版走完整安装包' };
  if (!manifest) return { mode: 'full', reason: '没有增量清单' };
  if (!electronVersion || String(manifest.electronVersion) !== String(electronVersion)) {
    return { mode: 'full', reason: 'Electron 版本不同，需要完整包' };
  }
  const appAsset = assets.find((a) => a && a.name === manifest.app.asset);
  if (!appAsset) return { mode: 'full', reason: '增量代码包未发布' };
  return { mode: 'app', appAsset, reason: '代码层增量更新' };
}

/**
 * 比对本地 app 层与清单：列出缺失 / 哈希不符的文件。
 * @param {string} installDir 便携版根目录（其下有 resources/app）
 * @param {object} files 清单里的 app.files（相对安装根目录的路径 → {sha256,size}）
 * @param {function} hash 注入的哈希函数，便于单测
 */
async function inspectLocal({ installDir, files, hash = sha256File }) {
  const changed = [];
  const missing = [];
  for (const [rel, meta] of Object.entries(files || {})) {
    const full = path.join(installDir, ...norm(rel).split('/'));
    let got = null;
    try { got = await hash(full); } catch (_) { /* 文件不存在或读不了 */ }
    if (got === null) missing.push(norm(rel));
    else if (String(got).toLowerCase() !== String(meta && meta.sha256 || '').toLowerCase()) changed.push(norm(rel));
  }
  return { changed, missing, ok: changed.length === 0 && missing.length === 0 };
}

/**
 * 校验解压后的增量载荷：清单里每个文件都必须存在且 sha256 一致。
 * 这是防止「下载被截断 / 镜像返回了错文件」的最后一道关。
 */
async function verifyExtracted({ payload, files, hash = sha256File }) {
  const bad = [];
  for (const [rel, meta] of Object.entries(files || {})) {
    const full = path.join(payload, ...norm(rel).split('/'));
    let got = null;
    try { got = await hash(full); } catch (_) { /* 缺文件 */ }
    if (got === null || String(got).toLowerCase() !== String(meta && meta.sha256 || '').toLowerCase()) {
      bad.push(norm(rel));
    }
  }
  return bad;
}

module.exports = {
  APP_DIR, MANIFEST_RE, APP_PACK_RE, norm, parseManifest, isAuxAsset,
  chooseMode, inspectLocal, verifyExtracted, sha256File,
};
