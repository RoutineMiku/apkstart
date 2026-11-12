'use strict';
// 裁剪 PNG：electron test/crop.js <in> <out> <x> <y> <w> <h> [scale]
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const [inp, out, x, y, w, h, scale] = process.argv.slice(2);
  const img = nativeImage.createFromPath(path.resolve(inp));
  const sz = img.getSize();
  const r = {
    x: Number(x) || 0,
    y: Number(y) || 0,
    width: Number(w) || sz.width,
    height: Number(h) || sz.height,
  };
  let c = img.crop(r);
  const k = Number(scale) || 0;
  if (k > 0) {
    const s = c.getSize();
    c = c.resize({ width: Math.round(s.width * k), height: Math.round(s.height * k), quality: 'good' });
  }
  fs.writeFileSync(path.resolve(out), c.toPNG());
  console.log(`CROP ${r.x},${r.y} ${r.width}x${r.height} -> ${c.getSize().width}x${c.getSize().height}`);
  app.quit();
});
