'use strict';

const zlib = require('zlib');

/* ---------- CRC32（ZIP 需要） ---------- */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

/**
 * 打包成 ZIP（零依赖，Deflate 压缩，UTF-8 文件名）。
 * entries: [{ name: 'import.json', data: Buffer|string }, ...]
 * 说明：不支持 Zip64，单文件与总大小需 < 4GB；已足够题目导出使用。
 */
function buildZip(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of list) {
    const nameBuf = Buffer.from(String(e.name || 'file').replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data == null ? '' : String(e.data), 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);      // version needed
    lh.writeUInt16LE(0x0800, 6);  // 通用标志：文件名为 UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);      // 修改时间
    lh.writeUInt16LE(0x21, 12);   // 修改日期（1980-01-01）
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);      // version made by
    ch.writeUInt16LE(20, 6);      // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(list.length, 8);
  eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat(chunks.concat([centralBuf, eocd]));
}

/**
 * 极简 ZIP 解析器（零依赖，仅用内置 zlib）。
 * 支持 Stored(0) 与 Deflate(8) 两种压缩方式；不处理 Zip64 / 数据描述符 / 加密。
 * 返回 [{ name, data(Buffer) }, ...]。
 */
function parseZip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');

  const totalEntries = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // 兼容某些 zip：若 central directory 偏移指向 local header，尝试回退定位
  if (cdOffset >= buf.length || buf.readUInt32LE(cdOffset) !== 0x02014b50) {
    cdOffset = findSignature(buf, 0x02014b50, cdOffset);
    if (cdOffset < 0) throw new Error('ZIP 中央目录损坏');
  }

  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');

    let data = Buffer.alloc(0);
    try {
      const lnameLen = buf.readUInt16LE(localOffset + 26);
      const lextraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lnameLen + lextraLen;
      const compressed = buf.slice(dataStart, dataStart + compressedSize);
      if (method === 0) {
        data = compressed;
      } else if (method === 8) {
        data = zlib.inflateRawSync(compressed);
      } else {
        data = compressed; // 未知方式：尽力而为
      }
    } catch { /* 解析失败则返回空数据 */ }

    entries.push({ name, data });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function findEocd(buf) {
  // EOCD 最小 22 字节，从末尾向前扫描（允许末尾有少量注释/填充）
  const min = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function findSignature(buf, sig, from) {
  for (let i = from; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === sig) return i;
  }
  return -1;
}

/**
 * 从 ZIP 条目中提取测试数据。
 * 匹配文件名形如 `1.in`、`2.out`、`data/3.ans`、`test01.in` 等，
 * 按编号配对成 [{ index, input, output }, ...]（index 为原始编号，如 1/2/3）。
 * 若压缩包内含 checker.cpp（Special Judge），一并返回。
 */
function testcasesFromZip(buf) {
  const entries = parseZip(buf);
  const inMap = {};
  const outMap = {};
  let checker = null;
  for (const e of entries) {
    if (e.name.endsWith('/')) continue; // 目录
    const base = e.name.replace(/\\/g, '/').split('/').pop().toLowerCase();
    if (base === 'checker.cpp' || base === 'checker.cc') {
      checker = e.data.toString('utf8');
      continue;
    }
    // 文件名后缀只需含一段连续数字即可，如 1.in / 01.out / test3.ans / data/2.txt
    const m = base.match(/^(?:.*?)(\d+)\.(in|out|ans|txt)$/);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    const text = e.data.toString('utf8');
    if (m[2] === 'in' || m[2] === 'txt') inMap[idx] = text;
    else outMap[idx] = text; // out / ans
  }
  const indices = Array.from(new Set([...Object.keys(inMap), ...Object.keys(outMap)].map(Number))).sort((a, b) => a - b);
  return { cases: indices.map((i) => ({ index: i, input: inMap[i] ?? '', output: outMap[i] ?? '' })), checker };
}

module.exports = { parseZip, testcasesFromZip, buildZip, crc32 };
