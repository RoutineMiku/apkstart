'use strict';
/**
 * Electron 集成测试：验证 ICO 生成、快捷方式创建、真实图标落盘
 * 运行：electron test/electron-integration.js
 * 输出：test/out/result.json
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const result = { steps: [] };
  const step = (name, ok, detail = '') => {
    result.steps.push({ name, ok, detail });
    console.log(`${ok ? '✓' : '✗'} ${name} ${detail}`);
  };

  try {
    const { drawAppIcon } = require('../src/core/png');
    const { pngToIco, writeShortcut, removeShortcut, iconToIco } = require('../src/core/shortcut');
    const { parseApk } = require('../src/core/apk');

    // 1. 程序图标 → PNG → ICO
    const png = drawAppIcon(256);
    fs.writeFileSync(path.join(OUT, 'icon.png'), png);
    const ico = pngToIco(png);
    fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
    step('生成 ICO', !!ico && ico.length > 1000, `${ico ? ico.length : 0} bytes`);

    // 1b. WebP 图标降级路径：nativeImage 解不了 WebP，必须能落到 decode 回调，
    // 没有解码器时用品牌占位图并**如实回报**（安装时会把它变成一条软警告）。
    {
      // 1x1 的最小 WebP
      const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
      let noDecoder = '';
      const placeholderIco = await iconToIco(webp, { onFallback: (why) => { noDecoder = why; } });
      step('WebP 无解码器 → 合法 ICO 且回报占位降级',
        !!placeholderIco && placeholderIco.length > 100 && /placeholder|webp-decode-failed/.test(noDecoder),
        noDecoder || '(no callback)');

      let decoded = 0;
      const viaDecode = await iconToIco(webp, {
        decode: async () => { decoded++; return png; },
        onFallback: (why) => { throw new Error(`不该降级：${why}`); },
      });
      // nativeImage 若某天能直接解 WebP，decoded 会是 0，同样算通过；关键是产出合法 ICO
      step('WebP 图标最终产出 ICO', !!viaDecode && viaDecode.readUInt16LE(2) === 1,
        `decode 调用 ${decoded} 次，${viaDecode ? viaDecode.length : 0} bytes`);
    }

    // 2. 快捷方式
    const lnk = path.join(OUT, 'test.lnk');
    writeShortcut({
      shortcutPath: lnk,
      target: process.execPath,
      args: '--version',
      iconIcoPath: path.join(OUT, 'icon.ico'),
      description: 'ApkStart 集成测试',
    });
    step('创建 .lnk', fs.existsSync(lnk));
    removeShortcut(lnk);
    step('删除 .lnk', !fs.existsSync(lnk));

    // 3. 真实 APK 图标 → ICO
    const fixture = process.env.APKSTART_TEST_APK
      || (() => {
        try {
          const dl = path.join(process.env.USERPROFILE || '', 'Documents');
          return fs.readdirSync(dl).map((f) => path.join(dl, f)).find((f) => /\.apk$/i.test(f));
        } catch (_) { return null; }
      })();
    if (fixture) {
      const meta = parseApk(fixture);
      const iconIco = pngToIco(meta.iconPng);
      if (iconIco) {
        fs.writeFileSync(path.join(OUT, 'app.ico'), iconIco);
        step('APK 图标 → 多尺寸 ICO', true, `${meta.label}: ${iconIco.length} bytes`);
      } else {
        step('APK 图标 → 多尺寸 ICO', false, 'pngToIco 返回空（图标可能是 webp/jpg 之外的格式）');
      }
    }

    result.ok = result.steps.every((s) => s.ok);
  } catch (e) {
    result.error = e.message;
    result.ok = false;
    console.error(e);
  }

  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  app.exit(result.ok ? 0 : 1);
});
