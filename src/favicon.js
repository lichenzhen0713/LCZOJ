'use strict';

/* 网站图标（favicon）存储：文件写入 DATA_DIR/favicon/favicon.<ext>，
 * 数据库 settings 表只保存短文件名（键 site_favicon；空 = 使用默认图标）。
 *
 * 为什么不像「站点 Logo」那样把整段 data URL 存进 settings：
 *   favicon 会被**每个页面**请求一次，以 base64 存库既会撑大 /api/settings 的响应，
 *   又无法被浏览器单独缓存。这里沿用 src/avatars.js 的目录约定（data/<用途>/<文件>）
 *   与**魔数校验**思路：只信真实文件头，不信调用方声明的类型 / 扩展名，
 *   杜绝「任意字节命名成 .png 落盘、再按 image/png 回放」的风险。
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { getSetting, setSetting } = require('./settings');

const ROOT = path.join(DATA_DIR, 'favicon');
const BASE = 'favicon';                    // 固定基名：换图只换扩展名 / 清旧文件，不堆积垃圾
const KEY = 'site_favicon';                // 值 = 文件名（如 favicon.png）；空 = 默认图标
const KEY_VER = 'site_favicon_v';          // 值 = 上传时间戳（毫秒），仅用于前端 ?v= 破缓存
const MAX_BYTES = 512 * 1024;              // 图标上限 512KB（favicon 通常几 KB，足够）
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
};
const EXT_BY_MIME = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
  'image/svg+xml': '.svg', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico',
  'image/webp': '.webp',
};

/* 站点默认图标 = 站长提供的站点 Logo（LCZOJ 矢量标：代码尖括号 + AC 对勾 + 三个测试点）。
 *
 * 与静态资源 public/img/logo.svg **逐字节一致**（同一份文本，末尾一个换行），
 * 站点 Logo 与标签页图标因此永远是同一张图；改动其一必须同步另一处。
 *
 * 为什么默认图标要带版本号（DEFAULT_VER）：
 *   Chrome 的 Favicons 库把「页面 URL → 图标 URL → 已栅格化位图」长期存在本地
 *   （实测落在 <用户目录>/Default/Favicons 的 favicons / favicon_bitmaps 表里）。
 *   只要**图标 URL 不变**，它就不会重新下载，标签页继续显示旧位图 ——
 *   这正是「上一轮已经换成矢量天平、站长那里却仍然是坏的/空白」的原因：
 *   旧位图（最初那版只含 <text> 的 emoji SVG 栅格化结果）一直挂在 /api/favicon 上。
 *   现在默认地址也带 ?v=（见 DEFAULT_VER），URL 变了 → 浏览器必然重新取一次，
 *   旧位图再也挂不住；以后换默认图只要把 DEFAULT_VER 递增一档即可。
 *
 * 三态兜底不变：未上传 / 上传文件损坏或丢失 / 恢复默认，都返回这份 SVG（绝不 404）。 */
const DEFAULT_VER = '293';                 // 默认图标的破缓存版本号（与 index.html / app.js 中的 ?v=293 保持一致）
const DEFAULT_SVG = Buffer.from([
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="20 36 88 76" width="88" height="76">',
  '  <defs>',
  '    <linearGradient id="lcGrad" x1="0%" y1="0%" x2="100%" y2="100%">',
  '      <stop offset="0%" stop-color="#4F46E5"/>',
  '      <stop offset="100%" stop-color="#06B6D4"/>',
  '    </linearGradient>',
  '    <linearGradient id="checkGrad" x1="0%" y1="100%" x2="100%" y2="0%">',
  '      <stop offset="0%" stop-color="#06B6D4"/>',
  '      <stop offset="100%" stop-color="#22C55E"/>',
  '    </linearGradient>',
  '  </defs>',
  '',
  '  <!-- 左侧代码括号 <（stroke-width 10） -->',
  '  <path d="M46 44 L28 64 L46 84"',
  '        fill="none"',
  '        stroke="url(#lcGrad)"',
  '        stroke-width="10"',
  '        stroke-linecap="round"',
  '        stroke-linejoin="round"/>',
  '',
  '  <!-- 右侧代码括号 >（stroke-width 10） -->',
  '  <path d="M82 44 L100 64 L82 84"',
  '        fill="none"',
  '        stroke="url(#lcGrad)"',
  '        stroke-width="10"',
  '        stroke-linecap="round"',
  '        stroke-linejoin="round"/>',
  '',
  '  <!-- 中间 AC 对勾（stroke-width 12） -->',
  '  <path d="M50 66 L64 80 L92 46"',
  '        fill="none"',
  '        stroke="url(#checkGrad)"',
  '        stroke-width="12"',
  '        stroke-linecap="round"',
  '        stroke-linejoin="round"/>',
  '',
  '  <!-- 底部三个测试点：半径 6（直径 12 = 对勾笔画粗细，与其它元素一致）；圆心 38/64/90 -->',
  '  <circle cx="38" cy="103" r="6" fill="#4F46E5"/>',
  '  <circle cx="64" cy="103" r="6" fill="#06B6D4"/>',
  '  <circle cx="90" cy="103" r="6" fill="#22C55E"/>',
  '</svg>',
  '',
].join('\n'), 'utf8');

