'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

/**
 * 让 readJsonBody 能拿到本次请求的「响应对象」，从而在请求体超限时回 413 JSON（L3）：
 * server.js 的 `http.createServer(handler)` 只把 (req, res) 交给 handler，readJsonBody 只收到 req，
 * 而 server.js 不允许改动，所以在 **HTTP 服务发出 request 事件之前**给 req 挂上 res 引用。
 * 只新增一个属性，不改变任何原有行为；把响应交给 handler 之前挂好，handler 里即可使用。
 */
(function attachResponseRef() {
  if (http.Server.prototype.__lczojResponseRef) return;
  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function emit(event, ...args) {
    if (event === 'request' && args[0] && args[1]) {
      try { if (!args[0].__res) args[0].__res = args[1]; } catch { /* ignore */ }
    }
    return origEmit.apply(this, [event, ...args]);
  };
  http.Server.prototype.__lczojResponseRef = true;
})();

/** 生成随机令牌 */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * 取本次请求对应的响应对象。
 * server.js 的 http 服务把 res 挂在 req.__res 上（见下方 attachResponseRef 的说明），
 * 万一没挂上（例如 util.js 在服务创建之后才被 require），退回 Node 内部的 socket._httpMessage ——
 * 它就是当前连接上正在写的 ServerResponse。取不到时返回 null，由调用方降级处理。
 */
function responseOf(req) {
  if (!req) return null;
  try { if (req.__res && !req.__res.writableEnded) return req.__res; } catch { /* ignore */ }
  try {
    const m = req.socket && req.socket._httpMessage;
    if (m && !m.writableEnded) return m;
  } catch { /* ignore */ }
  return null;
}

/**
 * 请求体超限时回 413（而不是直接 destroy 连接让客户端只看到「连接被关闭」）。
 * 要点：**不要**给响应加 Connection: close 再立刻结束 —— 客户端还在上传，服务端随即销毁 socket
 * 会让客户端收到 RST（fetch 报 ECONNRESET、cURL 看不到状态码）。正确做法是先把后续请求体
 * 丢弃（req.resume()，只丢不缓存，不占内存），再回 413，由 Node 在请求体收完后自行关闭连接。
 * 返回 true 表示已经回了响应；false 表示取不到响应对象，只能断连接。
 */
function respondPayloadTooLarge(req, limitBytes) {
  const message = `请求体过大（上限 ${Math.round(limitBytes / 1024)}KB）`;
  const res = responseOf(req);
  if (!res) return false;
  try {
    // 丢弃（而非缓存）剩余请求体，避免客户端写入途中收到 RST
    try { req.resume(); } catch { /* ignore */ }
    sendJson(res, 413, { success: false, message }, req);
    return true;
  } catch {
    return false;
  }
}

/** 从请求体读取 JSON（带大小上限）。
 *  超限时：先按 Content-Length 预检 → 立即回 413 JSON（不读取、不断连接）；
 *  没带 Content-Length 或声明值不可信时，边读边累计，一旦超限同样回 413 并停止读取。 */
function readJsonBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    // 1) Content-Length 预检：声明就超限的直接拒绝，避免白读几 MB 再报错
    const declared = parseInt((req.headers && req.headers['content-length']) || '', 10);
    if (Number.isFinite(declared) && declared > limitBytes) {
      const sent = respondPayloadTooLarge(req, limitBytes);
      const err = new Error('请求体过大');
      err.status = 413;
      err.handled = sent;      // 已回 413：上层再写响应会被 sendJson 的守卫忽略
      if (!sent) { try { req.destroy(); } catch { /* ignore */ } }
      reject(err);
      return;
    }
    let size = 0;
    const chunks = [];
    let finished = false;      // 已给出 413 并停止读取
    req.on('data', (c) => {
      if (finished) return;
      size += c.length;
      if (size > limitBytes) {
        finished = true;
        respondPayloadTooLarge(req, limitBytes);
        const err = new Error('请求体过大');
        err.status = 413;
        err.handled = true;
        reject(err);
        return; // 不再累积数据（respondPayloadTooLarge 已 req.resume() 丢弃剩余请求体）
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (finished) return;
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', (e) => { if (!finished) reject(e); });
  });
}

