'use strict';

/* 评测明细编解码（省空间）：
 * - 短内容（< 160 字符）原样存 TEXT；
 * - 较长内容 gzip 后以原始二进制（BLOB）入库，无 base64 冗余；
 * - 兼容历史格式：以 "gz:" 开头的 base64 文本（早期方案）也会被透明解码。
 * 读取端 decodeDetail 统一还原为原始 JSON 字符串。
 */
const zlib = require('zlib');

const LEGACY_PREFIX = 'gz:';
const MIN_RAW = 160;

/** 编码：返回 Buffer（已 gzip）或原样字符串 */
function encodeDetail(rawJson) {
  if (!rawJson || typeof rawJson !== 'string') return rawJson || '[]';
  if (rawJson.length < MIN_RAW) return rawJson;
  try {
    const buf = zlib.gzipSync(Buffer.from(rawJson, 'utf8'), { level: 9 });
    if (buf.length + 8 >= rawJson.length) return rawJson; // 收益太小则原样
    return buf;
  } catch (e) {
    return rawJson;
  }
}

/** 解码：value 可能是 Buffer（gzip 二进制）、"gz:" 文本（历史 base64）或原样字符串 */
function decodeDetail(value) {
  if (value == null) return '[]';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    try {
      return zlib.gunzipSync(Buffer.from(value)).toString('utf8');
    } catch (e) {
      return '[]';
    }
  }
  const text = String(value);
  if (!text) return '[]';
  if (text.startsWith(LEGACY_PREFIX)) {
    try {
      return zlib.gunzipSync(Buffer.from(text.slice(LEGACY_PREFIX.length), 'base64')).toString('utf8');
    } catch (e) {
      return '[]';
    }
  }
  return text;
}

module.exports = { encodeDetail, decodeDetail, LEGACY_PREFIX };
