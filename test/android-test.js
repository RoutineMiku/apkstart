'use strict';
// 断言里比对的是中文原文：固定界面语言，不随本机系统语言变化
require('../src/i18n').setLang('zh');
/**
 * 安卓系统设置（src/core/android.js）的纯 Node 测试：用假的 adb client 记录命令、返回预设输出，
 * 不需要模拟器。运行：node test/android-test.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AndroidSettings, volumeCmd, parseVolume, volumePercent } = require('../src/core/android');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

/** 假运行时：shell() 按顺序返回 replies 里的输出，并记下收到的脚本 */
function fakeSettings(replies) {
  const scripts = [];
  const client = {
    async shell(script) {
      scripts.push(script);
      return replies.length ? replies.shift() : '';
    },
  };
  const runtime = { async ensure() { return { ok: true, client }; } };
  return { set: new AndroidSettings(runtime), scripts };
}

(async () => {
  console.log('\n[android.js 音量]');

  await test('parseVolume 能读出档位与范围', () => {
    const v = parseVolume('[V] will get volume\nvolume is 5 in range [0..15]\n');
    assert(v && v.index === 5 && v.min === 0 && v.max === 15, JSON.stringify(v));
    assert(parseVolume('media: inaccessible or not found') === null, '无法识别的输出应返回 null');
    assert(parseVolume('') === null && parseVolume(undefined) === null, '空输出应返回 null');
  });

  await test('volumePercent 按档位范围换算百分比', () => {
    assert(volumePercent({ index: 0, min: 0, max: 15 }) === 0);
    assert(volumePercent({ index: 15, min: 0, max: 15 }) === 100);
    assert(volumePercent({ index: 5, min: 0, max: 15 }) === 33);
    assert(volumePercent({ index: 3, min: 0, max: 0 }) === 0, '范围为 0 时不应除以 0');
    assert(volumePercent(null) === 0);
  });

  await test('音量命令优先用 cmd media_session，旧镜像退回 media', () => {
    const c = volumeCmd('--set 7');
    assert(c.indexOf('cmd media_session volume --stream 3 --set 7') >= 0, c);
    assert(c.indexOf('|| media volume --stream 3 --set 7') > c.indexOf('cmd media_session'), c);
    assert(!/^media volume/.test(c), '不应只用 Android 11 起已移除的 media 工具');
  });

  await test('setVolume 把百分比换算成档位再设置（Android 11+）', async () => {
    const { set, scripts } = fakeSettings(['volume is 4 in range [0..15]\n', '']);
    const r = await set.setVolume(60);
    assert(scripts.length === 2, `应先读范围再设置，实际 ${scripts.length} 条`);
    assert(scripts[0].includes('cmd media_session volume --stream 3 --get'), scripts[0]);
    assert(scripts[1].includes('cmd media_session volume --stream 3 --set 9'), scripts[1]);
    assert(!scripts[1].includes('--set 60'), '不应把百分比直接当档位');
    assert(r.ok && r.volume === 60, JSON.stringify(r));
  });

  await test('setVolume 在不同档位范围上换算（0..25）', async () => {
    const { set, scripts } = fakeSettings(['volume is 10 in range [0..25]\n', '']);
    const r = await set.setVolume(100);
    assert(scripts[1].includes('--set 25'), scripts[1]);
    assert(r.volume === 100, JSON.stringify(r));
  });

  await test('读不到范围时按常见的 0..15 换算并夹在 0~100', async () => {
    const { set, scripts } = fakeSettings(['', '']);
    const r = await set.setVolume(250);
    assert(scripts[1].includes('--set 15'), scripts[1]);
    assert(r.volume === 100, JSON.stringify(r));
  });

  await test('status() 把档位换算成百分比显示', async () => {
    const out = ['wifi=1', 'air=0', 'font=1.0', 'density=320', 'animw=1.0', 'sdk=34', 'vol=volume is 6 in range [0..15]'].join('\n');
    const { set, scripts } = fakeSettings([out]);
    const s = await set.status();
    assert(scripts[0].includes('cmd media_session volume --stream 3 --get'), '状态应通过 media_session 读音量');
    assert(s.volume === 40, `应为 40%，实际 ${s.volume}`);
    assert(s.sdk === 34 && s.wifi === true, JSON.stringify(s));
  });

  // 真实 sh 里验证命令的回退：PATH 里只有一个假的 `media`（模拟没有 cmd 的旧镜像），
  // 以及一个假的 `cmd`（模拟 Android 11+）。
  if (process.platform !== 'win32') {
    await test('在 sh 里：没有 cmd 时回退到 media，有 cmd 时不再调用 media', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-vol-'));
      const log = path.join(dir, 'calls.log');
      const write = (name, body) => {
        fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
        fs.chmodSync(path.join(dir, name), 0o755);
      };
      write('media', 'echo "volume is 3 in range [0..15]"');
      const run = () => execFileSync('/bin/sh', ['-c', `${volumeCmd('--get')} 2>/dev/null`], {
        env: { PATH: dir },
        encoding: 'utf8',
      });
      assert(parseVolume(run()).index === 3, '旧镜像应通过 media 读到音量');
      write('cmd', 'echo "volume is 8 in range [0..15]"');
      fs.writeFileSync(log, '');
      assert(parseVolume(run()).index === 8, '有 cmd 时应读 media_session 的结果');
      assert(!fs.readFileSync(log, 'utf8').includes('media volume'), '有 cmd 时不应再调用 media');
    });
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();
