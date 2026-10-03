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

/** 解析 data URL → { ext, buf }，非图片或格式不支持时返回 null */
function parseDataUrl(s) {
  const m = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(s || '').trim());
  if (!m) return null;
  const ext = EXT_BY_TYPE[m[1].toLowerCase()];
  if (!ext) return null;
  let buf;
  try { buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64'); } catch { return null; }
  if (!buf || !buf.length) return null;
  return { ext, buf };
}

/** 生成带版本号的访问 URL（?v= 变化时浏览器会重新拉取） */
function urlFor(userId, stamp) {
  return `/api/avatars/${userId}?v=${stamp || Date.now()}`;
}

/** 保存头像文件（会先清掉该用户其它扩展名的旧文件），返回访问 URL 或 null */
function saveBuffer(userId, ext, buf) {
  if (!buf || !buf.length) return null;
  if (buf.length > MAX_BYTES) return null;
  if (!Object.keys(MIME).includes(ext)) return null;
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

/** 已保存的头像文件路径（不存在返回 null） */
function filePath(userId) {
  const base = path.join(ROOT, String(userId));
  for (const ext of Object.keys(MIME)) {
    const p = base + ext;
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 继续找 */ }
  }
  return null;
}

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
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

module.exports = { saveDataUrl, saveBuffer, normalize, filePath, mimeOf, remove, migrateDataUrls, urlFor, MAX_BYTES };
