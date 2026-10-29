'use strict';
/**
 * 零依赖 PNG 编码器 + 程序图标绘制
 * 这样不必往仓库里塞二进制素材，也便于换主题色时动态重绘。
 */
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA 像素（Uint8Array，长度 w*h*4）→ PNG Buffer */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------- 极简绘制（4x 超采样抗锯齿） ----------------

function roundRectAlpha(x, y, w, h, r, px, py) {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r ? 1 : 0;
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * 绘制 ApkStart 图标：深色圆角方块 + 安卓绿启动三角
 * @param {number} size 输出边长
 */
function drawAppIcon(size = 256) {
  const SS = 4;
  const S = size * SS;
  const acc = new Float32Array(size * size * 4); // 累积

  const pad = S * 0.06;
  const box = { x: pad, y: pad, w: S - pad * 2, h: S - pad * 2, r: S * 0.24 };

  // 三角（播放键）
  const tW = S * 0.30;
  const tH = S * 0.34;
  const tcx = S * 0.5 + S * 0.02;
  const tcy = S * 0.5;
  const ax = tcx - tW * 0.38, ay = tcy - tH / 2;
  const bx = tcx - tW * 0.38, by = tcy + tH / 2;
  const cx2 = tcx + tW * 0.62, cy2 = tcy;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const inBox = roundRectAlpha(box.x, box.y, box.w, box.h, box.r, px, py);
      if (!inBox) continue;

      // 背景渐变（对角）
      const t = (x / S) * 0.6 + (y / S) * 0.4;
      let r = Math.round(20 + t * 14);
      let g = Math.round(26 + t * 18);
      let b = Math.round(33 + t * 24);

      if (pointInTriangle(px, py, ax, ay, bx, by, cx2, cy2)) {
        r = 61; g = 220; b = 132; // #3ddc84
      }

      const oy = Math.floor(y / SS);
      const ox = Math.floor(x / SS);
      const idx = (oy * size + ox) * 4;
      acc[idx] += r; acc[idx + 1] += g; acc[idx + 2] += b; acc[idx + 3] += 255;
    }
  }

  const out = new Uint8Array(size * size * 4);
  const n = SS * SS;
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = Math.round(acc[i * 4] / n);
    out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / n);
    out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / n);
    out[i * 4 + 3] = Math.round(acc[i * 4 + 3] / n);
  }
  return encodePng(size, size, out);
}

module.exports = { encodePng, drawAppIcon };
