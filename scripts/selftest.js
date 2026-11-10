'use strict';
/**
 * 运行时自检（不需要打开界面）
 *
 *   npm run selftest                 # 只体检现有运行时
 *   npm run selftest -- --apk a.apk  # 额外走一遍 安装 → 启动 → 截图 → 共享目录
 *
 * 用途：装好 Android 之后，用一条命令确认「双击装应用、独立窗口、数据互通」这条链路
 * 在当前机器上真的成立，出问题时也能定位到具体环节。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');
const { Sharer } = require('../src/core/sharer');
const { parseApk } = require('../src/core/apk');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const APK = argOf('--apk');
const SERIAL = argOf('--serial') || store.getSettings().device || '127.0.0.1:5555';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok === null ? '○' : ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? `  —  ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  process.stdout.write('');
  try {
    const detail = await fn();
    record(name, true, detail || '');
    return true;
  } catch (e) {
    record(name, e && e.skipped ? null : false, e.message);
    return false;
  }
}

(async () => {
  console.log('\nApkStart 运行时自检');
  console.log(`设备：${SERIAL}`);
  console.log('─'.repeat(64));

  console.log('\n[组件]');
  const runtime = new Runtime(path.join(__dirname, '..'));
  const prov = runtime.provisioner;

  let env = null;
  await step('adb 可用', async () => {
    env = await prov.checkEnv();
    if (!env.adb.ok) throw new Error('未安装 adb，请先运行「一键部署」');
    return `v${env.adb.version}`;
  });
  await step('QEMU 可用', async () => {
    if (!env || !env.qemu.ok) throw new Error('未安装 QEMU');
    return `v${env.qemu.version}`;
  });
  await step('系统镜像完整', async () => {
    if (!env.iso.ok) throw new Error(env.iso.reason || '镜像缺失');
    return `${(env.iso.size / 1073741824).toFixed(2)}GB${env.iso.iso9660 ? ' · ISO9660' : ''}`;
  });
  record('硬件加速', env.hypervisor.whpx ? true : null,
    env.hypervisor.whpx ? 'WHPX 已启用' : '纯软件模拟（能跑，但明显慢）');

  console.log('\n[设备]');
  const client = runtime.client(SERIAL);
  const online = await step('adb 已连接', async () => {
    await client.connect().catch(() => false);
    if (!await client.isOnline()) throw new Error('设备不在线：先启动运行时');
    return SERIAL;
  });

  if (!online) {
    console.log('\n设备未就绪，后续项目跳过。');
  } else {
    await step('Android 版本', async () => {
      const [ver, sdk, abi] = await Promise.all([
        client.androidVersion(), client.sdkInt(), client.shell('getprop ro.product.cpu.abi').catch(() => ''),
      ]);
      if (!ver) throw new Error('读不到系统版本');
      return `Android ${ver} (API ${sdk}) · ${String(abi).trim()}`;
    });
    await step('屏幕分辨率', async () => {
      const s = await client.wmSize();
      if (!s) throw new Error('wm size 无返回');
      return `${s.width}×${s.height}`;
    });
    await step('freeform 独立窗口', async () => {
      const ok = await client.ensureFreeform();
      if (!ok) throw new Error('无法开启 freeform（系统可能不支持多窗口）');
      return '已开启';
    });

    console.log('\n[共享目录]');
    await step('双向同步', async () => {
      const sharer = new Sharer(runtime);
      await client.shellMkdir(store.getSettings().deviceSharedDir);
      const localDir = store.getSettings().sharedDir;
      fs.mkdirSync(localDir, { recursive: true });
      const probe = path.join(localDir, `selftest-${Date.now()}.txt`);
      const payload = `apkstart selftest ${new Date().toISOString()}`;
      fs.writeFileSync(probe, payload);

      const up = await sharer.sync();
      if (up.errors && up.errors.length) throw new Error(up.errors[0]);
      const remote = `${store.getSettings().deviceSharedDir}/${path.basename(probe)}`;
      const back = await client.shell(`cat "${remote}" 2>/dev/null`);
      if (!String(back).includes('apkstart selftest')) throw new Error('本机 → 设备 未同步');

      const reverse = path.join(localDir, `selftest-from-device-${Date.now()}.txt`);
      await client.shell(`echo device-side > "${store.getSettings().deviceSharedDir}/${path.basename(reverse)}"`);
      await sharer.sync();
      if (!fs.existsSync(reverse) || !fs.readFileSync(reverse, 'utf8').includes('device-side')) {
        throw new Error('设备 → 本机 未同步');
      }
      fs.rmSync(probe, { force: true });
      fs.rmSync(reverse, { force: true });
      await client.shell(`rm -f "${remote}"`);
      return '上行 + 下行均正常';
    });

    if (APK) {
      console.log('\n[应用链路]');
      let meta = null;
      await step('解析 APK', async () => {
        meta = parseApk(APK);
        return `${meta.label} (${meta.package} v${meta.versionName})`;
      });
      if (meta) {
        await step('安装到设备', async () => {
          await client.install(APK);
          const installed = await client.isInstalled(meta.package);
          if (!installed) throw new Error('pm path 未找到包');
          return 'pm path 校验通过';
        });
        await step('独立窗口启动', async () => {
          await client.startApp(meta.package, meta.launchActivity, { freeform: true });
          await sleep(4000);
          const top = await client.shell('dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity"');
          if (!String(top).includes(meta.package)) throw new Error('应用未在前台');
          return meta.package;
        });
        await step('截图', async () => {
          const png = await client.screenshot();
          const out = path.join(__dirname, '..', 'test', 'out');
          fs.mkdirSync(out, { recursive: true });
          const file = path.join(out, 'selftest.png');
          fs.writeFileSync(file, png);
          if (png.length < 4096) throw new Error('截图内容异常');
          return file;
        });
      }
    } else {
      console.log('\n[应用链路] 未指定 --apk，跳过');
    }
  }

  const failed = results.filter((r) => r.ok === false);
  console.log('\n' + '─'.repeat(64));
  console.log(`结果：${results.filter((r) => r.ok === true).length} 通过，${failed.length} 失败，`
    + `${results.filter((r) => r.ok === null).length} 跳过`);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log(`  · ${f.name}：${f.detail}`));
    process.exit(1);
  }
  console.log('全部检查通过 ✅\n');
})().catch((e) => {
  console.error('\n自检异常终止：', e.message);
  process.exit(1);
});