function ensureDir() {
  try { fs.mkdirSync(ROOT, { recursive: true }); } catch { /* ignore */ }
}

/**
 * 按**魔数**识别图标真实类型（PNG/JPEG/GIF/WEBP 复用 avatars.js 的判定，
 * 再补 favicon 特有的 SVG 文本与 ICO 容器）。
 * @returns {'image/png'|'image/jpeg'|'image/gif'|'image/webp'|'image/svg+xml'|'image/x-icon'|null}
 */
function detectMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  // ICO：ICONDIR = 00 00 01 00（favicon.ico 最常见的形式）
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'image/x-icon';
  try {
    const raster = require('./avatars').detectImageMime(buf);
    if (raster) return raster; // png / jpeg / gif / webp
  } catch { /* avatars 不可用时继续尝试 SVG */ }
  // SVG：文本文件，去 BOM / 空白后必须以 <?xml 或 <svg 开头，且真的含 <svg 标签
  const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^<(\?xml|!--|svg)[\s>]/i.test(head) || /^<svg[\s>]/i.test(head)) {
    const whole = buf.toString('utf8');
    if (/<svg[\s>]/i.test(whole)) return 'image/svg+xml';
  }
  return null;
}

/**
 * 校验图标字节：魔数 + 结构完整性 + 体积上限。
 * @returns {{ok:boolean,mime:string|null,reason:string}}
 */
function validateBuffer(buf) {
  const bad = (reason) => ({ ok: false, mime: null, reason });
  if (!Buffer.isBuffer(buf) || !buf.length) return bad('图标文件为空');
  if (buf.length > MAX_BYTES) return bad(`图标文件过大（最多 ${Math.round(MAX_BYTES / 1024)}KB）`);
  const mime = detectMime(buf);
  if (!mime) return bad('图标不是有效的图片（无法识别的文件头，仅支持 PNG/JPEG/SVG/ICO/WEBP）');
  if (mime === 'image/svg+xml') {
    const text = buf.toString('utf8');
    if (!/<\/svg>/i.test(text)) return bad('SVG 图标数据不完整（缺少 </svg>）');
    // favicon 以 <link rel="icon"> 加载，浏览器不会执行其中的脚本；这里仍然拒绝，
    // 避免该 SVG 被用户另存/直接打开成页面时变成 XSS 载体。
    if (/<script[\s>]/i.test(text) || /\son\w+\s*=/i.test(text) || /javascript:/i.test(text)) {
      return bad('SVG 图标不能包含脚本或事件属性');
    }
    return { ok: true, mime, reason: '' };
  }
  // 栅格图：交给 avatars.js 的深度校验（PNG 需 IHDR/IEND 与 CRC；JPEG 需 EOI；GIF 需 trailer；WEBP 需 RIFF 长度一致）
  try {
    const v = require('./avatars').validateImageBuffer(buf);
    if (!v.ok) return bad('图标文件已损坏：' + v.reason);
    return { ok: true, mime: v.mime, reason: '' };
  } catch {
    return { ok: true, mime, reason: '' }; // 校验器本身出问题时不做误判（魔数已确认是图片）
  }
}

/** 文件名安全化：只允许 data/favicon 目录下的纯文件名（拒绝任何路径分隔符 / ..） */
function safeName(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s || s.includes('/') || s.includes('\\') || s.includes('..')) return '';
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return '';
  return s;
}

/** 当前设置的图标文件名（未设置 → ''） */
function settingName() {
  let v = '';
  try { v = getSetting(KEY, ''); } catch { v = ''; }
  return safeName(v);
}

/** 已设置图标的版本号（上传时间戳，毫秒字符串；未设置 → ''） */
function settingVer() {
  try { return String(getSetting(KEY_VER, '')).trim(); } catch { return ''; }
}

/** 目录下实际存在的图标文件（按扩展名顺序） */
function existingFiles() {
  const out = [];
  for (const ext of Object.keys(MIME)) {
    const p = path.join(ROOT, BASE + ext);
    try { if (fs.statSync(p).isFile()) out.push(p); } catch { /* 继续找下一个 */ }
  }
  return out;
}

