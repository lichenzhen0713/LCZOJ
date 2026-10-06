'use strict';

/* 用户头像存储：写入 DATA_DIR/avatars/<uid>.<ext>，数据库只保存短 URL。
 * 之前头像以 data URL（最长 512KB）直接存在 users.avatar 里，
 * 导致 /api/me、排行榜、私信等每个包含用户信息的接口都要带上整段 base64，
 * 响应体动辄上百 KB，而且图片无法被浏览器单独缓存。 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const ROOT = path.join(DATA_DIR, 'avatars');
const MAX_BYTES = 2 * 1024 * 1024; // 头像上限 2MB（前端已压缩，足够）
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const EXT_BY_TYPE = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

function ensureDir() {
  try { fs.mkdirSync(ROOT, { recursive: true }); } catch { /* ignore */ }
}

/**
 * 按**魔数**识别图片真实类型（L4：不能只信 data URL 里声明的 MIME）。
 * @returns {'image/png'|'image/jpeg'|'image/gif'|'image/webp'|null}
 */
function detectImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return 'image/png';   // \x89PNG\r\n\x1a\n
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';                     // JPEG SOI
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return 'image/gif';                    // GIF87a / GIF89a
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** 校验「声明类型 / 扩展名」与文件头是否一致，不一致直接拒绝（返回错误文案） */
function assertImageMatches(buf, declaredMime) {
  const real = detectImageMime(buf);
  const want = String(declaredMime || '').toLowerCase();
  if (!real) return '头像文件不是有效的图片（无法识别的文件头，仅支持 PNG/JPEG/GIF/WEBP）';
  if (want === 'image/jpg') return real === 'image/jpeg' ? '' : `头像文件内容与声明的格式不一致（声明 ${want}，实际 ${real}）`;
  return real === want ? '' : `头像文件内容与声明的格式不一致（声明 ${want}，实际 ${real}）`;
}

/* ======================================================================
 * 已存盘头像的「深度校验」（v2.5.0 修复 admin 头像裂图）
 * ----------------------------------------------------------------------
 * 背景：data/avatars/1.png 只剩 72 字节 —— PNG 魔数 + 全 0，没有 IHDR/IEND。
 * 只按魔数判定会认为它是合法 PNG，而 filePath() 更是只看 statSync().isFile()，
 * 于是「文件存在」这个假象让兜底生成永远不再触发，浏览器拿到的却是一张解不
 * 开的图（裂图）。这里不只看魔数，还校验容器结构（IHDR/IEND、尺寸、CRC），
 * 0 字节 / 截断 / 结构不全一律判为「不可用」，交由调用方重新生成。
 * ====================================================================== */

/** 读取文件头部若干字节（魔数判定用）；失败返回 null */
function readHead(file, n = 16) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got);
  } catch { return null; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

/**
 * 深度校验图片字节：魔数 + 容器结构完整性。
 * @returns {{ok:boolean,mime:string|null,width:number,height:number,reason:string}}
 *   width/height 仅在能解出时给出（JPEG/WEBP 记 0，不影响可用性判定）
 */
function validateImageBuffer(buf) {
  const bad = (reason) => ({ ok: false, mime: null, width: 0, height: 0, reason });
  if (!Buffer.isBuffer(buf) || buf.length < 12) return bad('文件为空或过短');
  const mime = detectImageMime(buf);
  if (!mime) return bad('无法识别的文件头（仅支持 PNG/JPEG/GIF/WEBP）');

  if (mime === 'image/png') {
    if (buf.length < 45) return bad('PNG 数据被截断（缺少 IHDR/IEND）');
    if (buf.readUInt32BE(8) !== 13 || buf.subarray(12, 16).toString('latin1') !== 'IHDR') return bad('PNG 缺少 IHDR 块');
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (!w || !h || w > 20000 || h > 20000) return bad('PNG 尺寸非法');
    // IHDR 的 CRC 必须自洽（损坏/伪造的文件头在这里被挡住）
    try {
      const crc = require('./identicon').crc32(buf.subarray(12, 29));
      if (crc !== buf.readUInt32BE(29)) return bad('PNG IHDR 校验和不匹配');
    } catch { /* 取不到 crc32 时跳过这一步，不因为校验器本身的问题误判 */ }
    if (buf.subarray(buf.length - 8, buf.length - 4).toString('latin1') !== 'IEND') return bad('PNG 数据不完整（缺少 IEND）');
    return { ok: true, mime, width: w, height: h, reason: '' };
  }
  if (mime === 'image/jpeg') {
    if (buf.length < 8 || buf[buf.length - 2] !== 0xFF || buf[buf.length - 1] !== 0xD9) return bad('JPEG 数据不完整（缺少 EOI）');
    return { ok: true, mime, width: 0, height: 0, reason: '' };
  }
  if (mime === 'image/gif') {
    if (buf.length < 14) return bad('GIF 数据被截断');
    const w = buf.readUInt16LE(6);
    const h = buf.readUInt16LE(8);
    if (!w || !h) return bad('GIF 尺寸非法');
    if (buf[buf.length - 1] !== 0x3B) return bad('GIF 数据不完整（缺少 trailer）');
    return { ok: true, mime, width: w, height: h, reason: '' };
  }
  // WEBP：RIFF 声明长度必须与文件实际长度一致
  if (buf.length < 20) return bad('WEBP 数据被截断');
  const expect = buf.readUInt32LE(4) + 8;
  if (Math.abs(expect - buf.length) > 8) return bad('WEBP 长度与 RIFF 声明不一致');
  return { ok: true, mime, width: 0, height: 0, reason: '' };
}

/** 读取并校验磁盘上的头像文件（文件不存在/读不到/结构损坏都返回 ok:false） */
function validateImageFile(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return { ok: false, mime: null, width: 0, height: 0, reason: '读取失败' }; }
  return validateImageBuffer(buf);
}