/** 生成 Content-Disposition（带 UTF-8 文件名，兼容老浏览器用 ASCII 兜底） */
function contentDisposition(filename) {
  const name = String(filename || 'download.bin');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** 发送 JSON 响应（较大响应自动 gzip，减少传输体积） */
function sendJson(res, status, data, req) {
  // 守卫：响应已经结束（例如 readJsonBody 已回过 413）时静默返回，避免二次写入抛错
  if (!res || res.writableEnded || res.headersSent) return;
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  const accept = String((req && req.headers && req.headers['accept-encoding']) || '');
  if (body.length >= 1024 && /\bgzip\b/.test(accept)) {
    try {
      const zlib = require('zlib');
      const gz = zlib.gzipSync(body, { level: 5 });
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Content-Length': gz.length,
        'Vary': 'Accept-Encoding',
      });
      res.end(gz);
      return;
    } catch { /* 压缩失败则按原样发送 */ }
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

function ok(res, data = {}) {
  sendJson(res, 200, { success: true, ...data }, res.__req);
}

function fail(res, status, message) {
  sendJson(res, status, { success: false, message }, res.__req);
}

/** HTML 转义 */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function difficultyByLevel(level) {
  const { DIFFICULTIES } = require('./config');
  return DIFFICULTIES.find((d) => d.level === level) || DIFFICULTIES[0];
}

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 解析 cookie 字符串为对象 */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return out;
}

/** 简单的分页参数解析 */
function parsePagination(query, defaultSize = 20, maxSize = 100) {
  let page = parseInt(query.get('page') || '1', 10);
  let size = parseInt(query.get('size') || String(defaultSize), 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(size) || size < 1) size = defaultSize;
  if (size > maxSize) size = maxSize;
  return { page, size, offset: (page - 1) * size };
}

/* --------------------------- 文本编码稳健解码（v2.6.3） ---------------------------
 * 背景（待办 #16）：中文 Windows 环境下，checker / 交互器 / grader 的**源码**或**输出**可能是
 * GBK(cp936) 字节（典型的：checker.cpp 以 ANSI 保存后，g++ 会把字符串字面量的 GBK 字节原样
 * 写进可执行文件，判题消息因此是 GBK），而 Node 默认按 UTF-8 解码 → 整条消息变成一连串
 * U+FFFD 替换符（提交详情里就是「乱码方框 + 个别碰巧合法的西欧字母」）。
 *
 * decodeText() 的口径（**优先 UTF-8，失败/遇到非法序列才回退 GBK**，不引入任何第三方依赖）：
 *   1) 全量严格 UTF-8 解码成功 → 直接返回（与改动前的行为**逐字节一致**，不会改变任何既有判定）；
 *   2) 否则逐段解码：合法 UTF-8 段按 UTF-8，非法段按 GBK 兜底（同一段里 UTF-8 / GBK 混排也能还原）；
 *   3) 回退点只在「后面确实是可持续的合法 UTF-8」处切开，避免把 GBK 双字节序列从中间劈开；
 *   4) 两种编码都解释不了的字节退化为 U+FFFD —— 绝不抛错、绝不丢内容。
 * 运行环境没有 GBK 解码器（small-icu 的精简 Node）时退回 UTF-8 宽容解码，行为与改动前相同。
 */
const utf8StrictDecoder = new TextDecoder('utf-8', { fatal: true });
const utf8LossyDecoder = new TextDecoder('utf-8', { fatal: false });
let gbkDecoderCache = null;
function gbkDecoder() {
  if (gbkDecoderCache === null) {
    try { gbkDecoderCache = new TextDecoder('gbk', { fatal: false }); } catch { gbkDecoderCache = false; }
  }
  return gbkDecoderCache;
}
/** 回退点判定阈值：后面至少还有这么多字节是合法 UTF-8，才认为「UTF-8 在此重新开始」 */
const RESYNC_MIN_BYTES = 8;
/** 回退点搜索范围上限：纯 GBK 大文件不必逐字节试探（超出即整段按 GBK 解码） */
const RESYNC_SCAN_LIMIT = 4096;

