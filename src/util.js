'use strict';

const crypto = require('crypto');

/** 生成随机令牌 */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** 从请求体读取 JSON（带大小上限） */
function readJsonBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
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

module.exports = {
  randomToken,
  readJsonBody,
  sendJson,
  contentDisposition,
  ok,
  fail,
  escapeHtml,
  difficultyByLevel,
  formatDate,
  parseCookies,
  parsePagination,
};
