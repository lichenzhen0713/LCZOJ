'use strict';

const zlib = require('zlib');
const { decodeText } = require('./util');

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

/* ---------- 解压上限（防 ZIP 炸弹：小体积高压缩比包会把整站打爆） ---------- */
/** 单个条目解压后的字节上限（默认 64MB） */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** 一次性解析的所有条目解压后字节总量上限（默认 256MB） */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** 条目数上限（默认 20 万：整库导出为 200 题 × 200 测试点 × 2 文件量级，留足余量） */
const MAX_ENTRIES = 200000;

/** 压缩包超限错误：带 code，便于上层识别并转成友好提示（而不是 500 / OOM） */
function tooLargeError(message) {
  const err = new Error('压缩包过大：' + message);
  err.code = 'ZIP_TOO_LARGE';
  return err;
}

/** 上限参数归一化（测试可直接传小上限） */
function resolveLimits(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const pick = (v, def) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : def);
  return {
    maxEntryBytes: pick(o.maxEntryBytes, MAX_ENTRY_BYTES),
    maxTotalBytes: pick(o.maxTotalBytes, MAX_TOTAL_BYTES),
    maxEntries: pick(o.maxEntries, MAX_ENTRIES),
  };
}

/** 人类可读的体积（错误提示用） */
function humanSize(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + 'GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + 'KB';
  return n + 'B';
}

/**
 * 极简 ZIP 解析器（零依赖，仅用内置 zlib）。
 * 支持 Stored(0) 与 Deflate(8) 两种压缩方式；不处理 Zip64 / 数据描述符 / 加密。
 * 返回 [{ name, data(Buffer) }, ...]。
 *
 * 安全上限（防 ZIP 炸弹）：opts.maxEntryBytes / maxTotalBytes / maxEntries。
 *   · 先按 EOCD + 中央目录记录的 uncompressed size 预检（不实际解压）；
 *   · 解压时给 inflateRawSync 传 maxOutputLength（单条上限，超限由 zlib 直接中止，不会 OOM）；
 *   · 同时累计实际解压总量与条目数，超限立即抛「压缩包过大」错误（code=ZIP_TOO_LARGE）。
 */