/** 解析 data URL → { ext, buf, mime }，非图片或格式不支持时返回 null */
function parseDataUrl(s) {
  const m = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(s || '').trim());
  if (!m) return null;
  const ext = EXT_BY_TYPE[m[1].toLowerCase()];
  if (!ext) return null;
  let buf;
  try { buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64'); } catch { return null; }
  if (!buf || !buf.length) return null;
  return { ext, buf, mime: m[1].toLowerCase() };
}

/** 生成带版本号的访问 URL（?v= 变化时浏览器会重新拉取） */
function urlFor(userId, stamp) {
  return `/api/avatars/${userId}?v=${stamp || Date.now()}`;
}

/** 保存头像文件（会先清掉该用户其它扩展名的旧文件），返回访问 URL 或 null。
 *  L4：写盘前必须通过**魔数**校验，声明的扩展名与实际文件头不一致时一律拒绝，
 *  杜绝「任意字节命名成 .png 落盘、再按 image/png 回放」的已知风险。 */
function saveBuffer(userId, ext, buf) {
  if (!buf || !buf.length) return null;
  if (buf.length > MAX_BYTES) return null;
  if (!Object.keys(MIME).includes(ext)) return null;
  if (assertImageMatches(buf, MIME[ext])) return null;
  ensureDir();
  remove(userId);
  const file = path.join(ROOT, `${userId}${ext}`);
  try { fs.writeFileSync(file, buf); } catch { return null; }
  return urlFor(userId, Date.now());
}

/** 保存 data URL 形式的头像，返回访问 URL 或 null */
function saveDataUrl(userId, dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;
  return saveBuffer(userId, parsed.ext, parsed.buf);
}

/** 该用户目录下实际存在的候选文件（按扩展名顺序），不做内容校验 */
function existingFiles(userId) {
  const base = path.join(ROOT, String(userId));
  const out = [];
  for (const ext of Object.keys(MIME)) {
    const p = base + ext;
    try { if (fs.statSync(p).isFile()) out.push(p); } catch { /* 继续找 */ }
  }
  return out;
}

/** 已保存且**内容有效**的头像文件路径（不存在 / 0 字节 / 截断 / 非图片都返回 null，
 *  这样调用方的兜底生成才会被触发 —— 而不是对着一个坏文件永远不再生成） */
function filePath(userId) {
  for (const p of existingFiles(userId)) {
    if (validateImageFile(p).ok) return p;
  }
  return null;
}

/**
 * 读取某用户可直接回给浏览器的头像：{ file, buf, mime, width, height }；
 * 文件缺失或内容不是有效图片时返回 null（由调用方走生成 / 默认头像兜底）。
 */
function load(userId) {
  for (const p of existingFiles(userId)) {
    const v = validateImageFile(p);
    if (!v.ok) continue;
    try { return { file: p, buf: fs.readFileSync(p), mime: v.mime, width: v.width, height: v.height }; } catch { return null; }
  }
  return null;
}

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/* 内置默认头像（64×64 纯色 PNG，直接内嵌字节）：连像素画生成都失败时的最后兜底，
 * 保证 /api/avatars/<id> 永远回一张**能解码的图片**，而不是 500 / 404 / 裂图。 */
const FALLBACK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATklEQVR42u3PQQkAAAgEsHvb3cwawbcwWIGlel6LgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgMBlAcAAYXhMwZgxAAAAAElFTkSuQmCC',
  'base64',
);
let defaultPngCache = null;
/** 默认头像字节（优先用像素画生成器画一张，失败则用内嵌 PNG） */
function defaultAvatar() {
  if (defaultPngCache) return defaultPngCache;
  let buf = null;
  try { buf = require('./identicon').render('lczoj-default', 150); } catch { /* ignore */ }
  if (!buf || !validateImageBuffer(buf).ok) buf = FALLBACK_PNG;
  defaultPngCache = buf;
  return buf;
}

