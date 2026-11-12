'use strict';
// 桌面截图探针（不依赖 PowerShell）：electron test/cap.js out.png
const { app, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const out = path.resolve(process.argv[2] || 'test/cap.png');
  const d = screen.getPrimaryDisplay();
  const sf = d.scaleFactor || 1;
  const w = Math.round(d.size.width * sf);
  const h = Math.round(d.size.height * sf);
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: w, height: h },
    });
    if (!sources.length) throw new Error('no screen source');
    const png = sources[0].thumbnail.toPNG();
    fs.writeFileSync(out, png);
    console.log(`CAP ok ${w}x${h} ${png.length}B -> ${out}`);
  } catch (e) {
    console.log('CAP fail ' + (e && e.message));
  }
  app.quit();
});