function parseZip(buf, opts) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const limits = resolveLimits(opts);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');

  const totalEntries = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // 兼容某些 zip：若 central directory 偏移指向 local header，尝试回退定位
  if (cdOffset >= buf.length || buf.readUInt32LE(cdOffset) !== 0x02014b50) {
    cdOffset = findSignature(buf, 0x02014b50, cdOffset);
    if (cdOffset < 0) throw new Error('ZIP 中央目录损坏');
  }

  // ---- 预检：按中央目录记录的未压缩大小与条目数先判断，避免解压到一半才发现超限 ----
  if (totalEntries > limits.maxEntries) {
    throw tooLargeError(`条目数 ${totalEntries} 超过上限 ${limits.maxEntries}`);
  }
  {
    let pos = cdOffset;
    let declaredTotal = 0;
    let counted = 0;
    for (let i = 0; i < totalEntries; i++) {
      if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) break;
      const declared = buf.readUInt32LE(pos + 24); // 中央目录中的 uncompressed size
      const nameLen = buf.readUInt16LE(pos + 28);
      const extraLen = buf.readUInt16LE(pos + 30);
      const commentLen = buf.readUInt16LE(pos + 32);
      if (declared > limits.maxEntryBytes) {
        throw tooLargeError(`单个条目记录的解压后大小 ${humanSize(declared)} 超过上限 ${humanSize(limits.maxEntryBytes)}`);
      }
      declaredTotal += declared;
      counted++;
      if (declaredTotal > limits.maxTotalBytes) {
        throw tooLargeError(`记录的解压后总大小超过上限 ${humanSize(limits.maxTotalBytes)}`);
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }
    if (counted > limits.maxEntries) {
      throw tooLargeError(`条目数 ${counted} 超过上限 ${limits.maxEntries}`);
    }
  }

  const entries = [];
  let decodedTotal = 0; // 实际解压出的字节总量
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) break;
    if (i >= limits.maxEntries) {
      throw tooLargeError(`条目数超过上限 ${limits.maxEntries}`);
    }
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
      const remainTotal = limits.maxTotalBytes - decodedTotal;
      if (remainTotal <= 0) {
        throw tooLargeError(`解压后总大小超过上限 ${humanSize(limits.maxTotalBytes)}`);
      }
      // 单条上限 = min(配置上限, 剩余总量)，任一条目超限都会由 zlib 立即中止
      const maxThis = Math.min(limits.maxEntryBytes, remainTotal);
      if (method === 0) {
        if (compressed.length > maxThis) {
          throw tooLargeError(`单个条目解压后大小超过上限 ${humanSize(limits.maxEntryBytes)}`);
        }
        data = compressed;
      } else if (method === 8) {
        data = zlib.inflateRawSync(compressed, { maxOutputLength: maxThis });
      } else {
        if (compressed.length > maxThis) {
          throw tooLargeError(`单个条目解压后大小超过上限 ${humanSize(limits.maxEntryBytes)}`);
        }
        data = compressed; // 未知方式：尽力而为
      }
    } catch (e) {
      if (e && e.code === 'ZIP_TOO_LARGE') throw e; // 超限必须向上抛，交由入口转成友好提示
      if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|output length/i.test(String(e.message || '')))) {
        throw tooLargeError(`单个条目解压后大小超过上限 ${humanSize(limits.maxEntryBytes)}`);
      }
      // 其它解析失败（损坏条目）：返回空数据，保持原有容错行为
    }
    decodedTotal += data.length;
    if (decodedTotal > limits.maxTotalBytes) {
      throw tooLargeError(`解压后总大小超过上限 ${humanSize(limits.maxTotalBytes)}`);
    }

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
 * 同时识别题目配套的代码文件：
 *   checker.cpp（Special Judge）、interactor.cpp / grader.cpp（交互题）、*.h（函数式交互题头文件）。
 */
function testcasesFromZip(buf) {
  const entries = parseZip(buf);
  const inMap = {};
  const outMap = {};
  let checker = null;
  let interactor = null;
  let grader = null;
  const headers = {};
  // v2.6.3（待办 #16 根因）：数据包里的 checker.cpp / interactor.cpp / grader.cpp / *.h 在中文 Windows 上
  // 很可能是**GBK(cp936) 编码**（编辑器按 ANSI 保存）。此前一律用 e.data.toString('utf8') 宽容解码，
  // 会把 GBK 中文永久烧成 U+FFFD 落盘，导致重编译后的 checker 消息全是乱码（实测题目 #16）。
  // 现在统一走 decodeText：合法 UTF-8 原样通过，GBK 正确还原，源码不再被破坏。
  const decodeAsset = (b) => decodeText(b);
  for (const e of entries) {
    if (e.name.endsWith('/')) continue; // 目录
    const segs = e.name.replace(/\\/g, '/').split('/');
    const base = segs[segs.length - 1].toLowerCase();
    if (base === 'checker.cpp' || base === 'checker.cc') {
      checker = decodeAsset(e.data);
      continue;
    }
    if (base === 'interactor.cpp' || base === 'interactor.cc') {
      interactor = decodeAsset(e.data);
      continue;
    }
    if (base === 'grader.cpp' || base === 'grader.cc') {
      grader = decodeAsset(e.data);
      continue;
    }
    // 附加头文件：名称限制与 db.js 的 isValidInteractiveHeaderName 保持一致
    if (/^[a-z0-9_.-]{1,40}\.h$/.test(base)) {
      headers[base] = decodeAsset(e.data);
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
  return {
    cases: indices.map((i) => ({ index: i, input: inMap[i] ?? '', output: outMap[i] ?? '' })),
    checker,
    interactor,
    grader,
    headers: Object.keys(headers).sort().map((name) => ({ name, content: headers[name] })),
  };
}

module.exports = { parseZip, testcasesFromZip, buildZip, crc32, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES, MAX_ENTRIES };
