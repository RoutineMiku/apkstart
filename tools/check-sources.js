'use strict';
/**
 * 双源自检：一条命令看清「两个源各自的最新版本」和「每个下载地址的实测速度」。
 *
 *   node tools/check-sources.js            # 检查更新包
 *   node tools/check-sources.js runtime    # 检查运行时整包
 *
 * 会真下 256KB，所以会消耗一点流量；目的是在动手改代码之前先确认
 * 「现在这台机器到底该走哪个源」。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-sources-'));
process.env.APPDATA = TMP;

const { Sources } = require('../src/core/sources');
const store = require('../src/core/store');
const { Provisioner } = require('../src/core/provision');

const mb = (n) => (n / 1048576).toFixed(2);
const host = (u) => { try { return new URL(u).host; } catch (_) { return u.slice(0, 40); } };

(async () => {
  const which = (process.argv[2] || 'update').toLowerCase();
  const sources = new Sources(() => store.getSettings());

  console.log('=== 1) 两个源的发布信息 ===');
  const rels = await sources.fetchReleases();
  for (const r of rels) {
    if (r.rel) {
      const assets = (r.rel.assets || []).length;
      console.log(`  ${r.name.padEnd(7)} ${String(r.rel.tag_name || r.rel.name || '').padEnd(10)} 资产 ${assets} 个`);
    } else {
      console.log(`  ${r.name.padEnd(7)} 不可达：${r.error}`);
    }
  }

  console.log('\n=== 2) 合并结果 ===');
  const merged = await sources.latest();
  console.log(`  最高版本 ${merged.tag}（${merged.assets.length} 个资产）`);
  for (const a of merged.assets) {
    console.log(`    · ${a.name}  ${(a.size / 1048576).toFixed(0)}MB  [${a.source}]`);
  }

  console.log('\n=== 3) 实测每个下载地址的速度 ===');
  let target = null;
  if (which === 'runtime') {
    const p = new Provisioner(path.resolve(__dirname, '..'));
    const pack = await p.resolveRuntimePack().catch((e) => { console.log('  解析失败：', e.message); return null; });
    if (pack) {
      console.log(`  运行时整包 ${pack.name}（${pack.tag} · ${pack.from || '?'}）`);
      target = pack.url;
    }
  } else {
    const pick = merged.assets.find((a) => /portable.*\.zip$/i.test(a.name)) || merged.assets[0];
    if (pick) {
      console.log(`  更新包 ${pick.name}`);
      target = pick.url;
    }
  }
  if (!target) {
    console.log('  没有可测的资产');
  } else {
    const cands = sources.candidates(target);
    for (const c of cands) console.log(`  ${host(c).padEnd(22)} ${c === target ? '(直连)' : '(镜像)'}`);
    const t0 = Date.now();
    const ranked = await sources.rank(cands, { onProgress: (p) => console.log('  ·', p.message) });
    console.log(`  测速耗时 ${Date.now() - t0}ms，最终顺序：`);
    ranked.forEach((u, i) => {
      const c = sources._rankCache.get(u) || {};
      console.log(`    ${i + 1}. ${host(u).padEnd(22)} ${c.ok ? `${mb(c.speed)} MB/s` : '不可用'}`);
    });
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
})().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