/** 从 from 起扫描合法 UTF-8 序列，返回**第一个非法字节**的下标（到 to 全合法则返回 to） */
function utf8ValidEnd(buf, from, to) {
  let i = from;
  while (i < to) {
    const b = buf[i];
    if (b < 0x80) { i += 1; continue; }
    let extra;
    if (b >= 0xc2 && b <= 0xdf) extra = 1;
    else if (b >= 0xe0 && b <= 0xef) extra = 2;
    else if (b >= 0xf0 && b <= 0xf4) extra = 3;
    else break;
    if (i + extra >= to) break;                       // 序列被截断：视为非法
    let ok = true;
    for (let k = 1; k <= extra; k++) {
      const c = buf[i + k];
      if (c < 0x80 || c > 0xbf) { ok = false; break; }
    }
    if (ok) {
      // 严格 UTF-8：排除过长编码与 UTF-16 代理区
      if (extra === 2 && b === 0xe0 && buf[i + 1] < 0xa0) ok = false;
      else if (extra === 2 && b === 0xed && buf[i + 1] > 0x9f) ok = false;
      else if (extra === 3 && b === 0xf0 && buf[i + 1] < 0x90) ok = false;
      else if (extra === 3 && b === 0xf4 && buf[i + 1] > 0x8f) ok = false;
    }
    if (!ok) break;
    i += extra + 1;
  }
  return i;
}

/** 从 from 起最长的 GBK 串结束下标（ASCII 单字节 + GBK 双字节；遇到无法解释的字节即停） */
function gbkRunEnd(buf, from, to) {
  let i = from;
  while (i < to) {
    const b = buf[i];
    if (b < 0x80) { i += 1; continue; }
    if (b >= 0x81 && b <= 0xfe && i + 1 < to) {
      const t = buf[i + 1];
      if (t >= 0x40 && t <= 0xfe && t !== 0x7f) { i += 2; continue; }
    }
    break;
  }
  return i;
}

/**
 * 稳健解码来自**外部**的文本（子进程输出、压缩包内的 checker / 交互器源码、编译日志……）。
 * @param {Buffer|Uint8Array|string} input 字节内容（字符串按原样返回，避免二次解码）
 * @returns {string}
 */
function decodeText(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!buf.length) return '';
  // 1) 快速路径：全量合法 UTF-8（含纯 ASCII）——绝大多数情况，行为与改动前完全一致
  try { return utf8StrictDecoder.decode(buf); } catch { /* 有非法序列：进入 GBK 回退 */ }
  const gbkDec = gbkDecoder();
  if (!gbkDec) return utf8LossyDecoder.decode(buf);    // 环境不支持 GBK：退回宽容 UTF-8
  const n = buf.length;
  const parts = [];
  let i = 0;
  while (i < n) {
    const u = utf8ValidEnd(buf, i, n);
    if (u > i) {
      parts.push(utf8StrictDecoder.decode(buf.subarray(i, u)));
      i = u;
      if (i >= n) break;
    }
    // i 处是非法 UTF-8 序列：取一段 GBK，尽量在「之后的字节确实是可持续 UTF-8」处切开
    const runEnd = gbkRunEnd(buf, i, n);
    const scanTo = Math.min(runEnd, i + RESYNC_SCAN_LIMIT);
    let end = runEnd;
    for (let j = i + 1; j < scanTo; j++) {
      if (utf8ValidEnd(buf, j, n) - j >= RESYNC_MIN_BYTES) { end = j; break; }
    }
    if (end > i) {
      parts.push(gbkDec.decode(buf.subarray(i, end)));
      i = end;
    } else {
      parts.push('\uFFFD');
      i += 1;
    }
  }
  return parts.join('');
}

/** 读文件 + 稳健解码（文件不存在或读取失败时返回 fallback，绝不抛错） */
function readTextFile(file, fallback = '') {
  try { return decodeText(fs.readFileSync(file)); } catch { return fallback; }
}

module.exports = {
  randomToken,
  readJsonBody,
  respondPayloadTooLarge,
  sendJson,
  contentDisposition,
  ok,
  fail,
  escapeHtml,
  difficultyByLevel,
  formatDate,
  parseCookies,
  parsePagination,
  decodeText,
  readTextFile,
};