/** 磁盘上第一个「内容有效」的图标文件路径（不存在 / 空 / 损坏都返回 null） */
function filePath() {
  for (const p of existingFiles()) {
    let buf;
    try { buf = fs.readFileSync(p); } catch { continue; }
    if (validateBuffer(buf).ok) return p;
  }
  return null;
}

/**
 * 读取可直接回给浏览器的图标：{ buf, mime, custom }。
 * 已上传且文件有效 → custom:true 回自定义图标；未设置 / 文件丢失 / 文件损坏 → custom:false 回默认 SVG。
 * **任何情况下都返回可用的字节**，调用方不必（也不应该）回 404。
 */
function load() {
  const name = settingName();
  if (name) {
    const p = path.join(ROOT, name);
    let buf = null;
    try { if (fs.statSync(p).isFile()) buf = fs.readFileSync(p); } catch { buf = null; }
    if (buf) {
      const v = validateBuffer(buf);
      if (v.ok) return { buf, mime: v.mime, custom: true, file: p, name };
    }
  }
  // 设置里没有记录，但磁盘上存在有效图标（例如数据库被重置）：也用上，避免「文件在却显示默认图」
  const p = filePath();
  if (!name && p) {
    try {
      const buf = fs.readFileSync(p);
      const v = validateBuffer(buf);
      if (v.ok) return { buf, mime: v.mime, custom: true, file: p, name: path.basename(p) };
    } catch { /* 落到默认图 */ }
  }
  return { buf: DEFAULT_SVG, mime: 'image/svg+xml', custom: false, file: null, name: '' };
}

/** 删除 data/favicon 下所有旧图标文件（换扩展名 / 恢复默认时清干净） */
function removeFiles() {
  for (const p of existingFiles()) {
    try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * 保存自定义图标（先魔数校验 → 写盘 → 记录设置键），返回 { ok, name, mime, ver } 或 { error }。
 * @param {Buffer} buf 文件字节
 * @param {string} [declaredMime] 调用方声明的 MIME（仅用于「声明与实际不一致」时给出更准确的提示）
 */
function save(buf, declaredMime) {
  const v = validateBuffer(buf);
  if (!v.ok) return { error: v.reason };
  const want = String(declaredMime || '').toLowerCase().split(';')[0].trim();
  if (want && want !== 'application/octet-stream' && EXT_BY_MIME[want] && EXT_BY_MIME[want] !== EXT_BY_MIME[v.mime]) {
    return { error: `图标内容与声明的格式不一致（声明 ${want}，实际 ${v.mime}）` };
  }
  const ext = EXT_BY_MIME[v.mime];
  if (!ext) return { error: '图标格式不支持（仅支持 png/jpg/svg/ico/webp）' };
  ensureDir();
  removeFiles();                       // 先清掉旧扩展名，避免同目录下多份图标互相打架
  const file = path.join(ROOT, BASE + ext);
  try { fs.writeFileSync(file, buf); } catch { return { error: '图标保存失败（数据目录不可写）' }; }
  const ver = String(Date.now());
  try {
    setSetting(KEY, BASE + ext);
    setSetting(KEY_VER, ver);
  } catch { return { error: '图标已写入磁盘，但设置保存失败' }; }
  return { ok: true, name: BASE + ext, mime: v.mime, ver, size: buf.length };
}

/** 恢复默认图标：清空设置键并删除已上传的文件（幂等） */
function reset() {
  try { setSetting(KEY, ''); setSetting(KEY_VER, ''); } catch { /* ignore */ }
  removeFiles();
  return { ok: true, name: '', mime: 'image/svg+xml', size: DEFAULT_SVG.length };
}

/** 后台设置页展示用的当前状态 */
function status() {
  const cur = load();
  return {
    name: cur.custom ? (cur.name || '') : '',
    custom: !!cur.custom,
    mime: cur.mime,
    size: cur.buf.length,
    ver: settingVer(),
    url: urlFor(settingVer()),
  };
}

/** 图标访问地址（带版本号，前端换图后立刻生效）。
 *  未自定义时也不返回裸 /api/favicon，而是带上默认图标版本号：URL 一变，
 *  浏览器 Favicons 库里的旧位图就再也命不中（详见文件顶部 DEFAULT_VER 的说明）。 */
function urlFor(ver) {
  const v = String(ver == null ? '' : ver).trim() || DEFAULT_VER;
  return `/api/favicon?v=${encodeURIComponent(v)}`;
}

module.exports = {
  ROOT, KEY, KEY_VER, MAX_BYTES, DEFAULT_SVG, DEFAULT_VER, MIME,
  detectMime, validateBuffer, load, save, reset, status, urlFor, filePath, settingName, settingVer,
};
