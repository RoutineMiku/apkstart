'use strict';
/* 兼容模式端到端验证：走产品代码路径 boot（API 34 Play 镜像）→ abilist → 装 ARM APK → 启动 */
process.env.ANDROID_ADB_SERVER_PORT = process.env.ANDROID_ADB_SERVER_PORT || '5038';
const fs = require('fs');
const path = require('path');
const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');

const ROOT = path.join(__dirname, '..');
const APK = process.argv[2] || 'D:\\红果免费短剧.apk';

(async () => {
  store.saveSettings({ runtime: { compatImage: true } });
  const rt = new Runtime(ROOT);

  console.log('[1] ensure()（兼容模式 → 应启动 Google Play / API 34 镜像）');
  const r = await rt.ensure({
    onLog: (m) => console.log('    [boot]', m),
  });
  if (!r.ok) { console.error('    ensure 失败:', r.error || JSON.stringify(r).slice(0, 300)); process.exit(1); }
  console.log('    engine =', r.engine, r.reused ? '(复用已有实例)' : '');

  const c = rt.client();
  console.log('[2] release =', await c.shell('getprop ro.build.version.release'));
  console.log('    sdk     =', await c.shell('getprop ro.build.version.sdk'));
  console.log('    abilist =', await c.shell('getprop ro.product.cpu.abilist'));
  console.log('    tag     =', await c.shell('getprop ro.build.tags'));

  if (APK && fs.existsSync(APK)) {
    console.log('[3] 安装 ARM APK（红果短剧）…');
    const ins = await c.install(APK);
    console.log('    install =', JSON.stringify(ins).slice(0, 160));
    await c.shell('am start -n com.phoenix.read/com.dragon.read.pages.splash.SplashActivity');
    await new Promise((res) => setTimeout(res, 20000));
    const ps = await c.shell('ps -A | grep phoenix');
    console.log('[4] 启动 20s 后进程:', ps ? '存活 ✓' : '已消失 ✗');
  } else {
    console.log('[3] 跳过 APK 安装（未找到', APK, '）');
  }

  console.log('[5] 恢复普通模式设置');
  store.saveSettings({ runtime: { compatImage: false } });
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
