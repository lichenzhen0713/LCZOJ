'use strict';

/**
 * GitHub 风格像素画头像（identicon）生成器 —— 零依赖
 *
 * 规则与 GitHub 的头像一致：
 *   · 5×5 的方块网格，**左右对称**（第 1、2 列由第 5、4 列镜像而来），因此图案看起来像一张「像素脸」；
 *   · 哪些格子着色、以及用什么颜色，都由种子的哈希决定（同一用户永远得到同一张图）；
 *   · 每格的形状是「一个小方块」本身由多个像素组成，所以放大后是像素画而不是色块。
 *
 * 输出为 PNG（自己编码：zlib 压缩 + CRC32，不需要任何图形库），
 * 尺寸默认 150×150（5 格 × 每格 30 像素），足够显示到 96px 而不糊。
 */

const zlib = require('zlib');
const crypto = require('crypto');

/* ------------------------------ PNG 编码 ------------------------------ */

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
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 把 RGB 像素数据编码成 PNG（每像素 3 字节，无 alpha，画面不透明） */
function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0;                                    // 每行的 filter 类型：0（None）
    rgb.copy(raw, rowStart + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;        // 位深
  ihdr[9] = 2;        // 颜色类型：truecolor RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------ 图案与配色 ------------------------------ */

/** HSL → RGB（h: 0~360，s/l: 0~1） */
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0; let g = 0; let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * 由种子算出 5×5 的图案（左右对称）与颜色。
 * 返回 { cells: boolean[5][5]（true = 着色）, color: [r,g,b], bg: [r,g,b] }
 */
function pattern(seed) {
  const key = String(seed == null ? '' : seed);
  const ph = crypto.createHash('sha256').update('lczoj-identicon:pattern:' + key).digest();
  const ch = crypto.createHash('sha256').update('lczoj-identicon:color:' + key).digest();

  // 每行 3 个独立格子（其余两列镜像），共 15 位；用哈希位决定是否着色
  const cells = [];
  let bit = 0;
  const nextBit = () => {
    const byte = ph[Math.floor(bit / 8)] || 0;
    const v = (byte >> (bit % 8)) & 1;
    bit++;
    return v === 1;
  };
  for (let y = 0; y < 5; y++) {
    const row = [false, false, false, false, false];
    row[0] = nextBit();
    row[1] = nextBit();
    row[2] = nextBit();
    row[3] = row[1];
    row[4] = row[0];
    cells.push(row);
  }
  // 避免出现几乎空白的图案（GitHub 上也极少见）：全空时补中间一列
  if (!cells.some((row) => row.some(Boolean))) {
    for (let y = 0; y < 5; y++) cells[y][2] = true;
  }

  const hue = ((ch[0] << 8 | ch[1]) % 360);
  const sat = 0.45 + (ch[2] / 255) * 0.25;        // 0.45 ~ 0.70
  const light = 0.42 + (ch[3] / 255) * 0.16;      // 0.42 ~ 0.58
  const color = hslToRgb(hue, sat, light);
  const bg = [240, 240, 240];                     // GitHub 风格的浅灰底
  return { cells, color, bg };
}

/**
 * 生成头像 PNG。
 * @param {string|number} seed 种子（通常用用户名；同名用户永远得到同一张图）
 * @param {number} size 输出边长（像素），会被 5 整除取整；默认 150
 * @returns {Buffer} PNG 数据
 */
function render(seed, size = 150) {
  const px = Math.max(5, Math.floor(size / 5) * 5);
  const cell = px / 5;
  const { cells, color, bg } = pattern(seed);
  const rgb = Buffer.alloc(px * px * 3);

  /** 画一个矩形（含边界） */
  const fillRect = (x0, y0, w, h, rgbColor) => {
    for (let y = y0; y < y0 + h && y < px; y++) {
      for (let x = x0; x < x0 + w && x < px; x++) {
        const i = (y * px + x) * 3;
        rgb[i] = rgbColor[0]; rgb[i + 1] = rgbColor[1]; rgb[i + 2] = rgbColor[2];
      }
    }
  };

  fillRect(0, 0, px, px, bg);
  for (let gy = 0; gy < 5; gy++) {
    for (let gx = 0; gx < 5; gx++) {
      if (!cells[gy][gx]) continue;
      fillRect(Math.round(gx * cell), Math.round(gy * cell), Math.ceil(cell), Math.ceil(cell), color);
    }
  }
  return encodePng(px, px, rgb);
}

module.exports = { render, pattern, encodePng, crc32 };