/** 删除该用户的头像文件 */
function remove(userId) {
  const base = path.join(ROOT, String(userId));
  for (const ext of Object.keys(MIME)) {
    try { fs.rmSync(base + ext, { force: true }); } catch { /* ignore */ }
  }
}

/** 归一化用户提交的头像字段：
 *  - 空值 → 删除文件并返回 ''
 *  - data:image/... → 存成文件，返回 /api/avatars/<uid>?v=...
 *  - http(s) 外链 → 原样返回
 *  - 已经是本站 /api/avatars/... → 原样返回 */
function normalize(userId, value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) { remove(userId); return ''; }
  if (/^\/api\/avatars\//.test(v)) return v;
  if (/^https?:\/\//i.test(v)) { remove(userId); return v.slice(0, 512); } // 改用外链时清掉本地旧文件
  if (/^data:image\//i.test(v)) {
    // L4：先按魔数校验（声明 MIME 与实际文件头必须一致），再落盘
    const parsed = parseDataUrl(v);
    if (parsed) {
      const bad = assertImageMatches(parsed.buf, parsed.mime);
      if (bad) return { error: bad };
      if (parsed.buf.length > MAX_BYTES) return { error: '头像过大（最多 2MB）' };
    }
    const url = saveDataUrl(userId, v);
    if (url) return url;
    return { error: '头像保存失败（仅支持 png/jpg/gif/webp，且不超过 2MB）' };
  }
  return { error: '头像格式不支持' };
}

/** 启动时迁移：把历史遗留的 data URL 头像转成文件（幂等） */
function migrateDataUrls(db) {
  let rows = [];
  try { rows = db.prepare("SELECT id, avatar FROM users WHERE avatar LIKE 'data:image/%'").all(); } catch { return 0; }
  let done = 0;
  for (const r of rows) {
    const url = saveDataUrl(r.id, r.avatar);
    if (!url) continue;
    try { db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(url, r.id); done++; } catch { /* ignore */ }
  }
  return done;
}

/**
 * 为新用户生成 GitHub 风格的像素画头像（identicon）：图案与配色由种子（用户名）决定，
 * 因此同一用户每次得到的都是同一张图。已有头像时不做任何改动。
 * @returns {string|null} 头像访问 URL；已有头像或写入失败时返回 null
 */
function ensureIdenticon(userId, seed) {
  if (filePath(userId)) return null;
  // 种子兜底链：用户名 → user<id> → 固定默认图，任一成功即落盘（保证不会「生成不出来」）
  const keys = [];
  if (seed != null && String(seed).trim() !== '') keys.push(String(seed));
  keys.push('user' + userId);
  keys.push('lczoj-default');
  for (const key of keys) {
    let buf;
    try { buf = require('./identicon').render(key, 150); } catch { continue; }
    const url = saveBuffer(userId, '.png', buf);
    if (url) return url;
  }
  return null;
}

/**
 * 启动自愈（v2.5.0）：数据库里已经写着本站头像地址（/api/avatars/...），但磁盘上的
 * 文件缺失 / 0 字节 / 截断 / 根本不是图片时，立刻重新生成并回写带新 ?v= 的地址。
 *   · 只处理「本站头像」；外链头像、从未设置过头像的用户一律不碰；
 *   · 其它用户的头像文件不会被删除或覆盖（ensureIdenticon 只会重写坏掉的那一个）。
 * @returns {number} 修复数量
 */
function healBrokenFiles(db) {
  let rows = [];
  try { rows = db.prepare("SELECT id, username, avatar FROM users WHERE avatar LIKE '/api/avatars/%'").all(); } catch { return 0; }
  let fixed = 0;
  for (const r of rows) {
    if (filePath(r.id)) continue;                       // 文件在且是有效图片 → 不动
    const url = ensureIdenticon(r.id, r.username || ('user' + r.id));
    if (!url) continue;
    try { db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(url, r.id); fixed++; } catch { /* ignore */ }
  }
  return fixed;
}

/** 启动时补齐：为还没有任何头像的用户生成像素头像（幂等），返回补齐数量 */
function backfillIdenticons(db) {
  let rows = [];
  try {
    rows = db.prepare("SELECT id, username FROM users WHERE avatar IS NULL OR avatar = '' ORDER BY id").all();
  } catch { return 0; }
  let done = 0;
  for (const r of rows) {
    let url = ensureIdenticon(r.id, r.username || ('user' + r.id));
    // 文件已存在（例如由头像接口兜底生成过）但数据库里还没写地址：补上地址
    if (!url && filePath(r.id)) url = urlFor(r.id, Date.now());
    if (!url) continue;
    try { db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(url, r.id); done++; } catch { /* ignore */ }
  }
  return done;
}

module.exports = {
  saveDataUrl, saveBuffer, normalize, filePath, load, mimeOf, remove,
  migrateDataUrls, ensureIdenticon, backfillIdenticons, healBrokenFiles, urlFor, MAX_BYTES,
  detectImageMime, assertImageMatches, validateImageBuffer, validateImageFile, defaultAvatar,
};
