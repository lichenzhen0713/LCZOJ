'use strict';

const app = document.getElementById('app');

/* ---------- 路由 ---------- */
let SITE_NAME = 'LCZOJ';
/* v2.8.1：记住最近一次设置的「页面标题」。
   背景：applySiteBrand() 在每次渲染后会调用一次，原本用 setPageTitle('') 想让标题带上
   最新站点名，但那会把「系统设置 - 站点名」直接清成只剩「站点名」，表现为
   "系统设置页/其它页的标题文字不对"。改为用当前页标题重算，站点名变更时标题依然完整。 */
let LAST_PAGE_TITLE = '';
function setPageTitle(t) {
  LAST_PAGE_TITLE = t || '';
  document.title = (t ? t + ' - ' : '') + SITE_NAME;
}

/* 复制文本到剪贴板（含 execCommand 降级） */
async function copyText(text) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { /* ignore */ }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  return ok;
}

function parseHash() {
  const raw = location.hash.slice(1) || '/home';
  const [path, qs] = raw.split('?');
  return { path: path.replace(/\/+$/, '') || '/', query: new URLSearchParams(qs || '') };
}

/* 来源页记录：进入新页面时记录上一个 hash，供「返回」按钮动态跳回来源页面。
   持久化到 sessionStorage，刷新页面后仍保留来源（否则提交后刷新会丢失"返回题目"） */
let PREV_HASH = sessionStorage.getItem('oj_prev_hash') || '';
let CURRENT_HASH = sessionStorage.getItem('oj_cur_hash') || '';
function trackPrevHash() {
  const cur = location.hash || '#/home';
  if (cur !== CURRENT_HASH) {
    PREV_HASH = CURRENT_HASH;
    CURRENT_HASH = cur;
    try {
      sessionStorage.setItem('oj_prev_hash', PREV_HASH);
      sessionStorage.setItem('oj_cur_hash', CURRENT_HASH);
    } catch { /* ignore */ }
  }
}
/** 把来源 hash 收敛为安全的站内链接（S3）：只接受 `#/…` 且只保留常见 URL 字符，其余一律丢弃 */
function safeHashHref(h) {
  const s = String(h == null ? '' : h).trim();
  if (!/^#\//.test(s)) return '';
  const cleaned = s.replace(/[^A-Za-z0-9\-_./?=&%#:+~@!,;()[\]]/g, '');
  return /^#\//.test(cleaned) ? cleaned : '';
}
/** 返回链接：有来源页时返回来源页，否则回退到 fallback。
 *  S3：返回值会被拼进 6+ 处 href，因此这里统一做字符白名单 + escapeHtml，调用点无需再处理。 */
function backHref(fallback) {
  const prev = PREV_HASH && PREV_HASH !== CURRENT_HASH ? PREV_HASH : '';
  const href = safeHashHref(prev) || safeHashHref(fallback) || '#/home';
  return escapeHtml(href);
}
/** 返回按钮文案：来源页是题目页 → 「返回题目」；提交记录页 → 「返回提交记录」等 */
function backLabel(fallbackLabel) {
  const prev = PREV_HASH && PREV_HASH !== CURRENT_HASH ? PREV_HASH.replace(/^#\//, '') : '';
  if (!prev) return fallbackLabel;
  const seg = prev.split('/').filter(Boolean);
  const m = { problem: '返回题目', problems: '返回题目', submission: '返回提交详情', submissions: '返回提交记录', discussion: '返回讨论', discussions: '返回讨论区', contest: '返回比赛', contests: '返回比赛列表', editorial: '返回题解', articles: '返回题解与专栏', admin: '返回管理后台', user: '返回个人中心', ranking: '返回排行榜', home: '返回首页' };
  return m[seg[0]] || fallbackLabel;
}

/* 题目编辑器的返回按钮信息（{ href, label }）。
   新建题目保存后页面会跳到编辑页（hash 变为 admin/problem/ID），若不固化来源，
   返回按钮会被中间页覆盖成「返回管理后台」；这里在首次渲染新建编辑器时记录来源，保存后沿用。 */
let problemEditorBack = null;

/* 顶栏动作区（铃铛/私信/深色/头像菜单）的签名：仅在登录态、用户资料或功能开关变化时才重建 DOM */
let lastTopbarSig = null;

/* 启动阶段预取的主页数据：供首屏 renderHome 复用，避免重复请求 */
let bootHomeData = null;

function nav(path, query) {
  let h = '#/' + String(path).replace(/^\/+/, '');
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) h += '?' + qs;
  }
  if (location.hash === h) route();
  else location.hash = h;
}

/** 邮件发送失败原因 → 面向用户的简短说明（用于验证码直接展示时的提示语） */
function mailReason(reason) {
  const r = String(reason || '');
  if (!r || r === 'ignored') return '';
  if (r === 'smtp_not_configured') return '（管理员尚未配置邮件服务）';
  if (r === 'smtp_timeout') return '（连接邮件服务器超时）';
  if (/auth|535|535|认证|username|password/i.test(r)) return '（邮件服务认证失败，请管理员检查 SMTP 账号与授权码）';
  if (/ECONN|ETIMEDOUT|ENOTFOUND|connect/i.test(r)) return '（无法连接邮件服务器，请管理员检查 SMTP 地址与端口）';
  return r ? `（${r}）` : '';
}

/** 注册 / 邮箱验证类接口的错误 → 面向用户的友好文案（限流 429 明确告诉用户稍后重试） */
function authErrorText(e) {
  const msg = String((e && e.message) || '操作失败，请稍后重试');
  if (e && e.status === 429) return `${msg}；请稍后再试`;
  return msg;
}

/* 头像：优先用户上传图；无则生成默认头像（首字符 + 由用户名确定的颜色） */
function avatarColorSeed(name) {
  let h = 0;
  const s = String(name || '?');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function userAvatarHtml(u, size = 32) {
  const name = (u && u.username) || (u && u.nickname) || '?';
  const first = escapeHtml((name.trim()[0] || '?').toUpperCase());
  const s = typeof size === 'number' ? size + 'px' : size;
  if (u && u.avatar) {
    // 图片加载失败（外链失效 / 头像文件被清理）时回退为默认字母头像，避免出现破图
    return `<span class="avatar-img" style="width:${s};height:${s}"><img src="${escapeHtml(u.avatar)}" alt="头像" loading="lazy" decoding="async" data-uname="${escapeHtml(String((u && u.username) || ''))}" onerror="avatarImgFallback(this)" /></span>`;
  }
  const hue = avatarColorSeed(u && u.username);
  return `<span class="avatar avatar-gen" style="width:${s};height:${s};font-size:${Math.max(11, Math.round(size * 0.45))}px;background:hsl(${hue},55%,55%)">${first}</span>`;
}

/** 头像图片加载失败：就地退化为默认字母头像（与 userAvatarHtml 的无图分支一致） */
function avatarImgFallback(img) {
  try {
    const holder = img.parentElement;
    if (!holder) { img.style.display = 'none'; return; }
    const size = parseInt(holder.style.width, 10) || 32;
    const uname = (img.dataset.uname || '').trim() || '?';
    holder.classList.remove('avatar-img');
    holder.classList.add('avatar', 'avatar-gen');
    holder.style.background = `hsl(${avatarColorSeed(uname)},55%,55%)`;
    holder.style.fontSize = Math.max(11, Math.round(size * 0.45)) + 'px';
    holder.textContent = escapeHtml(uname[0].toUpperCase());
  } catch { /* ignore */ }
}

/** 正文内容最大宽度（全站统一，后台可配） */
let contentWidthCfg = '';
function applyContentWidth(px) {
  try {
    if (px !== undefined) contentWidthCfg = px;
    applyEffectiveWidth();
  } catch { /* ignore */ }
}

/* ---------- 页面宽度：站长可在后台为每个页面单独设置宽度 ---------- */
/** 可单独设置宽度的页面（key 与路由首段一致；default = 其它页面） */
const PAGE_WIDTH_LIST = [
  ['home', '首页'],
  ['problems', '题库列表'],
  ['problem', '题目详情'],
  ['submissions', '提交记录'],
  ['ranking', '积分排行榜'],
  ['rating-rank', '等级分排行榜'],
  ['articles', '专栏 / 博客列表'],
  ['article', '博客文章'],
  ['editorial', '题解'],
  ['discussions', '讨论区'],
  ['contests', '比赛列表'],
  ['contest', '比赛详情'],
  ['user', '个人中心'],
  ['default', '其它页面'],
];
/** 内置默认宽度（px）；未列出的页面沿用后台的「全站页面宽度」（默认 1320） */
const PAGE_WIDTH_BUILTIN = {
  article: 860,
  editorial: 860,
};
let sitePageWidths = {};   // 后台为各页面设置的宽度
let currentPageKey = 'default';

/** 后台下发的各页面宽度（JSON 字符串或对象） */
function applySitePageWidths(v) {
  if (v !== undefined) {
    let obj = v;
    if (typeof obj === 'string') { try { obj = JSON.parse(obj || '{}'); } catch { obj = {}; } }
    sitePageWidths = obj && typeof obj === 'object' ? obj : {};
  }
  applyEffectiveWidth();
}
/** 当前页面的最终宽度（'' = 用后台全站宽度） */
function pageWidthFor(key) {
  const s = parseFloat(sitePageWidths[key]);
  if (Number.isFinite(s) && s > 0) return Math.max(600, Math.min(2600, Math.round(s)));
  const b = PAGE_WIDTH_BUILTIN[key];
  if (Number.isFinite(b) && b > 0) return b;
  return '';
}
/** 应用当前页面的宽度（路由切换 / 设置变更时调用） */
function applyEffectiveWidth() {
  try {
    const per = pageWidthFor(currentPageKey);
    const raw = per === '' ? contentWidthCfg : per;
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0) document.documentElement.style.setProperty('--content-max-width', Math.max(600, Math.min(2600, Math.round(n))) + 'px');
    else document.documentElement.style.removeProperty('--content-max-width');
  } catch { /* ignore */ }
}
/** 路由 → 页面宽度 key */
function pageKeyFor(parts) {
  if (!parts || !parts.length) return 'home';
  const p = parts[0];
  if (p === 'admin' || p === 'settings') return p;
  if (p === 'editorial' && (parts[1] === 'new' || parts[1] === 'edit')) return 'default';
  if (PAGE_WIDTH_LIST.some(([k]) => k === p)) return p;
  return 'default';
}
/** 设置当前页面 key 并应用宽度 */
function applyPageWidth(key) {
  currentPageKey = key || 'default';
  try { app.dataset.page = currentPageKey; } catch { /* ignore */ }
  applyEffectiveWidth();
}

/** 首页宽度（后台可单独设置；留空=保持原始宽度） */
let homeWidthCfg = '';
function applyHomeWidth(px) {
  try {
    if (px !== undefined) homeWidthCfg = px;
    const n = parseFloat(homeWidthCfg);
    if (Number.isFinite(n) && n > 0) document.documentElement.style.setProperty('--home-max-width', Math.max(760, Math.min(2600, Math.round(n))) + 'px');
    else document.documentElement.style.removeProperty('--home-max-width');
  } catch { /* ignore */ }
}

/* ---------- 网站外观：固定主题预设（一键套用）＋ 自定义 ---------- */
const THEME_PRESETS = [
  { key: 'default', name: '默认蓝', colors: {} },
  { key: 'green', name: '青翠绿', colors: {
    accent: '#00b96b', accent_hover: '#009e5b', bg: '#f2fbf6', card: '#ffffff', sidebar: '#ffffff',
    text: '#26332c', text_light: '#6d7f75', border: '#d6ecdf',
    dark_bg: '#0d1512', dark_card: '#16211c', dark_sidebar: '#0f1a15', dark_text: '#e4efe8' } },
  { key: 'cyan', name: '青碧', colors: {
    accent: '#13c2c2', accent_hover: '#0fa8a8', bg: '#f1fbfb', card: '#ffffff', sidebar: '#ffffff',
    text: '#22333a', text_light: '#67808a', border: '#cfe9e9',
    dark_bg: '#0c1416', dark_card: '#152024', dark_sidebar: '#0d181a', dark_text: '#e2f0f2' } },
  { key: 'orange', name: '暖橙', colors: {
    accent: '#fa8c16', accent_hover: '#e07a0c', bg: '#fff8f0', card: '#ffffff', sidebar: '#ffffff',
    text: '#3a2c1e', text_light: '#87715d', border: '#f2ddc4',
    dark_bg: '#15100b', dark_card: '#211a13', dark_sidebar: '#191309', dark_text: '#f2e7db' } },
  { key: 'purple', name: '紫罗兰', colors: {
    accent: '#722ed1', accent_hover: '#6125b8', bg: '#f8f5ff', card: '#ffffff', sidebar: '#ffffff',
    text: '#2f2740', text_light: '#786d8f', border: '#e2d8f7',
    dark_bg: '#120e1b', dark_card: '#1c1626', dark_sidebar: '#140f1d', dark_text: '#ece4f8' } },
  { key: 'rose', name: '玫红', colors: {
    accent: '#eb2f96', accent_hover: '#d1217f', bg: '#fff5fa', card: '#ffffff', sidebar: '#ffffff',
    text: '#3a2430', text_light: '#8b6c7d', border: '#f6d6e7',
    dark_bg: '#150b11', dark_card: '#22131c', dark_sidebar: '#190f15', dark_text: '#f6e3ee' } },
  { key: 'indigo', name: '靛蓝', colors: {
    accent: '#2f54eb', accent_hover: '#2544c9', bg: '#f4f6ff', card: '#ffffff', sidebar: '#ffffff',
    text: '#252c47', text_light: '#6f789a', border: '#d8e0fb',
    dark_bg: '#0d1020', dark_card: '#171c30', dark_sidebar: '#0f1222', dark_text: '#e6eaf8' } },
  { key: 'graphite', name: '石墨', colors: {
    accent: '#5b6b7c', accent_hover: '#4a5967', bg: '#f5f6f8', card: '#ffffff', sidebar: '#ffffff',
    text: '#282f36', text_light: '#6f7b87', border: '#dfe3e8',
    dark_bg: '#0f1215', dark_card: '#191d22', dark_sidebar: '#12161a', dark_text: '#e6e9ec' } },
];

/** 网站外观里可自定义的颜色字段：[文本框 id, 设置键, 标签, 默认颜色]。
 *  默认色既是颜色选择器的初始值，也是「套用默认主题（该主题配色留空）」时的回显色 ——
 *  否则从其它主题切回默认主题后，所有取色器都会显示成白色（历史 bug）。 */
const AP_COLOR_FIELDS = [
  ['ap-accent', 'theme_accent', '主题色（按钮 / 链接）', '#0a8dff'],
  ['ap-accent-hover', 'theme_accent_hover', '主题色（悬停）', '#0077e6'],
  ['ap-bg', 'theme_bg', '页面背景色', '#f5f7fa'],
  ['ap-card', 'theme_card', '卡片 / 面板背景色', '#ffffff'],
  ['ap-sidebar', 'theme_sidebar', '侧边栏背景色', '#ffffff'],
  ['ap-text', 'theme_text', '正文文字色', '#2c3e50'],
  ['ap-text-light', 'theme_text_light', '次要文字色', '#7b8794'],
  ['ap-border', 'theme_border', '边框 / 分割线颜色', '#e5e9f0'],
  ['ap-dark-bg', 'theme_dark_bg', '夜间页面背景', '#0f1319'],
  ['ap-dark-card', 'theme_dark_card', '夜间卡片背景', '#171d29'],
  ['ap-dark-sidebar', 'theme_dark_sidebar', '夜间侧边栏背景', '#141a25'],
  ['ap-dark-text', 'theme_dark_text', '夜间正文文字', '#e6edf5'],
];

/** 网站外观自定义（后台「系统设置 → 网站外观」）。
 *  把主题色 / 背景 / 卡片色 / 侧边栏色 / 文字色 / 圆角 / 字号 / 字体注入一张动态样式表：
 *  选择器带 html 前缀并使用 !important，能压过历史 !important 规则；未配置的项直接不输出，清空即回到默认外观。
 *  兼容两种入参形态：前台 /api/home 返回的 appearance（accent/bg/…）与后台表单的 theme_* 字段名。 */
let appearanceCfg = {};
function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '').trim();
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
/** 把颜色按比例混向目标色（t=0 原色，t=1 目标色） */
function mixHex(hex, target, t) {
  const a = hexToRgb(hex);
  const b = hexToRgb(target);
  if (!a || !b) return hex;
  const m = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return '#' + m.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/* ---------- 外观配置值的安全处理（L10） ----------
   appearance 来自 /api/home，会被直接拼进 <style>；任何来自配置的字符串都必须先过白名单 / 夹取，
   否则可以注入任意 CSS（借 url() 外发访问者信息、伪装界面）。非法值一律回退默认（不输出该条规则）。 */

/** 允许的字体栈（与后台「网站外观」下拉框中的选项完全一致；命中后输出白名单里的原串） */
const SAFE_BODY_FONTS = [
  '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
  '"PingFang SC","Microsoft YaHei",sans-serif',
  'Georgia,"Times New Roman",serif',
  '"KaiTi","STKaiti",serif',
  '"SimSun","Songti SC",serif',
  '"Comic Sans MS","Segoe UI",cursive',
];
const SAFE_CODE_FONTS = [
  'Consolas,"Courier New",monospace',
  '"JetBrains Mono","Fira Code",Consolas,monospace',
  'Menlo,Monaco,"Courier New",monospace',
  '"Cascadia Code",Consolas,monospace',
];
const SAFE_TITLE_FONTS = SAFE_BODY_FONTS.concat(['Consolas,"Courier New",monospace']);
const fontKey = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
/** 字体栈白名单：不在列表里（含任何多余字符）一律回退默认 */
function safeFontStack(v, list) {
  const key = fontKey(v);
  if (!key) return '';
  const hit = (list || SAFE_BODY_FONTS).find((f) => fontKey(f) === key);
  return hit || '';
}
/** 颜色白名单：#rgb / #rrggbb / #rrggbbaa，或 rgb()/rgba()（数值必须合法且在范围内），其余回退默认 */
function safeColor(v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return '';
  if (/^#[0-9a-fA-F]{3}$/.test(raw) || /^#[0-9a-fA-F]{6}$/.test(raw) || /^#[0-9a-fA-F]{8}$/.test(raw)) return raw.toLowerCase();
  const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*)?\)$/i.exec(raw);
  if (m) {
    const r = Number(m[1]); const g = Number(m[2]); const b = Number(m[3]);
    const a = m[4] === undefined ? 1 : Number(m[4]);
    if (r <= 255 && g <= 255 && b <= 255 && a >= 0 && a <= 1) return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return '';
}
/** 数值型（px）配置：强制取数字并夹到 [min,max]；非数字一律回退默认（空串 = 不输出该条规则）
 *  decimals=0 时取整（圆角 / 字号），>0 时保留小数（字间距默认 0.5px，不能取整成 1px） */
function safePx(v, min, max, decimals = 0) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return '';
  const clamped = Math.max(min, Math.min(max, n));
  if (!decimals) return String(Math.round(clamped));
  const f = Math.pow(10, decimals);
  return String(Math.round(clamped * f) / f);
}
/** 字重白名单：100~900 的百位整数 */
function safeFontWeight(v) {
  const n = parseInt(String(v == null ? '' : v).trim(), 10);
  return Number.isFinite(n) && n >= 100 && n <= 900 && n % 100 === 0 ? String(n) : '';
}

/** 「网站外观」里是否配置了任何**配色**（主题色 / 背景 / 卡片 / 侧栏 / 文字 / 边框 / 夜间各色）。
 *  只有配色会替换 --border 并用 background-image:none 关掉 body 的装饰渐变，
 *  从而让「未选中标签」这类透明底 + 描边的按钮看起来"没框"；圆角 / 字号 / 字体不算。
 *  style.css 的 `html.look-custom body …` 规则用这个标记给它们补上可辨识的描边/底色
 *  （**只换颜色、不动结构**：border-width / padding / border-radius / box-shadow 等一概不写）。 */
function appearanceHasColor(a) {
  return !!(a && (a.accent || a.bg || a.card || a.sidebar || a.text || a.text_light || a.border
    || a.dark_bg || a.dark_card || a.dark_sidebar || a.dark_text));
}

function applyAppearance(cfg) {
  try {
    if (cfg) appearanceCfg = cfg;
    const raw = appearanceCfg || {};
    // 两种键名都接受：accent / theme_accent、bg / theme_bg …
    const val = (short, long) => {
      const v = raw[short] !== undefined && raw[short] !== null && raw[short] !== '' ? raw[short] : raw[long];
      return v === undefined || v === null ? '' : String(v);
    };
    const accent = safeColor(val('accent', 'theme_accent'));
    const accentHover = safeColor(val('accent_hover', 'theme_accent_hover') || (accent ? mixHex(accent, '#000000', 0.12) : ''));
    const a = {
      accent,
      accent_hover: accentHover,
      bg: safeColor(val('bg', 'theme_bg')),
      card: safeColor(val('card', 'theme_card')),
      sidebar: safeColor(val('sidebar', 'theme_sidebar')),
      text: safeColor(val('text', 'theme_text')),
      text_light: safeColor(val('text_light', 'theme_text_light')),
      border: safeColor(val('border', 'theme_border')),
      dark_bg: safeColor(val('dark_bg', 'theme_dark_bg')),
      dark_card: safeColor(val('dark_card', 'theme_dark_card')),
      dark_sidebar: safeColor(val('dark_sidebar', 'theme_dark_sidebar')),
      dark_text: safeColor(val('dark_text', 'theme_dark_text')),
      radius: safePx(val('radius', 'theme_radius'), 0, 40),
      font_size: safePx(val('font_size', 'theme_font_size'), 12, 20),
      font: safeFontStack(val('font', 'theme_font'), SAFE_BODY_FONTS),
      code_font: safeFontStack(val('code_font', 'theme_code_font'), SAFE_CODE_FONTS),
    };
    const light = [];
    const dark = [];
    // v2.7.5：配置过任何**配色**时，给 <html> 打一个 look-custom 标记。
    // 自定义配色会替换 --border，并用 background-image:none 关掉页面装饰渐变（body::before），
    // 后台标签行 / 二级子标签这类「透明底 + --border 描边」的按钮于是退化成"只有文字"。
    // style.css 里 `html.look-custom body …` 那组规则据此把它们的描边/底色换成跟随主题的颜色
    // （**只换颜色，不换结构**）；默认配色下不加这个类，因此默认主题的观感与改动前**完全一致**。
    if (!appearanceHasColor(a)) document.documentElement.classList.remove('look-custom');
    else document.documentElement.classList.add('look-custom');
    const put = (arr, name, v) => { if (v) arr.push(`${name}:${v};`); };
    put(light, '--accent', a.accent);
    put(light, '--accent-hover', a.accent_hover);
    put(light, '--bg', a.bg);
    put(light, '--card', a.card);
    put(light, '--border', a.border);
    put(light, '--text', a.text);
    put(light, '--text-light', a.text_light);
    put(light, '--radius', a.radius ? a.radius + 'px' : '');
    // 主题色在夜间模式同样要跟随（原先只写进浅色 :root，夜间模式用的是样式表里硬编码的蓝色，
    // 于是「系统设置」的二级标题小竖杠、版本号徽章等用 var(--accent) 的元素在夜间不跟主题变化）。
    // 夜间模式把主题色稍微提亮，保证在深色底上的对比度。
    if (a.accent) {
      put(dark, '--accent', mixHex(a.accent, '#ffffff', 0.12));
      put(dark, '--accent-hover', mixHex(a.accent_hover || a.accent, '#ffffff', 0.2));
    }
    put(dark, '--bg', a.dark_bg);
    put(dark, '--card', a.dark_card);
    put(dark, '--text', a.dark_text);

    let css = '';
    if (light.length) css += `html:root{${light.join('')}}`;
    if (dark.length) css += `html body.dark{${dark.join('')}}`;
    // 十六进制 → rgba（用于「保留半透明」：卡片/表头仍要能透出后面的内容，毛玻璃才看得见）
    const rgbaOf = (hex, alpha) => {
      const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
      if (!m) return '';
      const n = parseInt(m[1], 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    };
    // 页面背景：自定义背景色时**保留装饰光晕层**（否则卡片毛玻璃后面没有可模糊的内容，
    // 看起来就"没有毛玻璃效果"），只把光晕调淡一些以适应自定义底色。
    if (a.bg) css += `html body{background-color:${a.bg}!important;background-image:none!important}html body::before{opacity:.7!important}`;
    if (a.dark_bg) css += `html body.dark{background-color:${a.dark_bg}!important;background-image:none!important}html body.dark::before{opacity:.6!important}`;
    if (a.font_size) css += `html body{font-size:${a.font_size}px!important}`;
    if (a.font) css += `html body,html .btn,html .input,html select.input,html .card-title,html .page-title,html .table,html .hero-content h1{font-family:${a.font}!important}`;
    if (a.code_font) css += `html pre,html code,html .mono,html .code-view,html textarea.mono,html .CodeMirror{font-family:${a.code_font}!important}`;
    if (a.radius) css += `html .card,html .btn,html .input,html select.input,html .table-scroll,html .tag,html .chip,html .user-menu,html .modal-backdrop .card,html .status-banner,html .tc-chip{border-radius:${a.radius}px!important}`;
    // 侧边栏（手机端同时是底部导航栏）：浅色模式与夜间模式分开适配，
    // 否则浅色的侧边栏配色在夜间模式会显得突兀（历史 bug）。
    if (a.sidebar) css += `html body:not(.dark) .sidebar{background:${a.sidebar}!important;background-image:none!important}`;
    const darkSide = a.dark_sidebar || (a.dark_card ? mixHex(a.dark_card, a.accent || '#000000', 0.05) : '');
    if (darkSide) css += `html body.dark .sidebar{background:${darkSide}!important;background-image:none!important}`;
    // 卡片 / 表格容器：自定义卡片色时用**半透明**版本并保留玻璃高光渐变
    // （以前是整体换成不透明纯色 + 去掉渐变，那样毛玻璃就完全看不出来了）。
    const cardTint = a.card ? (rgbaOf(a.card, 0.5) || a.card) : '';
    const darkCardTint = a.dark_card ? (rgbaOf(a.dark_card, 0.66) || a.dark_card) : '';
    if (darkCardTint) css += `html body.dark .card,html body.dark .table-scroll,html body.dark .modal-backdrop .card{background-color:${darkCardTint}!important}`;
    if (cardTint) css += `html body:not(.dark) .card,html body:not(.dark) .table-scroll{background-color:${cardTint}!important}`;
    // 主题色必须真正改变主要交互元素：主按钮 / 选中标签 / 侧栏高亮等原本是硬编码蓝色渐变，需要显式覆盖。
    // 覆盖时**只换颜色、不换结构**：默认主题的选中按钮 / 主按钮底色是
    //   .btn / .chip.active      background: linear-gradient(135deg, #0a8dff, #4a6cf7)
    //   .btn:hover               background: linear-gradient(135deg, #0077e6, #3d5ef2)   （两档色标各压暗约 12%）
    // 即「background-image 是渐变 + background-color 透明」，所以自定义主题也只替换这两个渐变色标，
    // 绝不改成纯色实心（更不能用 background-image:none 把渐变关掉，那会造成结构差异）。
    if (a.accent) {
      const tintDark = mixHex(a.accent, '#000000', 0.72);
      // hover 渐变的第二个色标：沿用默认主题「再深一档」的关系（#4a6cf7 → #3d5ef2 约压暗 12%）
      const accentDeep = mixHex(a.accent_hover || a.accent, '#000000', 0.12);
      // 侧边栏选中项：底色必须明显区别于侧边栏自身底色（否则设了自定义侧边栏色后「选中」几乎看不出来），
      // 文字颜色按选中底色的明暗自动选白字或深色主题字，保证可读。
      const sideBase = a.sidebar || '#ffffff';
      const activeBg = mixHex(sideBase, a.accent, 0.22);
      const bgRgb = hexToRgb(activeBg) || [255, 255, 255];
      const bgLum = (0.2126 * bgRgb[0] + 0.7152 * bgRgb[1] + 0.0722 * bgRgb[2]) / 255;
      const activeText = bgLum < 0.55 ? '#ffffff' : mixHex(a.accent, '#000000', 0.45);
      // 选中态 / 主按钮：与默认主题**同构的渐变**，只把两个色标换成主题色。
      // 三个声明与默认主题逐项对应：background-image 有渐变、background-color 透明、文字白色；
      // 描边**不写**（默认 .btn / .chip.active 的 border-color 本来就是 transparent，交给默认规则即可）。
      css += `html .btn:not(.btn-ghost):not(.btn-danger),html .btn-primary,html .chip.active,html .hero-search .btn,html .pagination .active,html .pagination .page-active{background-image:linear-gradient(135deg, ${a.accent}, ${a.accent_hover})!important;background-color:transparent!important;color:#fff!important}`;
      // hover：默认 hover 是「更深一档的渐变」（不是纯色），这里同样用渐变，只换色标
      css += `html .btn:not(.btn-ghost):not(.btn-danger):hover,html .btn-primary:hover,html .chip.active:hover,html .hero-search .btn:hover{background-image:linear-gradient(135deg, ${a.accent_hover}, ${accentDeep})!important;background-color:transparent!important}`;
      // 下面两类元素在默认主题里本来就是**实心**（style.css 写的是 background: var(--accent)），
      // 与主按钮的渐变**不同构**，所以不能跟着上面那条渐变规则走：单独摘出来，保持实心、只换颜色。
      //   · .switch input:checked + .slider  开关轨道（默认 background: var(--accent)，无 background-image）
      css += `html .switch input:checked + .slider{background:${a.accent}!important}`;
      //   · .submit-modes .chip.active       提交页「提交代码 / 提交代码文件」切换胶囊
      //     （默认 background: var(--accent) !important，也是实心；放在渐变:hover 规则之后，权重 (0,4,1) 稳压它）
      css += `html .submit-modes .chip.active,html .submit-modes .chip.active:hover{background:${a.accent}!important;border-color:${a.accent}!important;color:#fff!important}`;
      css += `html body:not(.dark) .side-nav > a.active{background:${activeBg}!important;background-image:none!important;color:${activeText}!important}`;
      css += `html body:not(.dark) .side-nav > a.active i{color:${activeText}!important}`;
      // 选中项左侧的主题色竖条（原有设计），确保自定义主题下也保留
      css += `html .side-nav > a.active::before{background:${a.accent}!important}`;
      // 夜间模式侧边栏是深色底：高饱和的主题色直接当文字色对比度太低，用提亮后的同色系
      const accentOnDark = mixHex(a.accent, '#ffffff', 0.42);
      css += `html body.dark .side-nav > a.active{background:${tintDark}!important;color:${accentOnDark}!important}html body.dark .side-nav > a.active i{color:${accentOnDark}!important}`;
      css += `html .side-nav > a:hover i{color:${a.accent}!important}`;
      css += `html .input:focus,html .textarea:focus,html select.input:focus{border-color:${a.accent}!important}`;
      css += `html .sidebar .brand i,html .sidebar .brand:hover i{background:none!important;-webkit-text-fill-color:${a.accent}!important;color:${a.accent}!important}`;
      css += `html .page-title{border-left-color:${a.accent}!important}`;
      // 首页大标题区：跟随主题色但不压暗（浅色模式保持毛玻璃质感，只加一层淡色主题光晕）
      const accentTint = rgbaOf(a.accent, 0.26) || a.accent;
      const accentTint2 = rgbaOf(a.accent, 0.12) || a.accent;
      css += `html body:not(.dark) .home-hero{background-image:radial-gradient(120% 130% at 8% -20%, ${accentTint}, transparent 58%), radial-gradient(120% 130% at 102% 8%, ${rgbaOf(a.accent, 0.18)}, transparent 58%)!important}`;
      css += `html body.dark .home-hero{background-image:linear-gradient(130deg, ${accentTint2}, rgba(255, 255, 255, .02) 40%, rgba(255, 255, 255, 0) 70%), radial-gradient(130% 120% at 100% 0%, ${rgbaOf(a.accent, 0.22)}, transparent 55%)!important}`;
    }

    let el = document.getElementById('appearance-style');
    if (!el) {
      el = document.createElement('style');
      el.id = 'appearance-style';
      document.head.appendChild(el);
    }
    el.textContent = css;
  } catch { /* ignore */ }
}

/** 网站标题自定义样式（后台「系统设置 → 网站外观 → 标题样式」）
 *  用内联样式 + important 写到侧栏站名与首页大标题上：既能压过历史 !important 规则，
 *  未配置时又能完全移除回到默认样式；不传参数表示"用当前配置重新套用"（换页后 DOM 重建时用）。 */
let siteTitleStyle = {};
function applySiteTitleStyle(style) {
  try {
    if (style) siteTitleStyle = style;
    const t = siteTitleStyle || {};
    // 后台配置的首页大标题字号在手机端同样生效（手机端无配置时用 CSS 默认值，见 style.css 的 ≤760px 规则）
    // L10：这些值同样来自 /api/home 并会写进行内样式，必须先过白名单 / 夹取
    const heroSize = safePx(t.hero_size, 12, 96) ? safePx(t.hero_size, 12, 96) + 'px' : '';
    const spacing = safePx(t.spacing, -5, 20, 2) !== '' ? safePx(t.spacing, -5, 20, 2) + 'px' : '';
    const titleFont = safeFontStack(t.font, SAFE_TITLE_FONTS);
    const titleColor = safeColor(t.color);
    const titleWeight = safeFontWeight(t.weight);
    const put = (el, prop, value) => {
      if (!el) return;
      if (value) el.style.setProperty(prop, value, 'important');
      else el.style.removeProperty(prop);
    };
    const side = document.getElementById('site-brand');
    put(side, 'font-family', titleFont);
    put(side, 'font-weight', titleWeight);
    put(side, 'color', titleColor);
    put(side, 'letter-spacing', spacing);
    // 侧栏站名字号由「系统设置 → 网站外观 → 侧栏站名字号」滑块独立控制（applyTitleSize → --brand-title-size），
    // Logo 尺寸由「Logo 大小」滑块控制（applyLogoSize → --brand-logo-size），这里都不再介入。
    document.querySelectorAll('.hero-content .hero-brand h1, .hero-content h1').forEach((h) => {
      put(h, 'font-size', heroSize);
      put(h, 'font-family', titleFont);
      put(h, 'font-weight', titleWeight);
      put(h, 'color', titleColor);
      put(h, 'letter-spacing', spacing);
    });
  } catch { /* ignore */ }
}

/* ---------- 网站图标（favicon，v2.7.9；v2.8.5 补默认图标版本号 + type） ----------
   站点图标统一由后端 /api/favicon 提供（未自定义时返回默认图标，绝不为 404）。
   index.html 里的 <link rel="icon"> 初始就指向它；这里负责在「后台换了图标」之后
   就地改写 href 并带上 ?v= 版本号，使浏览器立刻重新拉取 —— 无需刷新页面，
   标签页图标随即变化（换回默认图标同样走这里，只是回到默认版本号）。

   为什么**未自定义时也要带 ?v=**：Chrome 的 Favicons 库按「图标 URL」把位图长期存在
   本地（<用户目录>/Default/Favicons 的 favicon_bitmaps），URL 不变就一次都不重新请求。
   实测：服务端把 /api/favicon 的字节换掉之后，同一 profile 再打开首页
   **没有任何 favicon 请求**、数据库里的位图仍是旧的（16×16 = 489B / 32×32 = 492B，
   sha 前后完全一致）—— 这就是「上一轮换了默认图标、站长那里却仍然用不了」的根因。
   默认版本号三处同步：本文件 FAVICON_DEFAULT_VER = '286'、src/favicon.js 的 DEFAULT_VER、
   index.html 里 <link rel="icon"> 的 ?v=286；以后换默认图三处一起递增。 */
const FAVICON_DEFAULT_VER = '293';
/** 图标扩展名 → MIME（上传自定义图标后要同步 link 的 type，声明与实际格式必须一致） */
const FAVICON_MIME_BY_EXT = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon' };
/** 由「文件名（favicon.png）/ MIME」推图标类型；空 = 默认图标（SVG） */
function faviconMime(name) {
  const s = String(name == null ? '' : name).trim().toLowerCase();
  if (!s) return 'image/svg+xml';
  if (s.includes('/')) return s;                       // 已是 MIME
  return FAVICON_MIME_BY_EXT[s.split('.').pop()] || 'image/svg+xml';
}
/** 网站图标的访问地址：ver 非空时拼 ?v=（后台每次上传都会写入新的时间戳版本号）；
 *  为空时回落到默认图标版本号（同样带 ?v=，避免浏览器一直用本地缓存的旧位图） */
function faviconUrl(ver) {
  const v = String(ver == null ? '' : ver).trim() || FAVICON_DEFAULT_VER;
  return `/api/favicon?v=${encodeURIComponent(v)}`;
}
/** 把标签页图标指向 /api/favicon（带版本号破缓存），返回实际写入的地址。
 *  注意：始终复用 index.html 里**已有**的那一个 link[rel="icon"]，不新增重复的 link。
 *  @param {string} ver 版本号（后台时间戳；空 = 默认图标）
 *  @param {string} [name] 当前图标的文件名或 MIME（决定 link 的 type；空 = 默认 SVG） */
function applyFavicon(ver, name) {
  const href = faviconUrl(ver);
  try {
    const link = document.querySelector('link[rel="icon"]');
    // 只改 href / type：实际字节由 /api/favicon 按当前设置返回
    // （服务端 Cache-Control: no-cache + ?v= 版本号，浏览器换图后必然重新取）。
    if (link) {
      link.setAttribute('href', href);
      link.setAttribute('type', faviconMime(name));
    }
  } catch { /* ignore */ }
  return href;
}

/* ---------- 侧边栏 Logo 大小 / 站名字号（系统设置 → 网站外观，两个独立滑块） ----------
   默认值与 style.css 的 --brand-logo-size: 40px（v2.8.7 起，原 28px）/ --brand-title-size: 24px 一致。
   两者互不联动：站名字号用「侧栏站名字号」，未设置时回退默认 24px。 */
const BRAND_LOGO_DEFAULT = 28;   // 恢复默认尺寸（站长反馈放大过头）
const BRAND_LOGO_MIN = 18;
const BRAND_LOGO_MAX = 60;       // 恢复默认上限
const BRAND_TITLE_DEFAULT = 24;
const BRAND_TITLE_MIN = 12;
const BRAND_TITLE_MAX = 40;
/** 把后台输入折算成可用的 logo 尺寸：留空 / 非数字 → 默认 28；数字一律夹到 18~60（0 与负数 → 18） */
function brandLogoSize(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return BRAND_LOGO_DEFAULT;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return BRAND_LOGO_DEFAULT;
  return Math.max(BRAND_LOGO_MIN, Math.min(BRAND_LOGO_MAX, Math.round(n)));
}
/** 把后台输入折算成可用的侧栏站名字号：留空 / 非数字 → 默认 24；数字一律夹到 12~40 */
function brandTitleSize(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return BRAND_TITLE_DEFAULT;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return BRAND_TITLE_DEFAULT;
  return Math.max(BRAND_TITLE_MIN, Math.min(BRAND_TITLE_MAX, Math.round(n)));
}
/** 套用 Logo 尺寸，返回实际生效的 px 数值（供滑块旁的数值显示） */
function applyLogoSize(size) {
  const logo = brandLogoSize(size);
  try { document.documentElement.style.setProperty('--brand-logo-size', logo + 'px'); } catch { /* ignore */ }
  return logo;
}
/** 套用侧栏站名字号，返回实际生效的 px 数值（供滑块旁的数值显示） */
function applyTitleSize(size) {
  const title = brandTitleSize(size);
  try { document.documentElement.style.setProperty('--brand-title-size', title + 'px'); } catch { /* ignore */ }
  return title;
}

function renderTopbar() {
  const navLinks = document.querySelectorAll('#nav a');
  const { path, query } = parseHash();
  let section = (path.split('/')[1] || 'home');
  if (section === 'problem') section = 'problems';
  if (section === 'submission') section = 'submissions';
  if (section === 'discussion') section = 'discussions';
  if (section === 'contest') section = 'contests';
  if (section === 'editorial') section = 'articles';
  if (section === 'admin') section = 'admin';
  if (section === 'editorials') section = 'articles';
  if (section === 'articles') section = 'articles';
  // 等级分排行：侧边栏高亮「排行榜」（入口合并为积分排行）
  if (section === 'rating-rank') section = 'ranking';
  // 系统设置：侧边栏高亮「系统设置」而非「管理后台」
  if (path.split('/')[1] === 'settings') section = 'settings';
  else if (section === 'admin' && path.split('/')[2] === 'settings') section = 'settings';
  // 比赛上下文：**只有「赛题」页面**（#/problem/<id>?contest=<比赛 id>）高亮「比赛」。
  // v2.6.3 起 #/submissions 的 contest 参数兼作「来源」筛选（contest=all / 0 / only / <比赛 id>），
  // 因此**不能**再拿 submissions 上存在 contest 参数当比赛上下文：翻页时 URL 会带上 contest=all，
  // 老逻辑（section==='submissions' && query.get('contest') 为真）会把「提交记录」误判成比赛页，
  // 侧边栏「比赛」被高亮（这就是「翻页后变成赛时状态」的 bug）；提交记录页一律高亮「提交记录」。
  const contestCtx = query.get('contest') || '';
  if (section === 'problems' && /^[0-9]+$/.test(contestCtx) && contestCtx !== '0') {
    section = 'contests';
  }
  navLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('data-nav') === section));
  // 管理后台 / 系统设置：电脑端侧边栏显示（手机端由 CSS 隐藏，改从右下角头像菜单进入）
  const adminLink = document.querySelector('.admin-link');
  if (adminLink) adminLink.style.display = (Store.user && Store.user.is_admin) ? '' : 'none';
  const settingsLink = document.querySelector('.settings-link');
  if (settingsLink) settingsLink.style.display = (Store.user && Store.user.username === 'admin') ? '' : 'none';
  // v2.8.6：社区管理页（只公示用户权限变更记录）；v2.9.0 起为**公开页**，未登录也能查看，侧边栏入口对所有人显示
  // （default 隐藏写在 index.html 的行内样式里，避免首屏闪一下；手机端本就由 CSS 隐藏该入口）
  const moderationLink = document.querySelector('.moderation-link');
  // v2.9.0（站长要求）：社区管理是**公开公示页**，入口对所有人（含未登录）显示 —— 原先仅管理员可见。
  if (moderationLink) moderationLink.style.display = '';
  // 功能开关：关闭后全站隐藏入口（包括管理员）
  if (Store.features) {
    const discNav = document.querySelector('#nav a[data-nav="discussions"]');
    if (discNav) discNav.style.display = Store.features.discussion_enabled ? '' : 'none';
    const artNav = document.querySelector('#nav a[data-nav="articles"]');
    if (artNav) artNav.style.display = Store.features.article_enabled ? '' : 'none';
    // 积分系统关闭：隐藏侧边栏「排行榜」（积分）入口，仅保留「等级分」
    const rankNav = document.querySelector('#nav a[data-nav="ranking"]');
    if (rankNav) rankNav.style.display = (Store.features.points_enabled === false) ? 'none' : '';
    // 私信关闭：隐藏侧边栏 / 手机端的「私信」图标入口（未读数徽标随之隐藏，见 refreshBellBadge）
    // 注意：.side-nav > .nav-actions .nav-btn 带 display:inline-flex !important，
    // 因此这里必须用 important 行内样式才能藏住（普通 display:none 会被样式表压回去）。
    const pmNav = document.getElementById('msg-btn');
    if (pmNav) pmNav.style.setProperty('display', (Store.features.pm_enabled === false) ? 'none' : '', 'important');
  }

  // 顶栏动作区：仅当登录态 / 用户资料 / 功能开关变化时才重建，避免每次路由切换都销毁重建 DOM
  if (Store.user) refreshBellBadge();
  const topbarSig = JSON.stringify({ u: Store.user || null, f: Store.features || null });
  if (topbarSig === lastTopbarSig) return;
  lastTopbarSig = topbarSig;

  // 侧栏底部：三个图标按钮 + 头像（排版用的一行 flex，视觉透明，贴底）
  const navEl = document.getElementById('nav');
  navEl.querySelectorAll(':scope > .nav-actions, :scope > .nav-btn, :scope > .nav-avatar, :scope > .nav-menu, :scope > .nav-act, :scope > .nav-user').forEach((n) => n.remove());
  const row = document.createElement('div');
  row.className = 'nav-actions';
  if (Store.user) {
    const displayName = Store.user.username;
    row.innerHTML = `
        <button class="nav-btn" id="bell-btn" title="通知"><i class="fa-solid fa-bell"></i><span class="bell-badge" id="bell-badge" style="display:none">0</span></button>
        <a class="nav-btn" id="msg-btn" href="#/messages" title="私信" style="${Store.features && Store.features.pm_enabled === false ? 'display:none !important' : ''}"><i class="fa-solid fa-envelope"></i><span class="bell-badge" id="msg-badge" style="display:none">0</span></a>
        ${Store.user.is_admin ? '<a class="nav-btn fab-extra" id="fab-admin" href="#/admin" title="管理后台"><i class="fa-solid fa-gear"></i></a>' : ''}
        ${Store.user.username === 'admin' ? '<a class="nav-btn fab-extra" id="fab-settings" href="#/settings" title="系统设置"><i class="fa-solid fa-sliders"></i></a>' : ''}
        <a class="nav-btn fab-extra" id="fab-moderation" href="#/moderation" title="社区管理" style=""><i class="fa-solid fa-shield-halved"></i></a>
        <button class="nav-btn" id="dark-toggle" title="切换深色模式"><i class="fa-solid fa-moon"></i></button>
        <div class="user-menu-wrap" id="user-menu-wrap">
          <a class="nav-avatar" id="avatar-link" title="${escapeHtml(displayName)}">${userAvatarHtml(Store.user, 32)}</a>
          <div class="user-menu" id="user-menu" style="display:none">
            <div class="um-head">
              ${userAvatarHtml(Store.user, 46)}
              <div class="um-info">
                <div class="um-name">${userSpan(Store.user)}</div>
                <div class="um-meta">UID ${Store.user.uid} · 等级分 ${Store.user.rating}</div>
              </div>
            </div>
            <div class="um-list">
              <a class="um-item" href="#/user/${Store.user.uid}"><span class="um-ico"><i class="fa-solid fa-user"></i></span><span class="um-label">个人中心</span><i class="fa-solid fa-chevron-right um-arrow"></i></a>
              <a class="um-item" href="#/edit-profile"><span class="um-ico"><i class="fa-solid fa-user-pen"></i></span><span class="um-label">编辑资料</span><i class="fa-solid fa-chevron-right um-arrow"></i></a>
              <a class="um-item" href="#/user/${Store.user.uid}?tab=favorites"><span class="um-ico"><i class="fa-solid fa-star"></i></span><span class="um-label">我的收藏</span><i class="fa-solid fa-chevron-right um-arrow"></i></a>
              <a class="um-item" href="#/user/${Store.user.uid}?tab=articles"><span class="um-ico"><i class="fa-solid fa-newspaper"></i></span><span class="um-label">我的专栏</span><i class="fa-solid fa-chevron-right um-arrow"></i></a>
              <!-- 私信 / 管理后台 / 系统设置都不放在头像二级菜单：私信在侧边栏与手机端圆形按钮，管理后台与系统设置在侧边栏（手机端为圆形按钮） -->
              <div class="um-divider"></div>
              <button class="um-item um-logout" id="logout-btn"><span class="um-ico"><i class="fa-solid fa-right-from-bracket"></i></span><span class="um-label">退出登录</span></button>
            </div>
          </div>
        </div>
        <button class="nav-btn nav-actions-toggle" id="nav-actions-toggle" title="收起 / 展开快捷按钮"><i class="fa-solid fa-chevron-down"></i></button>`;
    navEl.appendChild(row);
    const avatarLink = document.getElementById('avatar-link');
    const wrap = document.getElementById('user-menu-wrap');
    avatarLink.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const m = document.getElementById('user-menu');
      if (!m) return;
      const show = m.style.display === 'none';
      m.style.display = show ? 'block' : 'none';
      if (wrap) wrap.classList.toggle('open', show);
    });
    document.getElementById('bell-btn').addEventListener('click', () => nav('notifications'));
    const fabToggle = document.getElementById('nav-actions-toggle');
    if (fabToggle) fabToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleFabCollapsed();
    });
    document.getElementById('logout-btn').addEventListener('click', async () => {
      try { await api.post('/api/logout'); } catch { /* ignore */ }
      Store.user = null;
      renderTopbar();
      toast('已退出登录', 'info');
      nav('home');
    });
    // 点击二级菜单里的任意一项后立刻收起菜单（否则跳转后菜单会一直留在页面上）
    document.querySelectorAll('#user-menu .um-item').forEach((item) => {
      item.addEventListener('click', () => closeUserMenu());
    });
  } else {
    row.innerHTML = `
        <button class="nav-btn" id="dark-toggle" title="切换深色模式"><i class="fa-solid fa-moon"></i></button>
        <a class="nav-btn" href="#/login" title="登录"><i class="fa-solid fa-right-to-bracket"></i></a>
        <a class="nav-btn" href="#/register" title="注册"><i class="fa-solid fa-user-plus"></i></a>
        <button class="nav-btn nav-actions-toggle" id="nav-actions-toggle" title="收起 / 展开快捷按钮"><i class="fa-solid fa-chevron-down"></i></button>`;
    navEl.appendChild(row);
    const fabToggleGuest = document.getElementById('nav-actions-toggle');
    if (fabToggleGuest) fabToggleGuest.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleFabCollapsed();
    });
  }
  bindDarkToggle();
  // 点头像以外的地方关闭头像菜单
  document.removeEventListener('click', closeUserMenu);
  document.addEventListener('click', closeUserMenu);
  // Esc 也能收起头像菜单
  document.removeEventListener('keydown', closeUserMenuOnEsc);
  document.addEventListener('keydown', closeUserMenuOnEsc);
}

/** Esc 收起头像二级菜单 */
function closeUserMenuOnEsc(ev) {
  if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) closeUserMenu();
}

function closeUserMenu(ev) {
  const m = document.getElementById('user-menu');
  if (!m || m.style.display === 'none') return;
  const holder = m.closest('.user-menu-wrap');
  if (ev && holder && holder.contains(ev.target)) return;
  m.style.display = 'none';
  if (holder) holder.classList.remove('open');
}

/** 收起 / 展开右下角快捷按钮。
 *  手机端点击后 DOM 会立即重排（其它圆形按钮出现或消失），浏览器随后补发的那次 click
 *  可能落到「因展开而出现在同一位置的头像」上，导致误弹头像二级菜单。
 *  这里在切换后主动关闭头像菜单，并在极短时间内屏蔽一次后续点击。 */
function toggleFabCollapsed() {
  const collapsed = !document.body.classList.contains('fab-collapsed');
  document.body.classList.toggle('fab-collapsed', collapsed);
  try { localStorage.setItem('oj_fab', collapsed ? 'collapsed' : ''); } catch { /* ignore */ }
  closeUserMenu();
  const wrap = document.getElementById('user-menu-wrap');
  if (wrap) wrap.classList.remove('open');
  try {
    const swallow = (ev) => {
      if (ev.target && ev.target.closest && ev.target.closest('#nav-actions-toggle')) return;
      ev.stopPropagation();
      ev.preventDefault();
      ev.stopImmediatePropagation && ev.stopImmediatePropagation();
    };
    document.addEventListener('click', swallow, true);
    setTimeout(() => document.removeEventListener('click', swallow, true), 400);
  } catch { /* ignore */ }
}

/* 深色模式：默认按时间自动（19:00–06:59 夜间为暗色），手动切换后按手动偏好 */
function isNight() {
  const h = new Date().getHours();
  return h >= 19 || h < 7;
}
function syncDarkIcon() {
  const btn = document.getElementById('dark-toggle');
  if (btn) {
    const icon = btn.querySelector('i');
    if (icon) icon.className = document.body.classList.contains('dark') ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
}
  }
function applyDarkMode() {
  const saved = localStorage.getItem('oj_dark');
  const dark = saved === '1' ? true : (saved === '0' ? false : isNight());
  document.body.classList.toggle('dark', dark);
  syncDarkIcon();
}
function bindDarkToggle() {
  const btn = document.getElementById('dark-toggle');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const dark = !document.body.classList.contains('dark');
    document.body.classList.toggle('dark', dark);
    localStorage.setItem('oj_dark', dark ? '1' : '0');
    syncDarkIcon();
  });
}

/* 通知未读数 + 私信未读数（合并为一个请求；15 秒内复用缓存，避免每次导航都请求） */
const badgeState = { t: 0, notifications: 0, messages: 0, loading: false };
function applyBadges() {
  const b1 = document.getElementById('bell-badge');
  if (b1) { b1.textContent = badgeState.notifications; b1.style.display = badgeState.notifications > 0 ? '' : 'none'; }
  const b2 = document.getElementById('msg-badge');
  if (b2) { b2.textContent = badgeState.messages; b2.style.display = badgeState.messages > 0 ? '' : 'none'; }
}
async function refreshBellBadge(force = false) {
  applyBadges();
  const fresh = Date.now() - badgeState.t < 15000;
  if (!force && (fresh || badgeState.loading)) return;
  badgeState.loading = true;
  try {
    const r = await api.get('/api/badges');
    badgeState.notifications = r.notifications || 0;
    badgeState.messages = r.messages || 0;
    badgeState.t = Date.now();
    applyBadges();
  } catch { /* ignore */ } finally {
    badgeState.loading = false;
  }
}

async function route() {
  trackPrevHash();
  renderTopbar();
  const { path, query } = parseHash();
  const parts = path.split('/').filter(Boolean);
  // 每个页面可以有自己的宽度（内置默认 / 后台设置 / 用户自定义），先按路由确定当前页面
  applyPageWidth(pageKeyFor(parts));
  // 离开题目编辑器时清除固化的返回来源，避免下次进入沿用旧来源
  const isProblemEditor = parts[0] === 'admin' && parts[1] === 'problem' && parts[2];
  if (!isProblemEditor) problemEditorBack = null;
  try {
    if (parts.length === 0) { nav('home'); return; }
    if (parts[0] === 'home') { await renderHome(); return; }
    // #/checkin：每日打卡页（与首页的「每日打卡」卡片同源，方便直接收藏 / 分享这个地址）
    if (parts[0] === 'checkin' && parts.length === 1) { await renderHome(); return; }
    if (parts[0] === 'problems' && parts.length === 1) { await renderProblems(query); return; }
    if (parts[0] === 'problem' && parts[1]) { await renderProblemDetail(parts[1], query); return; }
    if (parts[0] === 'submissions' && parts.length === 1) { await renderSubmissions(query); return; }
    if (parts[0] === 'submission' && parts[1]) { await renderSubmissionDetail(parts[1]); return; }
    if (parts[0] === 'ranking') { await renderRanking(query); return; }
    if (parts[0] === 'rating-rank') { await renderRatingRanking(query); return; }
    if (parts[0] === 'articles' && parts.length === 1) { await renderArticles(query); return; }
    if (parts[0] === 'favorites' && parts.length === 1) { await renderFavorites(query); return; }
    if (parts[0] === 'my-articles' && parts.length === 1) { await renderMyArticles(query); return; }
    if (parts[0] === 'notifications' && parts.length === 1) { await renderNotificationsPage(query); return; }
    if (parts[0] === 'messages' && parts.length === 1) {
      // 功能开关「私信」关闭：直接访问 #/messages 也一律拦住（不进入私信页面、不发请求）
      if (Store.features && Store.features.pm_enabled === false) { renderFeatureClosed('私信'); return; }
      await renderMessages(query); return;
    }
    if (parts[0] === 'help' && parts.length === 1) { await renderSitePage('help'); return; }
    if (parts[0] === 'agreement' && parts.length === 1) { await renderSitePage('agreement'); return; }
    if (parts[0] === 'contact' && parts.length === 1) { await renderSitePage('contact'); return; }
    if (parts[0] === 'about' && parts.length === 1) { await renderSitePage('about'); return; }
    if (parts[0] === 'rules' && parts.length === 1) { await renderSitePage('rules'); return; }
    if (parts[0] === 'editorials' && parts[1] === 'problem' && parts[2]) { await renderEditorialsList(parts[2], query); return; }
    if (parts[0] === 'user' && parts[1]) { await renderUserProfile(decodeURIComponent(parts[1]), query); return; }
    if (parts[0] === 'edit-profile' && parts.length === 1) { await renderEditProfile(); return; }
    if (parts[0] === 'discussions' && parts.length === 1) { await renderDiscussions(query); return; }
    if (parts[0] === 'discussion' && parts[1]) { await renderDiscussionDetail(parts[1], query); return; }
    if (parts[0] === 'contests' && parts.length === 1) { await renderContests(query); return; }
    if (parts[0] === 'contest' && parts[1]) { await renderContestDetail(parts[1], query); return; }
    if (parts[0] === 'moderation') { await renderModeration(query); return; }
    if (parts[0] === 'editorial' && parts[1] === 'new' && parts[2]) { await renderEditorialEditor(null, parts[2]); return; }
    if (parts[0] === 'editorial' && parts[1] === 'edit' && parts[2]) { await renderEditorialEditor(parts[2], null); return; }
    if (parts[0] === 'editorial' && parts[1]) { await renderEditorialDetail(parts[1], query); return; }
    if (parts[0] === 'login') { renderLogin(query); return; }
    if (parts[0] === 'register') { renderRegister(); return; }
    if (parts[0] === 'forgot-password' && parts.length === 1) { await renderForgotPassword(); return; }
    // v2.7.0：清理多余数据 / 批量生成用户 / 批量删除都并入系统设置 →
    // #/settings/cleanup、#/settings/batch-users、#/settings/batch-delete（侧边栏高亮「系统设置」）。
    // 旧地址 #/admin/cleanup 与 #/admin/batch-* 保留为重定向，不留死链接；`?c=` 之类的查询串由 nav() 带走。
    // v2.8.5：「积分计算」（原「全站积分结算」）不再是系统设置下与「功能设置」平级的一级分区，
    // 而是**「功能设置」的二级页面** #/settings/features/points —— 页头仍走 settingsTabs('features', …, 'points')，
    // 子标签里父项「功能设置」保持可见、子项「积分计算」为当前项，侧边栏高亮「系统设置」（renderTopbar 按 parts[1]==='settings' 判定）。
    if (parts[0] === 'settings' && parts[1] === 'features' && parts[2] === 'points') { await renderAdminPointsSettle(); return; }
    // 旧的 #/settings/points（一级地址）保留为重定向，不留死链。
    if (parts[0] === 'settings' && parts[1] === 'points') { nav('settings/features/points'); return; }
    if (parts[0] === 'settings' && parts[1] === 'cleanup') { await renderAdminCleanup(); return; }
    if (parts[0] === 'settings' && parts[1] === 'batch-users') { await renderAdminBatchUsers(); return; }
    if (parts[0] === 'settings' && parts[1] === 'batch-delete') { await renderAdminBatchDelete(); return; }
    if (parts[0] === 'settings' && parts.length <= 2) { await renderAdminSettings(parts[1]); return; }
    if ((parts[0] === 'verify' || parts[0] === 'verify-email') && parts.length === 1) { await renderVerifyEmail(query); return; }
    if (parts[0] === 'feedback' && parts.length === 1) { await renderFeedback(query); return; }
    if (parts[0] === 'admin') {
      if (parts.length === 1) { await renderAdminPanel('problems'); return; }
      if (parts[1] === 'users') { await renderAdminPanel('users'); return; }
      if (parts[1] === 'editorials') { await renderAdminPanel('editorials'); return; }
      // 专栏管理 / 讨论管理带子页面：parts[2] 为子页面 key（categories / boards），空或未知值=父页面列表
      if (parts[1] === 'articles') { await renderAdminPanel('articles', parts[2] || ''); return; }
      if (parts[1] === 'contests') { await renderAdminPanel('contests'); return; }
      if (parts[1] === 'discussions') { await renderAdminPanel('discussions', parts[2] || ''); return; }
      if (parts[1] === 'rejudge') { await renderAdminPanel('rejudge'); return; }
      // v2.7.0：板块 / 分类管理是「讨论管理」与「专栏管理」下的**子页面**（#/admin/discussions/boards、
      // #/admin/articles/categories）；旧的独立地址 #/admin/taxonomy 保留为重定向，直接跳到板块管理子页面，
      // 避免任何死链接；上一轮用过的 ?taxo=board 参数由 renderAdminDiscussions 内部兼容跳转。
      if (parts[1] === 'taxonomy') { nav('admin/discussions/boards'); return; }
      if (parts[1] === 'settings') { nav('settings' + (parts[2] ? '/' + parts[2] : '')); return; } // 已独立为 #/settings
      if (parts[1] === 'feedbacks') { await renderAdminPanel('feedbacks'); return; }
      // v2.7.0：「批量生成用户 / 批量删除」已并入系统设置，旧地址重定向到 #/settings/batch-*（不留死链接）
      if (parts[1] === 'batch-users') { nav('settings/batch-users'); return; }
      if (parts[1] === 'batch-delete') { nav('settings/batch-delete'); return; }
      // v2.7.0：「清理多余数据」已并入系统设置，旧地址重定向到 #/settings/cleanup（不留死链接）
      if (parts[1] === 'cleanup') { nav('settings/cleanup'); return; }
      if (parts[1] === 'problem' && parts[2] === 'new') { await renderAdminProblemEditor(null); return; }
      // 注意：import 必须排在「按 id 打开编辑器」之前，否则会被当成题目 id
      if (parts[1] === 'problem' && parts[2] === 'import') { await renderAdminProblemImport(); return; }
      if (parts[1] === 'problem' && parts[2]) { await renderAdminProblemEditor(parts[2]); return; }
      if (parts[1] === 'contest' && parts[2] === 'new') { await renderAdminContestEditor(null); return; }
      if (parts[1] === 'contest' && parts[2]) { await renderAdminContestEditor(parts[2]); return; }
    }
    app.innerHTML = '<div class="empty">页面不存在</div>';
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="empty">加载失败：${escapeHtml(e.message)}</div>`;
  } finally {
    // 页面与预览共用同一渲染管线：每次路由后都升级 .math 为 KaTeX（未加载成功则保持内置渲染）
    renderMath();
    // 所有 markdown 代码块 / 样例的 <pre> 增加「复制」按钮
    bindCodeCopy();
    // 首页大标题每次渲染都会重建，重新套用后台配置的标题样式
    applySiteTitleStyle();
    // 后台「网站外观」里未保存的预览不带出设置页：路由切换时回到「已保存」的配置
    applySavedLook();
    // 路由切换（点菜单项、点侧边栏、浏览器前进后退）时收起头像二级菜单
    closeUserMenu();
  }
}

/* ============================================================================
   数学公式渲染（重写版）
   ----------------------------------------------------------------------------
   分工：服务端 src/markdown.js 先用零依赖内置渲染器产出 HTML（保证任何情况下都有公式可看），
        客户端在 KaTeX 可用时接管升级为真正的 TeX 排版。
   约定（三处必须一致：src/markdown.js、本文件、public/css/style.css）：
     · 宿主元素：<span class="math" data-latex="…">（行内）/ <div class="math-block" data-latex="…">（行间）
     · KaTeX 接管成功后给宿主加 .kx 类 —— 样式表里内置排版全部写成 .math:not(.kx) …，
       两者互不干扰，KaTeX 输出永远不会被内置样式污染；
     · 内置渲染器的类名统一 mm- 前缀，**绝不**使用 mop / mfrac / msqrt / mtable 这类名字，
       它们与 KaTeX 内部类名同名，曾把 KaTeX 的 \log（.mop）压成竖排 flex（字符上下堆叠）。
   性能：同一公式整个会话只渲染一次（结果缓存）；每帧最多渲染 12ms，其余留给下一帧。
   ========================================================================== */
const MathRender = (() => {
  const KATEX_JS = [
    'https://cdn.bootcdn.net/ajax/libs/KaTeX/0.16.9/katex.min.js',
    'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js',
    'https://unpkg.com/katex@0.16.9/dist/katex.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js',
  ];
  const KATEX_CSS = [
    'https://cdn.bootcdn.net/ajax/libs/KaTeX/0.16.9/katex.min.css',
    'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css',
    'https://unpkg.com/katex@0.16.9/dist/katex.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/katex/0.16.9/katex.min.css',
  ];
  /** 含「大算符 / 分式 / 环境」的行内公式：按行间公式排版（上下限堆叠、分式不缩号），与洛谷一致 */
  const BIG_MATH_RE = /\\(?:sum|prod|coprod|int|oint|iint|iiint|bigcup|bigcap|bigoplus|bigotimes|bigsqcup|lim|limsup|liminf|max|min|sup|inf|frac|dfrac|tfrac|binom|dbinom|tbinom|choose|begin|over|atop)\b/;
  const HOST_SEL = '.math[data-latex], .math-block[data-latex]';
  const CACHE_MAX = 3000;
  const FRAME_BUDGET = 12;

  const cache = new Map();       // 渲染结果缓存：同一公式只算一次
  const queued = new Set();      // 已排队等待渲染的宿主元素
  let queue = [];
  let scheduled = false;
  let status = 'idle';           // idle | loading | ready | failed

  const nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  /** 渲染单个公式；成功则接管宿主（加 .kx），失败返回 false 并保留内置渲染结果 */
  function renderOne(el, latex, displayMode) {
    const promote = !displayMode && BIG_MATH_RE.test(latex);
    const key = (displayMode ? 'D' : (promote ? 'S' : 'I')) + '\u0000' + latex;
    let html = cache.get(key);
    if (html === undefined) {
      try {
        html = window.katex.renderToString(promote ? '\\displaystyle ' + latex : latex, {
          displayMode,
          throwOnError: false,   // 坏公式只标红，不炸整页
          errorColor: '#c0392b',
          output: 'html',        // 只出 HTML，省掉重复的 MathML 节点
          strict: false,
          trust: false,
        });
      } catch { html = null; }
      if (cache.size >= CACHE_MAX) cache.clear();
      cache.set(key, html);
    }
    if (!html) return false;
    el.innerHTML = html;
    el.classList.add('kx');               // 关键：内置排版立即让位给 KaTeX
    if (promote) el.classList.add('math-ds');
    el.dataset.katexDone = '1';
    return true;
  }

  /** 每帧只渲染 FRAME_BUDGET 毫秒，长题面/长讨论不会卡住滚动与输入 */
  function flush() {
    scheduled = false;
    if (status !== 'ready' || !window.katex) { queue = []; queued.clear(); return; }
    const t0 = nowMs();
    while (queue.length) {
      const job = queue.shift();
      queued.delete(job.el);
      if (!job.el.isConnected || job.el.dataset.katexDone) continue;
      renderOne(job.el, job.latex, job.displayMode);
      if (nowMs() - t0 > FRAME_BUDGET) break;
    }
    if (queue.length) schedule();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 0);
  }

  function enqueue(els) {
    if (status !== 'ready' || !window.katex || !els.length) return;
    let added = 0;
    for (const el of els) {
      if (!el || !el.isConnected || el.dataset.katexDone || queued.has(el)) continue;
      queued.add(el);
      queue.push({ el, latex: el.dataset.latex || '', displayMode: el.classList.contains('math-block') });
      added++;
    }
    if (added) schedule();
  }

  function collect(root) {
    const scope = (root && root.querySelectorAll) ? root : document;
    const out = [];
    scope.querySelectorAll(HOST_SEL).forEach((el) => { if (!el.dataset.katexDone) out.push(el); });
    return out;
  }

  /** 渲染入口：可传根节点（局部刷新），默认全文档扫描 */
  function render(root) {
    if (status === 'failed') return;
    const els = collect(root);
    if (!els.length) return;
    if (!window.katex) { loadKatex(); return; }   // 加载完成后会重新全量扫描
    enqueue(els);
  }

  /* ---------- KaTeX 按需加载：只有页面真的出现公式才拉取（4 个 CDN 依次回退） ---------- */
  function loadCss() {
    let i = 0;
    const tryNext = () => {
      if (i >= KATEX_CSS.length) return;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = KATEX_CSS[i++];
      link.crossOrigin = 'anonymous';
      link.onerror = tryNext;
      document.head.appendChild(link);
    };
    tryNext();
  }

  function loadKatex() {
    if (status === 'loading' || status === 'ready' || window.katex) return;
    status = 'loading';
    loadCss();
    let i = 0;
    const tryNext = () => {
      if (window.katex) { onReady(); return; }
      if (i >= KATEX_JS.length) { status = 'failed'; window.__katexFailed = true; return; }
      const s = document.createElement('script');
      s.src = KATEX_JS[i++];
      s.crossOrigin = 'anonymous';
      let settled = false;
      const next = () => { if (settled) return; settled = true; clearTimeout(timer); tryNext(); };
      // 单个 CDN 卡住不放：8 秒后换下一个，避免整页公式一直等
      const timer = setTimeout(next, 8000);
      s.onload = () => { if (settled) return; settled = true; clearTimeout(timer); window.katex ? onReady() : tryNext(); };
      s.onerror = next;
      document.head.appendChild(s);
    };
    tryNext();
  }

  function onReady() {
    status = 'ready';
    window.__katexFailed = false;
    render();       // 重新全量扫描：加载期间页面可能已经换过路由
    observe();
  }

  /* ---------- 动态插入的公式（讨论、私信、编辑器预览等）自动接管 ---------- */
  let observer = null;
  let pendingNodes = [];
  let observerScheduled = false;
  function observe() {
    if (observer || typeof MutationObserver !== 'function') return;
    const host = document.getElementById('app') || document.body;
    observer = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (!node || node.nodeType !== 1) continue;
          if (node.matches && node.matches(HOST_SEL)) pendingNodes.push(node);
          if (node.querySelectorAll) node.querySelectorAll(HOST_SEL).forEach((el) => pendingNodes.push(el));
        }
      }
      if (!pendingNodes.length || observerScheduled) return;
      observerScheduled = true;
      const run = () => { observerScheduled = false; const list = pendingNodes; pendingNodes = []; enqueue(list); };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else setTimeout(run, 0);
    });
    observer.observe(host, { childList: true, subtree: true });
  }

  /** 空闲预热：当前页面没有公式时也把 KaTeX 准备好，
   *  这样「先看题库、再点进题面」不会出现「内置渲染 → 跳变成 KaTeX」的过程 */
  function warm() {
    if (status !== 'idle' || window.katex) return;
    if (document.querySelector(HOST_SEL)) return;   // 页面有公式：render() 已经在加载了
    loadKatex();
  }

  return { render, warm, isReady: () => status === 'ready', status: () => status };
})();

/** 兼容旧调用点：渲染当前页面（或指定根节点）里的数学公式 */
function renderMath(root) { MathRender.render(root); }

(function warmUpKatex() {
  const start = () => {
    try {
      // v2.9.0 优化：首页/空路由几乎不会出现公式，却会因为"空闲预热"去外链 CDN 拉 KaTeX
      // （实测 katex.min.css 从 bootcdn 耗时 **约 3 秒**，与首屏资源抢带宽，是首页最后一个长尾）。
      // 这里在首页直接跳过预热；进入题库/题面等页面时 render() 仍会**按需加载**，公式照常渲染。
      // 同时把空闲等待放宽（8 秒 / 5 秒），避免与首屏绘制抢资源。
      const seg = String((location.hash || '').replace(/^#\/?/, '')).split('/')[0];
      if (!seg || seg === 'home') return;
      if (typeof requestIdleCallback === 'function') requestIdleCallback(() => MathRender.warm(), { timeout: 8000 });
      else setTimeout(() => MathRender.warm(), 5000);
    } catch { setTimeout(() => MathRender.warm(), 5000); }
  };
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
})();


/** 给所有 markdown 渲染出的代码块 / 样例等 <pre> 加「复制」按钮（已处理的跳过；代码编辑器的高亮覆盖层除外） */
function bindCodeCopy(root) {
  const scope = root || document;
  scope.querySelectorAll('pre').forEach((pre) => {
    try {
      if (pre.dataset.copyBound) return;
      if (pre.closest('.editor-wrap')) return; // 提交代码编辑器的语法高亮覆盖层，不处理
      // v2.9.0：通信题提交详情里「程序一 / 程序二」各自已有带文字的「复制」按钮（.comm-copy），
      // 再挂这个浮动按钮就重复了（站长反馈"多余的复制按钮"）→ 所属容器已有复制按钮则跳过。
      // 空 <pre>（没有任何可复制文本）不挂按钮：否则会留下「空框 + 浮动复制按钮」的观感
      // （题目页样例的空白一侧现已改为 .sample-empty 占位，这里是覆盖 markdown 代码块等其它来源的兜底）
      if (!String(pre.textContent || '').trim()) return;
      pre.dataset.copyBound = '1';
      const wrap = document.createElement('div');
      wrap.className = 'code-copy-wrap';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-copy-btn';
      btn.title = '复制代码';
      btn.innerHTML = '<i class="fa-solid fa-copy"></i>';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const text = pre.textContent || '';
        let ok = false;
        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            ok = true;
          }
        } catch { /* ignore */ }
        if (!ok) {
          // 降级：隐藏 textarea + execCommand
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { ok = document.execCommand('copy'); } catch { ok = false; }
          ta.remove();
        }
        if (ok) {
          const old = btn.innerHTML;
          btn.innerHTML = '<i class="fa-solid fa-check"></i>';
          setTimeout(() => { btn.innerHTML = old; }, 1200);
          toast('已复制', 'success');
        } else {
          toast('复制失败，请手动选择复制', 'error');
        }
      });
      wrap.appendChild(btn);
    } catch { /* 单个代码块处理失败不影响整页 */ }
  });
}

/** 给「提交记录」里的代码块补「复制」按钮（v2.8.5 ④：**每一段代码都要有复制按钮**）。
 *  · `<pre>` 代码块（编译 / 运行错误、SPJ 输出、markdown 代码块…）由 bindCodeCopy() 统一处理，
 *    本函数**跳过 pre**，避免同一块被挂两个按钮；
 *  · 提交详情里的源代码（普通题 / 交互题）与通信题的两份程序都是 `<div class="code-view">`，
 *    bindCodeCopy() 只认 `<pre>`，管不到这些块 —— 这里按**同一套骨架**（.code-copy-wrap + .code-copy-btn）
 *    与站内既有 copyText() 补上按钮，样式全部复用现成 class，不新增样式。
 *  已挂过按钮的块（dataset.copyBound）与内容为空的块不重复处理。 */
function bindCodeViewCopy(root) {
  const scope = root || document;
  scope.querySelectorAll('.code-view').forEach((box) => {
    try {
      if (box.tagName === 'PRE') return;          // 交给 bindCodeCopy()
      if (box.dataset.copyBound) return;
      if (box.closest('.editor-wrap')) return;    // 提交代码编辑器的语法高亮覆盖层，不处理
      // v2.9.0：通信题提交详情里「程序一 / 程序二」各自已有带文字的「复制」按钮（.comm-copy），
      // 这里再挂浮动按钮就重复了（站长反馈"删除复制按钮"）→ 所属容器已有复制按钮则跳过。
      // v2.9.0：只跳过**通信题自己的代码块容器**（.comm-code-block 里已有带文字的「复制」按钮）；
      // 早先写成"向上 4 层里出现过 .comm-copy 就跳过"，会把同页普通代码块的复制按钮一起误删 ✗。
      const commHost = box.closest('.comm-code-block');
      if (commHost && commHost.querySelector('.comm-copy')) return;
      if (!String(box.textContent || '').trim()) return;
      box.dataset.copyBound = '1';
      const wrap = document.createElement('div');
      wrap.className = 'code-copy-wrap';
      box.parentNode.insertBefore(wrap, box);
      wrap.appendChild(box);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-copy-btn';
      btn.title = '复制代码';
      btn.innerHTML = '<i class="fa-solid fa-copy"></i>';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await copyText(box.textContent || '');
        if (ok) {
          const old = btn.innerHTML;
          btn.innerHTML = '<i class="fa-solid fa-check"></i>';
          setTimeout(() => { btn.innerHTML = old; }, 1200);
          toast('已复制', 'success');
        } else {
          toast('复制失败，请手动选择复制', 'error');
        }
      });
      wrap.appendChild(btn);
    } catch { /* 单个代码块处理失败不影响整页 */ }
  });
}

/* 用户名配色表（v2.7.0）：每一档都指向 style.css 末尾定义的 --uc-* 变量。
   八档在浅色 / 深色主题下都是**同一个单一色值**（灰 #8c8c8c、蓝 #0e90d2、青 #09d9e9、
   绿 #5eb95e、橙 #f39c11、红 #fe4c61、管理员紫 #8e44ad、棕名棕 #8b5e3c），
   黄色档按用户指定（v2.7.6）为 rgb(250,219,20) = #fadb14（两主题同值，色值与
   「Compile Error」判定色 .verdict-CE 完全一致）。
   等级 / 积分算法不变；分档阈值见下方 userColor()（v2.7.6 起为 100/120/140/160/180/200）。 */
const USER_COLORS = {
  gray: 'var(--uc-gray)', blue: 'var(--uc-blue)', cyan: 'var(--uc-cyan)', green: 'var(--uc-green)',
  yellow: 'var(--uc-yellow)', orange: 'var(--uc-orange)', red: 'var(--uc-red)',
  admin: 'var(--uc-admin)', brown: 'var(--uc-brown)',
};

/** 用户名颜色：管理员紫色；棕名棕色；其余按积分 */
function userColor(u) {
  const name = (u && (u.username || u.nickname)) || '';
  let meta = null;
  if (name && Store.userColors && Store.userColors[name]) meta = Store.userColors[name];
  if (u && (u.is_admin || u.role === 'admin' || u.role === 'superadmin')) return USER_COLORS.admin;
  if (meta && (meta.role === 'admin' || meta.role === 'superadmin')) return USER_COLORS.admin;
  if (u && u.brown_name) return USER_COLORS.brown;
  if (meta && meta.brown_name) return USER_COLORS.brown;
  // 积分系统关闭时，用户名颜色由等级分决定（管理员紫色不变）
  const ptsEnabled = !(Store.features && Store.features.points_enabled === false);
  if (!ptsEnabled) {
    const rt = (u && (u.rating || 0)) || (meta ? (meta.rating || 0) : 0);
    if (rt < 1000) return USER_COLORS.gray;
    if (rt < 1400) return USER_COLORS.blue;
    if (rt < 1700) return USER_COLORS.green;
    if (rt < 2000) return USER_COLORS.yellow;
    if (rt < 2300) return USER_COLORS.orange;
    return USER_COLORS.red;
  }
  const pts = (u && u.points ? u.points.total : u.points_num) || (meta ? meta.points : 0);
  // 积分分档阈值（v2.7.6）：<100 灰 · 100+ 蓝 · 120+ 青 · 140+ 绿 · 160+ 黄 · 180+ 橙 · 200+ 红
  //（同步改动的说明文字见 renderRanking 里的「用户名颜色随积分变化」那一句）
  if (pts < 100) return USER_COLORS.gray;
  if (pts < 120) return USER_COLORS.blue;
  if (pts < 140) return USER_COLORS.cyan;
  if (pts < 160) return USER_COLORS.green;
  if (pts < 180) return USER_COLORS.yellow;
  if (pts < 200) return USER_COLORS.orange;
  return USER_COLORS.red;
}

/** 带颜色的加粗用户名链接（昵称统一用用户名；链接使用 UID，兼容用户名） */
function userSpan(u) {
  const name = (u && u.username) || (u && u.nickname) || '?';
  const color = userColor(u);
  const ident = (u && (u.uid || u.id)) || u.username || name;
  return `<a href="#/user/${encodeURIComponent(ident)}" style="color:${color};font-weight:700">${escapeHtml(name)}</a>`;
}

/* ---------- 首页 ---------- */
async function renderHome() {
  app.innerHTML = '<div class="loading">加载中…</div>';
  // 首屏可复用启动阶段已取回的主页数据（bootHomeData），避免同一份数据请求两次
  const data = bootHomeData || await api.get('/api/home');
  bootHomeData = null;
  setPageTitle('首页');

  const logoHtml = data.site_logo
    ? `<img class="hero-logo" src="${escapeHtml(data.site_logo)}" alt="logo" onerror="this.style.display='none'" />`
    : '<img class="hero-logo" src="/img/logo.svg?v=296" alt="logo" />';

  // 最近比赛：每场比赛一个独立卡片框（仿洛谷首页），信息齐全；卡片内部两栏排布
  // 数量上限 6 场（v2.6.0：5 → 6；服务端 /api/home 已 LIMIT 6，这里再 slice 兜底，
  // 避免接口口径变化后首页被 16 场比赛刷屏；6 条在 .home-two-col 里正好 3 + 3 两栏）
  const contestBoxes = (data.recent_contests || []).slice(0, 6).map((c) => `
    <a class="home-contest-box" href="#/contest/${c.id}" target="_blank" rel="noopener">
      <div class="hcb-title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</div>
      <div class="hcb-meta">
        <span class="badge" style="background:${CONTEST_STATUS_COLOR[c.status] || '#1890ff'};color:#fff">${escapeHtml(c.status_label)}</span>
        <span class="badge" style="background:${CONTEST_TYPE_COLOR[c.type] || '#722ed1'};color:#fff">${escapeHtml(c.type)}</span>
        <span class="badge" style="background:${c.rated ? '#52c41a' : '#8c8c8c'};color:#fff">${c.rated ? 'Rated' : 'Unrated'}</span>
        <span class="hcb-time muted"><i class="fa-regular fa-clock"></i> ${fmtTime(c.start_time)}</span>
      </div>
    </a>`);
  const contests = contestBoxes.length
    ? `<div class="home-two-col">${contestBoxes.join('')}</div>`
    : '<div class="empty">暂无比赛</div>';

  // 标题行用 .reply-head 一行 flex：标题超长只省略号（.ellip），不再换行撑高条目。
  // 条目图标（比赛行小奖杯 / 讨论行图钉、对话气泡）按用户反馈已去掉，标题直接接在「置顶」徽章后。
  const discussionItems = (data.discussions || []).map((d) => `
    <div class="reply-item">
      <div class="reply-head">
        ${d.pinned ? '<span class="pinned-badge">置顶</span>' : ''}<a class="reply-title" href="#/discussion/${d.id}" target="_blank" rel="noopener" style="font-weight:600"><span class="ellip" title="${escapeHtml(d.title)}">${escapeHtml(d.title)}</span></a>
        ${d.board ? `<span class="tag" style="color:var(--blue)">${escapeHtml(boardLabel(d.board))}</span>` : ''}
        ${d.problem_id ? `<span class="tag tag-problem" style="color:var(--accent)" title="#${d.problem_id} ${escapeHtml(d.problem_title || '')}">#${d.problem_id} ${escapeHtml(d.problem_title || '')}</span>` : ''}
      </div>
      <div class="muted" style="font-size:12px">${userSpan({ uid: d.user_id, username: d.username, nickname: d.username })} · ${d.reply_count} 回复 · ${fmtTime(d.created_at)}</div>
    </div>`);
  // 讨论区：卡片内部按两栏排版（窄屏自动回退单栏）
  const discussions = `<div class="home-disc-grid">${discussionItems.join('') || '<div class="empty">暂无讨论</div>'}</div>`;

  const checkinHtml = Store.user
    ? `
      <div class="card checkin-card">
        <h2 class="card-title checkin-title"><span class="ck-head-icon" id="checkin-icon"><i class="fa-regular fa-calendar"></i></span>每日打卡</h2>
        <div class="ck-strip-head"><span class="ck-range" id="ck-range">最近 7 天</span></div>
        <div class="checkin-days" id="checkin-days" role="list" aria-label="最近 7 天打卡情况"></div>
        <div class="checkin-legend">
          <span class="ck-legend-item"><span class="ck-dot done"></span>已打卡</span>
          <span class="ck-legend-item"><span class="ck-dot today"></span>今日</span>
          <span class="ck-legend-item"><span class="ck-dot"></span>未打卡</span>
        </div>
        <div class="checkin-info muted" id="checkin-info">正在读取打卡记录…</div>
        <div class="ck-foot">
          <div class="ck-metrics">
            <div class="ck-metric ck-metric-main"><span class="ck-metric-cap">连续打卡</span><strong class="ck-metric-num ck-streak" id="ck-streak">0</strong><span class="ck-metric-unit">天</span></div>
            <div class="ck-metric ck-metric-sub"><span class="ck-metric-cap">累计</span><strong class="ck-metric-num-sm ck-total" id="ck-total">0</strong><span class="ck-metric-unit">天</span></div>
          </div>
          <button class="btn checkin-btn" id="checkin-btn"><i class="fa-solid fa-calendar-check"></i>今日打卡</button>
        </div>
      </div>`
    : `<div class="card" style="text-align:center;padding:28px 16px">
        <div style="font-size:40px;color:var(--accent)"><i class="fa-regular fa-calendar-check"></i></div>
        <p class="mt">登录后即可每日打卡，积累连续天数</p>
        <a class="btn" href="#/login"><i class="fa-solid fa-right-to-bracket"></i>登录 / 注册</a>
      </div>`;

  app.innerHTML = `
    <div class="home-hero">
      <div class="hero-content">
        <div class="hero-brand">
          ${logoHtml}
          <h1>${escapeHtml(data.site_name || 'LCZOJ')}</h1>
        </div>
        <div class="hero-sub">在线刷题 · 比赛竞技 · 社区交流</div>
        <div class="hero-search">
          <i class="fa-solid fa-magnifying-glass"></i>
          <input class="input" id="home-search" placeholder="搜索题目（标题 / 标签 / 题号）…" />
          <button class="btn" id="home-search-btn"><i class="fa-solid fa-magnifying-glass"></i>搜索</button>
        </div>
        <div class="hero-stats">
          <div class="hero-stat"><i class="fa-solid fa-book-open"></i><strong>${fmtCompact(data.stats.problems)}</strong><span>道题目</span></div>
          <div class="hero-stat"><i class="fa-solid fa-users"></i><strong>${fmtCompact(data.stats.users)}</strong><span>位用户</span></div>
          <div class="hero-stat"><i class="fa-solid fa-pen-to-square"></i><strong>${fmtCompact(data.stats.submissions || 0)}</strong><span>次评测</span></div>
          <div class="hero-stat"><i class="fa-solid fa-trophy"></i><strong>${fmtCompact(data.stats.contests || 0)}</strong><span>场比赛</span></div>
        </div>
      </div>
    </div>
    <div class="home-grid">
      <div class="home-left">
      <div class="card">
        <div class="row"><h2 class="card-title home-card-title" style="margin:0"><span class="home-card-ico home-card-ico-contest"><i class="fa-solid fa-trophy"></i></span>最近比赛</h2><div class="spacer"></div><a class="muted" href="#/contests">全部 <i class="fa-solid fa-angle-right"></i></a></div>
        ${contests}
      </div>
      <div class="card">
        <div class="row"><h2 class="card-title home-card-title" style="margin:0"><span class="home-card-ico home-card-ico-discuss"><i class="fa-solid fa-comments"></i></span>讨论区（置顶优先）</h2><div class="spacer"></div><a class="muted" href="#/discussions">全部 <i class="fa-solid fa-angle-right"></i></a></div>
        ${discussions}
      </div>
      </div>
      <div class="home-right">
      ${checkinHtml}
      <div class="card">
        <h2 class="card-title home-card-title"><span class="home-card-ico home-card-ico-quick"><i class="fa-solid fa-bolt"></i></span>快捷入口</h2>
        <div class="quick-grid">
          <a class="quick-item" href="#/problems" style="--qi:#0a8dff"><i class="fa-solid fa-book-open"></i><span>刷题</span></a>
          <a class="quick-item" href="#/contests" style="--qi:#f39c11"><i class="fa-solid fa-trophy"></i><span>参赛</span></a>
          <a class="quick-item" href="#/ranking" style="--qi:#52c41a"><i class="fa-solid fa-ranking-star"></i><span>排行榜</span></a>
          <a class="quick-item" href="#/articles" style="--qi:#8e44ad"><i class="fa-solid fa-newspaper"></i><span>题解与专栏</span></a>
          <a class="quick-item" href="#/discussions" style="--qi:#eb2f96"><i class="fa-solid fa-comments"></i><span>讨论</span></a>
          <a class="quick-item" href="#/submissions" style="--qi:#13c2c2"><i class="fa-solid fa-pen-to-square"></i><span>提交记录</span></a>
        </div>
      </div>
      </div>
    </div>`;

  // 首页搜索：跳转题库并按关键字过滤
  const doSearch = () => {
    const q = document.getElementById('home-search').value.trim();
    nav('problems', { search: q, page: 1 });
  };
  const sbtn = document.getElementById('home-search-btn');
  const sinput = document.getElementById('home-search');
  if (sbtn) sbtn.addEventListener('click', doSearch);
  if (sinput) sinput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  document.querySelectorAll('tbody tr[data-id]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') return;
    window.open('#/contest/' + tr.dataset.id, '_blank', 'noopener');
  }));

  // 打卡
  const cbtn = document.getElementById('checkin-btn');
  if (cbtn && Store.user) {
    // 先画骨架格子（日期正确、状态未知），接口返回后再填真实状态，避免布局跳动
    renderCheckinDays(null, document.getElementById('checkin-days'));
    try {
      const st = await api.get('/api/checkin');
      document.getElementById('ck-streak').textContent = st.streak;
      document.getElementById('ck-total').textContent = st.total;
      renderCheckinDays(st, document.getElementById('checkin-days'));
      if (st.checked) {
        cbtn.classList.add('done');
        cbtn.innerHTML = '<i class="fa-solid fa-circle-check"></i>今日已打卡';
        const ic = document.getElementById('checkin-icon');
        if (ic) { ic.innerHTML = '<i class="fa-solid fa-calendar-check"></i>'; ic.classList.add('done'); }
      }
      document.getElementById('checkin-info').textContent = st.checked ? '今日已完成打卡' : '今天还没打卡，来签个到吧';
    } catch { /* ignore */ }
    cbtn.addEventListener('click', async () => {
      try {
        const r = await api.post('/api/checkin');
        toast('打卡成功！', 'success');
        renderHome();
      } catch (e) { toast(e.message, 'error'); }
    });
  }

}

/** 每日打卡「方块」（最近 7 天）：每格一个方形日期块，已打卡 / 今日 / 未打卡一目了然。
 *  /api/checkin 只回 { checked, streak, total }：连续 streak 天必然是「从今天（已打卡时）
 *  或从昨天（未打卡时）往前连续」的若干天，据此可以准确还原最近 7 天的状态。
 *  尺寸由 style.css 的 --ck-size（40px 封顶）控制：一行 7 格，窄屏自动缩小、绝不横向溢出。
 *  @param {{checked:boolean,streak:number}|null} st 传 null 表示状态未知（画骨架格） */
function renderCheckinDays(st, box) {
  if (!box) return;
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const skeleton = !st;
  const streak = Math.max(0, parseInt(st && st.streak, 10) || 0);
  const checked = !!(st && st.checked);
  const cells = [];
  for (let i = 6; i >= 0; i--) {              // 左 → 右：6 天前 … 今天
    const d = new Date(Date.now() - i * 86400000);
    // 已打卡：最近 streak 天（含今天）；未打卡：从昨天往前 streak 天
    const done = skeleton ? false : (checked ? i < streak : (i >= 1 && i <= streak));
    const isToday = i === 0;
    const cls = ['checkin-cell'];
    if (skeleton) cls.push('pending');
    if (done) cls.push('done');
    if (isToday) cls.push('today');
    const m = d.getMonth() + 1, day = d.getDate(), wk = WEEK[d.getDay()];
    const label = `${m} 月 ${day} 日 周${wk} · ${skeleton ? '状态读取中' : (done ? '已打卡' : '未打卡')}${isToday ? '（今天）' : ''}`;
    cells.push(`<div class="${cls.join(' ')}" role="listitem" tabindex="0" title="${label}" aria-label="${label}">`
      + `<span class="ck-week">${wk}</span>`
      + `<span class="ck-date">${day}</span>`
      + '<span class="ck-check" aria-hidden="true"><i class="fa-solid fa-check"></i></span>'
      + '</div>');
  }
  box.innerHTML = cells.join('');
  // 「最近 7 天」标题带上日期区间，让方块有明确的时间语义
  const rangeEl = document.getElementById('ck-range');
  if (rangeEl) {
    const a = new Date(Date.now() - 6 * 86400000);
    rangeEl.textContent = `最近 7 天 · ${a.getMonth() + 1}/${a.getDate()} – ${new Date().getMonth() + 1}/${new Date().getDate()}`;
  }
}
/* ---------- 编辑资料（独立页：昵称/头像/简介[Markdown] + 修改密码） ---------- */
async function renderEditProfile() {
  app.innerHTML = '<div class="loading">加载中…</div>';
  setPageTitle('编辑资料');
  if (!Store.user) {
    app.innerHTML = '<div class="empty">请先 <a href="#/login">登录</a></div>';
    return;
  }
  let me = Store.user;
  try {
    const r = await api.get('/api/me');
    me = r.user || me;
  } catch { /* ignore */ }

  app.innerHTML = `
    <div class="crumb"><a href="#/user/${me.uid}"><i class="fa-solid fa-arrow-left"></i> 返回个人中心</a></div>
    <h1 class="page-title" style="margin-top:8px">编辑资料</h1>
    <div class="card">
      <h2 class="card-title">基本资料</h2>
      <div class="form-group"><label>用户名（还剩 ${Math.max(0, 3 - (me.username_changes || 0))} 次修改机会 / 一年）</label><input class="input" id="ep-username" value="${escapeHtml(me.username)}" /></div>
      <div class="form-group">
        <label>邮箱（更改需通过新邮箱验证码验证）</label>
        <div class="row" style="gap:8px;align-items:center">
          <input class="input" id="ep-email" value="${escapeHtml(me.email || '')}" placeholder="you@example.com" style="flex:1" />
          <button class="btn btn-ghost" id="ep-email-code-btn" type="button"><i class="fa-solid fa-envelope-circle-check"></i>获取验证码</button>
        </div>
        <div id="ep-email-status" class="muted" style="font-size:12px;margin-top:4px"></div>
        <div class="row" style="gap:8px;margin-top:8px">
          <input class="input" id="ep-email-code" placeholder="输入新邮箱收到的 6 位验证码" style="flex:1" />
          <button class="btn btn-ghost" id="ep-email-change-btn" type="button"><i class="fa-solid fa-envelope-circle-check"></i>验证并更换邮箱</button>
        </div>
      </div>
      <div class="form-group">
        <label>头像</label>
        <div class="row" style="gap:12px;align-items:center">
          <span id="ep-avatar-preview">${userAvatarHtml(me, 56)}</span>
          <input type="file" id="ep-avatar-file" accept="image/png,image/jpeg,image/gif,image/webp" />
          <input class="input" id="ep-avatar-url" value="${escapeHtml(me.avatar && !me.avatar.startsWith('data:') ? me.avatar : '')}" placeholder="或输入图片 URL" style="flex:1" />
          ${me.avatar ? '<button class="btn btn-ghost btn-sm" id="ep-avatar-clear" type="button"><i class="fa-solid fa-trash-can"></i>清除头像</button>' : ''}
        </div>
        <div class="muted" style="font-size:12px">支持上传 PNG/JPG/GIF/WebP 图片（≤500KB）或填写图片 URL；不填则使用默认头像</div>
      </div>
      <div class="form-group"><label>个人简介（支持 Markdown / LaTeX，右侧实时预览）</label>
        <div class="live-preview">
          <textarea class="textarea mono" id="ep-bio" rows="5">${escapeHtml(me.bio || '')}</textarea>
          <div class="live-preview-pane statement" id="ep-bio-preview"></div>
        </div>
      </div>
      <button class="btn" id="ep-save"><i class="fa-solid fa-floppy-disk"></i>保存资料</button>
    </div>
    <div class="card">
      <h2 class="card-title">修改密码</h2>
      <p class="muted" style="font-size:12px;margin:-4px 0 12px">密码要求：${PWD_RULE_TEXT}</p>
      <div class="form-group"><label>当前密码（必填）</label><input class="input" id="ep-old" type="password" autocomplete="current-password" placeholder="输入登录时使用的密码" /></div>
      <div class="form-group">
        <label>新密码（必填，至少 ${PWD_MIN_LENGTH} 位，且含字母 / 数字 / 符号中至少两类）</label>
        <input class="input" id="ep-new" type="password" autocomplete="new-password" placeholder="设置一个新的强密码" />
        <div class="muted" id="ep-new-hint" style="font-size:12px;margin-top:4px"></div>
      </div>
      <div class="form-group"><label>确认新密码（必填）</label><input class="input" id="ep-new2" type="password" autocomplete="new-password" /></div>
      <div id="ep-pwd-msg" role="alert" aria-live="polite" style="display:none;font-size:13px;line-height:1.5;margin:0 0 12px;padding:8px 10px;border-radius:8px"></div>
      <button class="btn" id="ep-pwd-save"><i class="fa-solid fa-key"></i>修改密码</button>
    </div>`;

  bindLivePreview('ep-bio', 'ep-bio-preview');
  const fileInput = document.getElementById('ep-avatar-file');
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (file.size > 512 * 1024) return toast('头像图片不能超过 500KB', 'error');
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        document.getElementById('ep-avatar-url').value = dataUrl;
        const prev = document.getElementById('ep-avatar-preview');
        if (prev) prev.innerHTML = userAvatarHtml({ avatar: dataUrl, username: me.username, nickname: me.nickname }, 56);
      };
      reader.readAsDataURL(file);
    });
  }
  const clearBtn = document.getElementById('ep-avatar-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    document.getElementById('ep-avatar-url').value = '';
    const prev = document.getElementById('ep-avatar-preview');
    if (prev) prev.innerHTML = userAvatarHtml({ avatar: '', username: me.username, nickname: me.nickname }, 56);
  });
  // 更换邮箱：先获取验证码，再用验证码确认更换
  const emailStatus = document.getElementById('ep-email-status');
  const emailCodeBtn = document.getElementById('ep-email-code-btn');
  const emailChangeBtn = document.getElementById('ep-email-change-btn');
  if (emailCodeBtn) {
    emailCodeBtn.addEventListener('click', async () => {
      const email = document.getElementById('ep-email').value.trim();
      if (!email) return toast('请先填写新邮箱', 'error');
      try {
        await api.put('/api/me', { email, request_email_code: true });
        if (emailStatus) emailStatus.innerHTML = `<span style="color:var(--green)">验证码已发送至新邮箱，请查收（10 分钟内有效；若未收到可点击「重新发送」或稍后重试）</span>`;
        toast('验证码已发送至新邮箱', 'success');
      } catch (e) { toast(e.message, 'error'); }
    });
  }
  if (emailChangeBtn) {
    emailChangeBtn.addEventListener('click', async () => {
      const email = document.getElementById('ep-email').value.trim();
      const code = document.getElementById('ep-email-code').value.trim();
      if (!email) return toast('请先填写新邮箱', 'error');
      if (!code) return toast('请输入验证码', 'error');
      try {
        const r = await api.put('/api/me', { email, email_code: code });
        Store.user = r.user;
        renderTopbar();
        if (emailStatus) emailStatus.textContent = '';
        toast('邮箱已更新为 ' + email, 'success');
      } catch (e) { toast(e.message, 'error'); }
    });
  }
  document.getElementById('ep-save').addEventListener('click', async () => {
    try {
      const r = await api.put('/api/me', {
        username: document.getElementById('ep-username').value.trim(),
        avatar: document.getElementById('ep-avatar-url').value.trim(),
        bio: document.getElementById('ep-bio').value.trim(),
      });
      Store.user = r.user;
      renderTopbar();
      toast('资料已保存', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
  document.getElementById('ep-pwd-save').addEventListener('click', async () => {
    const oldEl = document.getElementById('ep-old');
    const n1El = document.getElementById('ep-new');
    const n2El = document.getElementById('ep-new2');
    // 1) 本地先校验：能立刻说清「缺什么」，避免提交后只有一个一闪而过的 toast。
    //    本地规则与服务端**完全同规则或更宽**（绝不比服务端更严），因此不会误伤合法强口令。
    if (!String(oldEl.value || '')) { showPwdMsg('请输入当前密码（用于确认是本人操作）', 'error'); oldEl.focus(); return; }
    if (!String(n1El.value || '')) { showPwdMsg('请输入新密码', 'error'); n1El.focus(); return; }
    if (n1El.value !== n2El.value) { showPwdMsg('两次输入的新密码不一致，请重新确认', 'error'); n2El.focus(); return; }
    if (n1El.value === oldEl.value) { showPwdMsg('新密码不能与当前密码相同，请更换一个', 'error'); n1El.focus(); return; }
    const localErr = localPasswordPolicyError(n1El.value);
    if (localErr) { showPwdMsg(localErr, 'error'); n1El.focus(); return; }
    // 2) 提交：旧口令是否正确、是否命中服务端「常见弱口令及其变形」规则，一律以服务端判定为准
    const btn = document.getElementById('ep-pwd-save');
    const btnHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 提交中…';
    try {
      const r = await api.put('/api/me/password', { old_password: oldEl.value, new_password: n1El.value });
      // 3) 改密成功：**立刻**按服务端事实刷新登录态，并清掉一次性改密提示 → 顶部横幅立即消失（无需重新登录）
      clearPasswordWarning();
      try {
        const me = await api.get('/api/me');
        if (me && me.user) Store.user = me.user;
      } catch (e) { /* 忽略：刷新失败不影响已经生效的改密结果 */ }
      // 服务端 must_change_password 已归零时不会重建横幅；万一没有归零，横幅会立刻重新出现（属正确行为）
      showPasswordWarning();
      renderTopbar();
      oldEl.value = ''; n1El.value = ''; n2El.value = '';
      updatePwdNewHint();
      const revoked = r && r.sessions_revoked ? `，其他 ${r.sessions_revoked} 个设备的登录已失效` : '';
      showPwdMsg(`密码已修改成功${revoked}。当前登录仍然有效，可以直接继续使用（顶部改密提示已消失）。`, 'success');
      toast('密码已修改成功', 'success');
    } catch (e) {
      // 失败：原因留在表单内（不会 3 秒后消失），已填写的内容保持不动
      const msg = (e && e.message) ? e.message : '密码修改失败，请稍后重试';
      showPwdMsg(msg, 'error');
      if (/当前密码/.test(msg)) oldEl.focus(); else n1El.focus();
    } finally {
      btn.disabled = false;
      btn.innerHTML = btnHtml;
    }
  });
  // 输入时实时提示新口令还差什么（错误提示框本身不做自动清除，只有重新提交才会更新）
  ['ep-new', 'ep-new2'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updatePwdNewHint);
  });
  updatePwdNewHint();
}

/* ---------- 修改密码：本地即时校验 + 表单内联提示（v2.5.0 可用性修复） ----------
 * 背景（线上故障）：改密失败时只弹一个 3 秒 toast，且《新密码》标签误写「至少 6 位」、
 * 弱口令黑名单完全没披露，用户看到的现象就是「改不动，也不知道为什么，横幅一直挂着」。
 * 这里的本地校验只做「服务端必然也会拒绝」的判断，绝不比服务端更严：
 *   · 必填 / 两次一致 / 与当前密码相同 / 长度 / 字符类别 —— 与服务端 src/db.js 同规则；
 *   · 常见弱口令 —— 只取 src/db.js 中 WEAK_PASSWORDS 的子集，命中即拦（服务端必然也拒绝）；
 *   · 服务端还有「以常见弱口令开头」（如 abcd1234!@ / password!@）的规则，本地无法完整复刻，
 *     这类口令提交后由服务端返回原因，我们把它**显示在表单里**，因此不会再出现「不知道为什么」。
 */
const PWD_MIN_LENGTH = 10; // 与 src/db.js 的 PASSWORD_MIN_LENGTH 保持一致
const PWD_RULE_TEXT = `至少 ${PWD_MIN_LENGTH} 位，且包含字母、数字、符号中至少两类；不要使用常见弱口令及其变形（如 password / abcd1234 / qwerty / admin123）`;
// 全部取自 src/db.js 的 WEAK_PASSWORDS（子集，保证不会比服务端更严）
const PWD_WEAK_EXACT = [
  'admin', 'admin123', 'admin1234', 'admin12345', 'administrator', 'root', '123456', '12345678',
  '1234567890', '111111', 'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'qwerty',
  'qwerty123', 'abcd1234', 'test1234', 'changeme', 'letmein', 'welcome', 'lczoj', 'lczoj123',
  'oj123456', '1q2w3e4r', '1qaz2wsx', 'zxcvbnm', 'asdfghjkl', 'a1b2c3d4', '5201314',
];

/** 口令包含哪几类字符（字母 / 数字 / 符号），用于给出「缺哪一类」的准确文案 */
function passwordKinds(pw) {
  const s = String(pw == null ? '' : pw);
  const kinds = [];
  if (/[a-zA-Z]/.test(s)) kinds.push('字母');
  if (/\d/.test(s)) kinds.push('数字');
  if (/[^a-zA-Z0-9]/.test(s)) kinds.push('符号');
  return kinds;
}

/** 本地口令强度检查：通过返回 ''，否则返回中文原因（只做服务端必然也会拒绝的判断） */
function localPasswordPolicyError(pw) {
  const s = String(pw == null ? '' : pw);
  if (!s) return '请输入新密码';
  if (s.length > 200) return '密码长度不能超过 200 位';
  if (/^\s|\s$/.test(s)) return '密码首尾不能是空白字符（请检查是否误粘贴了空格）';
  if (PWD_WEAK_EXACT.includes(s.toLowerCase())) return '该密码属于常见弱口令，请更换更复杂的密码';
  if (s.length < PWD_MIN_LENGTH) return `密码长度至少 ${PWD_MIN_LENGTH} 位（当前 ${s.length} 位）`;
  const kinds = passwordKinds(s);
  if (kinds.length < 2) return `密码需至少包含字母、数字、符号中的两类（当前只有${kinds.join('、') || '0'}一类）`;
  return '';
}

/** 新密码输入框下方的实时提示：直接写出还差什么 */
function updatePwdNewHint() {
  const hint = document.getElementById('ep-new-hint');
  if (!hint) return;
  const v = String((document.getElementById('ep-new') || {}).value || '');
  if (!v) { hint.textContent = ''; hint.style.color = ''; return; }
  const err = localPasswordPolicyError(v);
  hint.textContent = err ? ('✗ ' + err) : '✓ 符合密码强度要求';
  hint.style.color = err ? 'var(--red)' : 'var(--green)';
}

/** 修改密码表单的内联提示：error 常驻显示（不自动消失），success 显示成功说明 */
function showPwdMsg(message, type) {
  const box = document.getElementById('ep-pwd-msg');
  if (!box) return;
  if (!message) { box.style.display = 'none'; box.textContent = ''; return; }
  const ok = type === 'success';
  box.style.display = 'block';
  box.style.background = ok ? 'rgba(82,196,26,.12)' : 'rgba(255,77,79,.10)';
  box.style.color = ok ? 'var(--green)' : 'var(--red)';
  box.style.border = '1px solid ' + (ok ? 'rgba(82,196,26,.45)' : 'rgba(255,77,79,.45)');
  box.innerHTML = (ok ? '<i class="fa-solid fa-circle-check"></i> ' : '<i class="fa-solid fa-circle-exclamation"></i> ') + escapeHtml(message);
}

/* ---------- 题库列表 ---------- */
/* 仅这些（C/C++ 系）语言支持 O2 优化，提交时才会显示 O2 开关 */
const O2_LANGS = ['c', 'cpp', 'cpp11', 'cpp98'];
async function renderProblems(query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const search = query.get('search') || '';
  // 多选：逗号分隔（tag=a,b）
  const tagSet = new Set((query.get('tag') || '').split(',').map((s) => s.trim()).filter(Boolean));
  const sourceSet = new Set((query.get('source') || '').split(',').map((s) => s.trim()).filter(Boolean));
  const tag = Array.from(tagSet).join(',');
  const source = Array.from(sourceSet).join(',');
  const difficulty = query.get('difficulty') || '';
  const page = parseInt(query.get('page') || '1', 10);

  const params = new URLSearchParams({ page: String(page), size: '20' });
  if (search) params.set('search', search);
  if (tag) params.set('tag', tag);
  if (source) params.set('source', source);
  if (difficulty) params.set('difficulty', difficulty);

  const data = await api.get('/api/problems?' + params.toString());
  setPageTitle('题库');

  const diffOptions = ['<option value="">全部难度</option>']
    .concat(Store.difficulties.map((d) => `<option value="${d.level}" ${difficulty === String(d.level) ? 'selected' : ''}>${escapeHtml(d.label)}</option>`))
    .join('');

  const tagChips = Store.tags.map((t) => `<span class="chip ${tagSet.has(t) ? 'active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('');
  const srcChips = (Store.sources || []).map((s) => `<span class="chip ${sourceSet.has(s) ? 'active' : ''}" data-source="${escapeHtml(s)}">${escapeHtml(s)}</span>`).join('');

  let rows = '';
  if (data.items.length === 0) {
    rows = '<tr><td colspan="7" class="empty" style="text-align:center;padding:48px 0">暂无题目</td></tr>';
  } else {
    rows = data.items.map((p) => {
      const rate = p.submit_count > 0 ? Math.round((p.accepted_count / p.submit_count) * 100) + '%' : '—';
      // 状态：有提交才显示（AC 对号 / 未 AC 错号），无提交不显示
      const statusBadge = p.user_ac
        ? '<span style="color:var(--green);font-weight:700" title="已通过"><i class="fa-solid fa-check"></i></span>'
        : (p.user_submitted ? '<span style="color:var(--red);font-weight:700" title="已提交未通过"><i class="fa-solid fa-xmark"></i></span>' : '');
      const tagHtml = p.tags.map((t) => `<span class="tag click-tag" data-tag="${escapeHtml(t)}" title="点击筛选该算法标签">${escapeHtml(t)}</span>`).join('');
      // 有题目管理权限的用户能看到未公开题目，需要一眼区分出来
      const hiddenHtml = p.is_public ? '' : '<span class="tag" style="color:#f5222d;border-color:#f5222d" title="该题未公开，仅有题目管理权限的用户可见">未公开</span>';
      const srcHtml = p.source
        ? `<span class="tag click-source" data-source="${escapeHtml(p.source)}" style="color:var(--accent);border-color:var(--accent)" title="点击筛选该来源">${escapeHtml(p.source)}</span>`
        : '';
      return `<tr data-id="${p.id}">
        <td style="width:40px">${statusBadge}</td>
        <td><span class="muted mono">#${p.id}</span> <a href="#/problem/${p.id}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a></td>
        <td>${hiddenHtml}${tagHtml}${srcHtml}</td>
        <td><span class="badge diff click-diff" data-diff="${p.difficulty}" style="background:${p.difficulty_color};cursor:pointer" title="点击筛选该难度">${escapeHtml(p.difficulty_label)}</span></td>
        <td class="num">${p.accepted_count} / ${p.submit_count}</td>
        <td class="num muted">${rate}</td>
      </tr>`;
    }).join('');
  }

  app.innerHTML = `
    <div class="page-header">
      <div class="ph-left">
        <h1 class="page-title">题库</h1>
        <div class="muted page-sub">共 ${data.total} 道题目${tagSet.size ? ` · 算法：${escapeHtml(tag)}` : ''}${sourceSet.size ? ` · 来源：${escapeHtml(source)}` : ''}${difficulty ? ' · 难度筛选' : ''}</div>
      </div>
      <div class="spacer"></div>
      ${(Store.user && hasP('problem')) ? '<a class="btn" href="#/admin/problem/new"><i class="fa-solid fa-plus"></i>新建题目</a>' : ''}
    </div>
    <div class="filter-bar filter-grid">
      <input class="input" id="search-input" placeholder="搜索题目名称或标签…" value="${escapeHtml(search)}" list="tag-suggest" />
      <datalist id="tag-suggest">${Store.tags.map((t) => `<option value="${escapeHtml(t)}">`).join('')}</datalist>
      <select class="input" id="diff-select" style="width:auto">${diffOptions}</select>
      <button class="btn btn-ghost" id="filter-btn" type="button"><i class="fa-solid fa-sliders"></i>标签 / 来源筛选 ${(tagSet.size || sourceSet.size) ? `（${tagSet.size + sourceSet.size} 项）` : ''}</button>
      <button class="btn" id="search-btn"><i class="fa-solid fa-magnifying-glass"></i>搜索</button>
    </div>
    <div class="card table-scroll" style="padding:0">
      <table class="table table-left">
        <thead><tr><th>状态</th><th>题目</th><th>标签 / 来源</th><th>难度</th><th class="num">通过 / 提交</th><th class="num">通过率</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderPagination(data.total, data.page, data.size)}`;

  bindPagination((p) => nav('problems', { search, tag, source, difficulty, page: p }));
  document.querySelectorAll('tbody tr[data-id]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.tagName === 'A' || e.target.classList.contains('click-tag') || e.target.classList.contains('click-source') || e.target.classList.contains('click-diff')) return;
    window.open('#/problem/' + tr.dataset.id, '_blank', 'noopener');
  }));

  // 点击行内标签 → 多选该标签筛选
  document.querySelectorAll('.click-tag').forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = el.dataset.tag;
    const ns = new Set(tagSet);
    if (ns.has(t)) ns.delete(t); else ns.add(t);
    nav('problems', { search, tag: Array.from(ns).join(','), source, difficulty, page: 1 });
  }));
  // 点击行内来源 → 多选该来源筛选
  document.querySelectorAll('.click-source').forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = el.dataset.source;
    const ns = new Set(sourceSet);
    if (ns.has(s)) ns.delete(s); else ns.add(s);
    nav('problems', { search, tag, source: Array.from(ns).join(','), difficulty, page: 1 });
  }));
  // 点击行内难度 → 按该难度筛选
  document.querySelectorAll('.click-diff').forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const d = el.dataset.diff;
    nav('problems', { search, tag, source, difficulty: difficulty === d ? '' : d, page: 1 });
  }));

  // 标签/来源筛选弹窗：分「来源」与「算法」两部分，均支持多选（点击切换选中）
  const filterBtn = document.getElementById('filter-btn');
  filterBtn.addEventListener('click', () => {
    if (document.getElementById('tag-modal')) return;
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.id = 'tag-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200;display:flex;align-items:center;justify-content:center';
    const selTags = tagSet, selSrcs = sourceSet;
    const srcChipsHtml = (Store.sources && Store.sources.length)
      ? (Store.sources.map((s) => `<span class="chip ${selSrcs.has(s) ? 'active' : ''}" data-source="${escapeHtml(s)}">${escapeHtml(s)}</span>`).join(''))
      : '<div class="empty" style="padding:4px 0">暂无来源标签</div>';
    const tagChipsHtml = Store.tags.length
      ? (Store.tags.map((t) => `<span class="chip ${selTags.has(t) ? 'active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join(''))
      : '<div class="empty" style="padding:4px 0">暂无算法标签</div>';
    modal.innerHTML = `<div class="card" style="width:560px;max-width:92vw;margin:0">
      <div class="row" style="align-items:baseline"><h2 class="card-title" style="margin:0 8px 0 0">标签 / 来源筛选</h2><span class="muted">可多选</span><div class="spacer"></div><button class="btn btn-ghost btn-sm" id="tag-close"><i class="fa-solid fa-xmark"></i>关闭</button></div>
      <div style="margin:8px 0 4px;font-weight:600;color:var(--accent)"><i class="fa-solid fa-globe"></i> 来源</div>
      <div class="tag-chips">${srcChipsHtml}</div>
      <div style="margin:14px 0 4px;font-weight:600;color:var(--accent)"><i class="fa-solid fa-tags"></i> 算法</div>
      <div class="tag-chips">${tagChipsHtml}</div>
      <div class="row mt">
        <button class="btn btn-ghost btn-sm" id="tag-clear" type="button"><i class="fa-solid fa-eraser"></i>清除全部</button>
        <div class="spacer"></div>
        <button class="btn" id="tag-apply" type="button"><i class="fa-solid fa-filter"></i>应用筛选</button>
      </div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll('.chip[data-tag]').forEach((c) => c.addEventListener('click', () => {
      const t = c.dataset.tag;
      if (selTags.has(t)) selTags.delete(t); else selTags.add(t);
      c.classList.toggle('active');
    }));
    modal.querySelectorAll('.chip[data-source]').forEach((c) => c.addEventListener('click', () => {
      const s = c.dataset.source;
      if (selSrcs.has(s)) selSrcs.delete(s); else selSrcs.add(s);
      c.classList.toggle('active');
    }));
    document.getElementById('tag-close').addEventListener('click', () => modal.remove());
    document.getElementById('tag-apply').addEventListener('click', () => {
      modal.remove();
      nav('problems', { search, tag: Array.from(selTags).join(','), source: Array.from(selSrcs).join(','), difficulty, page: 1 });
    });
    document.getElementById('tag-clear').addEventListener('click', () => {
      modal.remove();
      nav('problems', { search, tag: '', source: '', difficulty, page: 1 });
    });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  });

  const doSearch = () => nav('problems', { search: document.getElementById('search-input').value.trim(), tag, source, difficulty, page: 1 });
  document.getElementById('search-btn').addEventListener('click', doSearch);
  document.getElementById('search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  document.getElementById('diff-select').addEventListener('change', (e) => {
    nav('problems', { search, tag, source, difficulty: e.target.value, page: 1 });
  });
}

/* ---------- 题目详情 + 提交 ---------- */
/* 把题目题面组装成 Markdown（洛谷式复制） */
function buildProblemMarkdown(p) {
  const L = [];
  L.push(`# ${p.title}`);
  L.push('');
  L.push(`> 难度：${p.difficulty_label || '—'}${p.source ? `　来源：${p.source}` : ''}${p.tags && p.tags.length ? `　标签：${p.tags.join('、')}` : ''}`);
  L.push('');
  if (p.description) { L.push('## 题目描述', '', p.description, ''); }
  if (p.input_format) { L.push('## 输入格式', '', p.input_format, ''); }
  if (p.output_format) { L.push('## 输出格式', '', p.output_format, ''); }
  // 交互题：把交互说明一并复制，题面 Markdown 才完整
  if (p.interactive_hint) { L.push('## 交互说明', '', p.interactive_hint, ''); }
  if (p.samples && p.samples.length) {
    L.push('## 样例');
    p.samples.forEach((s, i) => {
      L.push('', `### 样例输入 #${i + 1}`, '', '```', String(s.input != null ? s.input : ''), '```');
      L.push('', `### 样例输出 #${i + 1}`, '', '```', String(s.output != null ? s.output : ''), '```');
    });
    L.push('');
  }
  if (p.hint) { L.push('## 提示', '', p.hint, ''); }
  return L.join('\n');
}
/* 附件：大小格式化 + 按扩展名匹配图标 */
function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(2) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
/**
 * v2.5.3：限额区间显示。题目级与各测试点点级（留空 = 继承）一起算出的 min/max：
 *   · 全部相同（含「所有测试点都留空」）→ 沿用单值格式（如时限 ≥1000ms 显示秒，见 fmtDuration）；
 *   · 存在不同 → 显示「最小值 ~ 最大值」，且**两端同一种单位**：
 *       时限：最小值 < 1000ms 时两端都用 ms（如「500 ms ~ 2000 ms」），否则两端都用秒（如「1.00 s ~ 2.00 s」）；
 *       内存：两端都用 MB（如「256 MB ~ 512 MB」）。
 */
function fmtLimitRange(loVal, hiVal, single, fallback, unit) {
  const lo = Number(loVal);
  const hi = Number(hiVal);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi <= 0) return single(fallback);
  if (lo === hi) return single(lo);
  if (unit === 'ms') {
    if (lo < 1000) return `${Math.round(lo)} ms ~ ${Math.round(hi)} ms`;
    return `${(lo / 1000).toFixed(2)} s ~ ${(hi / 1000).toFixed(2)} s`;
  }
  return `${Math.round(lo)} ${unit} ~ ${Math.round(hi)} ${unit}`;
}
/** 时限：单值走 fmtDuration；区间两端同单位（见 fmtLimitRange） */
function fmtTimeLimit(p) {
  return fmtLimitRange(p.time_limit_min_ms, p.time_limit_max_ms, fmtDuration, p.time_limit_ms, 'ms');
}
/** 内存：区间形如「256 MB ~ 512 MB」，单值形如「256 MB」 */
function fmtMemoryLimit(p) {
  return fmtLimitRange(p.memory_limit_min_mb, p.memory_limit_max_mb, (v) => `${v} MB`, p.memory_limit_mb, 'MB');
}
function attIcon(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (['pdf'].includes(ext)) return { i: 'fa-file-pdf', c: '#e5484d' };
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return { i: 'fa-file-zipper', c: '#f5a623' };
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return { i: 'fa-file-image', c: '#8e44ad' };
  if (['doc', 'docx'].includes(ext)) return { i: 'fa-file-word', c: '#2b6cb0' };
  if (['xls', 'xlsx', 'csv'].includes(ext)) return { i: 'fa-file-excel', c: '#2f9e44' };
  if (['ppt', 'pptx'].includes(ext)) return { i: 'fa-file-powerpoint', c: '#e8590c' };
  if (['cpp', 'cc', 'c', 'h', 'py', 'js', 'java', 'pas', 'go', 'rs', 'php'].includes(ext)) return { i: 'fa-file-code', c: '#0e90d2' };
  if (['txt', 'md', 'in', 'out', 'ans', 'log'].includes(ext)) return { i: 'fa-file-lines', c: '#7b8794' };
  return { i: 'fa-file', c: '#7b8794' };
}

async function renderProblemDetail(id, query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const contestId = query.get('contest');

  // 比赛上下文
  let contestInfo = null;
  if (contestId) {
    try {
      const c = await api.get('/api/contests/' + contestId);
      contestInfo = c.contest;
    } catch { /* ignore */ }
  }

  const data = await api.get('/api/problems/' + id + (contestId ? '?contest=' + contestId : ''));
  const p = data.problem;
  setPageTitle((contestInfo ? '比赛 · ' : '') + p.title);

  // 题目附件（管理员上传，用户下载）
  let atts = [];
  try { atts = (await api.get(`/api/problems/${id}/attachments`)).items || []; } catch { /* ignore */ }

  // 题解（题目页仅展示点赞最高的 3 篇；比赛题目隐藏题解区）
  let editorials = [];
  let discussions = [];
  if (!contestInfo) {
    try {
      const [ed, ds] = await Promise.all([
        api.get(`/api/problems/${id}/editorials/top`),
        api.get(`/api/discussions?problem=${id}&size=5`),
      ]);
      editorials = (ed && ed.editorials) || [];
      discussions = (ds && ds.items) || [];
    } catch { /* ignore */ }
  }

  /* 样例渲染（v2.7.6）：某一侧没有内容时**不再渲染成空框**（此前会生成一个空 <pre>，
     并被 bindCodeCopy() 挂上「复制」按钮 → 「空框 + 浮动按钮」的坏观感）：
       · 该侧有内容  → 照旧渲染 <pre>（由 bindCodeCopy 挂复制按钮）；
       · 该侧无内容  → 渲染灰色占位「（空）」，用的是 <div class="sample-empty"> 而不是 <pre>，
                       因此天然不会挂复制按钮（bindCodeCopy 只处理 <pre>）；
       · 两侧都无内容 → 这一组样例整块不渲染（没有任何信息可给；下方「样例」标题也会一并省掉）。 */
  const sampleSide = (label, idx, text) => {
    const body = text.trim()
      ? `<pre>${escapeHtml(text)}</pre>`
      : '<div class="sample-empty">（空）</div>';
    return `<div class="sample-block">
        <div class="sample-head"><span>${label} #${idx + 1}</span></div>
        ${body}
      </div>`;
  };
  const samplesHtml = (p.samples || []).map((s, i) => {
    const inputText = s && s.input != null ? String(s.input) : '';
    const outputText = s && s.output != null ? String(s.output) : '';
    if (!inputText.trim() && !outputText.trim()) return '';
    return `<div class="sample-grid">
      ${sampleSide('输入', i, inputText)}
      ${sampleSide('输出', i, outputText)}
    </div>`;
  }).join('');

  // 题目管理权限：题目页直接提供编辑 / 删除（删除会连带清理测试数据、附件与提交记录）
  const adminBtns = (Store.user && hasP('problem')) ? `
    <a class="btn btn-ghost btn-sm" href="#/admin/problem/${p.id}"><i class="fa-solid fa-pen"></i>编辑题目</a>
    <button class="btn btn-danger btn-sm" id="problem-del-btn"><i class="fa-solid fa-trash"></i>删除题目</button>` : '';

  // 题目类型共 5 种：standard 传统题 / output_only 提交答案题 / interactive_io IO 交互题 /
  // interactive_func 函数式交互题 / communication 通信题（两个选手程序合作，独立题型）。
  // 兼容旧数据：problem_type 缺失或仍是 standard 时，用布尔 output_only 兜底（旧版「提交答案题」开关）。
  const rawType = String(p.problem_type || '');
  const outputOnlyFlag = p.output_only === true;
  const problemType = (rawType === 'output_only' || rawType === 'interactive_io' || rawType === 'interactive_func' || rawType === 'communication')
    ? rawType
    : (outputOnlyFlag ? 'output_only' : 'standard');
  const isInteractiveIO = problemType === 'interactive_io';
  const isInteractiveFunc = problemType === 'interactive_func';
  // 通信题：需要提交**两个程序**（程序一 / 程序二），评测端按 pipe_mode（relay / direct）把两者对接
  const isCommunication = problemType === 'communication';
  const isInteractive = isInteractiveIO || isInteractiveFunc || isCommunication;
  // 提交答案：类型是提交答案题，或接口直接标记 output_only（两者可以同时成立：交互题 + 提交答案）
  const outputOnly = outputOnlyFlag || problemType === 'output_only';
  p.output_only = outputOnly;   // 下方提交区、复制 Markdown 等沿用同一判断
  /** 函数式交互题：评测时 grader 与选手代码一起编译链接，只有 C / C++ 可用（与评测机判定一致） */
  const FUNC_INTERACTIVE_LANGS = ['c', 'cpp', 'cpp11', 'cpp98'];
  /** 通信题：两个程序分别编译成两个可执行文件，也只支持 C / C++（与评测机 COMM_LANGS 一致） */
  const COMM_LANGS = ['c', 'cpp', 'cpp11', 'cpp98'];
  // 「提交答案」（output）不是编程语言，只在提交答案题里用；普通题目的语言下拉里不出现它
  const langAllow = isCommunication ? COMM_LANGS : (isInteractiveFunc ? FUNC_INTERACTIVE_LANGS : null);
  const codeLangs = Store.languages.filter((l) => l.key !== 'output'
    && (!langAllow || langAllow.includes(l.key)));
  const availLangs = codeLangs.filter((l) => l.available);
  // 语言默认取「上次提交选择的语言」——「自动识别语言」也属于一种选择，会被记住；
  // 没有记录时回退到上次实际用过的具体语言（用于语法着色 / O2 开关初值），再回退 C++14/C++。
  let lastPick = '';
  let lastReal = '';
  try {
    lastPick = localStorage.getItem('lczoj_last_lang') || '';
    lastReal = localStorage.getItem('lczoj_last_real_lang') || '';
  } catch { /* ignore */ }
  const langExists = (k) => !!k && availLangs.some((l) => l.key === k);
  const fallbackLang = availLangs.find((l) => l.key === 'cpp14') ? 'cpp14'
    : (availLangs.find((l) => l.key === 'cpp') ? 'cpp' : (availLangs[0] ? availLangs[0].key : ''));
  const defaultLang = langExists(lastReal) ? lastReal : (lastPick !== 'auto' && langExists(lastPick) ? lastPick : fallbackLang);
  // 下拉框初始选中项：记住的选择优先（'auto' 或具体语言），否则默认「自动识别语言」
  const initialPick = lastPick === 'auto' ? 'auto' : (langExists(lastPick) ? lastPick : 'auto');
  const initialO2Lang = initialPick === 'auto' ? defaultLang : initialPick;
  const langOptions = codeLangs.map((l) =>
    `<option value="${l.key}" ${l.available ? '' : 'disabled'}>${escapeHtml(l.name)}${l.available ? '' : '（未安装）'}</option>`).join('');
  // 「自动识别语言」作为语言下拉里的一项（提交时按代码内容/文件扩展名判断真正使用的语言）
  const langOptionsWithAuto = `<option value="auto">自动识别语言</option>` + langOptions;

  // 比赛上下文时隐藏难度/标签
  const diffBadge = contestInfo ? '' : `<span class="badge diff" style="background:${p.difficulty_color}">${escapeHtml(p.difficulty_label)}</span>`;
  const tagHtml = contestInfo ? '' : `<span>${p.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}${p.source ? `<span class="tag" style="color:var(--accent);border-color:var(--accent)">${escapeHtml(p.source)}</span>` : ''}</span>`;
  const favBtnHtml = Store.user ? `<button class="btn btn-ghost btn-sm" id="fav-btn" title="收藏本题"><i class="fa-${p.is_favorite ? 'solid' : 'regular'} fa-star" style="color:${p.is_favorite ? '#faad14' : ''}"></i>${p.is_favorite ? '已收藏' : '收藏'}</button>` : '';
  const mdCopyBtn = '<button class="btn btn-ghost btn-sm" id="copy-md-btn" title="复制题面为 Markdown（洛谷式）"><i class="fa-solid fa-clipboard"></i>复制 Markdown</button>';

  // 比赛横幅（含私有题目提示）
  let contestBanner = '';
  if (contestInfo) {
    contestBanner = `
    <div class="status-banner blue" style="margin-top:12px">
      <span><i class="fa-solid fa-trophy"></i> 比赛提交</span>
      <span style="font-weight:700"><a href="#/contest/${contestInfo.id}" target="_blank" rel="noopener">${escapeHtml(contestInfo.title)}</a></span>
      <span class="badge" style="background:#0a8dff;color:#fff">${escapeHtml(contestInfo.type)}</span>
      <span class="muted">${contestInfo.status_label}</span>
      ${contestInfo.can_submit ? '' : '<span class="muted">（当前不在比赛窗口内，提交将按普通提交处理）</span>'}
    </div>
    ${!p.is_public ? '<div class="status-banner warn" style="margin-top:8px"><span style="font-weight:700"><i class="fa-solid fa-lock"></i> 比赛私有题目</span><span class="muted">本题未公开，仅可通过比赛界面进入查看</span></div>' : ''}`;
  }

  // 比赛题目自动隐藏题解区与讨论区；功能关闭时关闭入口
  let sideExtras = '';
  if (!contestInfo) {
    const artOff = Store.features && Store.features.article_enabled === false;
    const discOff = Store.features && Store.features.discussion_enabled === false;
    const editorialsHtml = editorials.length === 0
      ? '<div class="empty" style="padding:16px 0">暂无题解，快来写第一篇吧</div>'
      : editorials.map((e) => `
          <div class="reply-item" style="display:flex;align-items:center;gap:12px">
            <div style="flex:1">
              <a href="#/editorial/${e.id}" style="font-weight:600;font-size:15px" target="_blank" rel="noopener">${escapeHtml(e.title)}</a>
              ${e.status !== 'approved' ? `<span class="badge" style="background:${e.status === 'pending' ? '#fa8c16' : '#ff4d4f'};color:#fff;font-size:11px">${escapeHtml(e.status_label)}</span>` : ''}
              <div class="muted" style="font-size:12px">by ${userSpan({ uid: e.user_id, username: e.username, nickname: e.username, points_num: 0 })} · ${fmtTime(e.created_at)}</div>
            </div>
            <span class="muted"><i class="fa-solid fa-thumbs-up"></i> ${e.like_count} · <i class="fa-solid fa-comments"></i> ${e.comment_count || 0}</span>
            ${(Store.user && Store.user.is_admin && e.status === 'pending') ? `
              <button class="btn btn-sm btn-approve" data-ed-review="approved" data-id="${e.id}"><i class="fa-solid fa-check"></i>通过</button>
              <button class="btn btn-danger btn-sm" data-ed-review="rejected" data-id="${e.id}"><i class="fa-solid fa-ban"></i>驳回</button>` : ''}
          </div>`).join('');
    const edClosed = !!p.editorial_closed;
    // 右侧栏：题解
    const edSideHtml = editorials.length === 0
      ? '<div class="muted" style="padding:10px 0;text-align:center">暂无题解</div>'
      : editorials.map((e) => `
          <div style="padding:7px 0;border-bottom:1px dashed var(--border)">
            <div style="display:flex;align-items:center;gap:6px">
              <a href="#/editorial/${e.id}" style="font-weight:600;font-size:14px;flex:1;min-width:0" target="_blank" rel="noopener">${escapeHtml(e.title)}</a>
              ${(Store.user && Store.user.is_admin && e.status === 'pending') ? `<button class="btn btn-sm btn-approve" data-ed-review="approved" data-id="${e.id}"><i class="fa-solid fa-check"></i>通过</button><button class="btn btn-danger btn-sm" data-ed-review="rejected" data-id="${e.id}"><i class="fa-solid fa-ban"></i>驳回</button>` : ''}
            </div>
            <div class="muted" style="font-size:12px">by ${escapeHtml(e.username)} · <i class="fa-solid fa-thumbs-up"></i> ${e.like_count}${e.status !== 'approved' ? ` · ${escapeHtml(e.status_label)}` : ''}</div>
          </div>`).join('');
    // 右侧栏：讨论
    const discSideHtml = discussions.length === 0
      ? '<div class="muted" style="padding:10px 0;text-align:center">暂无讨论</div>'
      : discussions.map((dsc) => `
          <div style="padding:7px 0;border-bottom:1px dashed var(--border)">
            <a href="#/discussion/${dsc.id}" style="font-weight:600;font-size:14px" target="_blank" rel="noopener">${escapeHtml(dsc.title)}</a>
            <div class="muted" style="font-size:12px">${escapeHtml(dsc.username)} · <i class="fa-solid fa-comments"></i> ${dsc.reply_count} · ${fmtTime(dsc.created_at)}</div>
          </div>`).join('');
    sideExtras = `
      <div class="card">
        <div class="row">
          <h2 class="card-title" style="margin:0">题解（${editorials.length}）</h2>
          <div class="spacer"></div>
          ${artOff ? '<span class="tag" style="color:var(--red);font-size:11px">功能关闭</span>' : (edClosed ? '<span class="tag" style="color:var(--red);font-size:11px">已关闭</span>' : `<a class="btn btn-ghost btn-sm" href="#/editorial/new/${p.id}"><i class="fa-solid fa-pen-nib"></i>写题解</a>`)}
          ${Store.user && Store.user.is_admin ? `<button class="btn btn-ghost btn-sm" id="toggle-ed-closed" style="font-size:12px">${edClosed ? '<i class="fa-solid fa-lock-open"></i>开放提交' : '<i class="fa-solid fa-lock"></i>关闭提交'}</button>` : ''}
        </div>
        ${edClosed ? '<div class="muted" style="font-size:12px;margin-bottom:8px">管理员已关闭本题的题解提交通道。</div>' : ''}
        ${edSideHtml}
        <a class="muted" style="display:block;margin-top:6px;font-size:12px" href="#/editorials/problem/${p.id}">全部题解 →</a>
      </div>
      ${discOff ? '' : `<div class="card">
        <div class="row"><h2 class="card-title" style="margin:0">讨论（${discussions.length}）</h2><div class="spacer"></div><a class="btn btn-ghost btn-sm" href="#/discussions?problem=${p.id}"><i class="fa-solid fa-comments"></i>本题讨论</a></div>
        ${discSideHtml}
      </div>`}`;
  }

  // 题目信息（右侧栏）
  const acRate = p.submit_count > 0 ? ((p.accepted_count / p.submit_count) * 100).toFixed(1) + '%' : '0%';
  // 题目类型徽章（文案与后台「题目类型」下拉一致）：传统题 / 提交答案题 / 交互题 · IO / 通信题（两程序）。
  // 同时是提交答案与其它题型时多个徽章都会出现。
  const typeBadgeList = [];
  if (outputOnly) typeBadgeList.push(['#eb2f96', '提交答案题']);
  if (isInteractiveIO) typeBadgeList.push(['#722ed1', '交互题 · IO']);
  if (isInteractiveFunc) typeBadgeList.push(['#722ed1', '交互题 · 函数式']);
  // 通信题：与交互题刻意用不同颜色，一眼区分「两个选手程序合作」这一独立题型
  if (isCommunication) typeBadgeList.push(['#08979c', '通信题（两程序）']);
  if (!typeBadgeList.length) typeBadgeList.push(['#7b8794', '传统题']);
  const badgeHtml = (bg, label, extra = '') => `<span class="badge" style="background:${bg};color:#fff${extra}">${label}</span>`;
  const typeBadges = typeBadgeList.map(([bg, label]) => badgeHtml(bg, label)).join(' ');
  const interactiveBadge = typeBadgeList.map(([bg, label]) => badgeHtml(bg, label, ';font-size:12px;vertical-align:middle')).join(' ');
  // 「特性」一行：题目类型徽章 + 可选能力（O2 / Special Judge）；提交答案题不再单独占一个 O2 徽章
  const featBadges = [
    outputOnly ? '' : (p.enable_o2 ? badgeHtml('#13c2c2', 'O2 优化') : ''),
    p.spj ? badgeHtml('#8e44ad', 'Special Judge') : '',
    typeBadges,
  ].filter(Boolean).join(' ');
  // 交互题 / 通信题提示横幅：IO 交互提示不要读写文件 / 刷新缓冲；函数式交互提示只需实现题面函数；
  // 通信题提示**提交两个程序**并说明两者的输入输出关系与连接方式（relay / direct）。
  const interactiveBanner = !isInteractive ? '' : `
    <div class="status-banner blue" style="margin-top:12px">
      <span><i class="fa-solid fa-comments"></i> ${isCommunication ? '通信题（需要两个程序）' : (isInteractiveFunc ? '函数式交互题' : 'IO 交互题')}</span>
      <span class="muted">${isCommunication
        ? `本题需要提交<b>两个程序</b>：请求下方的「程序一」「程序二」都要填写。程序一读入题目输入并产生输出，程序二以程序一的输出为输入产生最终答案；评测端按题目配置的<b>${escapeHtml(p.pipe_mode_label || 'relay（评测端中转）')}</b>方式把两者对接。仅支持 C / C++ 提交，两个程序都只用标准输入输出。`
        : (isInteractiveFunc
          ? '你只需实现题面指定的函数，<b>不要自带 <code>main()</code></b>：评测时评测机会把 grader 与你的代码一起编译链接（仅支持 C / C++ 提交）。'
          : '你的程序通过<b>标准输入输出</b>与评测机的交互器对话；请<b>不要读写任何文件</b>，每次输出后刷新缓冲区（如 <code>fflush(stdout)</code>），也不要打印多余的调试信息。')}</span>
    </div>`;
  // 历史最高得分（放在「题目信息」内；题目设置不显示分数时显示 AC/WA；比赛题目不显示）
  // 注意：my_submissions 只保留最近 8 条，只能用来看列表/兜底；次数与历史最高一律用后端返回的真实统计字段
  //（my_submission_count / my_best_score / my_accepted 均按「用户+题目」全量统计，不受 LIMIT 8 影响）。
  const mySubs = (Store.user && p.my_submissions) || [];
  const mySubCount = p.my_submission_count != null ? Number(p.my_submission_count) : mySubs.length;
  const bestScoreHtml = (() => {
    if (!mySubCount) return '<span class="muted">未提交</span>';
    if (p.show_score) {
      const best = p.my_best_score != null ? Number(p.my_best_score) : Math.max(...mySubs.map((s) => s.score || 0));
      return `<strong style="color:${ioiScoreColor(best)}">${best}</strong>`;
    }
    const accepted = p.my_accepted != null ? !!p.my_accepted : mySubs.some((s) => s.verdict === 'Accepted');
    return accepted
      ? '<span class="verdict-AC">AC</span>'
      : '<span class="verdict-WA">WA</span>';
  })();
  const attCard = atts.length ? `
    <div class="card att-card">
      <div class="row" style="align-items:baseline;margin-bottom:8px">
        <h2 class="card-title" style="margin:0"><i class="fa-solid fa-paperclip"></i> 附件下载</h2>
        <div class="spacer"></div>
        <span class="muted" style="font-size:12px">共 ${atts.length} 个</span>
      </div>
      <div class="att-list">
        ${atts.map((a) => {
          const ic = attIcon(a.name);
          return `<a class="att-item" href="/api/problems/${p.id}/attachments/${encodeURIComponent(a.name)}" download title="下载 ${escapeHtml(a.name)}">
            <span class="att-ico" style="color:${ic.c}"><i class="fa-solid ${ic.i}"></i></span>
            <span class="att-main">
              <span class="att-name">${escapeHtml(a.name)}</span>
              <span class="att-meta">${fmtBytes(a.size)}${a.mtime ? ' · ' + fmtTime(a.mtime) : ''}</span>
            </span>
            <span class="att-dl"><i class="fa-solid fa-download"></i></span>
          </a>`;
        }).join('')}
      </div>
    </div>` : '';
  const probSide = `
    <div class="card">
      <h2 class="card-title"><i class="fa-solid fa-circle-info"></i> 题目信息</h2>
      ${contestInfo ? '' : `<div class="info-row"><span class="il">难度</span><span class="iv">${diffBadge}</span></div>`}
      <div class="info-row"><span class="il">通过率</span><span class="iv">${acRate}</span></div>
      <div class="info-row"><span class="il">通过 / 提交</span><span class="iv">${p.accepted_count} / ${p.submit_count}</span></div>
      <div class="info-row"><span class="il">时间限制</span><span class="iv">${fmtTimeLimit(p)}</span></div>
      <div class="info-row"><span class="il">内存限制</span><span class="iv">${fmtMemoryLimit(p)}</span></div>
      ${contestInfo ? '' : (p.tags.length ? `<div class="info-row"><span class="il">标签</span><span class="iv">${p.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</span></div>` : '')}
      ${contestInfo ? '' : (p.source ? `<div class="info-row"><span class="il">来源</span><span class="iv">${escapeHtml(p.source)}</span></div>` : '')}
      ${p.created_by_username ? `<div class="info-row"><span class="il">上传者</span><span class="iv">${userSpan({ uid: p.created_by, username: p.created_by_username, nickname: p.created_by_username })}</span></div>` : ''}
      <div class="info-row${(Store.user && !contestInfo) ? '' : ' style="border-bottom:none"'}"><span class="il">特性</span><span class="iv">${featBadges || '—'}</span></div>
      ${(Store.user && !contestInfo) ? `
      <div class="info-row"><span class="il">历史最高</span><span class="iv">${bestScoreHtml}</span></div>
      <div class="info-row" style="border-bottom:none"><span class="il">提交记录</span><span class="iv"><a href="#/submissions?problem=${p.id}&mine=1&contest=0">${mySubCount} 次 →</a></span></div>` : ''}
    </div>
    ${attCard}
    ${!contestInfo ? sideExtras : ''}`;

  // 题面区块：题目背景 / 题目描述 / 输入格式 / 输出格式 / 样例 / 提示。
  // 很多题目（尤其是导入的洛谷风格题面）会自己在正文里写「## 题目描述」，
  // 这种情况不再自动补小标题，避免整页出现两个「题目描述」。
  const descHasOwnHeading = /^\s*<h[1-3][^>]*>\s*题目描述\s*<\/h[1-3]>/i.test(String(p.description_html || ''));
  const statementSections = [
    p.background ? '<h2>题目背景</h2>' + (p.background_html || '') : '',
    p.description_html ? (descHasOwnHeading ? p.description_html : '<h2>题目描述</h2>' + p.description_html) : '',
    p.input_format ? '<h2>输入格式</h2>' + p.input_format_html : '',
    p.output_format ? '<h2>输出格式</h2>' + p.output_format_html : '',
    // 交互说明 / 通信说明：管理员在题目编辑器里填写，与题面同样走 Markdown / LaTeX 渲染
    (isInteractive && p.interactive_hint) ? `<h2>${isCommunication ? '通信说明' : '交互说明'}</h2>` + (p.interactive_hint_html || '') : '',
    // 样例区：samplesHtml 为空表示「所有样例两侧都为空」已被整块跳过，此时连标题也不出现
    samplesHtml ? '<h2>样例</h2>' + samplesHtml : '',
    p.hint ? '<h2>提示</h2>' + p.hint_html : '',
  ].filter(Boolean).join('');

  app.innerHTML = `
    <div class="crumb"><a href="${contestInfo ? '#/contest/' + contestInfo.id : '#/problems'}"><i class="fa-solid fa-arrow-left"></i> ${contestInfo ? '返回比赛' : '返回题库'}</a></div>
    <div class="row mt" style="margin-top:8px;align-items:baseline">
      <h1 class="page-heading">${escapeHtml(p.title)}</h1>
      ${interactiveBadge}
      <div class="spacer"></div>
      ${favBtnHtml}
      ${mdCopyBtn}
      ${adminBtns}
    </div>
    ${contestBanner}
    ${interactiveBanner}

    <div class="contest-grid">
      <div class="cg-main">
        <div class="card statement">
          ${statementSections}
        </div>

        <div class="card" id="submit-card">
          <h2 class="card-title">${p.output_only ? '提交答案' : '提交代码'} <a class="btn btn-ghost btn-sm" href="/docs/USAGE.md#一普通用户" target="_blank" rel="noopener"><i class="fa-solid fa-book"></i>使用说明</a></h2>
          ${Store.user ? (p.output_only ? `
            <div class="answer-drop" id="answer-drop">
              <i class="fa-solid fa-file-zipper"></i>
              <div style="font-weight:600;margin-top:6px">点击选择答案文件，或把文件拖到这里</div>
              <div class="muted" style="font-size:12px;margin-top:4px">单个测试点：直接上传答案文件（<code>.out</code> / <code>.ans</code> / <code>.txt</code>）<br />多个测试点：打包成 ZIP，内含 <code>1.out</code>、<code>2.out</code> …（与测试点编号对应）</div>
              <input type="file" id="answer-file" style="display:none" accept=".zip,.out,.ans,.txt,.in" />
            </div>
            <div class="row" style="gap:10px;align-items:center;margin-top:10px">
              <span class="muted" id="answer-file-info">尚未选择文件</span>
              <button type="button" class="btn btn-ghost btn-sm" id="answer-file-clear" style="display:none"><i class="fa-solid fa-eraser"></i>清除</button>
            </div>
            <div class="answer-tips">
              <span><i class="fa-solid fa-circle-info"></i> 提交后按测试点编号取用答案内容，评测结果会显示每个测试点是否正确。</span>
              <span><i class="fa-solid fa-triangle-exclamation"></i> 单文件上限 32MB；ZIP 内请勿再套一层目录。</span>
            </div>
            <div class="row mt">
              <button class="btn btn-lg" id="submit-btn" disabled><i class="fa-solid fa-cloud-arrow-up"></i>提交评测</button>
              <span class="muted">提交后将自动评测并显示结果</span>
            </div>
            <div id="submit-status" class="mt"></div>` : `
            <div class="submit-modes" id="submit-modes" style="display:${isCommunication ? 'none' : ''}">
              <button type="button" class="chip active" data-mode="code"><i class="fa-solid fa-keyboard"></i> 提交代码</button>
              <button type="button" class="chip" data-mode="file"><i class="fa-solid fa-file-arrow-up"></i> 提交代码文件</button>
            </div>
            <div class="row mb" style="gap:10px;align-items:center">
              <label style="font-weight:600">语言：</label>
              <select class="input" id="lang-select" style="width:auto">${langOptionsWithAuto}</select>
              <span class="muted" id="lang-auto-tip" style="font-size:12px"></span>
              <label id="o2-wrap" class="switch" style="margin-left:6px;display:${(p.enable_o2 !== false && (initialPick === 'auto' || O2_LANGS.includes(initialO2Lang))) ? '' : 'none'}" title="仅 C/C++ 支持 O2 优化（编译时追加 -O2）；取消勾选即以不开优化的方式编译评测">
                <input type="checkbox" id="o2-check" ${(p.enable_o2 !== false) ? 'checked' : ''} />
                <span class="slider"></span>
                <span class="switch-label">开启 O2 优化</span>
              </label>
              <div class="spacer"></div>
              <a href="#/submissions?problem=${p.id}&contest=0" class="muted">查看本题全部提交记录 →</a>
            </div>
            ${isCommunication ? `<div class="status-banner warn" style="margin-top:-4px;margin-bottom:12px">
              <span style="font-weight:700"><i class="fa-solid fa-people-arrows"></i> 通信题：需要提交两个程序</span>
              <span class="muted">请在下方分别填写<b>程序一</b>与<b>程序二</b>（两者共用同一个语言，仅支持 C / C++）。程序一读入题目输入并输出中间结果，程序二以该结果（评测端可能再经 <code>grader.cpp</code> 中转处理）为输入，输出最终答案；两者都会各自受到时限 / 内存限制。连接方式：<b>${escapeHtml(p.pipe_mode_label || 'relay（评测端中转）')}</b>。</span>
            </div>` : ''}
            ${isInteractiveFunc ? `<div class="status-banner warn" style="margin-top:-4px;margin-bottom:12px">
              <span style="font-weight:700"><i class="fa-solid fa-code"></i> 仅支持 C / C++</span>
              <span class="muted">函数式交互题评测时会把 grader 与你的代码一起编译链接，因此语言下拉里只保留 C 与 C++；请只实现题面指定的函数，<b>不要自带 <code>main()</code></b>。</span>
            </div>` : ''}

            <div id="mode-code">
              ${isCommunication ? `
              <div class="comm-editors">
                <div class="comm-editor-block">
                  <div class="comm-editor-head"><i class="fa-solid fa-1"></i> 程序一（读入题目输入，产生输出）</div>
                  <div id="editor-host"></div>
                </div>
                <div class="comm-editor-block">
                  <div class="comm-editor-head"><i class="fa-solid fa-2"></i> 程序二（以程序一的输出为输入，产生答案）</div>
                  <div id="editor-host2"></div>
                </div>
              </div>` : '<div id="editor-host"></div>'}
              <div class="row mt">
                <button class="btn btn-lg" id="submit-btn"><i class="fa-solid fa-cloud-arrow-up"></i>提交评测</button>
                <span class="muted">提交后将自动评测并显示结果</span>
              </div>
            </div>

            <div id="mode-file" style="display:none">
              <div class="code-drop" id="code-drop">
                <i class="fa-solid fa-file-code"></i>
                <div style="font-weight:600;margin-top:6px">点击选择源码文件，或把文件拖到这里</div>
                <div class="muted" style="font-size:12px;margin-top:4px">单文件 ≤ 64KB · 按扩展名自动识别语言（也可用上面的语言框手动指定）· 文件内容直接提交，<b>不会载入代码框</b>${isInteractiveFunc ? ' · 函数式交互题请提交 <code>.c</code> / <code>.cpp</code> 文件' : ''}</div>
                <input type="file" id="code-file-input" style="display:none"
                  accept="${isInteractiveFunc ? '.cpp,.cc,.cxx,.c++,.c' : '.py,.js,.mjs,.cjs,.cpp,.cc,.cxx,.c++,.c,.java,.pas,.pp,.php,.go,.rs,.txt'}" />
              </div>
              <div class="row" style="gap:10px;align-items:center;margin-top:10px">
                <span class="muted" id="code-file-info">尚未选择文件</span>
                <button type="button" class="btn btn-ghost btn-sm" id="code-file-clear" style="display:none"><i class="fa-solid fa-eraser"></i>清除</button>
              </div>
              <div class="row mt">
                <button class="btn btn-lg" id="submit-file-btn" disabled><i class="fa-solid fa-cloud-arrow-up"></i>提交文件评测</button>
                <span class="muted">提交后将自动评测并显示结果</span>
              </div>
            </div>
            <div id="submit-status" class="mt"></div>`)
            : `<div class="empty">请先 <a href="#/login">登录</a> 后提交</div>`}
        </div>
      </div>
      <div class="cg-side">
        ${probSide}
      </div>
    </div>`;

  // 提交答案题：答案文件上传评测（拖放区 + 文件信息 + 提交）
  if (Store.user && p.output_only) {
    const drop = document.getElementById('answer-drop');
    const fileInput = document.getElementById('answer-file');
    const info = document.getElementById('answer-file-info');
    const clearBtn = document.getElementById('answer-file-clear');
    const submitBtn = document.getElementById('submit-btn');
    let answerFile = null;

    const setAnswerFile = (file) => {
      if (!file) return;
      const ext = String(file.name.split('.').pop() || '').toLowerCase();
      if (!['zip', 'out', 'ans', 'txt', 'in'].includes(ext)) {
        return toast('答案文件请使用 .zip / .out / .ans / .txt / .in', 'error');
      }
      if (file.size > 32 * 1024 * 1024) return toast('答案文件不能超过 32MB', 'error');
      answerFile = file;
      const kind = ext === 'zip' ? 'ZIP（多测试点）' : '单文件答案';
      if (info) {
        info.innerHTML = `已选择 <b>${escapeHtml(file.name)}</b>（${(file.size / 1024).toFixed(1)} KB · ${kind}）`;
        info.classList.add('code-file-ok');
      }
      if (clearBtn) clearBtn.style.display = '';
      if (submitBtn) submitBtn.disabled = false;
    };

    const clearAnswerFile = () => {
      answerFile = null;
      if (info) { info.textContent = '尚未选择文件'; info.classList.remove('code-file-ok'); }
      if (clearBtn) clearBtn.style.display = 'none';
      if (submitBtn) submitBtn.disabled = true;
    };

    if (drop && fileInput) {
      drop.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        setAnswerFile(fileInput.files && fileInput.files[0]);
        fileInput.value = '';
      });
      ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.add('code-drop-active');
      }));
      ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.remove('code-drop-active');
      }));
      drop.addEventListener('drop', (e) => {
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) setAnswerFile(f);
      });
      if (clearBtn) clearBtn.addEventListener('click', clearAnswerFile);
    }

    if (submitBtn) submitBtn.addEventListener('click', async () => {
      if (!answerFile) return toast('请先选择答案文件', 'error');
      const reader = new FileReader();
      const btn = submitBtn;
      btn.disabled = true;
      if (info) info.textContent = '正在上传并提交…';
      reader.onload = async () => {
        try {
          const raw = String(reader.result || '');
          const answerBase64 = raw.slice(raw.indexOf(',') + 1);
          const payload = { language: 'output', answer_file: answerBase64 };
          if (contestId) payload.contest_id = parseInt(contestId, 10);
          const r = await api.post(`/api/problems/${p.id}/submit`, payload);
          toast('提交成功，正在评测…', 'success');
          pendingCelebrateId = r.id; // 本次提交若 AC，进入提交页后播放通过动画
          nav('submission/' + r.id);
        } catch (e) {
          toast(e.message, 'error');
          btn.disabled = false;
          if (info && answerFile) info.innerHTML = `已选择 <b>${escapeHtml(answerFile.name)}</b>（${(answerFile.size / 1024).toFixed(1)} KB）`;
        }
      };
      reader.onerror = () => {
        toast('读取文件失败', 'error');
        btn.disabled = false;
        if (info && answerFile) info.innerHTML = `已选择 <b>${escapeHtml(answerFile.name)}</b>（${(answerFile.size / 1024).toFixed(1)} KB）`;
      };
      reader.readAsDataURL(answerFile);
    });
  }

  // 普通提交
  if (Store.user && defaultLang && !p.output_only) {
    const langSelect = document.getElementById('lang-select');
    const langTip = document.getElementById('lang-auto-tip');
    const o2Wrap = document.getElementById('o2-wrap');
    /* O2 开关的**题目侧**条件：题目字段 `enable_o2`（problems.enable_o2，缺省 1 = 允许）。
       提交时 payload.enable_o2 取开关勾选值，服务端 src/submissions.js 的
       `enableO2 == null ? (problem.enable_o2 !== 0 && problem.enable_o2 !== false) : !!enableO2`
       与此处的判断口径一致。 */
    const o2Check = document.getElementById('o2-check');
    const o2Allowed = p.enable_o2 !== false;
    const editor = createEditor(document.getElementById('editor-host'), { language: defaultLang });
    // 通信题：第二个代码框（程序二）。两者共用上方同一个语言下拉与 O2 开关（评测时分别编译成两个可执行文件）。
    const editor2 = isCommunication ? createEditor(document.getElementById('editor-host2'), { language: defaultLang }) : null;
    // 默认选中「上次提交选择的语言」；「自动识别语言」同样会被记住
    langSelect.value = initialPick;
    let autoDetected = '';   // 自动识别出的语言（供提交时使用）

    const rememberPick = (pick) => { try { localStorage.setItem('lczoj_last_lang', pick); } catch { /* ignore */ } };
    const rememberReal = (lang) => { if (lang) { try { localStorage.setItem('lczoj_last_real_lang', lang); } catch { /* ignore */ } } };

    /* O2 文案（本轮调整）：把两件事拆开，避免「语言不认识 ⇒ O2 状态整段消失」
       · 题目允许 O2  → 固定「（O2 优化：开启 / 未开启）」，只跟开关勾选值走，**与语言无关**；
       · 题目不允许 O2 → 只有本次语言本来能开 O2（C/C++ 系，见 O2_LANGS）时才写「（本题不允许 O2）」。 */
    const isO2Lang = (lang) => O2_LANGS.includes(lang);
    const o2StateSuffix = () => `（O2 优化：${(o2Check && o2Check.checked) ? '开启' : '未开启'}）`;
    const o2DenySuffix = (lang) => (isO2Lang(lang) ? '（本题不允许 O2）' : '');
    /* O2 开关的**显示**条件（本轮调整）：
       · 题目不允许 O2 时一律不显示（开关勾了也不会生效，改用文案提示）；
       · 语言选「自动识别语言」时**立即显示**——语言要等提交那一刻才识别，不能先藏起来；
       · 手动选了具体语言时，只有 C/C++ 系才显示（与改动前一致）。 */
    const showO2For = (lang) => {
      if (!o2Wrap) return;
      o2Wrap.style.display = (o2Allowed && (isAuto() || isO2Lang(lang))) ? '' : 'none';
    };
    const isAuto = () => langSelect.value === 'auto';
    const langNameOf = (key) => {
      const opt = [...langSelect.options].find((o) => o.value === key);
      return opt ? opt.textContent.replace(/（未安装）$/, '') : key;
    };
    const syncEditorLang = () => {
      const eff = isAuto() ? (autoDetected || defaultLang) : langSelect.value;
      editor.setLanguage(eff);
      // 通信题的程序二与程序一共用同一个语言（评测时分别编译）
      if (editor2) {
        editor2.setLanguage(eff);
        editor2.setLanguageLabel(isAuto() ? '' : (LANG_NAMES[eff] || eff));
      }
      // 「自动识别语言」时不显示语言名（只显示字符数）——避免代码框里写着一个并不作数的语言
      editor.setLanguageLabel(isAuto() ? '' : (LANG_NAMES[eff] || eff));
      showO2For(eff);
    };
    /** 解析本次提交真正使用的语言：选了具体语言就用它；选了「自动识别」就**在提交这一刻**按代码内容识别 */
    const resolveSubmitLang = async (codeForDetect) => {
      if (!isAuto()) {
        rememberPick(langSelect.value);
        rememberReal(langSelect.value);
        return langSelect.value;
      }
      const detected = detectLanguage(codeForDetect || '');
      rememberPick('auto');
      if (!detected) {
        toast('没能自动识别出语言，请在语言里手动选择后重试', 'error');
        if (langTip) langTip.textContent = autoTipText('未能识别语言，请手动选择');
        return '';
      }
      autoDetected = detected;
      rememberReal(detected);
      refreshLangTip();   // 统一由 refreshLangTip 输出「自动识别：<语言>（O2 优化：开启/未开启）」
      return detected;
    };

    /* ---------- 语言自动识别（按代码内容判断） ---------- */
    const EXT_LANG = {
      py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
      cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp', c: 'c',
      java: 'java', pas: 'pascal', pp: 'pascal', php: 'php', go: 'go', rs: 'rust',
    };
    /** 按内容特征给各语言打分，取最高分（分数太低则认为无法判断） */
    const detectLanguage = (code) => {
      const s = String(code || '');
      if (s.trim().length < 8) return '';
      const head = s.slice(0, 4000);
      const scores = {
        python: 0, javascript: 0, cpp: 0, c: 0, java: 0, pascal: 0, php: 0, go: 0, rust: 0,
      };
      const hit = (lang, re, weight) => { if (re.test(head)) scores[lang] += (weight || 1); };
      // 强特征
      hit('php', /<\?php/i, 10);
      /* Pascal（本轮修复）：原来只有一条 `\b(program|begin|end\.|writeln|readln)\b` +3，
         而下面"够分才认"的阈值是 6 —— 一条特征最多 3 分，**Pascal 永远到不了 6 分**，
         所以粘贴 Pascal 代码时要么识别不出、要么被算成别的语言。
         现在按 Pascal 的真实语法分档给分（语言标识固定为 `pascal`，
         与 src/config.js 的 LANGUAGES.pascal.key / /api/languages 的 key 一致）：
           · `program xxx;`（标准写法，最强线索）                      +6
           · `end.`（程序体结束，Pascal 独有）                          +4
           · `begin` + `end;` / `end.`（语句块，用 `(^|[;\s])begin` 与
             `\bend\s*[;.]` 收紧，避免 C++ 的 std::begin/std::end(v) 误命中）  +3
           · `uses xxx;` / `unit xxx;` / `interface` / `implementation`   +4
           · `var` 段后跟 Pascal 类型（integer/longint/array …）          +4
           · `array[1..n] of`                                            +4
           · `writeln(` / `readln(`                                      +3
           · `:=` 赋值（C/C++/Python/Java/PHP/Rust 都没有）               +3
           · `procedure` / `function` + `;` 或 `(`                        +2
           · Pascal 关键字类型名                                           +1 */
      hit('pascal', /^\s*program\s+[A-Za-z_]\w*\s*(\(|;)/im, 6);
      hit('pascal', /\bend\s*\./, 4);
      if (/(^|[;\s])begin\b/im.test(head) && /\bend\s*[;.]/i.test(head)) scores.pascal += 3;
      hit('pascal', /\b(uses|unit|interface|implementation)\s+[A-Za-z_]\w*\s*;/i, 4);
      hit('pascal', /\bvar\b[\s\S]{0,400}?:\s*(integer|longint|int64|qword|cardinal|shortint|word|real|double|extended|boolean|char|string|ansistring|array)\b/i, 4);
      hit('pascal', /\barray\s*\[\s*\d+\s*\.\.\s*\w+\s*\]\s*of\b/i, 4);
      hit('pascal', /(^|[^\w.])(writeln|readln)\s*\(/im, 3);
      hit('pascal', /:=/, 3);
      hit('pascal', /\b(procedure|function)\s+[A-Za-z_]\w*\s*(\(|;)/i, 2);
      hit('pascal', /(^|[^\w.])(write|read)\s*\(/im, 2);
      hit('pascal', /\b(integer|longint|boolean|extended|ansistring|inc|dec)\b/i, 1);
      /* Pascal 必须有"强特征"才作数（program 行 / end. / begin…end / var 类型段 /
         array[1..n] of）——否则只靠 `:=`、`read(`、`write(` 这些弱特征可能把
         Go 的 `:=` 或 C 的 POSIX `read()/write()` 算成 Pascal。 */
      const pascalStrong =
        /^\s*program\s+[A-Za-z_]\w*/im.test(head)
        || /\bend\s*\./.test(head)
        || (/(^|[;\s])begin\b/im.test(head) && /\bend\s*[;.]/i.test(head))
        || /\bvar\b[\s\S]{0,400}?:\s*(integer|longint|int64|qword|cardinal|shortint|word|real|double|extended|boolean|char|string|ansistring|array)\b/i.test(head)
        || /\barray\s*\[\s*\d+\s*\.\.\s*\w+\s*\]\s*of\b/i.test(head);
      if (!pascalStrong) scores.pascal = 0;
      /* 反向排除：出现明确属于别的语言的写法时把 Pascal 分压下去
         （`const` / `class` 是 Pascal 自己的关键字，不列入） */
      if (/=>|#\s*include|#\s*define|\bdef\b|\blet\b|console\.log|\bfunc\s+\w+\s*\(|\bpackage\s+main\b|println!|\bpublic\s+static\b|\bstatic\s+\w+\s+\w+\s*\(/.test(head)) {
        scores.pascal = Math.max(0, scores.pascal - 6);
      }
      hit('go', /\bpackage\s+main\b/, 10);
      hit('go', /\bfunc\s+\w+\s*\(/, 3);
      hit('go', /fmt\.(Print|Sprint|Scan)/, 4);
      hit('rust', /\bfn\s+main\s*\(/, 10);
      hit('rust', /\b(let\s+mut|println!|use\s+std::|vec!)/, 4);
      hit('java', /\bpublic\s+(static\s+)?(class|void|int|long|String)\b/, 5);
      hit('java', /System\.out\.print/, 5);
      hit('java', /\bimport\s+java\./, 5);
      hit('javascript', /\b(console\.log|require\s*\(|module\.exports|=>|document\.\w+|process\.stdin)/, 4);
      hit('javascript', /\b(const|let|var)\s+\w+\s*=/, 2);
      hit('javascript', /\bfunction\s+\w+\s*\(/, 2);
      hit('python', /^\s*(def|class)\s+\w+.*:\s*$/m, 5);
      hit('python', /\b(elif|__name__|self\.|None|True|False|lambda|f["'])\b/, 3);
      hit('python', /^\s*(import\s+\w+|from\s+\w+\s+import)\b/m, 3);
      // 短小的 Python 片段（只有 print / input / 冒号结尾的块）也要能认出来
      hit('python', /(^|[^\w.])print\s*\(/, 3);
      hit('python', /(^|[^\w.])input\s*\(|sys\.std(in|out)/, 3);
      hit('python', /^\s*(if|for|while|else|elif|with|try|except)\b[^\n]*:\s*$/m, 3);
      hit('python', /\brange\s*\(|\blen\s*\(|\bsplit\s*\(/, 1);
      hit('cpp', /#\s*include\s*<(iostream|bits\/stdc\+\+\.h|vector|string|algorithm|map|set|queue|stack|cstdio)>/, 6);
      hit('cpp', /\b(std::|using\s+namespace\s+std|cout|cin|endl|vector<|template\s*<|nullptr)\b/, 4);
      hit('cpp', /\b(class|struct)\s+\w+\s*\{[\s\S]*?\bpublic\s*:/, 3);
      hit('c', /#\s*include\s*<(stdio|stdlib|string|math|stdbool)\.h>/, 6);
      hit('c', /\b(printf|scanf|malloc|free|sizeof|struct\s+\w+\s*\{)\b/, 3);
      // 排除：C 特征出现在 C++ 里时降权
      if (scores.cpp > 0 && scores.c > 0 && /std::|using\s+namespace\s+std|cout|cin|<\w+>/.test(head)) scores.c = Math.max(0, scores.c - 6);
      if (scores.python > 0 && /\bdef\s+\w+\s*\(.*\)\s*:/.test(head)) scores.python += 2;
      let best = '';
      let bestScore = 0;
      for (const [k, v] of Object.entries(scores)) {
        if (v > bestScore) { bestScore = v; best = k; }
      }
      // 只有明显够分才认（避免把普通文本误判）
      return bestScore >= 6 ? best : '';
    };
    /** 「自动识别语言」下的提示文案（本轮调整）：题目允许 O2 时**无论如何都先显示 O2 状态**。
     *  · 已识别出语言   → 「自动识别：<语言名>（O2 优化：开启 / 未开启）」
     *  · 还没识别出语言 → 「提交时按代码内容自动识别（O2 优化：开启 / 未开启）」
     *  · 识别失败       → 「未能识别语言，请手动选择（O2 优化：开启 / 未开启）」
     *    三段都带 O2 状态：不等识别结果，也不会因为识别出的是不能开 O2 的语言（如 Python）就把这段藏掉；
     *    括号里的开 / 未开与 O2 开关的勾选状态实时同步（见下方 o2Check 的 change 监听）。
     *  · 题目不允许 O2 → 只有（已识别 / 默认）语言本来能开 O2 时才补一句「（本题不允许 O2）」，
     *    否则整段不提 O2（此时开关本身也不显示）。
     *  · 手动选了具体语言 → 只有「题目不允许 O2 而该语言本来能开 O2」时才提示一句，
     *    其余情况留空（开关本身就在旁边，不必重复；与改动前完全一致，无回归）。 */
    const autoTipText = (prefix) => {
      const base = prefix || (autoDetected ? `自动识别：${langNameOf(autoDetected)}` : '提交时按代码内容自动识别');
      if (o2Allowed) return base + o2StateSuffix();
      return base + o2DenySuffix(autoDetected || defaultLang);
    };
    const refreshLangTip = () => {
      if (!langTip) return;
      if (isAuto()) { langTip.textContent = autoTipText(); return; }
      const cur = langSelect.value;
      langTip.textContent = (isO2Lang(cur) && !o2Allowed) ? '本题不允许 O2' : '';
    };
    // O2 开关变化：后缀里的「开启 / 未开启」要立刻跟着变
    if (o2Check) o2Check.addEventListener('change', refreshLangTip);
    // 选择语言：选具体语言即按它提交；选「自动识别语言」则等到提交那一刻按内容识别。
    // 注意：这里**不写记忆**——默认值只认「上次真正提交过」的语言（见 resolveSubmitLang）
    langSelect.addEventListener('change', () => {
      if (!isAuto()) {
        autoDetected = '';
      }
      refreshLangTip();
      syncEditorLang();
    });
    syncEditorLang();
    refreshLangTip();

    /* ---------- 提交方式：代码 / 代码文件（两个模式互不干扰） ---------- */
    const modeBtns = [...document.querySelectorAll('#submit-modes .chip')];
    const modeCode = document.getElementById('mode-code');
    const modeFile = document.getElementById('mode-file');
    let currentMode = 'code';
    const setMode = (mode) => {
      // 通信题必须提交**两个**程序的源码，没有「单文件」这种提交方式：强制停留在代码模式
      currentMode = (mode === 'file' && !isCommunication) ? 'file' : 'code';
      modeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === currentMode));
      if (modeCode) modeCode.style.display = currentMode === 'code' ? '' : 'none';
      if (modeFile) modeFile.style.display = currentMode === 'file' ? '' : 'none';
      try { localStorage.setItem('lczoj_submit_mode', currentMode); } catch { /* ignore */ }
    };
    modeBtns.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    try {
      const saved = localStorage.getItem('lczoj_submit_mode');
      if (saved === 'file' && !isCommunication) setMode('file');
    } catch { /* ignore */ }

    /* ---------- 提交代码文件：直接读文件内容提交，**不载入代码框** ---------- */
    const fileInput = document.getElementById('code-file-input');
    const dropZone = document.getElementById('code-drop');
    const fileInfo = document.getElementById('code-file-info');
    const fileClear = document.getElementById('code-file-clear');
    const submitFileBtn = document.getElementById('submit-file-btn');
    let pickedFile = null;   // { name, size, text, lang }

    const readFileText = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsText(file, 'utf-8');
    });

    const pickFile = async (file) => {
      if (!file) return;
      if (isCommunication) return toast('通信题需要提交两个程序，请直接填写两个代码框（不支持单文件提交）', 'error');
      if (file.size > 64 * 1024) return toast('代码文件不能超过 64KB', 'error');
      const ext = String(file.name.split('.').pop() || '').toLowerCase();
      const lang = EXT_LANG[ext] || '';
      let text = '';
      try { text = await readFileText(file); } catch (e) { return toast(e.message, 'error'); }
      pickedFile = { name: file.name, size: file.size, text, lang };
      if (fileInfo) {
        fileInfo.innerHTML = `已选择 <b>${escapeHtml(file.name)}</b>（${(file.size / 1024).toFixed(1)} KB）`
          + (lang ? ` · 语言自动识别为 <b>${escapeHtml((langSelect.querySelector(`option[value="${lang}"]`) || {}).textContent || lang)}</b>` : ' · 未能按扩展名识别语言');
        fileInfo.classList.add('code-file-ok');
      }
      if (fileClear) fileClear.style.display = '';
      if (submitFileBtn) submitFileBtn.disabled = false;
      // 语言：手动选定具体语言时用它；「自动识别」时记录扩展名线索用于高亮，真正识别在提交那一刻进行。
      // 这里不写「上次提交语言」的记忆（只有真正提交才算数）
      const byExt = lang;
      if (byExt) {
        autoDetected = byExt;
      }
      refreshLangTip();
      syncEditorLang();
      if (byExt && isAuto() && fileInfo) {
        fileInfo.innerHTML += ` · 语言：<b>${escapeHtml(langNameOf(byExt))}</b>（按扩展名）`;
      }
    };

    if (dropZone && fileInput) {
      dropZone.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        pickFile(fileInput.files && fileInput.files[0]);
        fileInput.value = '';
      });
      ['dragenter', 'dragover'].forEach((ev) => dropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropZone.classList.add('code-drop-active');
      }));
      ['dragleave', 'drop'].forEach((ev) => dropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropZone.classList.remove('code-drop-active');
      }));
      dropZone.addEventListener('drop', (e) => {
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) pickFile(f);
      });
      if (fileClear) fileClear.addEventListener('click', () => {
        pickedFile = null;
        if (fileInfo) { fileInfo.textContent = '尚未选择文件'; fileInfo.classList.remove('code-file-ok'); }
        fileClear.style.display = 'none';
        if (submitFileBtn) submitFileBtn.disabled = true;
      });
    }
    // 拖到整个提交卡片上：切到「提交代码文件」并选中该文件（不再载入代码框）
    const submitCard = document.getElementById('submit-card');
    if (submitCard) {
      ['dragenter', 'dragover'].forEach((ev) => submitCard.addEventListener(ev, (e) => {
        if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault();
      }));
      submitCard.addEventListener('drop', (e) => {
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!f) return;
        e.preventDefault();
        setMode('file');
        pickFile(f);
      });
    }

    if (submitFileBtn) {
      submitFileBtn.addEventListener('click', async () => {
        if (!pickedFile) return toast('请先选择代码文件', 'error');
        // 「自动识别」时：优先用扩展名给出的线索（最可靠），扩展名不认识才按文件内容识别 —— 都在提交这一刻做
        let lang = '';
        if (!isAuto()) {
          lang = await resolveSubmitLang('');
        } else if (pickedFile.lang) {
          lang = pickedFile.lang;
          autoDetected = lang;
          rememberPick('auto');
          rememberReal(lang);
          refreshLangTip();
        } else {
          lang = await resolveSubmitLang(pickedFile.text);
        }
        if (!lang) return;
        const btn = submitFileBtn;
        btn.disabled = true;
        try {
          const payload = {
            language: lang,
            code: pickedFile.text,
            enable_o2: document.getElementById('o2-check') ? document.getElementById('o2-check').checked : undefined,
          };
          if (contestId) payload.contest_id = parseInt(contestId, 10);
          const r = await api.post(`/api/problems/${p.id}/submit`, payload);
          toast(`已提交文件 ${pickedFile.name}（${langNameOf(lang)}），正在评测…`, 'success');
          pendingCelebrateId = r.id;
          nav('submission/' + r.id);
        } catch (e) {
          toast(e.message, 'error');
          btn.disabled = false;
        }
      });
    }

    document.getElementById('submit-btn').addEventListener('click', async () => {
      const code = editor.getValue();
      // 通信题：两个程序都必须填（服务端 src/submissions.js 同样会校验并给出明确提示）
      const code2 = editor2 ? editor2.getValue() : '';
      if (!code.trim()) return toast(isCommunication ? '程序一（程序一代码）不能为空' : '代码不能为空', 'error');
      if (isCommunication && !code2.trim()) return toast('程序二（程序二代码）不能为空：通信题需要两个程序合作完成任务', 'error');
      const lang = await resolveSubmitLang(code);
      if (!lang) return;
      const btn = document.getElementById('submit-btn');
      btn.disabled = true;
      try {
        const payload = {
          language: lang,
          code,
          enable_o2: document.getElementById('o2-check') ? document.getElementById('o2-check').checked : undefined,
        };
        // 只有通信题才带第二份程序（其余题型服务端会忽略该字段，带上也无副作用，但保持语义干净）
        if (isCommunication) payload.code2 = code2;
        if (contestId) payload.contest_id = parseInt(contestId, 10);
        const r = await api.post(`/api/problems/${p.id}/submit`, payload);
        toast('提交成功，正在评测…', 'success');
        pendingCelebrateId = r.id; // 本次提交若 AC，进入提交页后播放通过动画
        nav('submission/' + r.id);
      } catch (e) {
        toast(e.message, 'error');
        btn.disabled = false;
      }
    });
  }

  // 收藏
  const favBtn = document.getElementById('fav-btn');
  if (favBtn) favBtn.addEventListener('click', async () => {
    try {
      if (p.is_favorite) {
        await api.del('/api/favorites/problem/' + p.id);
        toast('已取消收藏', 'info');
      } else {
        await api.post('/api/favorites', { type: 'problem', id: p.id });
        toast('已收藏', 'success');
      }
      renderProblemDetail(id, query);
    } catch (e) { toast(e.message, 'error'); }
  });
  // 复制题面为 Markdown（洛谷式）
  const mdBtn = document.getElementById('copy-md-btn');
  if (mdBtn) mdBtn.addEventListener('click', async () => {
    if (await copyText(buildProblemMarkdown(p))) toast('题面已复制为 Markdown', 'success');
    else toast('复制失败，请手动全选复制', 'error');
  });

  // 题目管理权限：删除题目（连带测试数据 / 附件 / 提交记录）
  const problemDelBtn = document.getElementById('problem-del-btn');
  if (problemDelBtn) problemDelBtn.addEventListener('click', async () => {
    if (!confirm(`确定删除题目「${p.title}」吗？\n将同时删除该题的测试数据、附件与全部提交记录，此操作不可恢复。`)) return;
    try {
      await api.del('/api/problems/' + p.id);
      toast('题目已删除', 'success');
      nav(contestInfo ? 'contest/' + contestInfo.id : 'problems');
    } catch (e) { toast(e.message, 'error'); }
  });

  // 管理员：开关本题题解提交通道
  const toggleEdClosed = document.getElementById('toggle-ed-closed');
  if (toggleEdClosed) toggleEdClosed.addEventListener('click', async () => {
    try {
      await api.post(`/api/problems/${p.id}/editorial-closed`, { closed: !p.editorial_closed });
      toast(p.editorial_closed ? '已开放本题题解提交' : '已关闭本题题解提交', 'success');
      renderProblemDetail(id, query);
    } catch (e) { toast(e.message, 'error'); }
  });

  // 管理员在题目页直接审核题解
  document.querySelectorAll('button[data-ed-review]').forEach((b) => b.addEventListener('click', async () => {
    const status = b.dataset.edReview;
    let reason = '';
    if (status === 'rejected') {
      reason = prompt('请填写驳回原因（必填）');
      if (!reason || !reason.trim()) return toast('驳回题解必须填写原因', 'error');
    }
    try {
      await api.post(`/api/editorials/${b.dataset.id}/review`, { status, reason });
      toast(status === 'approved' ? '已通过' : '已驳回', 'success');
      renderProblemDetail(id, query);
    } catch (e) { toast(e.message, 'error'); }
  }));
}

/* ---------- 提交记录 ---------- */

/**
 * 提交记录列表「分数」列：ACM 赛制比赛的行不显示数字分值，只显示对错。
 * 词表沿用站内既有说法 —— 提交详情页 `hide_score`（ACM 赛制 / 不显示分数的题目）分支用的就是
 * 「正确 / 错误」（见 buildSubmissionSide / buildSubmitBannerHtml），此处不新造词。
 * 判定依据是**该行自己的** contest_type：跨比赛视图（contest=all / only）里每一行可能来自不同赛制的比赛，
 * 必须按行判断，不能看当前筛选的比赛（那个变量只描述"当前视图"）。
 * Pending / Judging 尚未出结果，沿用站内既有状态词（Pending / Judging），不显示成「错误」。
 */
function acmListScoreCell(s) {
  if (s.verdict === 'Pending' || s.verdict === 'Judging') {
    return `<td class="num muted">${escapeHtml(listStatusInfo(s.verdict).label)}</td>`;
  }
  const ok = s.verdict === 'Accepted';
  // v2.6.3：**不加** verdict-AC / verdict-WA 配色类 —— 「正确 / 错误」与「分数」列用完全相同的普通 .num 单元格
  // 样式（同色同字号，只有文字不同）；对错仍由左侧「状态」列自身颜色表达，此处刻意不再重复着色。
  return `<td class="num">${ok ? '正确' : '错误'}</td>`;
}

async function renderSubmissions(query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const problem = query.get('problem') || '';
  const verdict = query.get('verdict') || '';
  // 来源筛选（v2.6.3）：全部 / 题库 / 比赛。contest 为空（老链接、默认进入）按「全部」处理，
  // contest=all 命中「全部」（个人中心「查看全部（N 条）→」链接继续可用），contest=0 为「题库」，
  // contest=only 与 contest=<比赛 id>（比赛页「比赛提交记录」入口）都归入「比赛」。
  const contest = query.get('contest') || '';
  const contestId = /^[0-9]+$/.test(contest) && contest !== '0' ? contest : '';
  const source = (contest === '0') ? 'bank' : (contest === '' || contest === 'all') ? 'all' : 'contest';
  // 归一化后写回 URL / 分页 / 筛选的来源参数：hash 能如实反映选择（可分享、刷新不丢）
  const contestUrl = source === 'all' ? 'all' : (source === 'bank' ? '0' : (contestId || 'only'));
  // 「指定了某一场具体比赛」（contest=<比赛 id>，比赛页「比赛提交记录」入口）：这场比赛就是唯一的范围，
  // 题目筛选框在该视图里没有意义 —— 下方据 specificContest **不渲染**该控件（不是用 CSS 隐藏）。
  // contest=all / 0 / only（全部 / 题库 / 跨比赛）都不设置它，题目筛选框保持现状。
  const specificContest = !!contestId;
  const page = parseInt(query.get('page') || '1', 10);
  // 默认用当前用户 ID 筛选并填充；也可指定题目或用户查询。
  // 从题目页进入（带 problem 参数）时展示该题所有人的提交，不自动限定为本人。
  let user = query.get('user') || '';
  let mine = query.get('mine') || '';
  const fromProblemPage = !!problem;
  // 「只看我的提交」（?mine=1，题目页的「N 次 →」/「只看我的提交」进来的）也是"查看某一个人的提交记录"：
  // 统一换算成 user=<我的 UID>，这样第二个框会填上这个 UID，提示文字也能显示在筛谁。
  if (!user && mine && Store.user && Store.user.uid) { user = String(Store.user.uid); mine = ''; }
  if (!user && !mine && !fromProblemPage && Store.user && Store.user.uid) user = String(Store.user.uid);

  const params = new URLSearchParams({ page: String(page), size: '20' });
  if (problem) params.set('problem', problem);
  if (user) params.set('user', user);
  if (verdict) params.set('verdict', verdict);
  if (mine) params.set('mine', mine);
  // 接口参数：全部 → contest=all（含比赛提交）；题库 → 不带 contest（缺省语义 = 仅题库提交）；
  // 比赛 → contest=only（仅比赛提交）或具体比赛 id（保留比赛页既有入口）
  if (source === 'all') params.set('contest', 'all');
  else if (source === 'contest') params.set('contest', contestId || 'only');

  const data = await api.get('/api/submissions?' + params.toString());
  setPageTitle('提交记录');

  // M10：未登录浏览提交记录时服务端返回 200 + 空列表 + login_required（匿名不允许枚举全站提交），
  // 这里给出明确的登录引导，而不是显示一个空表格让用户以为「没有记录」。
  if (data.login_required || (!Store.user && data.error)) {
    app.innerHTML = `
      <div class="page-header"><h1 class="page-title">提交记录</h1></div>
      <div class="card empty" style="padding:30px 20px;text-align:center">
        <p style="margin:0 0 6px;font-weight:600">请先登录查看提交记录</p>
        <p class="muted" style="margin:0 0 14px">${escapeHtml(data.error || '提交记录仅登录后可见')}</p>
        <a class="btn" href="#/login"><i class="fa-solid fa-right-to-bracket"></i>登录</a>
        <a class="btn btn-ghost" href="#/register" style="margin-left:8px"><i class="fa-solid fa-user-plus"></i>注册新账号</a>
      </div>`;
    return;
  }

  // 指定了具体比赛时，页头补充该场比赛信息（contest=all / only 时没有单一比赛）
  let contestInfo = null;
  if (contestId) {
    try { contestInfo = (await api.get('/api/contests/' + contestId)).contest; } catch { /* ignore */ }
  }

  // 状态筛选：与列表显示保持一致，只保留「全部 / Accepted / Unaccepted」三种（Unaccepted 覆盖其它所有已评测结果，
  // 含 Compile Error —— 状态列对 CE 直接显示英文原词，但它仍归属 Unaccepted 这一档筛选）。
  // 这三档是 v2.6.3 起的既定设计，本轮不新增 Compile Error 选项（只做判定文案统一，不改筛选口径）。
  const verdictOptions = ['<option value="">全部状态</option>',
    `<option value="Accepted" ${verdict === 'Accepted' ? 'selected' : ''}>Accepted</option>`,
    `<option value="Unaccepted" ${verdict === 'Unaccepted' ? 'selected' : ''}>Unaccepted</option>`].join('');

  // 来源筛选：全部（默认，含比赛提交）/ 题库（旧口径，仅 contest_id IS NULL）/ 比赛（仅比赛提交）
  const sourceOptions = [['all', '全部'], ['bank', '题库'], ['contest', '比赛']]
    .map(([val, label]) => `<option value="${val}" ${source === val ? 'selected' : ''}>${label}</option>`).join('');

  // 筛选栏：**只在没有指定具体比赛时渲染**。指定了某一场具体比赛（specificContest）时，这场比赛就是唯一的
  // 范围，用户名 / 状态 / 来源 / 题目 四个控件连同「筛选」按钮全部不再产出 HTML —— 元素根本不存在
  //（不是 visibility/display 隐藏），整条 .filter-bar 也不渲染，因此列表上方不会留下空位或错位。
  // contest=all / 0 / only（全部 / 题库 / 跨比赛）不设置 specificContest，筛选栏与之前完全一致。
  const filterBarHtml = specificContest ? '' : `
    <div class="filter-bar filter-oneline">
      <input class="input" id="problem-input" placeholder="题目 ID" value="${escapeHtml(problem)}" style="flex:0 0 120px" />
      <input class="input" id="user-input" placeholder="用户名 / 用户 ID" value="${escapeHtml(user)}" style="flex:0 0 160px" />
      <select class="input" id="verdict-select" style="width:auto">${verdictOptions}</select>
      <select class="input" id="source-select" title="来源筛选" style="width:auto">${sourceOptions}</select>
      <button class="btn" id="search-btn"><i class="fa-solid fa-filter"></i>筛选</button>
    </div>`;

  const rows = (data.error || data.items.length === 0)
    ? '<tr><td colspan="8" class="empty">' + (data.error ? escapeHtml(data.error) : '暂无提交记录') + '</td></tr>'
    : data.items.map((s) => {
      const v = listStatusInfo(s.verdict);
      // 比赛提交在题目列内加一个淡色「比赛 #N」小标签（不新增列）：题名仍走省略号 + title 全文，
      // 标签 flex:0 0 auto 不会被长题名挤掉或被省略号裁掉。
      const contestTag = s.contest_id
        ? `<a class="tag sub-contest-tag" href="#/contest/${s.contest_id}" title="${escapeHtml('来自比赛：' + (s.contest_title || ('#' + s.contest_id)))}" target="_blank" rel="noopener">比赛 #${s.contest_id}</a>`
        : '';
      // 分数列：ACM 赛制（**该行**的比赛赛制）只显示「正确 / 错误」，不显示数字分数；
      // 其余（IOI / OI / 题库提交）照旧显示分数。
      const scoreCell = s.contest_type === 'ACM' ? acmListScoreCell(s) : `<td class="num">${s.score}</td>`;
      // 通信题提交在「语言」列后再加一个小标签，列表里一眼能看出这是「两个程序」的提交
      const commTag = String(s.problem_type || '') === 'communication'
        ? ' <span class="tag" style="color:#08979c;border-color:#08979c" title="通信题：本次提交包含程序一与程序二两份源码">两程序</span>'
        : '';
      // 用时列（v2.9.0，站长：提交记录列表要和提交记录页面信息对应）：值 = **各测试点用时之和（总用时）**，
      // 与提交详情「提交信息」的用时行 / 顶部横幅是同一个数 —— 列表接口 serializeBrief 带
      // testcase_time_sum_ms（同一份明细的合计），详情接口带 judge_detail，两处统一交给 submissionTotalTimeMs 取数；
      // 列头文字仍是「用时」（站长：文字都是用时）。
      return `<tr data-id="${s.id}">
        <td class="${v.cls}" title="${escapeHtml(v.title)}">${escapeHtml(v.label)}</td>
        <td><div class="sub-prob-cell"><span class="muted mono">#${s.problem_id}</span> <a class="sub-prob-link" href="#/problem/${s.problem_id}${s.contest_id ? '?contest=' + s.contest_id : ''}" title="${escapeHtml(s.problem_title)}" target="_blank" rel="noopener">${escapeHtml(s.problem_title)}</a>${contestTag}</div></td>
        <td>${userSpan({ uid: s.user_id, username: s.username, nickname: s.username })}</td>
        <td>${escapeHtml(langName(s.language))}${commTag}</td>
        ${scoreCell}
        <td class="num">${fmtDuration(submissionTotalTimeMs(s))}</td>
        <td class="num">${fmtMem(s.memory_kb, s.memory_sampled)}</td>
        <td class="num muted">${fmtTime(s.created_at)}</td>
      </tr>`;
    }).join('');

  app.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${contestInfo ? '比赛提交记录' : '提交记录'}</h1>
      ${contestInfo ? `<span class="tag" style="color:var(--blue);font-weight:600"><i class="fa-solid fa-trophy"></i> <a href="#/contest/${contestInfo.id}" target="_blank" rel="noopener">${escapeHtml(contestInfo.title)}</a></span>` : ''}
      ${contestInfo ? `<a class="muted" href="#/contest/${contestInfo.id}">← 返回比赛</a>` : ''}
    </div>
    ${contestInfo ? '<div class="status-banner blue"><span style="font-weight:700"><i class="fa-solid fa-flag-checkered"></i> 赛时提交</span><span class="muted">以下为比赛期间产生的提交记录（OI 赛制比赛中仅显示编译情况）</span></div>' : ''}
    ${filterBarHtml}
    <p class="muted" style="font-size:12px;margin-top:-6px">
      ${specificContest
        // 指定具体比赛时不渲染任何筛选控件：提示文字也不再提「题目 ID」「第二个框」等与本视图无关的内容
        ? `本场比赛${problem ? `题目 #${escapeHtml(problem)} ` : ''}的提交记录（按提交时间倒序）；本视图不提供筛选控件，如需按题目 / 用户 / 状态筛选，请到 <a href="#/submissions">提交记录</a> 页。`
        : (problem
        ? (user
          ? `正在查看题目 #${escapeHtml(problem)} 中${(Store.user && Store.user.uid && String(Store.user.uid) === String(user)) ? '我的' : '用户 ' + escapeHtml(user) + ' 的'}提交记录；第二个框里就是筛选对象（清空后筛选可看该题全部人的记录）。`
          : `正在查看题目 #${escapeHtml(problem)} 的全部提交记录（所有人）；也可输入「用户名 / 用户 ID」筛选个人记录，或 <a href="#/submissions?problem=${escapeHtml(problem)}&mine=1">只看我的提交</a>。`)
        : (user
          ? `正在查看${(Store.user && Store.user.uid && String(Store.user.uid) === String(user)) ? '我的' : '用户 ' + escapeHtml(user) + ' 的'}提交记录；第二个框里就是筛选对象（可改成其它用户名 / UID）。`
          : '可输入「用户名 / 用户 ID」或「题目 ID」查询提交记录；「来源」可切换 全部 / 题库 / 比赛。'))}
      ${source === 'all' ? '' : (source === 'bank' ? '当前来源：题库（不含比赛提交）。' : (contestId ? '当前来源：比赛（仅该场比赛的提交记录）。' : '当前来源：比赛（所有比赛的提交记录）。'))}
    </p>
    <div class="card table-scroll" style="padding:0">
      <table class="table">
        <thead><tr><th>状态</th><th>题目</th><th>提交者</th><th>语言</th><th class="num">分数</th><th class="num">用时</th><th class="num">内存</th><th class="num">提交时间</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderPagination(data.total, data.page, data.size)}`;

  // 分页 / 筛选：保留题目、用户、状态等全部条件，只改来源与页码；切换来源时页码重置为 1
  bindPagination((p) => nav('submissions', { problem, user, mine, verdict, contest: contestUrl, page: p }));
  document.querySelectorAll('tbody tr[data-id]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') return;
    window.open('#/submission/' + tr.dataset.id, '_blank', 'noopener');
  }));
  // 筛选栏绑定：**仅在没有指定具体比赛时存在**（specificContest 视图里 filterBarHtml === ''，
  // 上面这些 id 的元素一个都没有）。若不加这个判断，getElementById 会拿到 null 并在 addEventListener 处抛错。
  if (!specificContest) {
    const sourceValue = () => {
      const v = document.getElementById('source-select').value;
      if (v === 'all') return 'all';
      if (v === 'bank') return '0';
      return contestId || 'only'; // 比赛：保留具体比赛 id，否则用 only（仅比赛提交）
    };
    const problemInput = document.getElementById('problem-input');
    const doFilter = () => nav('submissions', {
      problem: problemInput ? problemInput.value.trim() : problem,
      user: document.getElementById('user-input').value.trim(),
      mine: fromProblemPage ? mine : '',
      verdict: document.getElementById('verdict-select').value,
      contest: sourceValue(),
      page: 1,
    });
    document.getElementById('search-btn').addEventListener('click', doFilter);
    // 来源切换立即生效，并重置到第 1 页（其它筛选条件与筛选框内容原样保留）
    document.getElementById('source-select').addEventListener('change', doFilter);
    // 回车即筛选：给实际渲染出来的两个输入框绑定（题目 / 用户名）
    [problemInput, document.getElementById('user-input')]
      .forEach((el) => el && el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doFilter(); }));
  }
}

/* ---------- 提交详情 ---------- */
// 仅在「刚刚提交」后进入提交页时才播放通过动画（重新浏览历史提交不播放）
let pendingCelebrateId = null;

async function renderSubmissionDetail(id) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const data = await api.get('/api/submissions/' + id);
  const s = data.submission;
  setPageTitle('提交 #' + s.id);
  const v = verdictInfo(s.verdict);

  // OI 赛制：仅显示编译情况
  if (s.oi_masked) {
    app.innerHTML = `
      <div class="crumb">${s.contest_id
        ? `<a href="#/contest/${s.contest_id}"><i class="fa-solid fa-arrow-left"></i> 返回比赛</a>`
        : `<a href="${backHref('#/submissions')}"><i class="fa-solid fa-arrow-left"></i> ${backLabel('返回提交记录')}</a>`}</div>
      <h1 class="page-title" style="margin-top:8px">提交 #${s.id} <span class="muted" style="font-size:14px">· <a href="#/problem/${s.problem_id}${s.contest_id ? '?contest=' + s.contest_id : ''}">${escapeHtml(s.problem_title)}</a></span></h1>
      <div class="contest-grid">
        <div class="cg-main">
          <div class="status-banner ${s.verdict === 'Compile Error' ? 'ce' : 'ac'}">
            <span class="verdict-big ${v.cls}">${escapeHtml(v.label)}</span>
            <span class="muted">${escapeHtml(s.oi_note || '')}</span>
          </div>
          ${s.compile_error ? `<div class="card"><h3 style="margin-top:0">编译错误信息</h3><pre class="code-view err">${escapeHtml(s.compile_error)}</pre></div>` : ''}
          <div class="card">
            <h2 class="card-title">源代码</h2>
            <div class="code-view">${escapeHtml(s.code || '')}</div>
          </div>
        </div>
        <div class="cg-side">${buildSubmissionSide(s, v)}</div>
      </div>`;
    // OI 遮蔽视图同样有源代码 / 编译错误两块代码：补「复制」按钮（v2.8.5 ④）
    bindCodeViewCopy(app);
    return;
  }

  if (s.status !== 'Done') {
    // 评测中：先渲染一次，之后只局部更新（状态横幅 / 错误信息 / 测试点），不再整页重绘，避免闪动
    app.innerHTML = buildSubmissionDetailHtml(s, v, true);
    bindSubmissionDetail(s, v);
    pollSubmissionProgress(id);
    return;
  }

  app.innerHTML = buildSubmissionDetailHtml(s, v, false);
  bindSubmissionDetail(s, v);
  // 通过题目：播放恭喜动画
  // 通过题目：仅当这是本次刚提交的记录时播放恭喜动画
  if (s.verdict === 'Accepted' && pendingCelebrateId != null && String(pendingCelebrateId) === String(s.id)) {
    pendingCelebrateId = null;
    celebrate();
  }
}

/** 评测中局部刷新：只替换变化的区块，页面不闪 */
function pollSubmissionProgress(id) {
  const tick = async () => {
    if (parseHash().path !== '/submission/' + id) return; // 已离开页面，停止轮询
    let data = null;
    try { data = await api.get('/api/submissions/' + id); } catch { setTimeout(tick, 2000); return; }
    const s2 = data.submission;
    if (!s2) return;
    if (s2.status === 'Done') { renderSubmissionDetail(id); return; } // 判完再整页渲染一次

    const v2 = verdictInfo(s2.verdict);
    const banner = document.getElementById('sub-banner');
    if (banner) banner.outerHTML = buildSubmitBannerHtml(s2, v2, true);

    const errBox = document.getElementById('sub-err');
    if (errBox) {
      const errHtml = s2.compile_error
        ? `<div class="card"><h3 style="margin-top:0">编译/运行错误信息</h3><pre class="code-view err">${escapeHtml(s2.compile_error)}</pre></div>`
        : '';
      if (errBox.innerHTML !== errHtml) errBox.innerHTML = errHtml;
      // 局部重绘出来的编译错误 <pre> 与源代码 .code-view 也要重新挂「复制」按钮（v2.8.5 ④）
      bindCodeCopy(errBox);
      bindCodeViewCopy(errBox);
    }

    const box = document.getElementById('sub-details');
    const wrap = document.getElementById('sub-details-wrap');
    if (wrap) {
      const html = buildSubmitDetailCardHtml(s2);
      const curKey = box ? box.dataset.key : '';
      const newKey = (() => {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        const el = tmp.querySelector('#sub-details');
        return el ? el.dataset.key : '';
      })();
      if (newKey !== curKey) wrap.innerHTML = html;
    }
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 1500);
}

/** 一组测试点里**最慢的那一个**的用时（毫秒；都没有采到用时则为 0）。 */
function slowestDuration(list) {
  let max = 0;
  for (const it of (list || [])) {
    const v = Number(it && it.time_ms);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

/** 「用时」的标签：列表列头 / 详情侧栏 / 详情横幅 / 卡片标题**一律就写「用时」**。
 *  v2.7.7：用户要求「用时」不要再做解释 —— 原先按 time_ms_kind 区分「总用时 / 用时」并附带口径说明，
 *  现在标签统一为「用时」（OI 遮蔽时数值本身就显示 '—'，标签不再改叫「总用时」），
 *  原先那个生成口径说明文字的辅助函数已**整体删除**（提交记录列表单元格 title、提交详情注解行都不再出现解释文字）。
 *  数值仍是后端口径（src/submissions.js displayTimeOf：一律 = 最慢测试点用时），格式仍是 fmtDuration。 */
function timeLabelOf(s) {
  return '用时';
}

/** 提交的「总用时」= **各测试点用时之和**（站长：提交信息里的用时，数值就是总用时；但标签文字一律写「用时」）。
 *  真实字段（本机实测）：`GET /api/submissions/:id` → `submission.judge_detail[]`，每项都带 `time_ms`
 *  （服务端 src/submissions.js 把库里 gzip 存着的明细解出来原样下发；OI 遮蔽时该数组为空）。
 *  评测写进库里的 `s.time_ms` 是"最慢测试点"的用时，不是总用时，所以这里优先按明细求和；
 *  拿不到明细（未评测 / OI 遮蔽 / 历史导入数据）时依次回退 `testcase_time_sum_ms`（后端算好的同一份合计）→ `s.time_ms`。
 *  注意：本函数第二个参数是 `verdictInfo()` 的结果（{label, cls, title}），**不是**接口对象，
 *  所以明细一律从 `s`（接口返回的 submission）上取；`v` 只作兜底，兼容可能传入接口对象的调用方。 */
function submissionTotalTimeMs(s, v) {
  try {
    for (const o of [s, v]) {
      if (!o) continue;
      const cands = [o.judge_detail, o.testcases, o.items, o.details, o.cases, o.list, o.results];
      for (const arr of cands) {
        if (Array.isArray(arr) && arr.length) {
          let sum = 0;
          for (const d of arr) sum += Number(d && d.time_ms) || 0;
          if (sum > 0) return sum;
        }
      }
      // 子任务结构：{ subtasks: [{ testcases: [...] }] }
      const subs = o.subtasks || o.subtask_groups;
      if (Array.isArray(subs) && subs.length) {
        let sum = 0;
        for (const g of subs) for (const d of ((g && (g.testcases || g.items || g.cases)) || [])) sum += Number(d && d.time_ms) || 0;
        if (sum > 0) return sum;
      }
      // 后端已算好的同一份合计（src/submissions.js serializeBrief 的 testcase_time_sum_ms）
      const ts = Number(o.testcase_time_sum_ms);
      if (Number.isFinite(ts) && ts > 0) return ts;
    }
  } catch { /* 忽略，走回退 */ }
  return Number(s && s.time_ms) || 0;
}

function buildSubmissionSide(s, v) {
  // 侧边栏「状态」同样只显示 Accepted（绿）/ Unaccepted（红）；真实判定（Wrong Answer / TLE …）放在悬停提示里。
  // OI 赛制提交只公示编译情况（Compiled），此时保持原样显示。
  const waiting = s.verdict === 'Judging' || s.verdict === 'Pending';
  const sv = s.oi_masked ? { label: v.label, cls: v.cls, title: v.label } : listStatusInfo(s.verdict);
  // 用时（v2.7.7：标签一律「用时」，不做任何口径解释，也没有 title 提示）。
  // v2.9.0（站长）：**数值 = 总用时（各测试点用时之和）**，与提交记录列表的「用时」列、顶部横幅三处完全对应；
  // 列表接口 serializeBrief 带 testcase_time_sum_ms，详情接口带 judge_detail，都由 submissionTotalTimeMs 统一取数。
  // 标签仍写「用时」（站长：文字都是用时）
  const timeRow = `<div class="info-row"><span class="il">用时</span><span class="iv">${fmtDuration(submissionTotalTimeMs(s, v))}</span></div>`;
  return `
    <div class="card">
      <h2 class="card-title"><i class="fa-solid fa-circle-info"></i> 提交信息</h2>
      <div class="info-row"><span class="il">题目</span><span class="iv"><a href="#/problem/${s.problem_id}${s.contest_id ? '?contest=' + s.contest_id : ''}" target="_blank" rel="noopener">${escapeHtml(s.problem_title)}</a></span></div>
      ${s.contest_id && s.contest_title
        ? `<div class="info-row"><span class="il">所属比赛</span><span class="iv"><span class="badge" style="background:${CONTEST_TYPE_COLOR[s.contest_type] || '#722ed1'};color:#fff;font-size:11px">${escapeHtml(s.contest_type || '')}</span> <a href="#/contest/${s.contest_id}" target="_blank" rel="noopener">${escapeHtml(s.contest_title)}</a></span></div>`
        : ''}
      <div class="info-row"><span class="il">状态</span><span class="iv"><span class="${sv.cls}" title="${escapeHtml(sv.title)}">${waiting ? '<span class="spin-inline"></span>' : ''}${escapeHtml(sv.label)}</span></span></div>
      ${s.hide_score
        ? `<div class="info-row"><span class="il">结果</span><span class="iv">${s.verdict === 'Accepted' ? '正确' : '错误'}</span></div>`
        : `<div class="info-row"><span class="il">分数</span><span class="iv"><strong>${s.score}</strong></span></div>`}
      <div class="info-row"><span class="il">语言</span><span class="iv">${escapeHtml(langName(s.language))}</span></div>
      ${timeRow}
      <div class="info-row"><span class="il">内存</span><span class="iv">${fmtMem(s.memory_kb, s.memory_sampled)}</span></div>
      <div class="info-row"><span class="il">提交者</span><span class="iv">${userSpan({ uid: s.user_id, username: s.username, nickname: s.username })}</span></div>
      <div class="info-row" style="border-bottom:none"><span class="il">提交时间</span><span class="iv">${fmtTime(s.created_at)}</span></div>
    </div>`;
}

/* ---------- 提交详情：状态横幅 / 测试点详情（洛谷风格，可局部刷新）---------- */
const TC_CHIP_CLASS = {
  'Accepted': 'v-ac',
  'Wrong Answer': 'v-wa',
  'Time Limit Exceeded': 'v-tle',
  'Memory Limit Exceeded': 'v-mle',
  'Runtime Error': 'v-re',
  'Compile Error': 'v-ce',
  'System Error': 'v-se',
  'Compiled': 'v-ac',
  'Pending': 'v-wait',
  'Judging': 'v-wait',
};

function buildSubmitBannerHtml(s, v, judging) {
  const waiting = s.verdict === 'Judging' || s.verdict === 'Pending';
  // 状态栏与提交记录列表保持一致：只显示 Accepted（绿）/ Unaccepted（红），真实判定放在悬停提示里。
  // 例外（v2.7.6）：Compile Error 是「根本没跑测试点」的独立状态，直接显示英文原词，不再并入 Unaccepted
  //（列表 / 详情顶部 / 详情侧栏三处口径因此完全一致）。
  const isCE = s.verdict === 'Compile Error';
  const cls = waiting ? (v.cls || '') : (s.verdict === 'Accepted' ? 'verdict-AC' : (isCE ? 'verdict-CE' : 'verdict-WA'));
  const bannerCls = waiting ? '' : (s.verdict === 'Accepted' ? 'ac' : (isCE ? 'ce' : 'wa'));
  const label = waiting ? v.label : (s.verdict === 'Accepted' ? 'Accepted' : (isCE ? 'Compile Error' : 'Unaccepted'));
  // 用时（v2.7.7：只写「用时：数值」，不含任何口径解释与 title 提示）
  // v2.9.0：横幅里的用时同样是**总用时**（与「提交信息」卡片一致）
  const totalSpan = `<span class="muted">用时：<strong>${fmtDuration(submissionTotalTimeMs(s, v))}</strong></span>`;
  return `<div class="status-banner ${bannerCls}" id="sub-banner">
      <span class="verdict-big ${cls}" title="${escapeHtml(v.label)}">${waiting ? '<span class="spin-inline"></span>' : ''}${escapeHtml(label)}</span>
      ${s.hide_score
        ? '<span class="muted">结果：<strong>' + (s.verdict === 'Accepted' ? '正确' : '错误') + '</strong></span>'
        : `<span class="muted">分数：<strong>${s.score}</strong></span>`}
      ${totalSpan}
    </div>`;
}

/** 测试点信息块（洛谷风格）：颜色表示结果，块内显示 状态 / 用时 / 内存，悬停看备注。
 *  块内状态用 2~3 字母短码（AC / WA / TLE / MLE / RE / **CE** / SE）—— 方块宽度有限，这是**测试点方块专属**的
 *  短码，不是提交的判定文案：提交记录列表、详情顶部横幅、详情侧栏、交互器消息里的判定一律写英文原词
 *  （Accepted / Wrong Answer / Time Limit Exceeded / Memory Limit Exceeded / Compile Error …）。
 *  每个方块的 title 第一行就带完整判定词（如「测试点 #2（Compile Error）」），悬停即可看到全称。 */
const TC_SHORT = {
  'Accepted': 'AC',
  'Wrong Answer': 'WA',
  'Time Limit Exceeded': 'TLE',
  'Memory Limit Exceeded': 'MLE',
  'Runtime Error': 'RE',
  'Compile Error': 'CE',
  'System Error': 'SE',
  'Compiled': 'AC',
  'Pending': 'PD',
  'Judging': 'JDG',
};

function testcaseChip(d) {
  // 测试点方块保留真实判定与配色（AC / WA / TLE / MLE / RE / CE / SE）。提交记录与详情侧边栏合并为
  // Accepted / Unaccepted，**例外是 Compile Error**：它不并入 Unaccepted，列表/详情/侧栏都直接写英文原词。
  const waiting = d.verdict === 'Pending' || d.verdict === 'Judging';
  const cls = TC_CHIP_CLASS[d.verdict] || 'v-wait';
  const dv = verdictInfo(d.verdict);
  const short = TC_SHORT[d.verdict] || dv.label;
  // 内存：未采样（memory_sampled === false）显示 '—'，不能显示成 0 KB；已采样（含 0~几百 KB）照常显示数值。
  // 老接口没有 memory_sampled 字段时用 memory_kb 兜底（>0 视为已采样）。
  const memSampled = d.memory_sampled != null ? d.memory_sampled : (Number(d.memory_kb) > 0);
  const memText = fmtMem(d.memory_kb, memSampled);
  const timeText = d.time_ms != null ? fmtDuration(d.time_ms) : '—';
  // 悬停提示第一行就写全称，保证缩写成 CE 的方块也能直接看到「Compile Error」
  const lines = [`测试点 #${d.id}（${dv.label}）`, `结果：${dv.label}`];
  if (d.subtask != null) lines.push(`子任务：${d.subtask}`);
  if (d.time_ms != null) lines.push(`用时：${fmtDuration(d.time_ms)}`);
  if (memSampled === false) lines.push('内存：未采样（本次评测未采集到内存数据）');
  else lines.push(`内存：${memText}`);
  if (d.verdict === 'Wrong Answer' && d.expected != null) {
    lines.push(`期望：${String(d.expected).slice(0, 120)}`);
    lines.push(`实际：${String(d.actual == null ? '' : d.actual).slice(0, 120)}`);
  }
  // 交互题：交互器 / grader 的输出是排查问题的关键，悬停时无论 AC 与否都展示
  if (d.interactor_exit != null) lines.push(`交互器退出码：${d.interactor_exit}`);
  if (d.grader_exit != null) lines.push(`grader 退出码：${d.grader_exit}`);
  if (d.solution_exit != null) lines.push(`程序退出码：${d.solution_exit}`);
  if (d.message) {
    const isItr = d.interactor_exit != null || d.grader_exit != null;
    if (d.verdict !== 'Accepted' || isItr) lines.push(`${isItr ? '交互器消息' : '备注'}：${String(d.message).slice(0, 300)}`);
  }
  return `<span class="tc-chip ${cls}${waiting ? ' waiting' : ''}" title="${escapeHtml(lines.join('\n'))}">
      <span class="tc-chip-id">#${d.id}</span>
      <span class="tc-chip-state${waiting ? ' wait' : ''}">${waiting ? '<span class="tc-spin"></span>' : escapeHtml(short)}</span>
      <span class="tc-chip-meta">${waiting ? '' : `${timeText} · ${memText}`}</span>
    </span>`;
}

/** 通过题目（AC）时的庆祝动画：彩带 + 恭喜提示 */
function celebrate() {
  try {
    if (document.querySelector('.celebrate-layer')) return;
    const colors = ['#52c41a', '#1890ff', '#faad14', '#f5222d', '#722ed1', '#13c2c2', '#eb2f96', '#fa8c16'];
    const layer = document.createElement('div');
    layer.className = 'celebrate-layer';
    for (let i = 0; i < 90; i++) {
      const p = document.createElement('i');
      p.className = 'celebrate-piece';
      p.style.left = (Math.random() * 100).toFixed(2) + 'vw';
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = (Math.random() * 0.7).toFixed(2) + 's';
      p.style.animationDuration = (1.7 + Math.random() * 1.5).toFixed(2) + 's';
      if (i % 3 === 0) p.classList.add('round');
      layer.appendChild(p);
    }
    const text = document.createElement('div');
    text.className = 'celebrate-text';
    text.innerHTML = '<i class="fa-solid fa-circle-check"></i> Accepted · 恭喜通过！';
    layer.appendChild(text);
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 4200);
  } catch (e) { /* ignore */ }
}

function buildSubmitDetailCardHtml(s) {
  let list = s.judge_detail || [];
  // 评测中：按测试点元信息补齐占位（含所属子任务），未判完显示转圈，判完一个点亮一个
  if (s.status && s.status !== 'Done') {
    const judged = new Map(list.map((d) => [d.id, d]));
    if (Array.isArray(s.testcase_meta) && s.testcase_meta.length) {
      const merged = s.testcase_meta.map((m) => judged.get(m.id) || {
        id: m.id, verdict: 'Judging', subtask: m.subtask == null ? 0 : m.subtask, subtask_score: m.subtask_score || 0,
      });
      list.forEach((d) => { if (!merged.some((x) => x.id === d.id)) merged.push(d); });
      list = merged;
    } else if (s.testcase_count > 0) {
      const merged = [];
      for (let i = 1; i <= s.testcase_count; i++) merged.push(judged.get(i) || { id: i, verdict: 'Judging', subtask: 0, subtask_score: 0 });
      list.forEach((d) => { if (!merged.some((x) => x.id === d.id)) merged.push(d); });
      list = merged;
    }
  }
  if (!list.length) return '';
  const groupMap = new Map();
  list.forEach((d) => {
    const k = d.subtask == null ? 0 : d.subtask;
    if (!groupMap.has(k)) groupMap.set(k, []);
    groupMap.get(k).push(d);
  });
  const groupKeys = Array.from(groupMap.keys()).sort((a, b) => a - b);
  const multiSub = groupKeys.length > 1;
  const key = list.map((d) => `${d.id}:${d.verdict}:${d.time_ms || 0}`).join(',') + '|' + groupKeys.length;

  // v2.9.0（站长澄清）：没设子任务时，卡片标题里的「用时」数值就是**各测试点用时之和**（不是最慢测试点、
  // 也不是评测返回的单个 time_ms），但标签文字仍写「用时」（站长：文字都是用时，不写「总用时」）。
  // 设了子任务时保持原有渲染（子任务行仍显示该子任务内最慢测试点用时）。
  const noSubtask = groupKeys.length <= 1 && (groupKeys[0] || 0) === 0;
  const totalTimeMs = list.reduce((a, d) => a + (Number(d.time_ms) || 0), 0);

  const body = multiSub
    ? groupKeys.map((k) => {
        const group = groupMap.get(k);
        const full = group[0].subtask_score != null ? group[0].subtask_score : 0;
        const earned = group[0].subtask_earned != null ? group[0].subtask_earned : null;
        const acCount = group.filter((d) => d.verdict === 'Accepted' || (d.fraction != null && d.fraction >= 1)).length;
        // 子任务行展示的用时 = 该子任务内**最慢测试点**的用时（v2.7.6 起不再用「各测试点求和」）。
        // v2.7.7：不再输出「（最长，即本次提交用时）」这类解释，子任务行只保留「用时 数值」。
        const used = fmtDuration(slowestDuration(group));
        return `<div class="subtask-block">
          <div class="subtask-title"><i class="fa-solid fa-layer-group"></i> 子任务 ${k}
            <span class="subtask-meta">满分 ${full}${earned != null ? ` · 得分 ${earned}` : ''} · 通过 ${acCount}/${group.length} · 用时 ${used}</span>
          </div>
          <div class="tc-chips">${group.map(testcaseChip).join('')}</div>
        </div>`;
      }).join('')
    // v2.8.5（③）：**没有子任务时也要显示总用时**。通信题 / 交互题未配置子任务时，原来这里只有一排测试点方块，
    // 页面上除了卡片标题里的「· 用时 …」看不到明确的「总用时」行 —— 现在补一行与子任务标题同骨架的「总用时」，
    // 数值沿用后端整份提交的 time_ms（= 提交记录列表时间列 / 侧栏 / 横幅用的同一个数，不另算口径），
    // 并标注测试点个数；有子任务时的既有渲染完全不变。
    : `<div class="subtask-block">
        <div class="subtask-title"><i class="fa-solid fa-stopwatch"></i> 用时
          <span class="subtask-meta">${fmtDuration(totalTimeMs)} · 共 ${list.length} 个测试点</span>
        </div>
        <div class="tc-chips">${list.map(testcaseChip).join('')}</div>
      </div>`;
  // 卡片标题里的用时：没设子任务时数值就是各测试点之和（v2.8.5 起如此），有子任务时沿用原数值口径。
  // v2.7.7：标签固定「用时」，不带任何口径说明的 title。
  // v2.9.0（站长澄清）：**文字一律写「用时」**（不写「总用时」），只是数值上「用时 = 总用时」。
  const timeHead = ` <span class="muted" style="font-size:12px">· ${timeLabelOf(s)} ${fmtDuration(noSubtask ? totalTimeMs : s.time_ms)}</span>`;

  // 交互题 / 通信题：把每个测试点的交互器 / grader / 两个程序的判定消息直接列出来
  //（悬停提示里放不下，这是排查「本地能过、评测 WA」的主要线索；通信题的「程序一编译失败」也走这里与 compile_error）
  const interactiveDetail = String(s.problem_type || '') === 'interactive_io'
    || String(s.problem_type || '') === 'interactive_func'
    || String(s.problem_type || '') === 'communication'
    || list.some((d) => d && (d.interactor_exit != null || d.grader_exit != null));
  const msgList = interactiveDetail ? list.filter((d) => d && d.message) : [];
  const msgTitle = String(s.problem_type || '') === 'communication' ? '通信题判定消息' : '交互器消息';
  const msgBlock = msgList.length ? `
    <div class="subtask-block" style="margin-top:14px">
      <div class="subtask-title"><i class="fa-solid fa-comments"></i> ${msgTitle}
        <span class="subtask-meta">${String(s.problem_type || '') === 'communication'
          ? '两个程序的运行 / 判定信息（每个测试点一条）'
          : '交互过程中评测程序输出的信息（每个测试点一条）'}</span>
      </div>
      ${msgList.map((d) => {
        // 交互器消息可能包含上百行问答：默认只显示最后一条结论，完整内容折叠在「展开」里
        const raw = String(d.message_full || d.message || '');   // 完整交互过程（后端保留全文，前端折叠展示）
        const briefSrc = String(d.message || raw);               // 判定消息（后端已精简成一行结论）
        const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        // 优先取「结论行」（ok, / wrong answer / FAIL / 答案错误 / 超时 …），否则退回最后一行
        const bLines = briefSrc.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        const concl = [...bLines].reverse().find((x) => /ok,|wrong answer|FAIL|答案|超时|error|退出码|超出/i.test(x));
        const last = concl || (bLines.length ? bLines[bLines.length - 1] : raw.trim());
        const brief = last.length > 160 ? last.slice(0, 160) + '…' : last;
        const more = lines.length > 1 || raw.length > brief.length + 20;
        // 判定文案用完整英文原词（Accepted / Wrong Answer / … / Compile Error），
        // 这里不是测试点小方块（有尺寸约束），不能再用 AC/TLE/CE 这类 2~3 字母缩写
        const dvLabel = verdictInfo(d.verdict).label;
        const dvColor = d.verdict === 'Accepted' ? 'var(--green)' : (d.verdict === 'Compile Error' ? '#fae607' : 'var(--red)');
        return `<div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:6px;font-size:12.5px;line-height:1.6">
        <span class="muted mono">#${escapeHtml(String(d.id))}</span>
        <span style="font-weight:700;color:${dvColor};margin:0 6px">${escapeHtml(dvLabel)}</span>
        <span class="mono" style="white-space:pre-wrap;word-break:break-word">${escapeHtml(brief)}</span>
        ${more ? `<details style="margin-top:4px"><summary class="muted" style="cursor:pointer;font-size:12px">展开完整交互过程（共 ${lines.length} 行 / ${raw.length} 字）</summary><div class="mono" style="white-space:pre-wrap;word-break:break-word;margin-top:4px;max-height:240px;overflow:auto">${escapeHtml(raw.slice(0, 8000))}</div></details>` : ''}
      </div>`;
      }).join('')}
    </div>` : '';

  return `<div class="card" id="sub-details" data-key="${escapeHtml(key)}">
      <h2 class="card-title">测试点详情${multiSub ? ` <span class="muted" style="font-size:12px">共 ${groupKeys.length} 个子任务</span>` : ''}${timeHead}</h2>
      <div class="muted" style="font-size:12px;margin:-4px 0 10px">悬停测试点方块可查看用时 / 内存 / 期望与实际输出</div>
      ${body}
      ${msgBlock}
    </div>`;
}

function buildSubmissionDetailHtml(s, v, judging) {

  const isCommSubmission = String(s.problem_type || '') === 'communication';
  // 提交答案题：展示答案文件下载（base64）
  let codeBlock;
  if (s.language === 'output') {
    const href = `data:application/octet-stream;base64,${escapeHtml(s.code || '')}`;
    codeBlock = `<div class="row" style="gap:10px">
      <a class="btn" href="${href}" download="answer_${s.id}.zip"><i class="fa-solid fa-download"></i>下载答案文件</a>
      <span class="muted" style="font-size:12px">提交答案题：评测将使用该答案文件（ZIP 多测试点或单个答案文件）</span>
    </div>`;
  } else if (isCommSubmission) {
    // 通信题：两个程序分别展示（同一份提交里 code = 程序一，code2 = 程序二）
    codeBlock = s.code_locked
      ? `<div class="empty">代码仅对提交者、管理员及已 AC 本题的用户可见</div>`
      : `<div class="comm-code-block">
          <div class="comm-code-head"><i class="fa-solid fa-1"></i> 程序一（读入题目输入，产生输出）</div>
          <div class="code-view comm-code">${escapeHtml(s.code || '')}</div>
        </div>
        <div class="comm-code-block">
          <div class="comm-code-head"><i class="fa-solid fa-2"></i> 程序二（以程序一的输出为输入，产生答案）</div>
          <div class="code-view comm-code">${escapeHtml(s.code2 || '')}</div>
        </div>`;
  } else {
    codeBlock = s.code_locked
      ? `<div class="empty">代码仅对提交者、管理员及已 AC 本题的用户可见</div>`
      : `<div class="code-view">${escapeHtml(s.code || '')}</div>`;
  }

  return `
    <div class="crumb">${s.contest_id
      ? `<a href="#/contest/${s.contest_id}"><i class="fa-solid fa-arrow-left"></i> 返回比赛</a>`
      : `<a href="${backHref('#/submissions')}"><i class="fa-solid fa-arrow-left"></i> ${backLabel('返回提交记录')}</a>`}</div>
    <h1 class="page-title" style="margin-top:8px">提交 #${s.id} <span class="muted" style="font-size:14px">· <a href="#/problem/${s.problem_id}${s.contest_id ? '?contest=' + s.contest_id : ''}" target="_blank" rel="noopener">${escapeHtml(s.problem_title)}</a></span>${isCommSubmission ? '<span class="tag" style="color:#08979c;font-weight:600">通信题（两程序）</span>' : ''}${s.contest_id ? `<span class="tag" style="color:var(--blue);font-weight:600"><i class="fa-solid fa-trophy"></i> <a href="#/contest/${s.contest_id}" target="_blank" rel="noopener">赛时提交</a></span>` : ''}</h1>
    ${s.contest_id ? '<div class="muted" style="margin:-8px 0 12px;font-size:12px">该提交来自比赛，<a href="#/submissions?contest=' + s.contest_id + '">查看该场比赛提交记录 →</a></div>' : ''}
    <div class="contest-grid">
      <div class="cg-main">
        ${buildSubmitBannerHtml(s, v, judging)}
        <div id="sub-err">${s.compile_error ? `<div class="card"><h3 style="margin-top:0">${isCommSubmission ? '编译 / 运行错误信息（已注明是哪一个程序）' : '编译/运行错误信息'}</h3><pre class="code-view err">${escapeHtml(s.compile_error)}</pre></div>` : ''}</div>
        <div class="card">
          <h2 class="card-title">${s.language === 'output' ? '答案文件' : (isCommSubmission ? '源代码（两个程序）' : '源代码')}</h2>
          ${codeBlock}
        </div>
        <div id="sub-details-wrap">${buildSubmitDetailCardHtml(s)}</div>
      </div>
      <div class="cg-side">
        ${buildSubmissionSide(s, v)}
      </div>
    </div>`;
}

function bindSubmissionDetail(s, v) {
  // v2.8.5 ④：提交详情里**每一段代码**都要有「复制」按钮 ——
  // 普通题 / 交互题的源代码、通信题的两份程序、编译错误与 SPJ 等 <pre> 统一在这里补一遍：
  //   · .code-view（div）：本页新增的 bindCodeViewCopy（通信题两份程序也一并覆盖）
  //   · <pre>（编译错误 / SPJ 输出等）：复用站点既有的 bindCodeCopy
  bindCodeViewCopy(app);
  bindCodeCopy(app);
  // 通信题：提交详情里两个程序各有一个「复制」按钮（程序一 = code，程序二 = code2）
  document.querySelectorAll('.comm-copy').forEach((btn) => btn.addEventListener('click', async () => {
    const isTwo = String(btn.dataset.copy) === '2';
    const text = isTwo ? (s.code2 || '') : (s.code || '');
    if (await copyText(text)) toast(`${isTwo ? '程序二' : '程序一'}代码已复制`, 'success');
    else toast('复制失败，请手动全选复制', 'error');
  }));
}

/* ---------- 排行榜 ---------- */
async function renderRanking(query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  // 积分系统关闭：隐藏积分排行榜，直接跳转等级分排行
  if (Store.features && Store.features.points_enabled === false) {
    nav('rating-rank');
    return;
  }
  const page = parseInt((query && query.get('page')) || '1', 10);
  const params = new URLSearchParams({ page: String(page), size: '30' });
  const data = await api.get('/api/points-ranking?' + params.toString());
  setPageTitle('积分排行榜');
  const rows = data.items.length === 0
    ? `<tr><td colspan="9" class="empty">暂无数据${page > 1 ? '（已到榜单末尾）' : ''}</td></tr>`
    : data.items.map((u) => `
      <tr data-user="${u.id}">
        <td class="num" style="font-weight:800;width:50px">${u.rank <= 3 ? ['<i class="fa-solid fa-medal" style="color:#f5b301"></i>','<i class="fa-solid fa-medal" style="color:#c0c0c0"></i>','<i class="fa-solid fa-medal" style="color:#cd7f32"></i>'][u.rank - 1] : u.rank}</td>
        <td style="text-align:center"><span style="display:inline-flex;align-items:center;justify-content:center;gap:10px;vertical-align:middle">${userAvatarHtml(u, 34)}<span>${userSpan({ ...u, points_num: u.points })}</span></span></td>
        <td class="num" style="color:${ioiScoreColor(u.points / 4)};font-weight:700">${u.points}</td>
        <td class="num" style="color:${ioiScoreColor(u.breakdown.base)};font-weight:700">${u.breakdown.base}</td>
        <td class="num" style="color:${ioiScoreColor(u.breakdown.practice)};font-weight:700">${u.breakdown.practice}</td>
        <td class="num" style="color:${ioiScoreColor(u.breakdown.contest)};font-weight:700">${u.breakdown.contest}</td>
        <td class="num" style="color:${ioiScoreColor(u.breakdown.community)};font-weight:700">${u.breakdown.community}</td>
        <td>${u.brown_name ? '<span class="badge" style="background:#8b5e3c;color:#fff">棕名</span>' : ''}${u.banned ? '<span class="badge" style="background:#ff4d4f;color:#fff">已封禁</span>' : ''}</td>
      </tr>`).join('');

  app.innerHTML = `
    <div class="row rank-switch" style="gap:8px;margin-top:20px">
      <a class="btn" href="#/ranking"><i class="fa-solid fa-ranking-star"></i>积分排行</a>
      <a class="btn btn-ghost" href="#/rating-rank"><i class="fa-solid fa-chart-line"></i>等级分排行</a>
    </div>
    <h1 class="page-title" style="margin:16px 0 0">积分排行榜</h1>
    <p class="muted mb">按积分排名；积分颜色：≥320 绿 · ≥240 黄 · ≥160 橙 · 其余红（满分 400）；用户名颜色随积分变化：&lt;100 灰 · 100+ 蓝 · 120+ 青 · 140+ 绿 · 160+ 黄 · 180+ 橙 · 200+ 红；管理员紫色，棕名棕色。各列为四维分项（基础 / 练习 / 比赛 / 社区），点击用户行在新标签页打开个人中心。</p>
    <div class="card table-scroll" style="padding:0">
      <table class="table">
        <thead><tr><th class="num">排名</th><th>用户</th><th class="num">积分</th><th class="num">基础</th><th class="num">练习</th><th class="num">比赛</th><th class="num">社区</th><th>状态</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderPagination(data.total, data.page, data.size)}`;
  document.querySelectorAll('tbody tr[data-user]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') return;
    window.open('#/user/' + tr.dataset.user, '_blank', 'noopener');
  }));
  bindPagination((p) => nav('ranking', { page: p }));
}

async function renderRatingRanking(query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const page = parseInt((query && query.get('page')) || '1', 10);
  const params = new URLSearchParams({ page: String(page), size: '30' });
  const data = await api.get('/api/rating-ranking?' + params.toString());
  setPageTitle('等级分排行榜');
  const rows = data.items.length === 0
    ? `<tr><td colspan="4" class="empty">暂无数据${page > 1 ? '（已到榜单末尾）' : ''}</td></tr>`
    : data.items.map((u) => `
      <tr data-user="${u.id}">
        <td class="num" style="font-weight:800;width:50px">${u.rank <= 3 ? ['<i class="fa-solid fa-medal" style="color:#f5b301"></i>','<i class="fa-solid fa-medal" style="color:#c0c0c0"></i>','<i class="fa-solid fa-medal" style="color:#cd7f32"></i>'][u.rank - 1] : u.rank}</td>
        <td style="text-align:center"><span style="display:inline-flex;align-items:center;justify-content:center;gap:10px;vertical-align:middle">${userAvatarHtml(u, 34)}<span>${userSpan(u)}</span></span></td>
        <td class="num" style="font-weight:700">${u.rating}</td>
        <td class="num muted">${u.rated_games} 场</td>
      </tr>`).join('');

  const pointsDisabled = Store.features && Store.features.points_enabled === false;
  app.innerHTML = `
    <div class="row rank-switch" style="gap:8px;margin-top:20px">
      ${pointsDisabled ? '' : '<a class="btn btn-ghost" href="#/ranking"><i class="fa-solid fa-ranking-star"></i>积分排行</a>'}
      <a class="btn" href="#/rating-rank"><i class="fa-solid fa-chart-line"></i>等级分排行</a>
    </div>
    <h1 class="page-title" style="margin:16px 0 0">等级分排行榜</h1>
    <p class="muted mb">按等级分排名。新用户初始等级分 0；前 6 场 Rated 比赛按 1400 虚拟分计算（加成 500/350/250/150/100/50）。点击用户行在新标签页打开个人中心。</p>
    <div class="card table-scroll" style="padding:0">
      <table class="table">
        <thead><tr><th class="num">排名</th><th>用户</th><th class="num">等级分</th><th class="num">已参加 Rated 场次</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderPagination(data.total, data.page, data.size)}`;
  document.querySelectorAll('tbody tr[data-user]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') return;
    window.open('#/user/' + tr.dataset.user, '_blank', 'noopener');
  }));
  bindPagination((p) => nav('rating-rank', { page: p }));
}

/* ---------- 用户主页 ---------- */
async function renderUserProfile(username, query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const [data, eds, rh] = await Promise.all([
    api.get('/api/users/' + encodeURIComponent(username)),
    api.get(`/api/users/${encodeURIComponent(username)}/editorials`).catch(() => null),
    api.get(`/api/users/${encodeURIComponent(username)}/rating-history`).catch(() => null),
  ]);
  const u = data.user;
  setPageTitle(u.username + ' 的个人主页');
  const tab = query && query.get('tab') ? query.get('tab') : 'home';

  const roleBadge = { user: '<span class="badge" style="background:#8c8c8c;color:#fff">普通用户</span>', admin: '<span class="badge" style="background:var(--blue);color:#fff">管理员</span>', superadmin: '<span class="badge" style="background:#722ed1;color:#fff">超级管理员</span>' };

  // 主页 Tab：左侧等级分曲线 + 右侧积分（竖版）+ 个人简介（Markdown）
  // 等级分曲线包含「全部参加过的 Rated 比赛」（后端不再截断），绘制在 drawRatingChart 中
  const rhItems = (rh && rh.items) || [];
  const rhTotal = (rh && rh.total) || rhItems.length;
  let chartHtml = '<div class="empty">暂无等级分变化记录（参加 Rated 比赛并结算后显示）</div>';
  if (rhItems.length) {
    chartHtml = `<div class="rating-chart-wrap">
      <div class="rating-chart-host" id="rating-chart"></div>
      <div class="muted rating-chart-tip">共 ${rhTotal} 场 Rated 比赛（全部展示，可左右滚动）· 绿点上升 / 红点下降 · 悬停查看详情，点击跳转对应比赛</div>
    </div>`;
  }

  // 积分（系统关闭时隐藏）
  const pts = u.points;
  let pointsPanel = '';
  if (pts) {
    const ptsBars = [
      ['基础', pts.breakdown.base, '#0a8dff'],
      ['练习', pts.breakdown.practice, '#52c41a'],
      ['比赛', pts.breakdown.contest, '#f39c11'],
      ['社区', pts.breakdown.community, '#8e44ad'],
    ];
    pointsPanel = `
      <div class="points-panel">
        <div style="text-align:center;padding:6px 0 2px"><strong style="font-size:30px;color:var(--orange)">${pts.total}</strong><div class="muted" style="font-size:12px">积分总分（0~400）</div></div>
        ${ptsBars.map(([label, val, color]) => `
          <div class="pts-row">
            <span class="pts-label">${label}</span>
            <span class="pts-bar"><i style="width:${Math.max(2, Math.min(100, val))}%;background:${color}"></i></span>
            <span class="pts-num" style="color:${color}">${val}</span>
          </div>`).join('')}
        <div class="muted" style="font-size:12px;text-align:center;padding-top:6px">积分 = 基础（100，权限被撤销一次扣 10）+ 社区 + 比赛 + 练习</div>
      </div>`;
  }

  const bioHtml = u.bio
    ? `<div class="statement">${u.bio_html || escapeHtml(u.bio)}</div>`
    : '<div class="muted">这个人很懒，还没有填写简介。</div>';

  // 最近提交（v2.6.0）：个人中心右栏只有 ~345px 宽，上一版的 6 列（状态 / 题目 / 来源 / 语言 / 分数 / 时间）
  // 即使放进块内滚动容器也仍然拥挤，且「来源」列把口径信息塞进了一张窄表。
  // 现按用户要求精简为 **恰好 3 列**：题目 / 结果 / 时间（来源信息不再展示）。
  // 溢出处理：题目列走 .rs-prob-link 的块级省略号（min-width:0 + ellipsis），超长题名不再撑开表格，
  // 完整题名放 title 悬浮查看；表格用 table-layout:fixed 铺满卡片宽度，整块不产生横向滚动。
  const recent = u.recent_submissions.length === 0
    ? '<div class="empty">暂无提交</div>'
    : `<div class="recent-sub-scroll"><table class="table recent-sub-table"><thead><tr><th>题目</th><th>结果</th><th class="num">时间</th></tr></thead><tbody>` +
      u.recent_submissions.map((s) => {
        const v = listStatusInfo(s.verdict);
        return `<tr data-id="${s.id}"><td class="rs-prob"><a class="rs-prob-link" href="#/problem/${s.problem_id}${s.contest_id ? '?contest=' + s.contest_id : ''}" title="${escapeHtml(s.problem_title)}">${escapeHtml(s.problem_title)}</a></td><td class="${v.cls}" title="${escapeHtml(v.title)}">${escapeHtml(v.label)}</td><td class="num muted">${fmtTime(s.created_at)}</td></tr>`;
      }).join('') + '</tbody></table></div>';

  // 练习 Tab：尝试过的题目（含已通过/未通过，置顶） + 已通过题目 + 难度统计侧栏
  const solved = u.solved_problems.length === 0
    ? '<div class="empty">暂未通过任何题目</div>'
    : `<div style="display:flex;flex-wrap:wrap;gap:8px">${u.solved_problems.map((p) =>
        `<a class="chip" href="#/problem/${p.id}" target="_blank" rel="noopener" title="难度：${escapeHtml((Store.difficulties.find((d) => d.level === p.difficulty) || {}).label || '')}">#${p.id} ${escapeHtml(p.title)}</a>`).join('')}</div>`;

  // 尝试过的题目 = 提交过但尚未通过的题目（已通过的只在「已通过的题目」区展示）
  const attemptedAll = (u.attempted_problems || []).filter((p) => !p.ac);
  const attempted = attemptedAll.length === 0
    ? '<div class="empty">暂无未通过的尝试</div>'
    : `<div style="display:flex;flex-wrap:wrap;gap:8px">${attemptedAll.map((p) =>
        `<a class="chip" style="border-color:var(--orange);color:var(--orange)" href="#/problem/${p.id}" target="_blank" rel="noopener" title="已尝试 ${p.attempt_count} 次，尚未通过">#${p.id} ${escapeHtml(p.title)} <span class="muted" style="font-size:11px">(${p.attempt_count} 次)</span></a>`).join('')}</div>`;

  // 已通过题目的难度统计（右侧栏）：展示全部难度，未通过的显示 0 道，只列数量
  const diffStats = (() => {
    const counts = {};
    for (const p of u.solved_problems || []) {
      const lv = p.difficulty != null ? p.difficulty : 0;
      counts[lv] = (counts[lv] || 0) + 1;
    }
    const rows = (Store.difficulties || []).map((d) => {
      const n = counts[d.level] || 0;
      return `
        <div class="row" style="justify-content:space-between;font-size:14px;padding:6px 2px;border-bottom:1px dashed var(--border)">
          <span style="color:${d.color};font-weight:600">${escapeHtml(d.label)}</span>
          <span class="num" style="font-weight:700">${n} 道</span>
        </div>`;
    }).join('');
    return rows || '<div class="empty">暂无数据</div>';
  })();

  // 专栏 Tab
  const edsItems = (eds && eds.editorials) || [];
  const edStatusBadge = { pending: '<span class="badge" style="background:#fa8c16;color:#fff">待审核</span>', approved: '<span class="badge" style="background:#52c41a;color:#fff">已通过</span>', rejected: '<span class="badge" style="background:#ff4d4f;color:#fff">已驳回</span>', draft: '<span class="badge" style="background:#8c8c8c;color:#fff">草稿</span>' };
  const editorialsHtml = edsItems.length === 0
    ? '<div class="empty">暂无文章</div>'
    : edsItems.map((e) => `
      <div class="reply-item" style="padding:14px 16px;margin-bottom:10px">
        <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap">
          <a href="#/editorial/${e.id}" style="font-weight:700;font-size:16px;flex:1;min-width:160px" target="_blank" rel="noopener">${escapeHtml(e.title)}</a>
          ${e.category ? `<span class="tag" style="color:var(--accent);font-weight:600">${escapeHtml(categoryLabel(e.category))}</span>` : ''}
          ${e.is_article
            ? '<span class="tag" style="color:var(--blue)">专栏文章</span>'
            : `<a class="tag" style="font-weight:600" href="#/problem/${e.problem_id}" target="_blank" rel="noopener">#${e.problem_id} ${escapeHtml(e.problem_title)}</a>`}
          ${edStatusBadge[e.status] || ''}
          ${u.is_self ? `
          <span style="display:flex;gap:8px;margin-left:auto;flex-shrink:0">
            <a class="btn" href="#/editorial/edit/${e.id}"><i class="fa-solid fa-pen"></i>${e.status === 'draft' ? '继续编辑' : '编辑'}</a>
            <button class="btn btn-danger del-editorial" data-id="${e.id}"><i class="fa-solid fa-trash"></i>删除</button>
          </span>` : ''}
        </div>
        <div class="muted" style="font-size:13px;margin-top:8px;display:flex;gap:16px;flex-wrap:wrap">
          <span><i class="fa-regular fa-calendar"></i> ${fmtTime(e.created_at)}</span>
          <span><i class="fa-solid fa-thumbs-up"></i> ${e.like_count || 0}</span>
          <span><i class="fa-solid fa-comments"></i> ${e.comment_count || 0}</span>
          ${e.status === 'draft' ? '<span style="color:var(--orange)">草稿仅自己可见，完善后可提交审核</span>' : (e.status === 'rejected' ? '<span style="color:var(--red)">已被驳回，可编辑后重新提交</span>' : '')}
        </div>
      </div>`).join('');

  // 收藏 Tab（仅本人可见）：分三类展示
  let favHtml = '';
  if (tab === 'favorites') {
    favHtml = await renderProfileFavorites(u, query);
  }

  const tabsHtml = [
    ['home', '主页'],
    ['practice', '练习'],
    ['articles', '专栏'],
    ...(u.is_self ? [['favorites', '收藏']] : []),
  ].map(([k, label]) => `<a class="${tab === k ? 'active' : ''}" href="#/user/${u.uid}?tab=${k}">${label}</a>`).join('');

  // 全站积分排名（>1000 用 x.xxk 表示）
  const fmtRank = (r) => (r > 1000 ? (r / 1000).toFixed(2).replace(/0$/, '') + 'k' : r);
  // 「提交数」= 全部提交（含赛时提交），与下方「最近提交」列表、与「查看全部 →」的列表口径一致
  //（此前这里只数题库提交，赛时提交用户在列表里明明有记录、计数却是 0，v2.5.4 修复）
  const submitsTotal = u.stats.submits_all != null ? u.stats.submits_all : u.stats.submits;
  const headStats = [
    ['通过题目', u.stats.solved, '仅统计题库（非比赛）提交中通过的题目数'],
    ['提交数', submitsTotal, `含赛时提交；其中题库提交 ${u.stats.submits} 次`],
    ['等级分', u.rating, ''],
    ...(pts ? [['积分', pts.total, ''], ['积分排名', '#' + (u.points_rank ? fmtRank(u.points_rank) : '—'), '']] : []),
  ].map(([label, val, tip]) => `<div class="ph-stat"${tip ? ` title="${escapeHtml(tip)}"` : ''}><strong>${val}</strong><span>${label}</span></div>`).join('');

  app.innerHTML = `
    <div class="card profile-head" style="margin-top:20px">
      <div class="ph-left">
        ${userAvatarHtml(u, 88)}
      </div>
      <div class="ph-right">
        <div class="ph-name">${userSpan(u)} ${roleBadge[u.role] || roleBadge.user}${u.brown_name ? ' <span class="badge" style="background:#8b5e3c;color:#fff">棕名</span>' : ''}</div>
        <div class="muted" style="margin-top:4px">@${escapeHtml(u.username)} · UID ${u.uid} · 注册于 ${fmtTime(u.created_at)}</div>
        ${u.is_self ? `<div class="row mt"><a class="btn btn-ghost btn-sm" href="#/edit-profile"><i class="fa-solid fa-user-pen"></i>编辑资料</a></div>` : ''}
      </div>
      <div class="ph-stats">${headStats}</div>
    </div>
    <div class="profile-tabs">${tabsHtml}</div>
    ${tab === 'home' ? `
      <div class="profile-grid">
        <div class="pg-left">
          <div class="card"><h2 class="card-title">等级分变化</h2>${chartHtml}</div>
          <div class="card"><h2 class="card-title">个人简介</h2>${bioHtml}</div>
        </div>
        <div class="pg-right">
          ${pts ? `<div class="card"><h2 class="card-title">积分情况</h2>${pointsPanel}</div>` : ''}
          <div class="card"><h2 class="card-title">最近提交（仅 10 条）<a class="muted" style="font-size:12px;font-weight:400;margin-left:8px" href="#/submissions?user=${u.uid}&contest=all">查看全部（${submitsTotal} 条）→</a></h2>${recent}</div>
        </div>
      </div>` : ''}
    ${tab === 'practice' ? `
      <div class="profile-grid">
        <div class="pg-left">
          <div class="card">
            <h2 class="card-title">尝试过的题目（${attemptedAll.length}）</h2>
            ${attempted}
          </div>
          <div class="card">
            <h2 class="card-title">已通过的题目（${u.solved_problems.length}）</h2>
            ${solved}
          </div>
        </div>
        <div class="pg-right">
          <div class="card">
            <h2 class="card-title">通过题目难度统计</h2>
            ${diffStats}
          </div>
        </div>
      </div>` : ''}
    ${tab === 'articles' ? `
      <div class="card">
        <div class="row" style="align-items:center">
          <h2 class="card-title" style="margin:0">专栏文章 / 题解（${edsItems.length}）</h2>
          <div class="spacer"></div>
          ${u.is_self && Store.user && Store.user.can_editorial !== false ? '<a class="btn" href="#/editorial/new/0"><i class="fa-solid fa-pen"></i>写文章</a>' : ''}
          ${u.is_self && edsItems.length ? '<a class="btn btn-ghost" href="#/my-articles">查看全部 →</a>' : ''}
        </div>
        <div class="mt">${editorialsHtml}</div>
      </div>` : ''}
    ${tab === 'favorites' ? favHtml : ''}`;

  // 等级分曲线：需页面已插入 DOM 才能测量宽度，因此放在 innerHTML 之后绘制
  if (tab === 'home' && rhItems.length) drawRatingChart(rhItems);

  document.querySelectorAll('tbody tr[data-id]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') return;
    window.open('#/submission/' + tr.dataset.id, '_blank', 'noopener');
  }));
  // 个人中心专栏列表：删除自己的文章
  document.querySelectorAll('.del-editorial').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确定删除该文章/题解吗？删除后不可恢复。')) return;
    try {
      await api.del('/api/editorials/' + b.dataset.id);
      toast('已删除', 'success');
      renderUserProfile(u.uid, new URLSearchParams('tab=articles'));
    } catch (e) { toast(e.message, 'error'); }
  }));
}

/* 个人中心「等级分变化」曲线：像素级绘制，展示全部参加过的 Rated 比赛（点多时可横向滚动） */
let ratingChartItems = null;
let ratingChartResizeBound = false;

function shortDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

function drawRatingChart(items) {
  const host = document.getElementById('rating-chart');
  if (!host || !items || !items.length) return;
  ratingChartItems = items;
  if (!ratingChartResizeBound) {
    ratingChartResizeBound = true;
    let timer = null;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (ratingChartItems && document.getElementById('rating-chart')) drawRatingChart(ratingChartItems); }, 200);
    });
  }

  const n = items.length;
  const after = items.map((r) => Number(r.rating_after) || 0);
  const start = Number(items[0].rating_before);
  const all = Number.isFinite(start) ? after.concat([start]) : after;
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = Math.max(60, hi - lo);
  let y0 = Math.max(0, Math.floor((lo - span * 0.15) / 20) * 20);
  let y1 = Math.ceil((hi + span * 0.15) / 20) * 20;
  if (y1 - y0 < 100) y1 = y0 + 100; // 波动很小时给一个最小可视区间，避免曲线被拉爆

  const PL = 48, PR = 18, PT = 16, PB = 28, H = 190;
  const GRAY = '#8a93a6';
  const hostW = Math.max(260, host.clientWidth || 520);
  const innerW = hostW - PL - PR;
  // 每个点至少 34px（超出容器则横向滚动），否则等分铺满容器
  const step = n > 1 ? Math.max(34, innerW / (n - 1)) : 0;
  const W = Math.max(hostW, Math.round(PL + PR + step * Math.max(n - 1, 1)));
  const X = (i) => (n === 1 ? PL + innerW / 2 : PL + step * i);
  const Y = (v) => PT + (1 - (v - y0) / (y1 - y0)) * (H - PT - PB);
  const pts = after.map((v, i) => [X(i), Y(v)]);

  // 横向网格 + 等级分刻度
  let grid = '';
  for (let t = 0; t < 4; t++) {
    const v = y0 + ((y1 - y0) * t) / 3;
    const y = Y(v).toFixed(1);
    grid += `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="${GRAY}" stroke-opacity=".22" stroke-width="1" />`
      + `<text x="${PL - 8}" y="${(Number(y) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${GRAY}">${Math.round(v)}</text>`;
  }

  // 首场比赛前的起始等级分（虚线参考线）
  let startLine = '';
  if (Number.isFinite(start)) {
    const sy = Y(start).toFixed(1);
    startLine = `<line x1="${PL}" y1="${sy}" x2="${W - PR}" y2="${sy}" stroke="${GRAY}" stroke-opacity=".55" stroke-width="1" stroke-dasharray="4 4" />`
      + `<text x="${W - PR}" y="${(Number(sy) - 5).toFixed(1)}" text-anchor="end" font-size="10.5" fill="${GRAY}">起始 ${start}</text>`;
  }

  let line = '';
  let area = '';
  if (n > 1) {
    const d = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L ');
    line = 'M ' + d;
    area = `M ${d} L ${pts[n - 1][0].toFixed(1)},${H - PB} L ${pts[0][0].toFixed(1)},${H - PB} Z`;
  }

  const dotR = n > 80 ? 2.4 : (n > 40 ? 3 : 3.6);
  const dots = items.map((it, i) => {
    const [x, y] = pts[i];
    const cid = it.contest_id ? ` data-cid="${it.contest_id}"` : '';
    const title = `${it.contest_title || '第 ' + (i + 1) + ' 场'}｜${it.rating_before} → ${it.rating_after}（${it.delta >= 0 ? '+' : ''}${it.delta}）${it.created_at ? '｜' + fmtTime(it.created_at) : ''}`;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${dotR}" fill="${it.delta >= 0 ? '#52c41a' : '#f5222d'}" stroke="#ffffff" stroke-width="1.2"${cid}><title>${escapeHtml(title)}</title></circle>`;
  }).join('');

  // 横轴日期：按可用宽度抽稀，首尾必标
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(innerW / 76))));
  let xLabels = '';
  items.forEach((it, i) => {
    if (i !== 0 && i !== n - 1 && i % every !== 0) return;
    const d = shortDate(it.created_at);
    if (!d) return;
    xLabels += `<text x="${pts[i][0].toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10.5" fill="${GRAY}">${d}</text>`;
  });

  // 最新等级分与本次变化
  const last = items[n - 1];
  const tx = Math.min(Math.max(pts[n - 1][0], PL + 46), W - PR - 6);
  const lastLabel = `<text x="${tx.toFixed(1)}" y="${(pts[n - 1][1] - 10).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="${last.delta >= 0 ? '#389e0d' : '#cf1322'}">${last.rating_after}（${last.delta >= 0 ? '+' : ''}${last.delta}）</text>`;

  host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="rc-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#1890ff" stop-opacity=".26" />
        <stop offset="100%" stop-color="#1890ff" stop-opacity="0" />
      </linearGradient></defs>
      ${grid}${startLine}
      ${area ? `<path d="${area}" fill="url(#rc-grad)" stroke="none" />` : ''}
      ${line ? `<path d="${line}" fill="none" stroke="#1890ff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />` : ''}
      ${dots}${xLabels}${lastLabel}
    </svg>`;

  // 点击数据点跳转对应比赛（新标签页，与站内其它列表一致）
  host.querySelectorAll('circle[data-cid]').forEach((c) => c.addEventListener('click', () => {
    window.open('#/contest/' + c.dataset.cid, '_blank', 'noopener');
  }));
}

/* 个人中心「收藏」Tab：题目 / 讨论 / 比赛 分类展示（每类仅展示 5 条，更多分页） */
async function renderProfileFavorites(u, query) {
  const favType = (query.get('fav') || '').trim(); // '' = 全部
  // 顶部菜单：全部 / 题目 / 比赛 / 讨论 / 文章
  const menu = [['', '全部'], ['problem', '题目'], ['contest', '比赛'], ['discussion', '讨论'], ['article', '文章']]
    .map(([k, label]) => `<a class="chip ${favType === k ? 'active' : ''}" data-fav="${k}" href="#/user/${u.uid}?tab=favorites${k ? '&fav=' + k : ''}">${label}</a>`).join('');

  // 单条收藏的富信息渲染
  const renderItem = (f) => {
    if (f.type === 'problem') {
      const d = Store.difficulties.find((x) => x.level === f.difficulty) || {};
      return `
        <div style="flex:1;min-width:0">
          <a href="#/problem/${f.id}" target="_blank" rel="noopener" style="font-weight:600">#${f.id} ${escapeHtml(f.title)}</a>
          <div class="muted" style="font-size:12px;margin-top:2px">
            ${d.color ? `<span style="color:${d.color};font-weight:600">${escapeHtml(d.label)}</span>` : ''}
            · 通过 ${f.accepted_count || 0} / 提交 ${f.submit_count || 0} · 收藏于 ${fmtTime(f.created_at)}
          </div>
        </div>`;
    }
    if (f.type === 'contest') {
      const stLabel = { upcoming: '未开始', running: '进行中', ended: '已结束' }[f.status] || f.status;
      const st = CONTEST_STATUS_COLOR[f.status] ? `<span class="badge" style="background:${CONTEST_STATUS_COLOR[f.status]};color:#fff;font-size:11px">${stLabel}</span>` : '';
      return `
        <div style="flex:1;min-width:0">
          <a href="#/contest/${f.id}" target="_blank" rel="noopener" style="font-weight:600">${escapeHtml(f.title)}</a>
          <div class="muted" style="font-size:12px;margin-top:2px">
            ${st}
            <span class="badge" style="background:${CONTEST_TYPE_COLOR[f.extra] || '#722ed1'};color:#fff;font-size:11px">${escapeHtml(f.extra || '')}</span>
            · 报名 ${f.signup_count || 0} 人 · 收藏于 ${fmtTime(f.created_at)}
          </div>
        </div>`;
    }
    if (f.type === 'discussion') {
      return `
        <div style="flex:1;min-width:0">
          <a href="#/discussion/${f.id}" target="_blank" rel="noopener" style="font-weight:600">${escapeHtml(f.title)}</a>
          <div class="muted" style="font-size:12px;margin-top:2px">
            by ${escapeHtml(f.extra || '')}${f.problem_id ? ` · 题目 <a href="#/problem/${f.problem_id}">#${f.problem_id} ${escapeHtml(f.problem_title || '')}</a>` : ''} · 收藏于 ${fmtTime(f.created_at)}
          </div>
        </div>`;
    }
    // article
    return `
      <div style="flex:1;min-width:0">
        <a href="#/editorial/${f.id}" target="_blank" rel="noopener" style="font-weight:600">${escapeHtml(f.title)}</a>
        <div class="muted" style="font-size:12px;margin-top:2px">
          ${f.category ? `<span class="tag" style="color:var(--accent);font-weight:600;font-size:11px">${escapeHtml(categoryLabel(f.category))}</span>` : ''}
          ${f.is_article === undefined ? '' : (f.is_article ? '<span class="tag" style="color:var(--blue);font-size:11px">专栏文章</span>' : '<span class="tag" style="color:var(--blue);font-size:11px">题解</span>')}
          by ${escapeHtml(f.extra || '')} · <i class="fa-solid fa-thumbs-up"></i> ${f.like_count || 0} · <i class="fa-solid fa-comments"></i> ${f.comment_count || 0} · 收藏于 ${fmtTime(f.created_at)}
        </div>
      </div>`;
  };

  // 渲染某个分类的列表（含分页）
  const renderCategory = async (type, label, size) => {
    const page = parseInt((query && query.get('fp_' + type)) || '1', 10);
    const r = await api.get(`/api/favorites?type=${type}&page=${page}&size=${size}`);
    const items = r.items.length === 0
      ? '<div class="empty">暂无收藏</div>'
      : r.items.map((f) => `<div class="reply-item" style="display:flex;align-items:center;gap:10px">
          <span class="tag" style="color:var(--accent);flex-shrink:0">${label}</span>
          ${renderItem(f)}
          <button class="btn btn-ghost btn-sm unfav" data-type="${type}" data-id="${f.id}"><i class="fa-solid fa-star"></i>取消收藏</button>
        </div>`).join('');
    const pages = Math.max(1, Math.ceil(r.total / size));
    const pager = r.total > size ? `
      <div class="row" style="justify-content:center;gap:8px;margin-top:10px">
        <button class="btn btn-ghost btn-sm fav-page" data-type="${type}" data-p="${page - 1}" ${page <= 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i>上一页</button>
        <span class="muted" style="font-size:13px">${page} / ${pages}</span>
        <button class="btn btn-ghost btn-sm fav-page" data-type="${type}" data-p="${page + 1}" ${page >= pages ? 'disabled' : ''}>下一页<i class="fa-solid fa-chevron-right"></i></button>
      </div>` : '';
    return `<div class="card"><h2 class="card-title">${label}（${r.total}）</h2>${items}${pager}</div>`;
  };

  let html = '';
  if (favType) {
    const labelMap = { problem: '题目', contest: '比赛', discussion: '讨论', article: '文章' };
    html = await renderCategory(favType, labelMap[favType] || favType, 10);
  } else {
    // 全部：四个分类堆叠展示
    const sections = [];
    for (const [type, label] of [['problem', '题目'], ['contest', '比赛'], ['discussion', '讨论'], ['article', '文章']]) {
      try { sections.push(await renderCategory(type, label, 5)); } catch { /* ignore */ }
    }
    html = sections.join('');
  }

  setTimeout(() => {
    document.querySelectorAll('.unfav').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api.del(`/api/favorites/${b.dataset.type}/${b.dataset.id}`);
        toast('已取消收藏', 'info');
        renderUserProfile(u.uid, new URLSearchParams(query.toString()));
      } catch (e) { toast(e.message, 'error'); }
    }));
    document.querySelectorAll('.fav-page').forEach((b) => b.addEventListener('click', () => {
      const p = parseInt(b.dataset.p, 10);
      if (!Number.isFinite(p) || p < 1) return;
      const q = new URLSearchParams(query.toString());
      q.set('fp_' + b.dataset.type, String(p));
      renderUserProfile(u.uid, q);
    }));
  }, 0);
  return `<div class="tag-chips mb">${menu}</div>${html}`;
}
/* ---------- 题解与专栏（全站文章流） ----------
   v2.7.7：默认（无分类）只显示**专栏文章**（未关联题目且分类不是「题解」）；
   点分类「题解」只看题解，并且在「题解」分类下才出现按题号（题目 ID）筛选某道题题解的筛选条，
   两者可组合；离开「题解」分类时题号筛选一并清除（不会被带到专栏列表）。
   口径由服务端 listArticles() 统一判定（题解 = problem_id 非空），前端只负责传参。 */
async function renderArticles(query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const page = parseInt(query.get('page') || '1', 10);
  const category = (query.get('category') || '').trim();
  // 题号筛选只在「题解」分类下显示与生效（专栏文章不关联题目）
  const showProblemFilter = category === CAT_SOLUTION;
  const problem = showProblemFilter ? (query.get('problem') || '').trim() : '';
  const params = new URLSearchParams({ page: String(page), size: '20' });
  if (category) params.set('category', category);
  if (problem) params.set('problem_id', problem);
  await loadTaxonomy();
  const data = await api.get('/api/articles?' + params.toString());
  setPageTitle('题解与专栏');
  const isAdmin = Store.user && Store.user.is_admin;
  // 题号筛选命中的题目名（拿不到就只显示题号）
  let problemTitle = '';
  if (problem) {
    try { const pd = await api.get('/api/problems/' + encodeURIComponent(problem)); problemTitle = (pd.problem && pd.problem.title) || ''; } catch { /* 题号不存在：只显示题号 */ }
  }
  const emptyText = problem ? '该题号下暂无题解' : (category === CAT_SOLUTION ? '暂无题解' : '暂无文章');
  const rows = data.items.length === 0
    ? `<div class="empty">${emptyText}</div>`
    : data.items.map((e) => `
      <div class="reply-item">
        <div class="row" style="gap:10px;align-items:baseline">
          <a href="#/editorial/${e.id}" style="font-weight:600;font-size:15px;flex:1" target="_blank" rel="noopener">${escapeHtml(e.title)}</a>
          ${e.category ? `<span class="tag click-cat" data-cat="${escapeHtml(e.category)}" style="color:var(--accent);font-weight:600;cursor:pointer" title="筛选该分类">${escapeHtml(categoryLabel(e.category))}</span>` : ''}
          ${e.is_article ? '<span class="tag" style="color:var(--blue)">专栏文章</span>' : `<a class="tag" style="font-weight:600" href="#/problem/${e.problem_id}">#${e.problem_id}</a>`}
          ${ED_STATUS_BADGE[e.status] || ''}
          ${(isAdmin && e.status === 'pending') ? `
            <button class="btn btn-sm btn-approve" data-ed-review="approved" data-id="${e.id}"><i class="fa-solid fa-check"></i>通过</button>
            <button class="btn btn-danger btn-sm" data-ed-review="rejected" data-id="${e.id}"><i class="fa-solid fa-ban"></i>驳回</button>` : ''}
          ${(isAdmin && e.status === 'rejected') ? `<button class="btn btn-sm btn-approve" data-ed-review="approved" data-id="${e.id}"><i class="fa-solid fa-check"></i>通过</button>` : ''}
        </div>
        <div class="muted" style="font-size:12px;margin-top:4px">
          ${userSpan({ uid: e.user_id, username: e.username, nickname: e.username, points_num: 0 })} · ${fmtTime(e.created_at)}
          · <i class="fa-solid fa-thumbs-up"></i> ${e.like_count} · <i class="fa-solid fa-comments"></i> ${e.comment_count || 0}
        </div>
      </div>`).join('');

  const artOff = Store.features && Store.features.article_enabled === false;
  // 分类筛选（点击标签或筛选条切换）；分类列表来自接口，不再硬编码。
  // 只有切到「题解」分类时才保留题号筛选（题号筛选仅属于题解分类）。
  const catChips = [['', '全部'], ...categoryList().filter((c) => c.key !== CAT_UNCATEGORIZED).map((c) => [c.key, c.name])].map(([k, label]) => {
    const q = new URLSearchParams();
    if (k) q.set('category', k);
    if (k === CAT_SOLUTION && problem) q.set('problem', problem);
    return `<a class="chip ${category === k ? 'active' : ''}" data-cat="${escapeHtml(k)}" href="#/articles${q.toString() ? '?' + q.toString() : ''}">${escapeHtml(label)}</a>`;
  }).join('');
  // 题号筛选条：**只在「题解」分类下出现**；沿用站内既有 .filter-bar + .input + .btn（与讨论区 / 后台筛选条同一套控件）
  const clearQ = new URLSearchParams();
  if (category) clearQ.set('category', category);
  const problemBar = !showProblemFilter ? '' : `<div class="filter-bar">
      <input class="input" id="art-problem" placeholder="按题号筛选：输入题目 ID，查看该题的题解" value="${escapeHtml(problem)}" style="max-width:280px" />
      <button class="btn" id="art-problem-btn"><i class="fa-solid fa-filter"></i>按题号筛选</button>
      ${problem ? `<span class="tag" style="font-weight:600">#${escapeHtml(problem)}${problemTitle ? ' ' + escapeHtml(problemTitle) : ''}</span>
        <a class="muted" href="#/articles${clearQ.toString() ? '?' + clearQ.toString() : ''}">清除题号筛选</a>` : ''}
    </div>`;
  app.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">题解与专栏</h1>
      <div class="spacer"></div>
      ${(Store.user && Store.user.can_editorial !== false && !artOff) ? '<a class="btn" href="#/editorial/new/0"><i class="fa-solid fa-pen"></i>写文章</a>' : ''}
    </div>
    ${artOff ? '<div class="status-banner warn"><span style="font-weight:700"><i class="fa-solid fa-lock"></i> 题解与专栏功能已关闭</span><span class="muted">仅可浏览已发布内容</span></div>' : ''}
    <div class="list-layout">
      <div class="list-side">
        <div class="card">
          <h2 class="card-title"><i class="fa-solid fa-filter"></i> 分类</h2>
          <div class="cat-chips">${catChips}</div>
          <p class="muted" style="font-size:12px;margin:10px 0 0;line-height:1.7">默认只展示「专栏文章」（未关联题目的独立文章）；点「题解」分类查看题解，并在该分类下用题号筛选某道题的题解。题解关联题目以 #N 标注。文章与题解均需管理员审核后公开。</p>
        </div>
      </div>
      <div class="list-main">
        ${problemBar}
        <div class="card" style="padding:8px 20px">${rows}</div>
        ${renderPagination(data.total, data.page, data.size)}
      </div>
    </div>`;
  const goPage = (p) => {
    const q = new URLSearchParams();
    if (category) q.set('category', category);
    if (problem) q.set('problem', problem);
    q.set('page', String(p));
    nav('articles', q);
  };
  bindPagination(goPage);
  // 题号筛选：输入题目 ID → 只看该题的题解（回车与按钮等效）
  const pInput = document.getElementById('art-problem');
  const pBtn = document.getElementById('art-problem-btn');
  const applyProblem = () => {
    const raw = String(pInput.value || '').trim();
    if (raw && !/^\d+$/.test(raw)) return toast('题号只能是数字', 'error');
    const q = new URLSearchParams();
    if (category) q.set('category', category);
    if (raw) q.set('problem', String(parseInt(raw, 10)));
    q.set('page', '1');
    nav('articles', q);
  };
  if (pBtn) pBtn.addEventListener('click', applyProblem);
  if (pInput) pInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyProblem(); } });
  // 管理员在文章流直接审核
  document.querySelectorAll('button[data-ed-review]').forEach((b) => b.addEventListener('click', async () => {
    const status = b.dataset.edReview;
    let reason = '';
    if (status === 'rejected') {
      reason = prompt('请填写驳回原因（必填）');
      if (!reason || !reason.trim()) return toast('驳回必须填写原因', 'error');
    }
    try {
      await api.post(`/api/editorials/${b.dataset.id}/review`, { status, reason });
      toast(status === 'approved' ? '已通过' : '已驳回', 'success');
      renderArticles(query);
    } catch (e) { toast(e.message, 'error'); }
  }));
}

/* ---------- 我的收藏（题目 / 讨论 / 比赛 分类） ---------- */
async function renderFavorites(query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  if (!Store.user) {
    app.innerHTML = '<div class="empty">请先 <a href="#/login">登录</a></div>';
    return;
  }
  const type = query.get('type') || 'problem';
  const page = parseInt(query.get('page') || '1', 10);
  const params = new URLSearchParams({ type, page: String(page), size: '20' });
  const data = await api.get('/api/favorites?' + params.toString());
  setPageTitle('我的收藏');

  const renderItem = (f) => {
    if (f.type === 'problem') return `<a href="#/problem/${f.id}" target="_blank" rel="noopener" style="font-weight:600;flex:1">#${f.id} ${escapeHtml(f.title)}</a>`;
    if (f.type === 'discussion') return `<a href="#/discussion/${f.id}" target="_blank" rel="noopener" style="font-weight:600;flex:1">${escapeHtml(f.title)}</a><span class="muted" style="font-size:12px"> · ${escapeHtml(f.extra)}</span>`;
    if (f.type === 'article') return `<a href="#/editorial/${f.id}" target="_blank" rel="noopener" style="font-weight:600;flex:1">${escapeHtml(f.title)}</a><span class="muted" style="font-size:12px"> · ${escapeHtml(f.extra)}${f.category ? ' · ' + escapeHtml(f.category) : ''}</span>`;
    return `<a href="#/contest/${f.id}" target="_blank" rel="noopener" style="font-weight:600;flex:1">${escapeHtml(f.title)}</a><span class="muted" style="font-size:12px"> · ${escapeHtml(f.extra)}</span>`;
  };
  const rows = data.items.length === 0
    ? '<div class="empty">暂无收藏</div>'
    : data.items.map((f) => `
      <div class="reply-item">
        <div class="row" style="gap:10px;align-items:baseline">
          ${renderItem(f)}
          <span class="muted" style="font-size:12px">${fmtTime(f.created_at)}</span>
          <button class="btn btn-ghost btn-sm fav-remove" data-type="${f.type}" data-id="${f.id}"><i class="fa-solid fa-star"></i>取消收藏</button>
        </div>
      </div>`).join('');

  const tabs = [['problem', '题目'], ['discussion', '讨论'], ['contest', '比赛'], ['article', '文章']]
    .map(([k, label]) => `<a class="chip ${type === k ? 'active' : ''}" data-type="${k}">${label}</a>`).join('');

  app.innerHTML = `
    <h1 class="page-title">我的收藏</h1>
    <div class="tag-chips" id="fav-tabs">${tabs}</div>
    <div class="card" style="padding:8px 20px">${rows}</div>
    ${renderPagination(data.total, data.page, data.size)}`;
  bindPagination((p) => nav('favorites', { type, page: p }));
  document.querySelectorAll('#fav-tabs .chip').forEach((c) => c.addEventListener('click', () => {
    nav('favorites', { type: c.dataset.type, page: 1 });
  }));
  document.querySelectorAll('.fav-remove').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api.del(`/api/favorites/${b.dataset.type}/${b.dataset.id}`);
      toast('已取消收藏', 'info');
      renderFavorites(query);
    } catch (e) { toast(e.message, 'error'); }
  }));
}

/* ---------- 我的专栏文章 ---------- */
async function renderMyArticles(query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  if (!Store.user) {
    app.innerHTML = '<div class="empty">请先 <a href="#/login">登录</a></div>';
    return;
  }
  const data = await api.get('/api/users/' + Store.user.id + '/editorials');
  setPageTitle('我的专栏文章');
  const rows = data.editorials.length === 0
    ? '<div class="empty">还没有写过文章或题解。</div>'
    : data.editorials.map((e) => `
      <div class="reply-item">
        <div class="row" style="gap:10px;align-items:baseline">
          <a href="#/editorial/${e.id}" style="font-weight:600;flex:1" target="_blank" rel="noopener">${escapeHtml(e.title)}</a>
          ${e.category ? `<span class="tag" style="color:var(--accent);font-weight:600">${escapeHtml(categoryLabel(e.category))}</span>` : ''}
          ${e.is_article
            ? '<span class="tag" style="color:var(--blue)">专栏文章</span>'
            : `<a class="tag" style="font-weight:600" href="#/problem/${e.problem_id}">#${e.problem_id}</a>`}
          ${ED_STATUS_BADGE[e.status] || ''}
        </div>
        <div class="muted" style="font-size:12px;margin-top:4px">${fmtTime(e.created_at)}${e.status === 'draft' ? ' · 草稿仅自己可见，完善后可提交审核' : (e.status === 'rejected' ? ' · 已被驳回，可编辑后重新提交' : '')}</div>
        <div class="row mt" style="gap:8px">
          <a class="btn btn-ghost btn-sm" href="#/editorial/edit/${e.id}">${e.status === 'draft' ? '继续编辑' : '编辑'}</a>
          <button class="btn btn-danger btn-sm del-article" data-id="${e.id}"><i class="fa-solid fa-trash-can"></i>删除</button>
        </div>
      </div>`).join('');

  const artOff = Store.features && Store.features.article_enabled === false;
  app.innerHTML = `
    <div class="crumb"><a href="#/user/${Store.user.id}"><i class="fa-solid fa-arrow-left"></i> 返回个人中心</a></div>
    <div class="page-header">
      <h1 class="page-title">我的专栏文章</h1>
      <div class="spacer"></div>
      ${artOff ? '<span class="tag" style="color:var(--red)">专栏功能已关闭</span>' : '<a class="btn" href="#/editorial/new/0"><i class="fa-solid fa-pen"></i>写文章</a>'}
    </div>
    ${artOff ? '<div class="status-banner warn"><span style="font-weight:700"><i class="fa-solid fa-lock"></i> 题解与专栏功能已关闭</span><span class="muted">仅可管理已发布内容，不能发布新文章</span></div>' : ''}
    <p class="muted mb">这里管理你发布的全部题解与专栏文章；文章与题解均需管理员审核后公开，驳回后可以编辑重新提交。</p>
    <div class="card" style="padding:8px 20px">${rows}</div>`;
  document.querySelectorAll('.del-article').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确定删除该文章吗？')) return;
    try {
      await api.del('/api/editorials/' + b.dataset.id);
      toast('已删除', 'success');
      renderMyArticles({});
    } catch (e) { toast(e.message, 'error'); }
  }));
}

/* ---------- 通知中心（分类页） ---------- */
const NOTIF_TABS = [['', '全部'], ['mention', '被@'], ['reply', '回复我的'], ['system', '系统']];

async function renderNotificationsPage(query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  if (!Store.user) {
    app.innerHTML = '<div class="empty">请先 <a href="#/login">登录</a></div>';
    return;
  }
  const page = parseInt(query.get('page') || '1', 10);
  const cat = query.get('cat') || '';
  const params = new URLSearchParams({ page: String(page), size: '20' });
  if (cat) params.set('category', cat);
  const data = await api.get('/api/notifications?' + params.toString());
  setPageTitle('通知中心');

  const tabs = NOTIF_TABS.map(([k, label]) => `<a class="chip ${cat === k ? 'active' : ''}" data-cat="${k}" href="#/notifications${k ? '?cat=' + k : ''}">${label}</a>`).join('');
  const rows = data.items.length === 0
    ? '<div class="empty">暂无通知</div>'
    : data.items.map((n) => `
      <div class="reply-item notif-row ${n.is_read ? '' : 'unread'}" data-link="${escapeHtml(n.link)}" data-id="${n.id}">
        <div class="row" style="gap:10px;align-items:center">
          ${n.is_read ? '' : '<span class="notif-dot" title="未读"></span>'}
          <span class="badge" style="background:${n.category === 'mention' ? '#722ed1' : n.category === 'reply' ? '#1890ff' : '#8c8c8c'};color:#fff;font-size:11px">${n.category === 'mention' ? '被@' : n.category === 'reply' ? '回复我的' : '系统'}</span>
          <span style="font-weight:600;flex:1">${escapeHtml(n.title)}</span>
          <span class="muted" style="font-size:12px">${fmtTime(n.created_at)}</span>
        </div>
        ${n.content ? `<div class="muted" style="font-size:13px;margin-top:4px">${escapeHtml(n.content)}</div>` : ''}
      </div>`).join('');

  app.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">通知中心</h1>
      <div class="spacer"></div>
      <button class="btn btn-ghost btn-sm" id="notif-all-read"><i class="fa-solid fa-check-double"></i>全部已读</button>
    </div>
    <p class="muted mb">分类说明：被@ = 讨论/回复/评论中提及你；回复我的 = 你的文章/题解/讨论被评论或回复；系统 = 权限变更、题解审核结果等。</p>
    <div class="tag-chips" id="notif-tabs">${tabs}</div>
    <div class="card" style="padding:8px 20px">${rows}</div>
    ${renderPagination(data.total, data.page, data.size)}`;
  bindPagination((p) => nav('notifications', { cat, page: p }));
  const allRead = document.getElementById('notif-all-read');
  if (allRead) allRead.addEventListener('click', async () => {
    try {
      await api.post('/api/notifications/read-all');
      toast('已全部标记为已读', 'success');
      refreshBellBadge(true);
      renderNotificationsPage(query);
    } catch (e) { toast(e.message, 'error'); }
  });
  document.querySelectorAll('.notif-row').forEach((el) => el.addEventListener('click', async () => {
    const link = el.dataset.link;
    const nid = el.dataset.id;
    if (nid) {
      try { await api.post('/api/notifications/' + nid); } catch { /* ignore */ }
      refreshBellBadge(true);
    }
    if (link) nav(link.replace(/^#\//, ''));
  }));
}

/* 功能开关关闭时的占位页（如「私信功能已关闭」） */
function renderFeatureClosed(name) {
  setPageTitle(name);
  app.innerHTML = `
    <div class="page-header"><h1 class="page-title">${escapeHtml(name)}</h1></div>
    <div class="card">
      <div class="empty" style="padding:56px 0">
        <div style="font-size:40px;color:var(--text-light);margin-bottom:10px"><i class="fa-solid fa-ban"></i></div>
        <p><strong style="font-size:16px">${escapeHtml(name)}功能已关闭</strong></p>
        <p class="muted">站点管理员已在「系统设置 → 功能设置」中关闭了该功能，如有疑问请联系管理员。</p>
        <a class="btn mt" href="#/home"><i class="fa-solid fa-house"></i>返回首页</a>
      </div>
    </div>`;
}

/* ---------- 站内信（私信，仿洛谷界面） ---------- */
async function renderMessages(query) {
  // 兜底：功能开关「私信」关闭时即使走到这里也不渲染私信界面
  if (Store.features && Store.features.pm_enabled === false) { renderFeatureClosed('私信'); return; }
  if (!Store.user) {
    app.innerHTML = '<div class="empty" style="padding:80px 0"><div style="font-size:40px;color:var(--accent);margin-bottom:10px"><i class="fa-regular fa-envelope"></i></div><p>登录后即可收发私信</p><a class="btn mt" href="#/login"><i class="fa-solid fa-right-to-bracket"></i>登录 / 注册</a></div>';
    return;
  }
  app.innerHTML = '<div class="loading">加载中…</div>';
  setPageTitle('私信');
  const meId = Store.user.uid;
  const want = parseInt((query && query.get('with')) || '0', 10) || 0;

  app.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">私信</h1>
      <div class="spacer"></div>
      <button class="btn btn-sm" id="msg-new-btn"><i class="fa-solid fa-pen"></i>发私信</button>
    </div>
    <div class="msg-wrap">
      <div class="msg-list" id="msg-list"></div>
      <div class="msg-thread card" id="msg-thread">
        <div class="empty" style="padding:70px 0">
          <div style="font-size:42px;color:var(--text-light);margin-bottom:10px"><i class="fa-regular fa-comments"></i></div>
          选择左侧会话开始聊天，或点击右上角「发私信」
        </div>
      </div>
    </div>`;

  let convs = [];
  let curOther = null;
  let poll = null;

  const fmtT = (ms) => {
    if (!ms) return '';
    const d = new Date(ms), n = new Date();
    const p = (x) => String(x).padStart(2, '0');
    if (d.toDateString() === n.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
    if (d.getFullYear() === n.getFullYear()) return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  const nmCol = (u) => userColor({ username: u.username, role: u.role, brown_name: !!u.brown_name });
  // 消息文本清理：统一换行、多余空格折叠（含全角空格）、去行首行尾空白、压缩连续空行（与存储一致）
  const cleanTxt = (s) => String(s || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l
      .replace(/[\u3000\u00A0]+/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/^ +/, '')
      .replace(/ +$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const renderList = () => {
    const box = document.getElementById('msg-list');
    if (!box) return;
    if (!convs.length) {
      box.innerHTML = '<div class="msg-list-head"><i class="fa-solid fa-envelope"></i> 我的私信</div><div class="empty" style="padding:30px 12px">暂无私信</div>';
      return;
    }
    box.innerHTML = '<div class="msg-list-head"><i class="fa-solid fa-envelope"></i> 我的私信</div>' + convs.map((c) => `
      <div class="msg-item ${curOther === c.other.id ? 'active' : ''} ${c.unread > 0 ? 'unread' : ''}" data-uid="${c.other.id}">
        ${c.unread > 0 ? '<span class="notif-dot" title="未读"></span>' : ''}
        ${userAvatarHtml(c.other, 38)}
        <div class="msg-item-main">
          <div class="msg-item-name" style="color:${nmCol(c.other)}">${escapeHtml(c.other.nickname || c.other.username)}</div>
          <div class="msg-item-prev">${c.last_message ? (c.last_message.mine ? '<span style="color:var(--text-light)">我：</span>' : '') + escapeHtml(cleanTxt(c.last_message.content).slice(0, 60)) : '开始聊天吧'}</div>
        </div>
        <div class="msg-item-time">${fmtT(c.last_at)}</div>
      </div>`).join('');
    box.querySelectorAll('.msg-item').forEach((el) => el.addEventListener('click', () => openThread(parseInt(el.dataset.uid, 10))));
  };

  const bubbleRow = (m, other) => {
    const mine = !!m.mine;
    const bubbleBg = mine ? 'var(--accent)' : 'var(--bg)';
    const bubbleBorder = mine ? '1px solid transparent' : '1px solid var(--border)';
    const bubbleColor = mine ? '#fff' : '';
    // 全部使用内联样式：气泡与文字严格贴合（width:fit-content），不受旧缓存 CSS 影响
    return `<div class="msg-bubble-row ${mine ? 'mine' : ''}" data-mid="${m.id}"
      style="display:flex;gap:8px;align-items:flex-end;justify-content:${mine ? 'flex-end' : 'flex-start'}">
      ${mine ? '' : userAvatarHtml(other, 28)}
      <div style="display:flex;flex-direction:column;align-items:${mine ? 'flex-end' : 'flex-start'};width:fit-content;max-width:min(560px,76%);min-width:0">
        <div style="width:fit-content;max-width:100%;background:${bubbleBg};border:${bubbleBorder};color:${bubbleColor};border-radius:12px;padding:8px 12px;line-height:1.55;font-size:14px;white-space:pre-line;word-break:break-word">${escapeHtml(cleanTxt(m.content))}</div>
        <div style="color:var(--text-light);font-size:11px;margin-top:3px;padding:0 2px">${fmtTime(m.created_at)}</div>
      </div>
    </div>`;
  };

  const stopPoll = () => { if (poll) { clearInterval(poll); poll = null; } };

  const openThread = async (uid) => {
    stopPoll();
    curOther = uid;
    document.querySelectorAll('.msg-item').forEach((el) => el.classList.toggle('active', parseInt(el.dataset.uid, 10) === uid));
    const t = document.getElementById('msg-thread');
    if (!t) return;
    t.innerHTML = '<div class="empty">加载中…</div>';
    let data;
    try {
      data = await api.get('/api/messages/conversation?with=' + uid);
    } catch (e) {
      t.innerHTML = `<div class="empty">加载失败：${escapeHtml(e.message)}</div>`;
      return;
    }
    const other = data.other;
    const head = `
      <div class="msg-thread-head">
        ${userAvatarHtml(other, 34)}
        <div class="msg-thread-user">
          <a href="#/user/${other.id}" target="_blank" rel="noopener" style="color:${nmCol(other)};font-weight:700">${escapeHtml(other.nickname || other.username)}</a>
          <span class="muted" style="font-size:12px;margin-left:6px">@${escapeHtml(other.username)} · UID ${other.id}</span>
        </div>
        <div class="spacer"></div>
      </div>`;
    const bubbles = (data.messages || []).map((m) => bubbleRow(m, other)).join('');
    t.innerHTML = head + `
      <div class="msg-bubbles">${bubbles || '<div class="empty" style="padding:34px 0">还没有消息，发一条打个招呼吧～</div>'}</div>
      <div class="msg-input-area">
        <textarea id="msg-input" rows="3" maxlength="2000" placeholder="输入内容，Enter 发送 · Shift+Enter 换行"></textarea>
        <button class="btn msg-send-btn" id="msg-send-btn"><i class="fa-solid fa-paper-plane"></i>发送</button>
      </div>`;
    const area = t.querySelector('.msg-bubbles');
    if (area && bubbles) area.scrollTop = area.scrollHeight;

    const inp = document.getElementById('msg-input');
    const sendBtn = document.getElementById('msg-send-btn');
    const doSend = async () => {
      const txt = inp.value.trim();
      if (!txt) return;
      try {
        const r = await api.post('/api/messages/send', { to: uid, content: txt });
        inp.value = '';
        const row = bubbleRow(r.message, other);
        const boxes = t.querySelector('.msg-bubbles');
        if (boxes) {
          if (boxes.querySelector('.empty')) boxes.innerHTML = '';
          boxes.insertAdjacentHTML('beforeend', row);
          boxes.scrollTop = boxes.scrollHeight;
        }
        const found = convs.find((c) => c.other.id === uid);
        if (found) {
          found.last_message = { mine: true, content: r.message.content, created_at: r.message.created_at };
          found.last_at = r.message.created_at;
          found.unread = 0;
          convs.sort((a, b) => (b.last_at || 0) - (a.last_at || 0));
          renderList();
        } else {
          const cv = await api.get('/api/messages/conversations');
          convs = cv.items; renderList();
        }
        refreshBellBadge();
      } catch (e) { toast(e.message, 'error'); }
    };
    if (sendBtn) sendBtn.addEventListener('click', doSend);
    if (inp) inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    // 打开会话即已读：刷新铃铛红点与会话未读数
    refreshBellBadge(true);
    try {
      const cv = await api.get('/api/messages/conversations');
      convs = cv.items; renderList();
    } catch { /* ignore */ }
    poll = setInterval(async () => {
      if (!document.getElementById('msg-input') || curOther !== uid) { stopPoll(); return; }
      try {
        const d = await api.get('/api/messages/conversation?with=' + uid);
        const area = t.querySelector('.msg-bubbles');
        if (!area) { stopPoll(); return; }
        const have = new Set([...area.querySelectorAll('.msg-bubble-row')].map((el) => parseInt(el.dataset.mid, 10)));
        const fresh = (d.messages || []).filter((m) => !have.has(m.id));
        const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 90;
        if (area.querySelector('.empty') && fresh.length) area.innerHTML = '';
        let gotIncoming = false;
        for (const m of fresh) { area.insertAdjacentHTML('beforeend', bubbleRow(m, other)); if (!m.mine) gotIncoming = true; }
        if (gotIncoming) {
          refreshBellBadge(true);
          try { const cv = await api.get('/api/messages/conversations'); convs = cv.items; renderList(); } catch { /* ignore */ }
        }
        if (fresh.length && nearBottom) area.scrollTop = area.scrollHeight;
      } catch { /* ignore */ }
    }, 4000);
  };

  // 会话列表
  const loadConvs = async () => {
    try {
      const cv = await api.get('/api/messages/conversations');
      convs = cv.items || [];
    } catch { convs = []; }
    renderList();
    refreshBellBadge();
    if (want && !curOther) await openThread(want);
  };
  await loadConvs();

  // 发新私信弹窗
  document.getElementById('msg-new-btn').addEventListener('click', () => {
    if (document.getElementById('msg-new-modal')) return;
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.id = 'msg-new-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:flex;align-items:center;justify-content:center';
    modal.innerHTML = `<div class="card" style="width:520px;max-width:92vw;margin:0">
      <div class="row" style="align-items:center"><h2 class="card-title" style="margin:0"><i class="fa-solid fa-pen"></i> 发私信</h2><div class="spacer"></div><button class="btn btn-ghost btn-sm" id="msg-close" type="button"><i class="fa-solid fa-xmark"></i>关闭</button></div>
      <div class="row mt" style="gap:8px">
        <input class="input" id="msg-target" placeholder="对方 UID 或用户名（精确匹配）" style="flex:1" />
        <button class="btn" id="msg-search-btn" type="button"><i class="fa-solid fa-magnifying-glass"></i>查找</button>
      </div>
      <div id="msg-target-result" class="mt"></div>
    </div>`;
    document.body.appendChild(modal);
    const close = () => { modal.remove(); };
    // 弹窗不因点击空白处而消失：仅通过「关闭」按钮或查找后「去私信」关闭
    document.getElementById('msg-close').addEventListener('click', close);
    const doSearch = async () => {
      const q = document.getElementById('msg-target').value.trim();
      const box = document.getElementById('msg-target-result');
      if (!q) return;
      box.innerHTML = '<div class="muted">查找中…</div>';
      let r;
      try { r = await api.get('/api/users/lookup?q=' + encodeURIComponent(q)); }
      catch (e) { box.innerHTML = `<div class="muted" style="color:var(--red)">${escapeHtml(e.message)}</div>`; return; }
      const u = r.user;
      box.innerHTML = `<div class="row" style="gap:10px;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px 12px">
        ${userAvatarHtml(u, 36)}
        <div><div style="font-weight:700;color:${nmCol(u)}">${escapeHtml(u.nickname || u.username)}</div><div class="muted" style="font-size:12px">@${escapeHtml(u.username)} · UID ${u.id}</div></div>
        <div class="spacer"></div>
        <button class="btn btn-sm" id="msg-start-btn" type="button"><i class="fa-solid fa-envelope"></i>去私信</button>
      </div>`;
      document.getElementById('msg-start-btn').addEventListener('click', () => {
        close();
        if (curOther !== u.id) { nav('messages', { with: u.id }); } else { renderList(); }
      });
    };
    document.getElementById('msg-search-btn').addEventListener('click', doSearch);
    const ti = document.getElementById('msg-target');
    ti.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    ti.focus();
  });
}

/* ---------- 讨论板块 / 文章分类（v2.7.0：全站改为读接口，不再硬编码） ----------
 * 数据源：GET /api/discussion-boards 与 GET /api/article-categories（公开可读，启动时由
 * api.js 的 initStore() 预取一次；这里提供按需刷新）。
 * 板块与分类的 key 是**稳定内部标识**（discussions.board / editorials.category 存的就是它），
 * 显示名由后台「讨论管理 → 板块管理」/「专栏管理 → 分类管理」维护 —— 重命名只改显示名，key 不变，因此已有内容不会失联。
 * 映射不到时（历史数据 / 已被删除的 key）一律**回退显示原始值**，绝不出现 undefined 或空白。 */
let _taxonomyLoadedAt = Date.now(); // 启动时 initStore 已预取，视为刚加载
let _taxonomyLoading = null;
async function loadTaxonomy(force) {
  if (!force && _taxonomyLoadedAt && Date.now() - _taxonomyLoadedAt < 20000
      && ((Store.boards || []).length || (Store.categories || []).length)) return;
  if (_taxonomyLoading) return _taxonomyLoading;
  _taxonomyLoading = (async () => {
    try {
      const [b, c] = await Promise.all([
        api.get('/api/discussion-boards'),
        api.get('/api/article-categories'),
      ]);
      Store.boards = (b && b.items) || [];
      Store.categories = (c && c.items) || [];
      _taxonomyLoadedAt = Date.now();
    } catch { /* 拉取失败：保留上一次数据；首次失败则回退显示原始 key，页面照常渲染 */ }
    finally { _taxonomyLoading = null; }
  })();
  return _taxonomyLoading;
}
function boardList() { return Store.boards || []; }
function categoryList() { return Store.categories || []; }
/* 文章分类的两个**系统 key**（v2.7.0 起内置分类的 key 一律英文 slug，显示名保持中文，
   key 与显示名彻底分离；服务端对应 src/taxonomy.js 的 SOLUTION_CATEGORY / UNCATEGORIZED）：
     · solution      —— 显示名「题解」：必须关联题目，属于题解管理页，专栏管理列表排除它；
     · uncategorized —— 显示名「未分类」：保留值，提交审核时不允许作为分类。
   前端只拿 key 做逻辑判断，展示一律走 categoryLabel(key) → 配置表里的显示名。 */
const CAT_SOLUTION = 'solution';
const CAT_UNCATEGORIZED = 'uncategorized';
/** 板块 key → 显示名（找不到时回退 key 本身） */
function boardLabel(key) {
  const k = String(key == null ? '' : key);
  const b = boardList().find((x) => x.key === k);
  return b ? b.name : k;
}
/** 分类 key → 显示名（找不到时回退 key 本身） */
function categoryLabel(key) {
  const k = String(key == null ? '' : key);
  const c = categoryList().find((x) => x.key === k);
  return c ? c.name : k;
}
/** 板块筛选条 / 下拉用的 [(key, 显示名)]，首项是「全部板块」 */
function boardPairs() {
  return [['', '全部板块'], ...boardList().map((b) => [b.key, b.name])];
}

/* ---------- 讨论（分板块） ---------- */
async function renderDiscussions(query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const page = parseInt(query.get('page') || '1', 10);
  const problem = query.get('problem') || '';
  const board = query.get('board') || '';
  const params = new URLSearchParams({ page: String(page), size: '20' });
  if (problem) params.set('problem', problem);
  if (board) params.set('board', board);
  await loadTaxonomy();
  const data = await api.get('/api/discussions?' + params.toString());
  setPageTitle('讨论区');

  // 题目总版：展示题目编号 + 题目名
  let problemTitle = '';
  if (problem) {
    try {
      const pd = await api.get('/api/problems/' + problem);
      problemTitle = pd.problem.title || '';
    } catch { /* ignore */ }
  }

  const rows = data.items.length === 0
    ? '<tr><td colspan="5" class="empty">暂无讨论</td></tr>'
    : data.items.map((d) => `
      <tr data-id="${d.id}">
        <td>${d.pinned ? '<span class="pinned-badge">置顶</span>' : ''}<a href="#/discussion/${d.id}" target="_blank" rel="noopener">${escapeHtml(d.title)}</a></td>
        <td>${d.problem_id
          ? `<a class="tag" style="font-weight:600" href="#/discussions?problem=${d.problem_id}">#${d.problem_id} ${escapeHtml(d.problem_title || '')}</a>`
          : (d.board ? `<span class="tag" style="color:var(--blue)">${escapeHtml(boardLabel(d.board))}</span>` : '<span class="muted">—</span>')}</td>
        <td>${userSpan({ uid: d.user_id, username: d.username, nickname: d.username })}</td>
        <td class="num">${d.reply_count}</td>
        <td class="num muted">${fmtTime(d.created_at)}</td>
      </tr>`).join('');

  // 板块筛选：题目总版始终为常规板块；进入题目分板块时，顶部额外高亮当前题目的分板块（题号+题名）
  const boardTabs = boardPairs().map(([k, label]) => {
    const isActive = !problem && board === k;
    return `<a class="chip ${isActive ? 'active' : ''}" data-board="${escapeHtml(k)}" data-problem="">${escapeHtml(label)}</a>`;
  }).join('');
  const probChip = problem
    ? `<a class="chip active" data-board="" data-problem="${escapeHtml(problem)}">#${escapeHtml(problem)} ${escapeHtml(problemTitle)}</a>`
    : '';
  // 题目总版：输入题号跳转到该题的讨论板块（板块被后台删除后不再展示入口）
  const probJumpBox = boardList().some((b) => b.key === 'problem') ? `
    <div class="muted" style="font-size:12px;margin-bottom:8px">题目总版：输入题号进入对应题目的讨论</div>
    <div class="row" style="gap:6px">
      <input class="input" id="prob-jump" placeholder="输入题号" style="flex:1;min-width:0" />
      <button class="btn btn-sm" id="prob-jump-btn"><i class="fa-solid fa-arrow-right"></i>进入</button>
    </div>` : '';

  const discOff = Store.features && Store.features.discussion_enabled === false;
  // 侧栏板块说明：文案跟着配置表走（板块可被后台重命名 / 删除），不再写死显示名
  const specialBoards = [
    boardList().some((b) => b.key === 'site') ? `${boardLabel('site')}仅管理员发帖` : '',
    boardList().some((b) => b.key === 'problem') ? `${boardLabel('problem')}帖文不关联具体题目` : '',
  ].filter(Boolean).join('；');
  const boardHint = specialBoards ? `${specialBoards}。板块由超级管理员在后台「讨论管理」页维护。` : '板块由超级管理员在后台「讨论管理」页维护。';
  app.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">讨论区</h1>
      ${problem ? `<span class="tag" style="color:var(--blue);font-weight:600">#${escapeHtml(problem)} ${escapeHtml(problemTitle)}</span>` : ''}
      ${problem ? `<a class="muted" href="#/problem/${escapeHtml(problem)}">← 返回题目</a>` : ''}
      <div class="spacer"></div>
      ${(Store.user && Store.user.can_speak !== false && !discOff) ? '<button class="btn" id="new-post-btn"><i class="fa-solid fa-pen"></i>发布讨论</button>' : ''}
    </div>
    ${discOff ? '<div class="status-banner warn"><span style="font-weight:700"><i class="fa-solid fa-lock"></i> 讨论功能已关闭</span><span class="muted">仅可浏览历史内容</span></div>' : ''}
    <div class="list-layout">
      <div class="list-side">
        <div class="card">
          <h2 class="card-title"><i class="fa-solid fa-layer-group"></i> 板块</h2>
          <div id="board-tabs">${probChip}${boardTabs}</div>
          <hr style="border:none;border-top:1px dashed var(--border);margin:12px 0" />
          ${probJumpBox}
          <p class="muted" style="font-size:12px;margin:10px 0 0;line-height:1.7">${escapeHtml(boardHint)}</p>
        </div>
      </div>
      <div class="list-main">
        <div class="card table-scroll" style="padding:0">
          <table class="table">
            <thead><tr><th>标题</th><th>所属板块</th><th>作者</th><th class="num">回复</th><th class="num">时间</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${renderPagination(data.total, data.page, data.size)}
      </div>
    </div>`;

  bindPagination((p) => nav('discussions', { problem, board, page: p }));
  document.querySelectorAll('#board-tabs .chip').forEach((c) => c.addEventListener('click', () => {
    nav('discussions', { problem: c.dataset.problem || '', board: c.dataset.board, page: 1 });
  }));
  // 题目总版：输入题号跳转
  const probJumpInput = document.getElementById('prob-jump');
  const probJumpBtn = document.getElementById('prob-jump-btn');
  const doProbJump = () => {
    const n = parseInt((probJumpInput.value || '').trim(), 10);
    if (!Number.isFinite(n) || n <= 0) return toast('请输入有效题号', 'error');
    nav('discussions', { problem: String(n), page: 1 });
  };
  if (probJumpBtn) probJumpBtn.addEventListener('click', doProbJump);
  if (probJumpInput) probJumpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doProbJump(); });
  document.querySelectorAll('tbody tr[data-id]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') return;
    window.open('#/discussion/' + tr.dataset.id, '_blank', 'noopener');
  }));
  const newPostBtn = document.getElementById('new-post-btn');
  if (newPostBtn) {
    newPostBtn.addEventListener('click', () => {
      if (!Store.user) return toast('请先登录', 'error');
      showDiscussionEditor(problem, problemTitle);
    });
  }

}
function showDiscussionEditor(problemId, problemTitle) {
  // 板块下拉改为读配置表（v2.7.0）：不再硬编码；站务版仅管理员可选，默认选中「学术版」（不存在则取第一个）
  const boards = boardList().filter((b) => b.key !== 'site' || (Store.user && Store.user.is_admin));
  const defBoard = boards.some((b) => b.key === 'academic') ? 'academic' : ((boards[0] && boards[0].key) || '');
  const boardOptions = problemId
    ? `<option value="problem" selected>#${escapeHtml(problemId)} ${escapeHtml(problemTitle || '')}</option>`
    : (boards.length
      ? boards.map((b) => `<option value="${escapeHtml(b.key)}" ${b.key === defBoard ? 'selected' : ''}>${escapeHtml(b.name)}${b.key === 'site' ? '（仅管理员）' : ''}</option>`).join('')
      : '<option value="">（暂无板块，请联系管理员）</option>');
  app.insertAdjacentHTML('beforeend', `
    <div class="modal-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200;display:flex;align-items:center;justify-content:center">
      <div class="card" style="width:820px;max-width:94vw;max-height:92vh;overflow:auto;margin:0">
        <h2 class="card-title">发布新讨论</h2>
        <div class="form-group"><label>板块</label><select class="input" id="d-board">${boardOptions}</select></div>
        <div class="form-group"><label>标题</label><input class="input" id="d-title" /></div>
        <div class="form-group"><label>内容（支持 Markdown）</label><div class="live-preview"><textarea class="textarea" id="d-content" rows="16" style="min-height:340px"></textarea><div class="live-preview-pane statement" id="pv-dcontent"></div></div></div>
        <div class="row">
          <button class="btn btn-ghost" id="d-cancel"><i class="fa-solid fa-xmark"></i>取消</button>
          <div class="spacer"></div>
          <button class="btn" id="d-submit"><i class="fa-solid fa-paper-plane"></i>发布</button>
        </div>
    </div>
    </div>`);
  const backdrop = document.querySelector('.modal-backdrop');
  bindLivePreview('d-content', 'pv-dcontent');
  document.getElementById('d-cancel').addEventListener('click', () => backdrop.remove());
  document.getElementById('d-submit').addEventListener('click', async () => {
    const title = document.getElementById('d-title').value.trim();
    const content = document.getElementById('d-content').value.trim();
    const board = document.getElementById('d-board').value;
    if (!title || !content) return toast('标题和内容不能为空', 'error');
    try {
      const r = await api.post('/api/discussions', { problem_id: problemId || null, title, content, board });
      toast('发布成功', 'success');
      nav('discussion/' + r.id);
    } catch (e) { toast(e.message, 'error'); }
  });
}

async function renderDiscussionDetail(id, query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const page = parseInt((query && query.get('page')) || '1', 10);
  const data = await api.get(`/api/discussions/${id}?page=${page}&size=10`);
  const d = data.discussion;
  setPageTitle(d.title);

  const replies = d.replies.length === 0
    ? '<div class="empty">暂无回复</div>'
    : d.replies.map((r) => `
      <div class="reply-item">
        <div class="row" style="margin-bottom:4px">
          ${userAvatarHtml({ username: r.username, nickname: r.username, avatar: '' }, 26)}
          ${userSpan({ uid: r.user_id, username: r.username, nickname: r.username })}
          <span class="muted">${fmtTime(r.created_at)}</span>
          <div class="spacer"></div>
          ${(Store.user && (Store.user.is_admin || Store.user.id === r.user_id)) ? `<button class="btn btn-danger btn-sm del-reply" data-id="${r.id}"><i class="fa-solid fa-trash-can"></i>删除</button>` : ''}
        </div>
        <div class="statement">${r.content_html}</div>
      </div>`).join('');

  const replyPages = renderPagination(d.reply_total, d.reply_page, d.reply_size);

  const discSide = `
    <div class="card">
      <h2 class="card-title"><i class="fa-solid fa-circle-info"></i> 讨论信息</h2>
      <div class="info-row"><span class="il">板块</span><span class="iv">${d.problem_id
        ? `<a href="#/discussions?problem=${d.problem_id}">#${d.problem_id} ${escapeHtml(d.problem_title || '')}</a>`
        : `<a href="#/discussions?board=${encodeURIComponent(d.board || '')}">${escapeHtml(boardLabel(d.board) || '综合')}</a>`}</span></div>
      <div class="info-row"><span class="il">作者</span><span class="iv">${userSpan({ uid: d.user_id, username: d.username, nickname: d.username })}</span></div>
      <div class="info-row"><span class="il">发布时间</span><span class="iv">${fmtTime(d.created_at)}</span></div>
      <div class="info-row"><span class="il">回复数</span><span class="iv">${d.reply_total}</span></div>
      ${d.problem_id ? `<div class="info-row"><span class="il">相关题目</span><span class="iv"><a href="#/problem/${d.problem_id}">${escapeHtml(d.problem_title || ('#' + d.problem_id))}</a></span></div>` : ''}
      <div class="info-row" style="border-bottom:none"><span class="il">状态</span><span class="iv">${d.pinned ? '<span class="badge" style="background:#fa8c16;color:#fff">置顶</span>' : '<span class="muted">普通</span>'}</span></div>
    </div>`;

  app.innerHTML = `
    <div class="crumb"><a href="${d.problem_id ? '#/problem/' + d.problem_id : '#/discussions'}"><i class="fa-solid fa-arrow-left"></i> ${d.problem_id ? '返回题目' : '返回讨论区'}</a></div>
    <div class="contest-grid">
      <div class="cg-main">
        <div class="card" style="margin-top:8px">
          <div class="row" style="align-items:baseline">
            <h1 class="page-heading" style="margin:0">${escapeHtml(d.title)}</h1>
            <div class="spacer"></div>
            ${Store.user ? `<button class="btn btn-ghost btn-sm" id="fav-disc-btn" title="收藏本讨论"><i class="fa-${d.is_favorite ? 'solid' : 'regular'} fa-star" style="color:${d.is_favorite ? '#faad14' : ''}"></i>${d.is_favorite ? '已收藏' : '收藏'}</button>` : ''}
            ${(Store.user && hasP('discussion')) ? `<button class="btn btn-ghost btn-sm" id="pin-btn">${d.pinned ? '取消置顶' : '置顶'}</button>` : ''}
            ${(Store.user && (Store.user.is_admin || Store.user.id === d.user_id)) ? `<button class="btn btn-danger btn-sm" id="del-discussion"><i class="fa-solid fa-trash-can"></i>删除讨论</button>` : ''}
          </div>
          <hr style="border:none;border-top:1px solid var(--border);margin:14px 0" />
          <div class="statement">${d.content_html}</div>
        </div>
        <div class="card">
          <h2 class="card-title">回复（${d.reply_total}）</h2>
          ${replies}
          ${replyPages}
          <div class="mt">
            ${(Store.features && Store.features.discussion_enabled === false)
              ? '<div class="empty">讨论功能已关闭，不能回复</div>'
              : Store.user
                ? `<textarea class="textarea" id="reply-content" rows="3" placeholder="写下你的回复…（支持 Markdown）"></textarea>
                   <div class="row mt"><div class="spacer"></div><button class="btn" id="reply-btn"><i class="fa-solid fa-reply"></i>回复</button></div>`
                : '<div class="empty">请先 <a href="#/login">登录</a> 后回复</div>'}
          </div>
        </div>
      </div>
      <div class="cg-side">
        ${discSide}
      </div>
    </div>`;

  bindPagination((p) => nav('discussion/' + id, { page: p }));

  if (Store.user) {
    const rb = document.getElementById('reply-btn');
    if (rb) rb.addEventListener('click', async () => {
      const content = document.getElementById('reply-content').value.trim();
      if (!content) return toast('回复不能为空', 'error');
      try {
        await api.post(`/api/discussions/${d.id}/replies`, { content });
        toast('回复成功', 'success');
        renderDiscussionDetail(id);
      } catch (e) { toast(e.message, 'error'); }
    });
  }
  const dd = document.getElementById('del-discussion');
  if (dd) dd.addEventListener('click', async () => {
    if (!confirm('确定删除该讨论及其所有回复吗？')) return;
    try { await api.del('/api/discussions/' + d.id); toast('已删除', 'success'); nav('discussions'); }
    catch (e) { toast(e.message, 'error'); }
  });
  const favDiscBtn = document.getElementById('fav-disc-btn');
  if (favDiscBtn) favDiscBtn.addEventListener('click', async () => {
    try {
      if (d.is_favorite) {
        await api.del('/api/favorites/discussion/' + d.id);
        toast('已取消收藏', 'info');
      } else {
        await api.post('/api/favorites', { type: 'discussion', id: d.id });
        toast('已收藏', 'success');
      }
      renderDiscussionDetail(id, query);
    } catch (e) { toast(e.message, 'error'); }
  });
  const pb = document.getElementById('pin-btn');
  if (pb) pb.addEventListener('click', async () => {
    try {
      await api.post(`/api/discussions/${d.id}/pin`, { pinned: !d.pinned });
      toast(d.pinned ? '已取消置顶' : '已置顶', 'success');
      renderDiscussionDetail(id);
    } catch (e) { toast(e.message, 'error'); }
  });
  document.querySelectorAll('.del-reply').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确定删除该回复吗？')) return;
    try { await api.del('/api/discussion-replies/' + b.dataset.id); toast('已删除', 'success'); renderDiscussionDetail(id); }
    catch (e) { toast(e.message, 'error'); }
  }));
  // 与文章评论区一致：回复/正文的数学公式统一用 KaTeX 渲染（评论后重渲染同样生效）
  renderMath();
}

/* ---------- 登录 / 注册 ---------- */

/* H3：首登 / 弱口令强制改密提示。
   登录响应与 /api/me 都会带 must_change_password（登录响应另带 password_warning 文案）。
   这里用**固定在页面顶部的横幅**（挂在 body 上，路由切换不会丢失），引导到 编辑资料 → 修改密码；
   改密成功后由 clearPasswordWarning() 清除（同时清掉一次性提示文案，横幅立即消失、不再复活）。 */
const DEFAULT_PWD_WARNING = '检测到当前账号使用弱口令（或由系统初始生成 / 管理员重置），请立即修改为至少 10 位、且包含字母、数字、符号中至少两类的强密码。';
/** 最近一次由服务端下发的一次性改密提示文案；改密成功后必须一起清掉，避免旧文案再次被显示 */
let pwdWarningTextCache = '';
function showPasswordWarning(warning) {
  const old = document.getElementById('pwd-warn-banner');
  if (old) old.remove();
  if (!Store.user || !Store.user.must_change_password) return;
  const text = String(warning || '').trim() || DEFAULT_PWD_WARNING;
  pwdWarningTextCache = text;
  const el = document.createElement('div');
  el.id = 'pwd-warn-banner';
  el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:8px;z-index:9999;max-width:min(92vw,720px);display:flex;gap:10px;align-items:center;background:#fffbe6;color:#874d00;border:1px solid #ffe58f;border-radius:10px;padding:8px 12px;box-shadow:0 6px 20px rgba(0,0,0,.14);font-size:13px;line-height:1.5';
  el.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color:#faad14"></i><span>${escapeHtml(text)}</span>`
    + '<a href="#/edit-profile" style="font-weight:600;white-space:nowrap;color:#874d00;text-decoration:underline">去修改密码</a>'
    + '<button type="button" class="btn btn-ghost btn-sm" id="pwd-warn-close" title="暂时关闭">稍后</button>';
  document.body.appendChild(el);
  const close = el.querySelector('#pwd-warn-close');
  if (close) close.addEventListener('click', () => el.remove());
}
/** 改密成功后清除强制改密提示：移除横幅 + 清掉一次性文案 + 同步本地登录态
 *  （改密成功后调用一次即可让横幅**立即**消失，不需要等重新登录） */
function clearPasswordWarning() {
  const el = document.getElementById('pwd-warn-banner');
  if (el) el.remove();
  pwdWarningTextCache = '';
  if (Store.user) Store.user.must_change_password = false;
}

function renderLogin(query) {
  // 注册 / 邮箱验证完成后跳回登录页时，带上用户名（或邮箱）预填，省得再手输一遍
  const prefill = (query && (query.get('username') || query.get('email'))) || '';
  // 登录后跳回「登录前正在看的页面」：优先显式 ?redirect=，否则用上一页 hash（自动跳过登录/注册等自身页面）
  const rawRedirect = (query && query.get('redirect')) || '';
  const prevHash = (typeof PREV_HASH === 'string' ? PREV_HASH : '') || '';
  const prevPath = prevHash.replace(/^#?\/?/, '').replace(/^\?.*/, '');
  const redirect = (rawRedirect || (/^(login|register|verify|forgot-password|reset|logout)/.test(prevPath) ? '' : prevPath)).trim();
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-icon"><i class="fa-solid fa-right-to-bracket"></i></div>
        <h2 class="auth-title">欢迎回来</h2>
        <p class="auth-sub">登录你的 ${escapeHtml(SITE_NAME)} 账号</p>
        <div class="form-group"><label>用户名 / 邮箱</label><input class="input" id="l-username" placeholder="输入用户名或邮箱" value="${escapeHtml(prefill)}" /></div>
        <div class="form-group"><label>密码</label><input class="input" id="l-password" type="password" placeholder="输入密码" /></div>
        <button class="btn btn-lg" style="width:100%" id="l-submit"><i class="fa-solid fa-right-to-bracket"></i>登录</button>
        <p class="muted" style="text-align:center;margin-top:16px">还没有账号？<a href="#/register">立即注册</a> · <a href="#/forgot-password">忘记密码？</a></p>
      </div>
    </div>`;
  const submit = async () => {
    try {
      const r = await api.post('/api/login', {
        username: document.getElementById('l-username').value.trim(),
        password: document.getElementById('l-password').value,
      });
      Store.user = r.user;
      renderTopbar();
      // H3：首登 / 弱口令 → 顶部横幅要求改密，并展示服务端给出的 password_warning 文案
      showPasswordWarning(r.password_warning);
      toast('登录成功，欢迎 ' + r.user.username, 'success');
      // 回到登录前正在浏览的页面（没有来源页时去首页），不再额外弹跳转提示
      nav(redirect || 'home');
    } catch (e) { toast(e.message, 'error'); }
  };
  document.getElementById('l-submit').addEventListener('click', submit);
  ['l-username', 'l-password'].forEach((id) => document.getElementById(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));
}

function renderRegister() {
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-icon"><i class="fa-solid fa-user-plus"></i></div>
        <h2 class="auth-title">创建账号</h2>
        <p class="auth-sub">加入 ${escapeHtml(SITE_NAME)}，开始你的刷题之旅</p>
        <div class="form-group"><label>用户名（2-20 位字母/数字/下划线/中文）</label><input class="input" id="r-username" placeholder="输入用户名" /></div>
        <div class="form-group"><label>邮箱</label><input class="input" id="r-email" placeholder="用于接收验证码 / 找回密码" /></div>
        <div class="form-group"><label>密码（至少 10 位，且含字母 / 数字 / 符号中至少两类）</label><input class="input" id="r-password" type="password" placeholder="设置一个强密码" /></div>
        <button class="btn btn-lg" style="width:100%" id="r-submit"><i class="fa-solid fa-user-plus"></i>注册</button>
        <p class="muted" style="text-align:center;margin-top:16px">已有账号？<a href="#/login">去登录</a></p>
      </div>
    </div>`;
  const submit = async () => {
    // 提交前先取出三个输入框的值：验证步骤会替换整个页面，之后这些输入框已不存在
    const regName = document.getElementById('r-username').value.trim();
    const regEmail = document.getElementById('r-email').value.trim();
    const regPassword = document.getElementById('r-password').value;
    const btn = document.getElementById('r-submit');
    btn.disabled = true;
    try {
      const r = await api.post('/api/register', {
        username: regName,
        email: regEmail,
        password: regPassword,
      });
      if (r.email_verify_required) {
        // v2.5.0：开启邮箱验证时注册**不会创建账号**，只在服务端留下一条待验证记录；
        // 验证码校验通过后才真正建号。H5：验证码只通过邮件发送，接口与页面都不展示验证码。
        const mailFailed = r.email_sent === false || r.mail_sent === false;
        const emailText = mailFailed
          ? `验证码邮件发送失败${mailReason(r.email_reason)}。完成邮箱验证前不会创建账号，请点击下方「重新发送验证码」重试，或联系管理员处理。`
          : '验证码已发送，请完成邮箱验证后账号才会创建（10 分钟内有效；若未收到请点击下方「重新发送验证码」）。';
        app.innerHTML = `
          <div class="auth-wrap">
          <div class="auth-card">
            <div class="auth-icon"><i class="fa-solid fa-envelope-circle-check"></i></div>
            <h2 class="auth-title">邮箱验证</h2>
            <p class="auth-sub">${escapeHtml(emailText)}</p>
            <div class="form-group mt"><label>输入邮箱中收到的验证码</label><input class="input" id="v-code" placeholder="6 位数字验证码" /></div>
            <button class="btn btn-lg" style="width:100%" id="v-submit"><i class="fa-solid fa-user-check"></i>验证并创建账号</button>
            <p class="muted" style="text-align:center;margin-top:10px"><a href="#" id="v-resend">重新发送验证码</a> · <a href="#/login">返回登录</a></p>
          </div>
          </div>`;
        document.getElementById('v-submit').addEventListener('click', async () => {
          const vb = document.getElementById('v-submit');
          vb.disabled = true;
          try {
            await api.post('/api/verify-email', { code: document.getElementById('v-code').value.trim(), email: regEmail });
            // 验证通过后账号才真正创建，引导用户去登录（不再自动登录）
            toast('账号已创建，请登录', 'success');
            nav('login', { username: regName });
          } catch (e) {
            vb.disabled = false;
            toast(authErrorText(e), 'error');
          }
        });
        const resend = document.getElementById('v-resend');
        if (resend) resend.addEventListener('click', async (ev) => {
          ev.preventDefault();
          try {
            const rr = await api.post('/api/verify-email/resend', { email: regEmail });
            // H5：验证码不再下发，只能提示去邮箱查收；发送失败时给出明确指引
            const failed = rr.email_sent === false || rr.mail_sent === false;
            if (failed) toast(`验证码邮件发送失败${mailReason(rr.email_reason)}，请联系管理员处理`, 'error');
            else toast(rr.message || '验证码已重新发送至邮箱，请查收（旧的验证码已失效）', 'success');
          } catch (e) { toast(authErrorText(e), 'error'); }
        });
        return;
      }
      Store.user = r.user;
      renderTopbar();
      toast('注册成功，欢迎 ' + r.user.username + '（UID ' + r.user.uid + '）', 'success');
      nav('problems');
    } catch (e) {
      btn.disabled = false;
      toast(authErrorText(e), 'error');
    }
  };
  document.getElementById('r-submit').addEventListener('click', submit);
  ['r-username', 'r-email', 'r-password'].forEach((id) => document.getElementById(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));
}

/* ---------- 邮箱验证（注册后未完成验证、或邮件收不到时使用） ---------- */
async function renderVerifyEmail(query) {
  const prefill = (query && query.get('email')) || '';
  setPageTitle('邮箱验证');
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-icon"><i class="fa-solid fa-envelope-circle-check"></i></div>
        <h2 class="auth-title">邮箱验证</h2>
        <p class="auth-sub" id="ve-hint">输入注册邮箱获取验证码；验证码会发送到你的邮箱（10 分钟内有效）。</p>
        <div class="form-group"><label>注册邮箱</label><input class="input" id="ve-email" placeholder="you@example.com" value="${escapeHtml(prefill)}" /></div>
        <div class="form-group"><label>验证码</label><input class="input" id="ve-code" placeholder="6 位数字验证码" /></div>
        <div class="row" style="gap:10px">
          <button class="btn btn-ghost" id="ve-send" style="flex:1"><i class="fa-solid fa-envelope-circle-check"></i>获取验证码</button>
          <button class="btn" id="ve-submit" style="flex:1"><i class="fa-solid fa-check"></i>完成验证</button>
        </div>
        <p class="muted" style="text-align:center;margin-top:16px"><a href="#/login">返回登录</a> · <a href="#/register">重新注册</a></p>
      </div>
    </div>`;
  const emailOf = () => document.getElementById('ve-email').value.trim();
  document.getElementById('ve-send').addEventListener('click', async () => {
    const btn = document.getElementById('ve-send');
    btn.disabled = true; btn.textContent = '发送中…';
    try {
      const r = await api.post('/api/verify-email/resend', { email: emailOf() });
      // H5：接口不再下发验证码 —— 只提示去邮箱查收；发送失败时提示联系管理员。
      // 该邮箱既没有待验证注册、也没有未验证老账号时，服务端只回同一句模糊提示（reason=ignored），
      // 此时既不能说「发送失败」也不能说「已发送」，按中性文案展示，避免泄漏邮箱是否注册。
      const failed = r.email_sent === false && r.reason !== 'ignored';
      if (failed) {
        document.getElementById('ve-hint').textContent = `验证码邮件发送失败${mailReason(r.email_reason)}，请稍后重试或联系管理员。`;
        toast('验证码邮件发送失败，请联系管理员', 'error');
      } else if (r.reason === 'ignored') {
        document.getElementById('ve-hint').textContent = r.message || '如果该邮箱有待验证的注册，验证码已重新发送，请查收邮件（10 分钟内有效）。';
        toast(r.message || '如果该邮箱有待验证的注册，验证码已重新发送，请查收邮件', 'info');
      } else {
        document.getElementById('ve-hint').textContent = '验证码已发送至邮箱，请查收（10 分钟内有效；旧的验证码已失效，未收到可稍后重试或联系管理员）。';
        toast(r.message || '验证码已发送至邮箱', 'success');
      }
    } catch (e) { toast(authErrorText(e), 'error'); }
    btn.disabled = false; btn.textContent = '获取验证码';
  });
  document.getElementById('ve-submit').addEventListener('click', async () => {
    try {
      const r = await api.post('/api/verify-email', { code: document.getElementById('ve-code').value.trim(), email: emailOf() });
      // v2.5.0：验证通过后账号才真正创建（新流程 created=true），引导去登录
      toast(r && r.created ? '账号已创建，请登录' : '邮箱验证成功，请登录', 'success');
      nav('login', { username: (r && r.username) || '' });
    } catch (e) { toast(authErrorText(e), 'error'); }
  });
  ['ve-email', 've-code'].forEach((id) => document.getElementById(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('ve-submit').click(); }));
}

/* ---------- 忘记密码（需开启邮箱验证） ---------- */
async function renderForgotPassword() {
  setPageTitle('忘记密码');
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-icon"><i class="fa-solid fa-key"></i></div>
        <h2 class="auth-title">忘记密码</h2>
        <p class="auth-sub" id="fp-hint">输入注册邮箱，系统将发送找回验证码（需管理员已开启邮箱验证，验证码发送到邮箱，10 分钟内有效）。</p>
        <div class="form-group"><label>注册邮箱</label><input class="input" id="fp-email" placeholder="you@example.com" /></div>
        <div class="form-group"><label>验证码</label><input class="input" id="fp-code" placeholder="6 位数字验证码" /></div>
        <div class="form-group"><label>新密码（至少 ${PWD_MIN_LENGTH} 位，且含字母 / 数字 / 符号中至少两类）</label><input class="input" id="fp-pwd" type="password" autocomplete="new-password" /></div>
        <div id="fp-msg" role="alert" aria-live="polite" style="display:none;font-size:13px;line-height:1.5;margin:0 0 12px;padding:8px 10px;border-radius:8px"></div>
        <div class="row">
          <button class="btn btn-ghost" id="fp-send"><i class="fa-solid fa-paper-plane"></i>发送验证码</button>
          <div class="spacer"></div>
          <button class="btn" id="fp-reset"><i class="fa-solid fa-key"></i>重置密码</button>
        </div>
        <p class="muted" style="text-align:center;margin-top:14px"><a href="#/login">返回登录</a></p>
      </div>
    </div>`;
  /** 重置密码页的内联提示（与「编辑资料 → 修改密码」一致：失败原因常驻显示，不自动消失） */
  const showFpMsg = (message, type) => {
    const box = document.getElementById('fp-msg');
    if (!box) return;
    if (!message) { box.style.display = 'none'; box.textContent = ''; return; }
    const ok = type === 'success';
    box.style.display = 'block';
    box.style.background = ok ? 'rgba(82,196,26,.12)' : 'rgba(255,77,79,.10)';
    box.style.color = ok ? 'var(--green)' : 'var(--red)';
    box.style.border = '1px solid ' + (ok ? 'rgba(82,196,26,.45)' : 'rgba(255,77,79,.45)');
    box.innerHTML = (ok ? '<i class="fa-solid fa-circle-check"></i> ' : '<i class="fa-solid fa-circle-exclamation"></i> ') + escapeHtml(message);
  };
  const fpPwd = document.getElementById('fp-pwd');
  if (fpPwd) fpPwd.addEventListener('input', () => {
    const v = String(fpPwd.value || '');
    if (!v) { showFpMsg(''); return; }
    const err = localPasswordPolicyError(v);
    showFpMsg(err || '✓ 符合密码强度要求', err ? 'error' : 'success');
  });
  const sendBtn = document.getElementById('fp-send');
  sendBtn.addEventListener('click', async () => {
    try {
      const r = await api.post('/api/forgot-password', { email: document.getElementById('fp-email').value.trim() });
      // H5：接口不再下发验证码；L2：邮箱是否注册也不明说（统一文案）
      const failed = r.email_sent === false || r.mail_sent === false;
      document.getElementById('fp-hint').textContent = failed
        ? `验证码邮件发送失败${mailReason(r.email_reason)}，请稍后重试或联系管理员。`
        : '如果该邮箱已注册，找回验证码已发送至邮箱，请查收（10 分钟内有效）。';
      toast(failed ? '验证码邮件发送失败，请联系管理员' : (r.message || '验证码已发送，请查收邮件'), failed ? 'error' : 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
  document.getElementById('fp-reset').addEventListener('click', async () => {
    const email = document.getElementById('fp-email').value.trim();
    const code = document.getElementById('fp-code').value.trim();
    const pw = document.getElementById('fp-pwd').value;
    if (!email) { showFpMsg('请输入注册邮箱', 'error'); return; }
    if (!code) { showFpMsg('请输入邮件里的 6 位验证码（可先点「发送验证码」）', 'error'); return; }
    const localErr = localPasswordPolicyError(pw);
    if (localErr) { showFpMsg(localErr, 'error'); return; }
    const btn = document.getElementById('fp-reset');
    btn.disabled = true;
    try {
      await api.post('/api/forgot-password/reset', { email, code, new_password: pw });
      showFpMsg('密码已重置成功，正在跳转到登录页…', 'success');
      toast('密码已重置，请使用新密码登录', 'success');
      nav('login');
    } catch (e) {
      // 失败原因常驻在表单内（不再只弹 3 秒 toast），已填内容保持不动
      showFpMsg((e && e.message) ? e.message : '重置失败，请稍后重试', 'error');
      toast((e && e.message) ? e.message : '重置失败', 'error');
    } finally { btn.disabled = false; }
  });
}

/* ---------- 反馈 / 举报页 ---------- */
async function renderFeedback(query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  setPageTitle('反馈与举报');
  if (!Store.user) {
    app.innerHTML = '<div class="empty">请先 <a href="#/login">登录</a> 后提交反馈 / 举报</div>';
    return;
  }
  const page = parseInt((query && query.get('page')) || '1', 10);
  // v2.8.3：支持 #/feedback?id=N —— 从「反馈处理结果」站内通知点进来时，只显示那一条并高亮
  const focusId = parseInt((query && query.get('id')) || '', 10);
  const focus = Number.isFinite(focusId) && focusId > 0;
  let mine = { items: [], total: 0, page: 1, size: 20 };
  try { mine = await api.get('/api/feedback?page=' + page + '&size=10' + (focus ? '&id=' + focusId : '')); } catch { /* ignore */ }
  const rows = mine.items.length === 0
    ? '<tr><td colspan="5" class="empty">暂无反馈记录</td></tr>'
    : mine.items.map((f) => `
      <tr${f.id === focusId ? ' style="background:rgba(24,144,255,.10);outline:1px solid var(--blue)"' : ''}>
        <td><span class="badge" style="background:${f.type === 'report' ? '#ff4d4f' : (f.type === 'bug' ? '#fa8c16' : '#1890ff')};color:#fff">${escapeHtml(f.type_label)}</span></td>
        <td style="max-width:320px">${escapeHtml(f.content.slice(0, 80))}${f.content.length > 80 ? '…' : ''}</td>
        <td><span class="badge" style="background:${f.status === 'pending' ? '#fa8c16' : '#52c41a'};color:#fff">${escapeHtml(f.status_label)}</span></td>
        <td class="muted" style="max-width:200px">${f.reply ? escapeHtml(f.reply.slice(0, 60)) : '<span class="muted">—</span>'}</td>
        <td class="num muted">${fmtTime(f.created_at)}</td>
      </tr>`).join('');

  app.innerHTML = `
    <h1 class="page-title">反馈与举报</h1>
    <p class="muted mb">遇到 Bug、有建议，或需要举报违规内容（抄袭、人身攻击、违规信息等）？请填写下面的表单，管理员（超级管理员）审核后会通过本页反馈你的处理结果。</p>
    <div class="card">
      <h2 class="card-title">提交反馈 / 举报</h2>
      <div class="form-group"><label>类型</label>
        <select class="input" id="fb-type" style="width:auto">
          <option value="feedback">反馈</option>
          <option value="bug">Bug 报告</option>
          <option value="suggestion">建议</option>
          <option value="submission">投稿</option>
          <option value="report">举报</option>
        </select>
      </div>
      <div class="form-group"><label>内容（最多 5000 字，支持 Markdown / LaTeX，右侧实时预览；举报请尽量提供链接 / 用户名等线索）</label>
        <div class="live-preview">
          <textarea class="textarea" id="fb-content" rows="6"></textarea>
          <div class="live-preview-pane statement" id="fb-preview"></div>
        </div>
      </div>
      <button class="btn" id="fb-submit"><i class="fa-solid fa-paper-plane"></i>提交</button>
    </div>
    <div class="card">
      <h2 class="card-title">我的反馈记录</h2>
      ${focus ? '<p class="muted mb" id="fb-focus-tip">正在查看处理结果通知对应的反馈（已高亮）· <a href="#/feedback">查看我的全部反馈记录</a></p>' : ''}
      <div class="table-scroll"><table class="table">
        <thead><tr><th>类型</th><th>内容</th><th>状态</th><th>处理回复</th><th class="num">时间</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${focus ? '' : renderPagination(mine.total, mine.page, mine.size)}
    </div>`;
  bindPagination((p) => nav('feedback', { page: p }));
  bindLivePreview('fb-content', 'fb-preview');
  document.getElementById('fb-submit').addEventListener('click', async () => {
    const type = document.getElementById('fb-type').value;
    const content = document.getElementById('fb-content').value.trim();
    if (!content) return toast('内容不能为空', 'error');
    try {
      await api.post('/api/feedback', { type, content });
      toast('已提交，感谢你的反馈！', 'success');
      renderFeedback(query);
    } catch (e) { toast(e.message, 'error'); }
  });
}

/* ---------- 管理后台 ---------- */
async function renderAdminList() {
  app.innerHTML = '<div class="loading">加载中…</div>';
  if (!Store.user || !Store.user.is_admin) {
    app.innerHTML = '<div class="empty">需要管理员权限</div>';
    return;
  }
  const q = parseHash().query;
  const search = q.get('search') || '';
  const tagSet = new Set((q.get('tag') || '').split(',').map((s) => s.trim()).filter(Boolean));
  const sourceSet = new Set((q.get('source') || '').split(',').map((s) => s.trim()).filter(Boolean));
  const tag = Array.from(tagSet).join(',');
  const source = Array.from(sourceSet).join(',');
  const difficulty = q.get('difficulty') || '';
  const page = parseInt(q.get('page') || '1', 10);
  const params = new URLSearchParams({ page: String(page), size: '20', all: '1', sort: 'id_desc' });
  if (search) params.set('search', search);
  if (tag) params.set('tag', tag);
  if (source) params.set('source', source);
  if (difficulty) params.set('difficulty', difficulty);
  const data = await api.get('/api/problems?' + params.toString());
  // 后台题目管理默认倒序：题号从大到小（新题在最上面）
  const adminItems = (data.items || []).slice().sort((a, b) => b.id - a.id);
  const rows = adminItems.length === 0
    ? '<tr><td colspan="7" class="empty" style="text-align:center;padding:48px 0">暂无题目</td></tr>'
    : adminItems.map((p) => `
      <tr>
        <td><input type="checkbox" class="ap-pick" value="${p.id}" title="选中后可批量导出" /></td>
        <td>#${p.id}</td>
        <td><a href="#/problem/${p.id}">${escapeHtml(p.title)}</a>${p.is_public ? '' : ' <span class="tag" style="color:var(--red)">隐藏</span>'}${p.output_only ? ' <span class="tag" style="color:var(--pink,#eb2f96)">提交答案</span>' : ''}${p.spj ? ' <span class="tag" style="color:var(--purple,#8e44ad)">SPJ</span>' : ''}</td>
        <td><span class="badge diff" style="background:${p.difficulty_color}">${escapeHtml(p.difficulty_label)}</span></td>
        <td class="num">${p.accepted_count}/${p.submit_count}</td>
        <td>
          <a class="btn btn-ghost btn-sm" href="#/admin/problem/${p.id}"><i class="fa-solid fa-pen"></i>编辑</a>
          <a class="btn btn-ghost btn-sm" href="/api/problems/${p.id}/export" download title="导出该题（import.json + 测试数据 + checker）"><i class="fa-solid fa-file-export"></i>导出</a>
          ${Store.user && Store.user.is_superadmin ? `<a class="btn btn-ghost btn-sm" href="#/admin/rejudge?problem=${p.id}" title="重判该题目的全部提交"><i class="fa-solid fa-rotate-right"></i>重判</a>` : ''}
          <button class="btn btn-danger btn-sm" data-del="${p.id}"><i class="fa-solid fa-trash-can"></i>删除</button>
        </td>
      </tr>`).join('');

  const diffOptions = ['<option value="">全部难度</option>']
    .concat(Store.difficulties.map((d) => `<option value="${d.level}" ${difficulty === String(d.level) ? 'selected' : ''}>${escapeHtml(d.label)}</option>`))
    .join('');

  app.innerHTML = `${adminTabs('problems')}
    ${adminHead({
      title: '题目管理',
      actions: `<a class="btn btn-ghost btn-sm" href="/docs/USAGE.md#二管理员题目数据配置重点" target="_blank" rel="noopener"><i class="fa-solid fa-book"></i>使用说明</a>
        <a class="btn btn-ghost" href="#/admin/problem/import"><i class="fa-solid fa-file-import"></i>导入题目</a>
        <a class="btn" href="#/admin/problem/new"><i class="fa-solid fa-plus"></i>新建题目</a>`,
      filter: `<div class="filter-bar filter-grid">
        <input class="input" id="ap-search" placeholder="搜索题目名称或标签…" value="${escapeHtml(search)}" list="ap-tag-suggest" style="flex:0 0 200px" />
        <datalist id="ap-tag-suggest">${Store.tags.map((t) => `<option value="${escapeHtml(t)}">`).join('')}</datalist>
        <select class="input" id="ap-diff" style="width:auto">${diffOptions}</select>
        <button class="btn btn-ghost" id="ap-filter-btn" type="button"><i class="fa-solid fa-sliders"></i>标签 / 来源筛选 ${(tagSet.size || sourceSet.size) ? `（${tagSet.size + sourceSet.size} 项）` : ''}</button>
        <button class="btn" id="ap-search-btn"><i class="fa-solid fa-magnifying-glass"></i>搜索</button>
      </div>`,
    })}
    <div class="card table-scroll" style="padding:0;margin-top:16px">
      <table class="table">
        <thead><tr><th style="width:34px"><input type="checkbox" id="ap-pick-all" title="选中本页全部题目" /></th><th>ID</th><th>标题</th><th>难度</th><th class="num">通过/提交</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="row" style="margin-top:12px;gap:8px;align-items:center;flex-wrap:wrap">
      <span class="muted" id="ap-pick-info" style="font-size:12px">未选中题目</span>
      <div class="spacer"></div>
      <button class="btn btn-ghost btn-sm" id="ap-export-picked" disabled><i class="fa-solid fa-file-export"></i>导出所选</button>
      <button class="btn btn-ghost btn-sm" id="ap-export-filtered"><i class="fa-solid fa-filter"></i>导出当前筛选结果</button>
      <a class="btn btn-ghost btn-sm" href="/api/problems/export/all" download><i class="fa-solid fa-box-archive"></i>导出全部题目</a>
      <button class="btn btn-ghost btn-sm" id="ap-export-json"><i class="fa-solid fa-code"></i>导出清单 JSON</button>
    </div>
    <div class="muted" style="font-size:12px;margin-top:6px">
      导出包为标准 ZIP：<code>import.json</code>（题目清单，含测试数据与子任务分数）+ <code>data/&lt;题号&gt;/</code>（各题测试数据与 checker），
      可直接在「导入题目」页整体还原（支持跨站点迁移）。「导出当前筛选结果」会导出下方筛选条件下的全部题目（不受分页限制）。
    </div>
    ${renderPagination(data.total, data.page, data.size)}`;

  bindPagination((p) => nav('admin', { search, tag, source, difficulty, page: p }));

  /* ---------------- 批量导出 ---------------- */
  const pickedIds = () => [...document.querySelectorAll('.ap-pick:checked')].map((el) => el.value);
  const syncPickInfo = () => {
    const n = pickedIds().length;
    const info = document.getElementById('ap-pick-info');
    const btn = document.getElementById('ap-export-picked');
    if (info) info.textContent = n ? `已选中 ${n} 道题目` : '未选中题目';
    if (btn) btn.disabled = n === 0;
    const all = document.getElementById('ap-pick-all');
    const boxes = [...document.querySelectorAll('.ap-pick')];
    if (all) all.checked = boxes.length > 0 && boxes.every((b) => b.checked);
  };
  document.querySelectorAll('.ap-pick').forEach((el) => el.addEventListener('change', syncPickInfo));
  const pickAll = document.getElementById('ap-pick-all');
  if (pickAll) pickAll.addEventListener('change', () => {
    document.querySelectorAll('.ap-pick').forEach((el) => { el.checked = pickAll.checked; });
    syncPickInfo();
  });
  syncPickInfo();

  /** 触发浏览器下载（ZIP 需要携带登录 Cookie，因此用同源链接点击） */
  const downloadUrl = (url, filename) => {
    const a = document.createElement('a');
    a.href = url;
    if (filename) a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const exportBtn = document.getElementById('ap-export-picked');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    const ids = pickedIds();
    if (!ids.length) return toast('请先勾选要导出的题目', 'error');
    downloadUrl('/api/problems/export?ids=' + ids.join(','));
    toast(`正在导出 ${ids.length} 道题目…`, 'success');
  });

  // 导出当前筛选条件下的全部题目（先查询总数与题号，再一次性打包）
  const filteredBtn = document.getElementById('ap-export-filtered');
  if (filteredBtn) filteredBtn.addEventListener('click', async () => {
    filteredBtn.disabled = true;
    try {
      const all = new URLSearchParams({ page: '1', size: '500', all: '1' });
      if (search) all.set('search', search);
      if (tag) all.set('tag', tag);
      if (source) all.set('source', source);
      if (difficulty) all.set('difficulty', difficulty);
      const res = await api.get('/api/problems?' + all.toString());
      const ids = (res.items || []).map((p) => p.id);
      if (!ids.length) { toast('当前筛选条件下没有题目', 'error'); return; }
      downloadUrl('/api/problems/export?ids=' + ids.join(','));
      toast(`正在导出 ${ids.length} 道题目…` + (res.total > ids.length ? `（共 ${res.total} 道，已导出前 ${ids.length} 道）` : ''), 'success');
    } catch (e) {
      toast('导出失败：' + e.message, 'error');
    } finally {
      filteredBtn.disabled = false;
    }
  });

  // 只导出题目清单（JSON，测试数据内联）：由服务端把 ZIP 里的 import.json 单独输出
  const jsonBtn = document.getElementById('ap-export-json');
  if (jsonBtn) jsonBtn.addEventListener('click', async () => {
    jsonBtn.disabled = true;
    try {
      const all = new URLSearchParams({ page: '1', size: '500', all: '1' });
      if (search) all.set('search', search);
      if (tag) all.set('tag', tag);
      if (source) all.set('source', source);
      if (difficulty) all.set('difficulty', difficulty);
      const res = await api.get('/api/problems?' + all.toString());
      const ids = (res.items || []).map((p) => p.id);
      if (!ids.length) { toast('当前没有可导出的题目', 'error'); return; }
      downloadUrl('/api/problems/export/json?ids=' + ids.join(','));
      toast(`正在导出清单 JSON（${ids.length} 题）…`, 'success');
    } finally {
      jsonBtn.disabled = false;
    }
  });

  const doFilter = () => nav('admin', {
    search: document.getElementById('ap-search').value.trim(),
    tag,
    source,
    difficulty: document.getElementById('ap-diff').value,
    page: 1,
  });
  document.getElementById('ap-search-btn').addEventListener('click', doFilter);
  document.getElementById('ap-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') doFilter(); });
  // 标签/来源筛选弹窗（与题库一致：两部分多选）
  document.getElementById('ap-filter-btn').addEventListener('click', () => {
    if (document.getElementById('ap-filter-modal')) return;
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.id = 'ap-filter-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200;display:flex;align-items:center;justify-content:center';
    const selTags = new Set(tagSet), selSrcs = new Set(sourceSet);
    const srcChipsHtml = (Store.sources && Store.sources.length)
      ? Store.sources.map((s) => `<span class="chip ${selSrcs.has(s) ? 'active' : ''}" data-source="${escapeHtml(s)}">${escapeHtml(s)}</span>`).join('')
      : '<div class="empty" style="padding:4px 0">暂无来源标签</div>';
    const tagChipsHtml = Store.tags.length
      ? Store.tags.map((t) => `<span class="chip ${selTags.has(t) ? 'active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('')
      : '<div class="empty" style="padding:4px 0">暂无算法标签</div>';
    modal.innerHTML = `<div class="card" style="width:560px;max-width:92vw;margin:0">
      <div class="row" style="align-items:baseline"><h2 class="card-title" style="margin:0 8px 0 0">标签 / 来源筛选</h2><span class="muted">可多选</span><div class="spacer"></div><button class="btn btn-ghost btn-sm" id="ap-filter-close"><i class="fa-solid fa-xmark"></i>关闭</button></div>
      <div style="margin:8px 0 4px;font-weight:600;color:var(--accent)"><i class="fa-solid fa-globe"></i> 来源</div>
      <div class="tag-chips">${srcChipsHtml}</div>
      <div style="margin:14px 0 4px;font-weight:600;color:var(--accent)"><i class="fa-solid fa-tags"></i> 算法</div>
      <div class="tag-chips">${tagChipsHtml}</div>
      <div class="row mt">
        <button class="btn btn-ghost btn-sm" id="ap-filter-clear" type="button"><i class="fa-solid fa-eraser"></i>清除全部</button>
        <div class="spacer"></div>
        <button class="btn" id="ap-filter-apply" type="button"><i class="fa-solid fa-filter"></i>应用筛选</button>
      </div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll('.chip[data-tag]').forEach((c) => c.addEventListener('click', () => {
      const t = c.dataset.tag;
      if (selTags.has(t)) selTags.delete(t); else selTags.add(t);
      c.classList.toggle('active');
    }));
    modal.querySelectorAll('.chip[data-source]').forEach((c) => c.addEventListener('click', () => {
      const s = c.dataset.source;
      if (selSrcs.has(s)) selSrcs.delete(s); else selSrcs.add(s);
      c.classList.toggle('active');
    }));
    document.getElementById('ap-filter-close').addEventListener('click', () => modal.remove());
    document.getElementById('ap-filter-apply').addEventListener('click', () => {
      modal.remove();
      nav('admin', { search, tag: Array.from(selTags).join(','), source: Array.from(selSrcs).join(','), difficulty, page: 1 });
    });
    document.getElementById('ap-filter-clear').addEventListener('click', () => {
      modal.remove();
      nav('admin', { search, tag: '', source: '', difficulty, page: 1 });
    });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  });

  document.querySelectorAll('button[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确定删除该题目吗？\n将同时删除该题的测试数据、附件与全部提交记录，此操作不可恢复。')) return;
    try {
      await api.del('/api/problems/' + b.dataset.del);
      toast('已删除', 'success');
      renderAdminList();
    } catch (e) { toast(e.message, 'error'); }
  }));
}

/* ---------- 题目导入（JSON / ZIP） ---------- */
async function renderAdminProblemImport() {
  setPageTitle('导入题目');
  if (!Store.user || !hasP('problem')) {
    app.innerHTML = `${adminTabs('problems')}<div class="empty">需要「题目管理」权限</div>`;
    return;
  }
  const example = {
    title: '示例题：A+B',
    background: '这是一道用于演示的题目背景（可以写故事、引子等，留空则不显示）。',
    description: '# 题目描述\n\n输入两个整数 $a,b$，输出它们的和。',
    input_format: '一行两个整数 $a,b$（$|a|,|b|\\le 10^9$）。',
    output_format: '一行一个整数，表示 $a+b$。',
    samples: [{ input: '1 2', output: '3' }],
    hint: '注意读入两个数。',
    tags: ['入门', '数学'],
    source: '导入',
    difficulty: 1,
    time_limit_ms: 1000,
    memory_limit_mb: 128,
    is_public: true,
    testcases: [{ input: '1 2\n', output: '3\n', subtask: 0 }, { input: '-10 20\n', output: '10\n', subtask: 0 }],
    subtask_scores: [100],
    subtask_types: ['sum'],
  };

  app.innerHTML = `${adminTabs('problems')}
    ${adminHead({
      title: '导入题目',
      desc: '单题与批量使用同一个入口：支持 <b>JSON</b>（单个题目对象或题目数组，可粘贴或上传）与 <b>ZIP</b> 导入包（含本站「导出所选 / 导出全部题目」生成的包）。导入前会先做一次只解析不写入的<b>预检</b>，并可按「跳过 / 覆盖 / 允许重复」处理同名题目。',
      actions: `<a class="btn btn-ghost" href="#/admin"><i class="fa-solid fa-arrow-left"></i>返回题目管理</a>`,
    })}

    <div class="card" style="margin-top:12px">
      <h2 class="card-title">1. 选择文件</h2>
      <div class="row" style="gap:12px;flex-wrap:wrap;align-items:center">
        <input type="file" id="imp-file" accept=".json,.zip,application/json,application/zip" class="input" style="flex:0 0 auto" />
        <button class="btn btn-ghost btn-sm" id="imp-sample-json"><i class="fa-solid fa-file-code"></i>填入示例 JSON</button>
        <button class="btn btn-ghost btn-sm" id="imp-download-json"><i class="fa-solid fa-download"></i>下载 JSON 模板</button>
        <label class="row" style="gap:6px;align-items:center;font-size:13px">
          同名题目：
          <select class="input" id="imp-conflict" style="width:auto">
            <option value="skip" selected>跳过（推荐，重复导入同一份包不会产生重复题）</option>
            <option value="overwrite">覆盖（更新题面并覆盖测试数据）</option>
            <option value="duplicate">允许重复（同标题再建一道）</option>
          </select>
        </label>
      </div>
      <div id="imp-preview" style="margin-top:12px"></div>
      <div class="muted" style="font-size:12px;margin-top:8px">
        JSON 也可以直接粘贴在下面；ZIP 包请在根目录放 <code>import.json</code>（清单），每个题目用 <code>dir</code> 指定数据目录，目录内放 <code>1.in / 1.out / 2.in / 2.out …</code>，需要特判时放 <code>checker.cpp</code>。
        <b>本站「导出所选 / 导出全部题目」生成的 ZIP 可直接在这里整体导入</b>，无需手工整理结构。
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="row" style="align-items:baseline">
        <h2 class="card-title" style="margin:0">2. 粘贴 JSON（与文件二选一）</h2>
        <div class="spacer"></div>
        <span class="muted" id="imp-len" style="font-size:12px"></span>
      </div>
      <textarea class="textarea" id="imp-json" rows="14" spellcheck="false" placeholder='[{"title": "...", "description": "...", "testcases": [{"input": "1 2\n", "output": "3\n"}]}]' style="width:100%;font-family:Consolas,Monaco,monospace;font-size:12.5px;margin-top:8px"></textarea>
      <details style="margin-top:10px">
        <summary style="cursor:pointer;font-size:13px">字段说明 / ZIP 包结构</summary>
        <div class="statement" style="margin-top:8px;font-size:13px">
          <p><b>题目字段</b>：<code>title</code>（必填）、<code>description</code>、<code>input_format</code>、<code>output_format</code>、<code>samples</code>、<code>hint</code>、<code>tags</code>、<code>source</code>、<code>difficulty</code>（0~7）、<code>time_limit_ms</code>、<code>memory_limit_mb</code>、<code>is_public</code>、<code>spj</code>、<code>output_only</code>、<code>enable_o2</code>。</p>
          <p><b>测试数据</b>：<code>testcases: [{"input": "...", "output": "...", "subtask": 0}]</code>；子任务分数/计分方式用 <code>subtask_scores: [30,70]</code> 与 <code>subtask_types: ["sum","bundle"]</code>。</p>
          <p><b>Special Judge</b>：<code>spj: true</code> 并在 <code>checker</code> 里放 checker 源码（读入 in/out/ans 三个文件）。</p>
          <p><b>ZIP 包</b>：<code>import.json</code> 里每个题目写 <code>"dir": "p1"</code>，包内 <code>p1/1.in</code>、<code>p1/1.out</code>、<code>p1/checker.cpp</code>。</p>
        </div>
      </details>
    </div>

    <div class="row" style="margin-top:12px;gap:10px">
      <button class="btn btn-lg" id="imp-run"><i class="fa-solid fa-file-import"></i>开始导入</button>
      <a class="btn btn-ghost btn-lg" href="/api/problems/export/all" download><i class="fa-solid fa-file-export"></i>导出全部题目（ZIP）</a>
      <span class="muted" id="imp-status"></span>
    </div>
    <div class="muted" style="font-size:12px;margin-top:8px">
      「导出全部题目」会把整个题库打包成一个 ZIP：<code>import.json</code>（题目清单，含测试数据与子任务分数）+ <code>data/&lt;题号&gt;/</code>（各题测试数据与 checker）。
      单道题目的导出在「题目编辑器」里（导出题目 / 迁移题号）。
    </div>
    <div id="imp-result" style="margin-top:12px"></div>`;

  const $ = (id) => document.getElementById(id);
  const updateLen = () => {
    const v = $('imp-json').value.trim();
    $('imp-len').textContent = v ? `${v.length} 字符` : '';
  };
  $('imp-json').addEventListener('input', updateLen);
  $('imp-sample-json').addEventListener('click', () => {
    $('imp-json').value = JSON.stringify([example], null, 2);
    $('imp-file').value = '';
    updateLen();
  });
  $('imp-download-json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify([example], null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'problems-template.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  // 选择文件后自动区分 JSON / ZIP，并立即做一次「导入预检」（只解析、不写入）
  let pickedFile = null;
  const buildPayload = async () => {
    const jsonText = $('imp-json').value.trim();
    if (pickedFile && /\.zip$/i.test(pickedFile.name)) return { zip_base64: await fileToBase64(pickedFile) };
    if (jsonText) {
      const parsed = JSON.parse(jsonText);
      return { problems: Array.isArray(parsed) ? parsed : (Array.isArray(parsed.problems) ? parsed.problems : [parsed]) };
    }
    return null;
  };

  const runPreview = async () => {
    const box = $('imp-preview');
    let payload;
    try { payload = await buildPayload(); } catch (e) { box.innerHTML = `<div class="status-banner warn"><span>JSON 格式错误：${escapeHtml(e.message)}</span></div>`; return; }
    if (!payload) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="muted" style="font-size:13px">正在预检导入内容…</div>';
    try {
      const p = await api.post('/api/problems/import/preview', payload);
      const items = p.items || [];
      const rows = items.map((it) => it.error
        ? `<tr><td class="num">${it.index + 1}</td><td colspan="4" style="color:var(--red)">${escapeHtml(it.error)}</td><td class="num">—</td></tr>`
        : `<tr>
            <td class="num">${it.index + 1}</td>
            <td>${escapeHtml(it.title)}</td>
            <td class="num">${it.testcases}</td>
            <td>${[it.spj ? 'SPJ' : '', it.output_only ? '提交答案题' : '', it.is_public ? '' : '隐藏'].filter(Boolean).join(' ') || '传统题'}</td>
            <td>${it.exists ? `<span class="tag" style="color:var(--orange);border-color:var(--orange)">同名 #${it.existing_id}</span>` : '<span class="tag" style="color:var(--green);border-color:var(--green)">新题</span>'}</td>
            <td><a class="btn btn-ghost btn-sm" href="#/admin/problem/${it.existing_id || ''}">${it.exists ? '查看' : ''}</a></td>
          </tr>`).join('');
      box.innerHTML = `<div class="card" style="padding:0">
        <div class="row" style="padding:10px 12px;align-items:baseline;gap:10px">
          <b>导入预检</b>
          <span class="muted" style="font-size:12px">共 ${p.total} 题（新题 ${p.new_count}、同名 ${p.conflict_count}、异常 ${p.error_count}），测试点合计 ${p.testcases}</span>
        </div>
        <div class="table-scroll"><table class="table">
          <thead><tr><th class="num">#</th><th>标题</th><th class="num">测试点</th><th>类型</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`;
      if (p.conflict_count) {
        box.insertAdjacentHTML('beforeend', `<div class="muted" style="font-size:12px;margin-top:6px">其中 ${p.conflict_count} 道题目与题库中已有题目同名，将按上方选择的「同名题目」策略处理。</div>`);
      }
    } catch (e) {
      box.innerHTML = `<div class="status-banner warn"><span>预检失败：${escapeHtml(e.message)}</span></div>`;
    }
  };

  $('imp-file').addEventListener('change', () => {
    pickedFile = $('imp-file').files[0] || null;
    if (!pickedFile) return;
    if (/\.json$/i.test(pickedFile.name)) {
      const reader = new FileReader();
      reader.onload = () => {
        $('imp-json').value = String(reader.result).slice(0, 4 * 1024 * 1024);
        updateLen();
        runPreview();
      };
      reader.readAsText(pickedFile);
      $('imp-status').textContent = '已读取 JSON 文件：' + pickedFile.name;
    } else {
      $('imp-status').textContent = '已选择 ZIP 包：' + pickedFile.name + `（${fmtBytes(pickedFile.size)}）`;
      runPreview();
    }
  });

  $('imp-run').addEventListener('click', async () => {
    const btn = $('imp-run');
    const status = $('imp-status');
    const payload = { on_conflict: $('imp-conflict').value };
    const jsonText = $('imp-json').value.trim();
    if (pickedFile && /\.zip$/i.test(pickedFile.name)) {
      status.textContent = '读取压缩包…';
      payload.zip_base64 = await fileToBase64(pickedFile);
    } else if (jsonText) {
      try {
        const parsed = JSON.parse(jsonText);
        payload.problems = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.problems) ? parsed.problems : [parsed]);
      } catch (e) {
        toast('JSON 格式错误：' + e.message, 'error');
        return;
      }
    } else {
      toast('请选择 .json / .zip 文件，或粘贴 JSON 内容', 'error');
      return;
    }
    btn.disabled = true;
    status.textContent = '导入中…（题目较多或数据较大时需要一点时间）';
    try {
      const r = await api.post('/api/problems/import', payload);
      const created = r.created || [];
      const skipped = r.skipped || [];
      const errors = r.errors || [];
      let html = '';
      if (created.length) {
        html += `<div class="card"><h2 class="card-title">导入成功（${created.length} 题）</h2>
          <table class="table"><thead><tr><th>ID</th><th>标题</th><th class="num">测试点</th><th>方式</th><th>操作</th></tr></thead><tbody>
          ${created.map((c) => `<tr><td><span class="muted mono">#${c.id}</span></td><td><a href="#/problem/${c.id}" target="_blank" rel="noopener">${escapeHtml(c.title)}</a></td><td class="num">${c.testcases}</td><td>${c.overwritten ? '<span class="tag" style="color:var(--orange);border-color:var(--orange)">覆盖</span>' : '新建'}</td><td><a class="btn btn-ghost btn-sm" href="#/admin/problem/${c.id}"><i class="fa-solid fa-pen"></i>编辑</a></td></tr>`).join('')}
          </tbody></table></div>`;
      }
      if (skipped.length) {
        html += `<div class="card"><h2 class="card-title">跳过同名题目（${skipped.length} 题）</h2>
          <div class="muted" style="font-size:12px;margin-bottom:6px">题库中已存在同名题目；如需更新它们，请把「同名题目」改为「覆盖」后重新导入。</div>
          <table class="table"><thead><tr><th>ID</th><th>标题</th><th>操作</th></tr></thead><tbody>
          ${skipped.map((s) => `<tr><td><span class="muted mono">#${s.id}</span></td><td><a href="#/problem/${s.id}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a></td><td><a class="btn btn-ghost btn-sm" href="#/admin/problem/${s.id}"><i class="fa-solid fa-pen"></i>编辑</a></td></tr>`).join('')}
          </tbody></table></div>`;
      }
      if (errors.length) {
        html += `<div class="card"><h2 class="card-title" style="color:var(--red)">失败 ${errors.length} 条</h2>
          <ul class="statement" style="font-size:13px">${errors.map((e) => `<li>${escapeHtml(e.title ? e.title + '：' : '')}${escapeHtml(e.error)}</li>`).join('')}</ul></div>`;
      }
      $('imp-result').innerHTML = html || '<div class="empty">没有导入任何题目</div>';
      status.textContent = `完成：成功 ${created.length} 题，跳过 ${skipped.length} 题，失败 ${errors.length} 条`;
      toast(created.length ? `已导入 ${created.length} 道题目` : (skipped.length ? '全部为同名题目，已跳过' : '没有题目被导入'), created.length ? 'success' : 'error');
      // 新题可能带来新的标签/来源，刷新一下本地缓存
      try { await initStore(); } catch { /* ignore */ }
      runPreview();
    } catch (e) {
      status.textContent = '导入失败：' + e.message;
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

async function renderAdminProblemEditor(id) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  setPageTitle(id ? '编辑题目' : '新建题目');
  if (!Store.user || !Store.user.is_admin) {
    app.innerHTML = '<div class="empty">需要管理员权限</div>';
    return;
  }

  let problem = null;
  let testcases = [];
  let subtaskScores = [];
  let subtaskTypes = [];
  let checkerContent = '';
  let checkerExists = false;
  if (id) {
    const data = await api.get('/api/problems/' + id);
    problem = data.problem;
    const tdata = await api.get(`/api/problems/${id}/testcases`);
    testcases = tdata.testcases || [];
    subtaskScores = tdata.subtask_scores || [];
    subtaskTypes = tdata.subtask_types || [];
    try {
      const cdata = await api.get(`/api/problems/${id}/checker`);
      checkerContent = cdata.content || '';
      checkerExists = !!cdata.content;
    } catch (e) { checkerContent = ''; checkerExists = false; }
  }

  const diffOptions = Store.difficulties.map((d) =>
    `<option value="${d.level}" ${problem && problem.difficulty === d.level ? 'selected' : ''}>${escapeHtml(d.label)}</option>`).join('');

  /* ---------------- 题目类型与交互题 / 通信题配套文件 ----------------
   * 题目类型共 5 种：standard 普通题 / output_only 提交答案题 / interactive_io IO 交互题 /
   * interactive_func 函数式交互题 / communication 通信题（两个选手程序合作，独立题型）。
   * （旧版单独的「提交答案题」开关已合并进类型下拉，避免两个控件互相矛盾）。
   * 契约：GET /api/problems/:id 在管理端返回 problem_type、output_only、interactive_hint、
   * interactor_source、grader_source、interactive_headers（[{name, content}]）、
   * pipe_mode / prog1_output_limit_bytes / duplex（通信题的题目侧开关，存在 testdata/<题号>/meta.json）；
   * POST /api/problems 与 PUT /api/problems/:id 接受同名字段（problem_type 为准，output_only 由类型推导）。
   * 旧接口未返回 problem_type 时按 output_only 布尔兜底，页面不报错。
   */
  const rawPType = String((problem && problem.problem_type) || '');
  const problemType = (rawPType === 'output_only' || rawPType === 'interactive_io' || rawPType === 'interactive_func' || rawPType === 'communication')
    ? rawPType
    : ((problem && problem.output_only) ? 'output_only' : 'standard');
  /** 通信题（两个选手程序合作）：题目目录放 N.in / N.out，可选 grader.cpp 中转、checker.cpp SPJ */
  const isCommType = problemType === 'communication';
  let interactorContent = (problem && problem.interactor_source) || '';
  let graderContent = (problem && problem.grader_source) || '';
  let interactiveHeaders = Array.isArray(problem && problem.interactive_headers)
    ? problem.interactive_headers.map((h) => ({ name: String((h && h.name) || ''), content: String((h && h.content) || '') }))
    : [];
  /** 交互题配套源码（单个文件）大小上限，与后端一致（200KB） */
  const INTERACTIVE_SRC_MAX = 200 * 1024;

  const headerRowHtml = (h, i) => `
    <div class="hdr-row" data-i="${i}" style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px">
      <div class="row" style="margin-bottom:8px;gap:8px;align-items:center;flex-wrap:wrap">
        <label class="muted" style="margin:0">名称 <input class="input hdr-name" value="${escapeHtml(h.name || '')}" placeholder="如 problem.h" style="width:220px;display:inline-block" /></label>
        <div class="spacer"></div>
        <button type="button" class="btn btn-ghost btn-sm hdr-file"><i class="fa-solid fa-folder-open"></i>选择文件</button>
        <button type="button" class="btn btn-ghost btn-sm hdr-del"><i class="fa-solid fa-trash-can"></i>删除</button>
      </div>
      <textarea class="textarea mono hdr-content" rows="8" spellcheck="false" placeholder="// 头文件内容：选手与 grader 都可以 #include 这个文件">${escapeHtml(h.content || '')}</textarea>
    </div>`;
  const headersHtml = interactiveHeaders.map(headerRowHtml).join('');

  // 下拉文案：传统题 / 提交答案题 / 交互题 · IO / 交互题 · 函数式 / 通信题（两程序）。
  // 注：函数式交互题历史上曾被叫成「通信题」——两者是**同一个类型**（存库值都是 interactive_func）；
  // 本轮的「通信题」是**独立的第三种题型**（存库值 communication，需要两个选手程序合作），
  // 因此这里把函数式交互改回它自己的名字，避免两个含义不同的题型在后台共用同一个名字。
  const typeOptions = [
    { v: 'standard', label: '传统题' },
    { v: 'output_only', label: '提交答案题' },
    { v: 'interactive_io', label: '交互题 · IO' },
    { v: 'interactive_func', label: '交互题 · 函数式' },
    { v: 'communication', label: '通信题（两程序）' },
  ].map((t) => `<option value="${t.v}" ${problemType === t.v ? 'selected' : ''}>${t.label}</option>`).join('');
  const itrStatus = id ? (problem && problem.has_interactor ? '✓ 已找到 interactor.cpp' : '（未找到 interactor.cpp）') : '';
  const grdStatus = id ? (problem && problem.has_grader ? '✓ 已找到 grader.cpp' : '（未找到 grader.cpp）') : '';

  const samples = problem ? (problem.samples || []) : [{ input: '', output: '' }];
  const samplesHtml = samples.map((s, i) => `
    <div class="sample-row" data-i="${i}" style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px">
      <div class="row" style="margin-bottom:8px"><strong>样例 ${i + 1}</strong><div class="spacer"></div><button class="btn btn-ghost btn-sm del-sample" type="button"><i class="fa-solid fa-trash-can"></i>删除</button></div>
      <div class="tc-editor">
        <div><label class="muted">输入</label><textarea class="textarea mono" data-k="input">${escapeHtml(s.input || '')}</textarea></div>
        <div><label class="muted">输出</label><textarea class="textarea mono" data-k="output">${escapeHtml(s.output || '')}</textarea></div>
      </div>
    </div>`).join('');

  const fmtSize = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');
  // 测试点输入/输出渲染：数据过大时不预览，仅显示提示并标记保留标志（data-keep-*）
  const tcField = (t, k, label) => {
    const truncated = k === 'input' ? t.input_truncated : t.output_truncated;
    const size = k === 'input' ? t.input_size : t.output_size;
    const val = truncated ? '' : (k === 'input' ? t.input : t.output);
    const notice = truncated
      ? `<div class="muted" style="color:var(--orange);font-size:12px;margin-bottom:4px"><i class="fa-solid fa-triangle-exclamation"></i> 数据过大（${fmtSize(size)}），不在页面预览；保存时自动保留服务器上的完整数据</div>`
      : '';
    return `<div>
      <div class="row" style="justify-content:space-between;margin-bottom:4px"><label class="muted">${label}</label><button type="button" class="btn btn-ghost btn-sm tc-file-btn" data-k="${k}"><i class="fa-solid fa-folder-open"></i>选择文件</button></div>
      ${notice}
      <textarea class="textarea mono" data-k="${k}" ${truncated ? 'readonly title="数据过大，已设为只读（评测仍使用完整数据；需要修改请点上方「选择文件」或重新上传测试数据）" placeholder="数据过大，未预览（评测仍使用完整数据）"' : ''}>${escapeHtml(val || '')}</textarea>
    </div>`;
  };
  /**
   * v2.5.3 点级限额输入框：每个测试点可单独设置「时限 (ms)」「内存 (MB)」。
   * 留空 = 继承题目级限额（服务端存 null），占位符显示继承到的值（如「继承 1000」）。
   */
  const caseLimitInput = (cls, value, inherit) => {
    const v = (value != null && value !== '') ? value : '';
    return `<input class="input ${cls}" type="number" min="1" step="1" value="${v}" placeholder="继承 ${inherit}" title="留空则继承题目级限额（${inherit}）" style="width:96px;padding:4px 6px" />`;
  };
  // 占位符里显示的「继承到的值」＝题目级限额（新建题目尚无题目行时用与表单一致的默认值）
  const inheritTl = (problem && problem.time_limit_ms != null) ? problem.time_limit_ms : 1000;
  const inheritMem = (problem && problem.memory_limit_mb != null) ? problem.memory_limit_mb : 256;
  const tcHtml = testcases.map((t, i) => `
    <div class="tc-row" data-i="${i}" data-orig="${t.id}" data-keep-input="${t.input_truncated ? '1' : '0'}" data-keep-output="${t.output_truncated ? '1' : '0'}" style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px">
      <div class="row" style="margin-bottom:8px;gap:12px;align-items:center"><strong>测试点 ${i + 1}</strong><label class="muted" style="margin:0">子任务编号 <input class="input tc-subtask" type="number" min="0" value="${t.subtask != null ? t.subtask : 0}" style="width:70px;padding:4px 6px" /></label><label class="muted" style="margin:0">时限 (ms) ${caseLimitInput('tc-tl', t.time_limit_ms, inheritTl)}</label><label class="muted" style="margin:0">内存 (MB) ${caseLimitInput('tc-mem', t.memory_limit_mb, inheritMem)}</label><div class="spacer"></div><button class="btn btn-ghost btn-sm del-tc" type="button"><i class="fa-solid fa-trash-can"></i>删除</button></div>
      <div class="tc-editor">
        ${tcField(t, 'input', '输入 (.in)')}
        ${tcField(t, 'output', '输出 (.out)')}
      </div>
    </div>`).join('');

  // 返回按钮：新建保存后沿用首次进入时的来源（题库页 →「返回题目」，后台 →「返回管理后台」），
  // 避免保存跳转编辑页后被中间页覆盖成错误的来源。
  // 来源为题库页时，「返回题目」指向该题目详情页（新建题保存后指向刚创建的题目）。
  const srcSeg = (PREV_HASH || '').replace(/^#\//, '').split('/').filter(Boolean)[0];
  let backHrefVal = backHref('#/admin');
  let backLabelVal = backLabel('返回题目管理');
  if (problemEditorBack) {
    backHrefVal = problemEditorBack.href;
    backLabelVal = problemEditorBack.label;
  } else {
    if (srcSeg === 'problems') {
      // 题库来源：返回该题目详情页；新建题（id 为空）先指向题库，保存后再改为刚创建的题目
      backHrefVal = id ? `#/problem/${encodeURIComponent(String(id))}` : '#/problems';
      backLabelVal = '返回题目';
    } else if (srcSeg === 'admin') {
      backHrefVal = '#/admin';
      backLabelVal = '返回管理后台';
    } else if (srcSeg === 'problem') {
      backHrefVal = backHref('#/admin');
      backLabelVal = '返回题目';
    }
    if (!id) problemEditorBack = { href: backHrefVal, label: backLabelVal, fromProblems: srcSeg === 'problems' };
  }

  app.innerHTML = `
    ${adminHead({
      title: id ? '编辑题目' : '新建题目',
      actions: `<a class="btn btn-ghost" href="${backHrefVal}"><i class="fa-solid fa-arrow-left"></i> ${backLabelVal}</a>`,
    })}

    <div class="card card-basic-info">
      <h2 class="card-title">基本信息</h2>
      <div class="form-group fg-title"><label>标题 *</label><input class="input" id="f-title" value="${problem ? escapeHtml(problem.title) : ''}" /></div>
      <div class="bi-fields">
        <div class="form-group"><label>题目类型</label><select class="input" id="f-ptype">${typeOptions}</select></div>
        <div class="form-group"><label>难度</label><select class="input" id="f-difficulty">${diffOptions}</select></div>
        <div class="form-group"><label>时间限制 (ms)</label><input class="input" id="f-time" type="number" value="${problem ? problem.time_limit_ms : 1000}" /></div>
        <div class="form-group"><label>内存限制 (MB)</label><input class="input" id="f-mem" type="number" value="${problem ? problem.memory_limit_mb : 256}" /></div>
        <div class="form-group"><label>算法标签</label><input class="input" id="f-tags" value="${problem ? escapeHtml((problem.tags || []).join(', ')) : ''}" placeholder="逗号分隔，如 数学,字符串,搜索" /></div>
        <div class="form-group"><label>来源标签</label><input class="input" id="f-source" value="${problem ? escapeHtml(problem.source || '') : ''}" placeholder="如 洛谷 / Codeforces / 原创" /></div>
      </div>
      <div class="muted" id="ptype-hint" style="font-size:12px;line-height:1.6;margin:10px 0 0"></div>
      <div class="bi-switches">
        <div class="form-group fg-switch">
          <label class="switch"><input type="checkbox" id="f-o2" ${(!problem || problem.enable_o2 !== false) ? 'checked' : ''} /><span class="slider"></span><span class="switch-label">开启 O2 优化</span></label>
          <div class="muted sw-hint">选手提交时还能再单独勾选</div>
        </div>
        <div class="form-group fg-switch">
          <label class="switch"><input type="checkbox" id="f-spj" ${(problem && problem.spj) ? 'checked' : ''} /><span class="slider"></span><span class="switch-label">使用 Special Judge（SPJ）</span></label>
          <div class="muted sw-hint">五种题型共用；checker 在下方「测试数据」中编辑</div>
        </div>
        <div class="form-group fg-switch">
          <label class="switch"><input type="checkbox" id="f-public" ${(!problem || problem.is_public) ? 'checked' : ''} /><span class="slider"></span><span class="switch-label">公开可见</span></label>
          <div class="muted sw-hint">关闭后只有管理员能看到这道题</div>
        </div>
        <div class="form-group fg-switch">
          <label class="switch"><input type="checkbox" id="f-score" ${(!problem || problem.show_score !== false) ? 'checked' : ''} /><span class="slider"></span><span class="switch-label">显示分数（OI）</span></label>
          <div class="muted sw-hint">关闭则按 ACM 制只显示通过与否</div>
        </div>
        <div class="form-group fg-switch">
          <label class="switch"><input type="checkbox" id="f-ed-closed" ${(problem && problem.editorial_closed) ? 'checked' : ''} /><span class="slider"></span><span class="switch-label">关闭题解提交</span></label>
          <div class="muted sw-hint">关闭后选手不能再提交本题题解</div>
        </div>
      </div>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">题面（Markdown）</h2>
      <div class="form-group"><label>题目背景（左侧输入，右侧实时预览；留空则不显示该区块）</label><div class="live-preview"><textarea class="textarea mono" id="f-bg" rows="3">${problem ? escapeHtml(problem.background || '') : ''}</textarea><div class="live-preview-pane statement" id="pv-bg"></div></div></div>
      <div class="form-group"><label>题目描述（左侧输入，右侧实时预览）</label><div class="live-preview"><textarea class="textarea mono" id="f-desc" rows="6">${problem ? escapeHtml(problem.description || '') : ''}</textarea><div class="live-preview-pane statement" id="pv-desc"></div></div></div>
      <div class="form-group"><label>输入格式</label><div class="live-preview"><textarea class="textarea mono" id="f-infmt" rows="3">${problem ? escapeHtml(problem.input_format || '') : ''}</textarea><div class="live-preview-pane statement" id="pv-infmt"></div></div></div>
      <div class="form-group"><label>输出格式</label><div class="live-preview"><textarea class="textarea mono" id="f-outfmt" rows="3">${problem ? escapeHtml(problem.output_format || '') : ''}</textarea><div class="live-preview-pane statement" id="pv-outfmt"></div></div></div>
      <div class="form-group"><label>提示</label><div class="live-preview"><textarea class="textarea mono" id="f-hint" rows="3">${problem ? escapeHtml(problem.hint || '') : ''}</textarea><div class="live-preview-pane statement" id="pv-hint"></div></div></div>
      <div class="form-group">
        <label>样例</label>
        <div id="samples-container">${samplesHtml || ''}</div>
        <button class="btn btn-ghost btn-sm" id="add-sample" type="button"><i class="fa-solid fa-plus"></i>添加样例</button>
      </div>
      <div class="row">
        <button class="btn btn-lg" id="save-problem"><i class="fa-solid fa-floppy-disk"></i>保存题目信息</button>
        ${problem ? `
        <a class="btn btn-ghost btn-lg" id="export-problem" href="/api/problems/${problem.id}/export" download><i class="fa-solid fa-file-export"></i>导出题目</a>
        <button class="btn btn-ghost btn-lg" id="migrate-problem" type="button"><i class="fa-solid fa-right-left"></i>迁移题号</button>` : ''}
      </div>
      ${problem ? `<p class="muted" style="font-size:12px;margin-top:8px">
        <strong>导出题目</strong>：下载该题的 ZIP（import.json + 测试数据 + checker），可用「题目导入」在其它站点或本机还原；导入页的「导出全部题目」可整库导出。
        <strong>迁移题号</strong>：把该题整体搬到新的题号下（提交记录、题解、讨论、收藏、比赛关联与测试数据都会一起迁移）。
      </p>` : ''}
    </div>

    <div class="card" id="interactive-card" style="display:${problemType === 'standard' ? 'none' : 'block'}">
      <h2 class="card-title">${isCommType ? '通信题配置' : '交互题配置'} <a class="btn btn-ghost btn-sm" href="/docs/INTERACTIVE.md" target="_blank" rel="noopener"><i class="fa-solid fa-book"></i>配置说明</a> <a class="btn btn-ghost btn-sm" href="/docs/USAGE.md#15-通信题两个选手程序合作" target="_blank" rel="noopener"><i class="fa-solid fa-book"></i>通信题说明</a></h2>
      <p class="muted" style="font-size:12px">以下内容随「保存题目信息」一并保存，写入题目数据目录 <code>data/testdata/&lt;题号&gt;/</code>：交互器 <code>interactor.cpp</code>、grader <code>grader.cpp</code>、头文件 <code>&lt;名称&gt;.h</code>。清空文本框后保存即删除对应文件。</p>
      ${isCommType ? `<div class="status-banner blue" style="margin-bottom:12px">
        <span style="font-weight:700"><i class="fa-solid fa-people-arrows"></i> 通信题（两个选手程序合作）</span>
        <span class="muted">题目侧只需准备逐测试点数据 <code>N.in</code> / <code>N.out</code>（3~5 个即可），另可选放：<code>grader.cpp</code>（<b>评测端中转程序</b>：读取程序一的输出、按需处理后作为程序二的输入）与 <code>checker.cpp</code>（SPJ，勾选上方开关后在本页下方编辑）。选手提交时填两个程序；连接方式在下方「测试数据」卡片里选择 <code>relay</code>（评测端中转，默认）或 <code>direct</code>（双向管道直连，两程序并行边跑边传）。</span>
      </div>` : ''}

      <div id="itr-wrap" style="display:${problemType === 'interactive_io' ? 'block' : 'none'};margin-bottom:14px">
        <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;flex-wrap:wrap">
          <label class="muted"><i class="fa-solid fa-code"></i> 交互器源码（interactor.cpp）<span id="itr-status" class="muted" style="font-size:12px">${itrStatus ? '  ' + itrStatus : ''}</span></label>
          <button type="button" class="btn btn-ghost btn-sm" id="itr-file"><i class="fa-solid fa-folder-open"></i>选择 interactor.cpp 文件</button>
        </div>
        <input type="file" id="itr-file-input" accept=".cpp,.cc,.cxx,.c,.h,.txt" style="display:none" />
        <textarea class="textarea mono" id="f-interactor" rows="12" spellcheck="false" placeholder="// IO 交互题的交互器（testlib 风格）&#10;// 评测机以 interactor <测试输入文件> <交互器输出文件> 启动：argv[1] 读隐藏数据，argv[2] 是写入选手最终答案的文件（开启 SPJ 时 checker 会读它）&#10;// 用 stdout 向选手提问、从 stdin 读选手回答，以退出码给结论（0=AC、1=WA、2=WA(格式)、3=判题失败、4=WA、7=部分分）">${escapeHtml(interactorContent)}</textarea>
        <div class="muted" style="font-size:12px;margin-top:4px">评测时自动编译（testlib 已内置，可直接 <code>#include "testlib.h"</code>）；参数为 <code>argv[1]</code> 测试输入文件、<code>argv[2]</code> 交互器输出文件。</div>
      </div>

      <div id="grd-wrap" style="display:${(problemType === 'interactive_func' || isCommType) ? 'block' : 'none'};margin-bottom:14px">
        <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;flex-wrap:wrap">
          <label class="muted"><i class="fa-solid fa-code"></i> ${isCommType ? '评测端中转程序（grader.cpp，可选）' : 'grader 源码（grader.cpp）'}<span id="grd-status" class="muted" style="font-size:12px">${grdStatus ? '  ' + grdStatus : ''}</span></label>
          <button type="button" class="btn btn-ghost btn-sm" id="grd-file"><i class="fa-solid fa-folder-open"></i>选择 grader.cpp 文件</button>
        </div>
        <input type="file" id="grd-file-input" accept=".cpp,.cc,.cxx,.c,.h,.txt" style="display:none" />
        <textarea class="textarea mono" id="f-grader" rows="12" spellcheck="false" placeholder="${isCommType
          ? '// 通信题的评测端中转程序（可选，自带 main()）：read 程序一的输出（stdin）→ 按需处理 → 写程序二的输入（stdout）&#10;// 评测机以  grader &lt; 程序一输出文件 &gt; 程序二输入文件  的方式运行它（即 stdin → stdout 的过滤器）&#10;// 退出码 0 = 处理成功；非 0 = 程序一的输出未通过校验（判 WA 并回传你的结论）；不要做耗时操作'
          : '// 函数式交互题的 grader（自带 main()）&#10;// 评测时与选手提交一起编译链接后运行，以退出码 0 判 AC（非 0 通常按 WA 处理）'}">${escapeHtml(graderContent)}</textarea>
        <div class="muted" style="font-size:12px;margin-top:4px">${isCommType
          ? '留空 = 不中转（评测端把程序一的 stdout <b>原封不动</b>作为程序二的 stdin）。'
          : 'grader 需自带 <code>main()</code>，并与选手代码一起编译链接；选手提交只实现题面指定的函数。'}</div>
      </div>

      <div id="header-wrap" style="display:${problemType === 'standard' ? 'none' : 'block'};margin-bottom:14px">
        <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;flex-wrap:wrap">
          <label class="muted"><i class="fa-solid fa-file-code"></i> 头文件（${isCommType ? '中转程序 grader.cpp 可 #include 的公共头文件' : '函数式交互题的公共接口'}；可增删多个）</label>
          <button class="btn btn-ghost btn-sm" id="add-header" type="button"><i class="fa-solid fa-plus"></i>添加头文件</button>
        </div>
        <div id="headers-container">${headersHtml || `<div class="muted" style="font-size:12px">暂未添加头文件；${isCommType ? '通信题通常不需要头文件（除非 grader.cpp 要用）' : '函数式交互题通常需要一个声明接口（如 <code>problem.h</code>）'}。</div>`}</div>
      </div>

      <div id="ihint-wrap" style="display:${problemType === 'standard' || problemType === 'output_only' ? 'none' : 'block'}">
        <div class="form-group"><label>${isCommType ? '通信说明' : '交互说明'}（展示在题目页「${isCommType ? '通信说明' : '交互说明'}」区块；左侧输入，右侧实时预览）</label><div class="live-preview"><textarea class="textarea mono" id="f-ihint" rows="6">${escapeHtml((problem && problem.interactive_hint) || '')}</textarea><div class="live-preview-pane statement" id="pv-ihint"></div></div></div>
      </div>

      <div id="spj-itr-note" class="muted" style="display:none;font-size:12px;line-height:1.8;margin-top:4px;border:1px dashed var(--border);border-radius:8px;padding:8px 10px">
        <b>已开启 Special Judge（开关在页面顶部「基本信息」区）</b><br />
        <b>交互题 · IO</b>：交互器需要把选手的最终答案写入 <code>argv[2]</code> 指定的文件；交互结束后由 checker 校验 <code>&lt;输入文件&gt; &lt;交互器输出文件&gt; &lt;答案文件&gt;</code>（即 in / ouf / ans）。<br />
        <b>交互题 · 函数式</b>：由 grader 程序的标准输出作为 <code>ouf</code> 交给 checker。<br />
        <b>通信题</b>：由<b>程序二</b>的标准输出作为 <code>ouf</code> 交给 checker（in 仍是题目的 <code>N.in</code>，ans 是 <code>N.out</code>）。<br />
        checker 源码就在顶部同一个开关下方编辑 / 上传，五种题目类型共用同一份 <code>checker.cpp</code>。
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">测试数据 <a class="btn btn-ghost btn-sm" href="/docs/USAGE.md#二管理员题目数据配置重点" target="_blank" rel="noopener"><i class="fa-solid fa-book"></i>使用说明</a></h2>
      <div class="row mb" style="gap:8px;align-items:center">
        <button class="btn btn-ghost" id="zip-upload-btn" type="button"><i class="fa-solid fa-file-zipper"></i>上传 ZIP 测试数据包</button>
        <input type="file" id="zip-file-input" accept=".zip" style="display:none" />
        <label class="switch" style="margin-left:4px"><input type="checkbox" id="zip-overwrite" checked /><span class="slider"></span><span class="switch-label">覆盖当前数据<span class="muted">勾选：整体替换；取消勾选：合并（同编号覆盖、新编号追加，其余保留）</span></span></label>
      </div>
      <p class="muted">ZIP 内需含 1.in/1.out、2.in/2.out …（支持 .ans、可含子目录）。<strong>默认覆盖</strong>现有测试数据；取消「覆盖当前数据」后上传，新数据将与现有数据合并（同名编号被替换，未涉及的测试点保留）。</p>
      <p class="muted">每个测试点包含一个输入文件（.in）和一个期望输出文件（.out），也可点击「选择文件」逐个上传。同一「子任务编号」的测试点为一组，计分方式见下方。详细说明见<a href="/docs/USAGE.md#二管理员题目数据配置重点" target="_blank" rel="noopener">使用说明</a>。</p>
      ${isCommType ? `<div class="comm-config" id="comm-config">
        <div class="row" style="gap:14px;align-items:center;flex-wrap:wrap">
          <label class="muted" style="margin:0;font-weight:600"><i class="fa-solid fa-plug"></i> 通信题连接方式（pipe_mode）</label>
          <select class="input" id="f-pipemode" style="width:auto">
            <option value="relay" ${(problem && problem.pipe_mode !== 'direct') ? 'selected' : ''}>relay —— 评测端中转（默认）</option>
            <option value="direct" ${(problem && problem.pipe_mode === 'direct') ? 'selected' : ''}>direct —— 双向管道直连（两程序并行）</option>
          </select>
          <label class="muted" style="margin:0">程序一输出上限（字节，0 = 不限）<input class="input" id="f-prog1limit" type="number" min="0" step="1" value="${(problem && problem.prog1_output_limit_bytes) || 0}" style="width:140px;display:inline-block;padding:4px 6px" /></label>
          <label class="switch" style="margin-left:4px" title="仅 direct 模式有效：把程序二的 stdout 回传给程序一的 stdin（双向对话式合作）"><input type="checkbox" id="f-duplex" ${(problem && problem.duplex) ? 'checked' : ''} /><span class="slider"></span><span class="switch-label">duplex（direct 下回传程序二输出）</span></label>
        </div>
        <div class="muted" style="font-size:12px;line-height:1.7">
          <b>relay（评测端中转，默认）</b>：先用 <code>N.in</code> 跑<b>程序一</b> → 收下它的 stdout；若题目提供了 <code>grader.cpp</code> 就用它把程序一的输出处理成程序二的输入 → 再跑<b>程序二</b> → 比较程序二的 stdout 与 <code>N.out</code>（或交给 checker）。两个程序各自受时限 / 内存约束。<br />
          <b>direct（双向管道直连）</b>：把程序一的 stdout 直接接到程序二的 stdin，两者<b>并行运行、边跑边传</b>（不跑 grader）；勾选 duplex 后再把程序二的输出回传给程序一。<br />
          这两项随「保存测试数据」写入 <code>data/testdata/&lt;题号&gt;/meta.json</code>（键名 <code>pipe_mode</code> / <code>prog1_output_limit_bytes</code> / <code>duplex</code>），反复保存不会被重置。
        </div>
      </div>` : ''}
      <div id="spj-hint" class="muted" style="font-size:12px;display:${(problem && problem.spj) ? 'block' : 'none'};margin-top:-6px;margin-bottom:12px">Special Judge：在测试数据 ZIP 包内放置 <code>checker.cpp</code>（testlib 风格，评测机已内置 testlib.h，无需随包上传），上传后自动编译；checker 参数顺序为 in / ouf / ans，退出码 0=AC、1=WA、2=格式错误（按 WA）、3=checker 异常；checker 输出中的数值（0~1 或 1~100）作为部分分比例。<b>交互题开 SPJ 时</b>：交互题 · IO 由交互器把选手最终答案写入 <code>argv[2]</code> 的文件作为 <code>ouf</code>，交互题 · 函数式由 grader 的标准输出作为 <code>ouf</code>。</div>
      <div id="spj-checker-wrap" class="spj-checker-wrap" style="display:${(problem && problem.spj) ? 'block' : 'none'};margin-bottom:6px">
        <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;flex-wrap:wrap">
          <label class="muted"><i class="fa-solid fa-code"></i> checker.cpp 内容（Special Judge 配置）<span id="ck-status" class="muted" style="font-size:12px"></span></label>
          <span style="display:flex;gap:6px">
            <button type="button" class="btn btn-ghost btn-sm" id="ck-file"><i class="fa-solid fa-folder-open"></i>选择 checker.cpp 文件</button>
            <button type="button" class="btn btn-ghost btn-sm" id="ck-reload"><i class="fa-solid fa-rotate"></i>重新加载</button>
          </span>
        </div>
        <input type="file" id="ck-file-input" accept=".cpp,.cc,.h,.txt" style="display:none" />
        <textarea class="textarea mono" id="f-checker" rows="12" spellcheck="false" placeholder="// 在此直接编写或修改 checker.cpp（testlib 风格）&#10;// 也可以点击「选择 checker.cpp 文件」载入本地文件，或在上传测试数据 ZIP 时一并带上 checker.cpp&#10;// 五种题目类型（普通题 / 提交答案 / 交互题 · IO / 交互题 · 函数式 / 通信题）共用这一份 checker.cpp">${escapeHtml(checkerContent)}</textarea>
        <div class="row mt" style="gap:8px">
          <button class="btn btn-sm" id="ck-save" type="button"><i class="fa-solid fa-floppy-disk"></i>保存 checker.cpp</button>
          <span class="muted" style="font-size:12px;align-self:center">保存后评测时自动编译生效；评测机内置 testlib.h，可直接 <code>#include "testlib.h"</code>；如需删除 checker，清空后保存即可。</span>
        </div>
      </div>
      <div class="row" style="gap:16px">
        <div class="form-group" style="flex:1"><label>子任务分数（逗号分隔，如 30,70；留空则平均分配共 100 分）</label><input class="input" id="tc-subtask-scores" value="${subtaskScores.join(',')}" placeholder="留空平均分配" /></div>
        <div class="form-group" style="flex:1"><label>子任务计分方式（逗号分隔，顺序对应子任务）</label><input class="input" id="tc-subtask-types" value="${subtaskTypes.join(',')}" placeholder="bundle（捆绑：全对才得分）" />
          <div class="muted" style="font-size:12px;margin-top:2px">sum=加和 · min=最小值 · max=最大值 · bundle=捆绑（全对才得分）；<b>只有一个子任务时默认为 sum</b>，详见<a href="/docs/USAGE.md#6-子任务计分方式sum-min-max-bundle" target="_blank" rel="noopener">使用说明</a></div>
        </div>
      </div>
      <div id="tc-container">${tcHtml || '<div class="empty">暂无测试数据</div>'}</div>
      <button class="btn btn-ghost btn-sm" id="add-tc" type="button"><i class="fa-solid fa-plus"></i>添加测试点</button>
      <div class="row mt">
        <button class="btn btn-lg" id="save-tc" ${id ? '' : 'disabled'}><i class="fa-solid fa-floppy-disk"></i>保存测试数据</button>
        ${id ? '' : '<span class="muted">请先保存题目信息以获取题目 ID</span>'}
      </div>
    </div>

    <div class="card att-admin-card">
      <div class="row" style="align-items:baseline;margin-bottom:10px">
        <h2 class="card-title" style="margin:0"><i class="fa-solid fa-paperclip"></i> 题目附件</h2>
        <div class="spacer"></div>
        <span class="muted" style="font-size:12px">单个文件上限 20MB · 附件与测试数据分开存放</span>
      </div>
      <div id="att-drop" class="att-drop">
        <i class="fa-solid fa-cloud-arrow-up"></i>
        <div class="att-drop-main">点击选择文件，或把文件拖到这里上传</div>
        <div class="muted" style="font-size:12px">支持多选；上传后用户可在题目页「附件下载」中获取</div>
        <input type="file" id="att-file-input" multiple style="display:none" />
        ${id ? '' : '<div class="muted" style="font-size:12px;margin-top:6px;color:var(--orange)">请先保存题目信息以获取题目 ID 后再上传附件</div>'}
      </div>
      <div id="att-list" class="att-list att-list-admin"></div>
    </div>`;

  // 样例增删
  document.getElementById('add-sample').addEventListener('click', () => {
    const host = document.getElementById('samples-container');
    const i = host.querySelectorAll('.sample-row').length;
    host.insertAdjacentHTML('beforeend', `
      <div class="sample-row" data-i="${i}" style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px">
        <div class="row" style="margin-bottom:8px"><strong>样例 ${i + 1}</strong><div class="spacer"></div><button class="btn btn-ghost btn-sm del-sample" type="button"><i class="fa-solid fa-trash-can"></i>删除</button></div>
        <div class="tc-editor">
          <div><label class="muted">输入</label><textarea class="textarea mono" data-k="input"></textarea></div>
          <div><label class="muted">输出</label><textarea class="textarea mono" data-k="output"></textarea></div>
        </div>
      </div>`);
    bindRemove('.del-sample', '.sample-row');
  });
  document.getElementById('add-tc').addEventListener('click', () => {
    const host = document.getElementById('tc-container');
    const empty = host.querySelector('.empty');
    if (empty) empty.remove();
    const i = host.querySelectorAll('.tc-row').length;
    // 新行的「继承」占位符跟随当前表单里的题目级限额（用户可能刚改过基本信息还没保存）
    const curTlInput = document.getElementById('f-time');
    const curMemInput = document.getElementById('f-mem');
    const curTl = (curTlInput && curTlInput.value !== '') ? curTlInput.value : 1000;
    const curMem = (curMemInput && curMemInput.value !== '') ? curMemInput.value : 256;
    host.insertAdjacentHTML('beforeend', `
      <div class="tc-row" data-i="${i}" data-orig="" data-keep-input="0" data-keep-output="0" style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px">
        <div class="row" style="margin-bottom:8px;gap:12px;align-items:center"><strong>测试点 ${i + 1}</strong><label class="muted" style="margin:0">子任务编号 <input class="input tc-subtask" type="number" min="0" value="0" style="width:70px;padding:4px 6px" /></label><label class="muted" style="margin:0">时限 (ms) ${caseLimitInput('tc-tl', '', curTl)}</label><label class="muted" style="margin:0">内存 (MB) ${caseLimitInput('tc-mem', '', curMem)}</label><div class="spacer"></div><button class="btn btn-ghost btn-sm del-tc" type="button"><i class="fa-solid fa-trash-can"></i>删除</button></div>
        <div class="tc-editor">
          <div>
            <div class="row" style="justify-content:space-between;margin-bottom:4px"><label class="muted">输入 (.in)</label><button type="button" class="btn btn-ghost btn-sm tc-file-btn" data-k="input"><i class="fa-solid fa-folder-open"></i>选择文件</button></div>
            <textarea class="textarea mono" data-k="input"></textarea>
          </div>
          <div>
            <div class="row" style="justify-content:space-between;margin-bottom:4px"><label class="muted">输出 (.out)</label><button type="button" class="btn btn-ghost btn-sm tc-file-btn" data-k="output"><i class="fa-solid fa-folder-open"></i>选择文件</button></div>
            <textarea class="textarea mono" data-k="output"></textarea>
          </div>
        </div>
      </div>`);
    bindRemove('.del-tc', '.tc-row');
    bindTcFiles();
  });
  bindRemove('.del-sample', '.sample-row');
  bindRemove('.del-tc', '.tc-row');
  bindTcFiles();
  // 题面 Markdown/LaTeX 实时预览
  bindLivePreview('f-bg', 'pv-bg');
  bindLivePreview('f-desc', 'pv-desc');
  bindLivePreview('f-infmt', 'pv-infmt');
  bindLivePreview('f-outfmt', 'pv-outfmt');
  bindLivePreview('f-hint', 'pv-hint');

  /* ---------------- 题目类型切换：交互题控件 + SPJ 开关 / checker 编辑器显隐 ---------------- */
  const ptypeSel = document.getElementById('f-ptype');
  const ptypeHint = document.getElementById('ptype-hint');
  const itrWrap = document.getElementById('itr-wrap');
  const grdWrap = document.getElementById('grd-wrap');
  const hdrWrap = document.getElementById('header-wrap');
  const ihintWrap = document.getElementById('ihint-wrap');
  const interactiveCard = document.getElementById('interactive-card');
  const spjItrNote = document.getElementById('spj-itr-note');
  const spjCb = document.getElementById('f-spj');
  const spjCheckerWrap = document.getElementById('spj-checker-wrap');
  const spjHintEl = document.getElementById('spj-hint');
  const PTYPE_HINT = {
    standard: '传统题：选手读入数据、写出答案，逐测试点与标准输出比对。',
    output_only: '提交答案：用户上传答案文件（或 ZIP）评测，不写代码；评测按测试点与标准答案比对（勾选 SPJ 时由 checker 判定）。',
    interactive_io: '交互题 · IO：选手程序与「交互器」通过标准输入输出对话，由交互器判定结果（需要 interactor.cpp，可另附头文件）。',
    interactive_func: '交互题 · 函数式：选手只实现题面头文件里声明的函数；评测时把题目目录下的 grader.cpp（含 main）与选手代码一起编译链接后运行，再由 grader 读入测试数据、调用选手函数并输出结果。题目侧需要在 data/testdata/<题号>/ 放好 grader.cpp 与头文件（如 problem.h）以及逐点 N.in / N.out；仅支持 C/C++ 提交。',
    communication: '通信题（两个选手程序合作，独立题型）：选手需要提交两个程序——程序一读入题目输入（N.in）并产生输出，程序二的输入与程序一的输出相关，它产生问题的解。题目侧在 data/testdata/<题号>/ 放逐点 N.in / N.out（3~5 个即可），另可选放 grader.cpp（评测端中转程序：读取程序一的输出、按需处理后作为程序二的输入）与 checker.cpp（SPJ）。连接方式在下方「测试数据」卡片选择：relay = 评测端中转（先用 N.in 跑程序一，收下 stdout，必要时经 grader 处理，再跑程序二，比较程序二输出与 N.out）；direct = 双向管道直连（程序一 stdout 直接接程序二 stdin，两者并行边跑边传）。两个程序各自受时限 / 内存约束；仅支持 C/C++ 提交。',
  };
  /** SPJ 是五种题目类型共用的一个开关：勾选后展开 checker 编辑区与对应说明 */
  const applySpj = () => {
    const on = !!(spjCb && spjCb.checked);
    if (spjCheckerWrap) spjCheckerWrap.style.display = on ? 'block' : 'none';
    if (spjHintEl) spjHintEl.style.display = on ? 'block' : 'none';
    if (spjItrNote) spjItrNote.style.display = on ? 'block' : 'none';
  };
  /** 按当前题目类型显示 / 隐藏对应控件（交互题与通信题共用这张卡片，但显隐规则不同） */
  const applyProblemType = () => {
    const t = ptypeSel ? ptypeSel.value : 'standard';
    const isInter = t === 'interactive_io' || t === 'interactive_func' || t === 'communication';
    const isComm = t === 'communication';
    if (interactiveCard) interactiveCard.style.display = isInter ? 'block' : 'none';
    if (itrWrap) itrWrap.style.display = t === 'interactive_io' ? 'block' : 'none';
    // 通信题的 grader.cpp 是「评测端中转程序」（可选）；函数式交互题则必填
    if (grdWrap) grdWrap.style.display = (t === 'interactive_func' || isComm) ? 'block' : 'none';
    if (hdrWrap) hdrWrap.style.display = isInter ? 'block' : 'none';
    if (ihintWrap) ihintWrap.style.display = isInter ? 'block' : 'none';
    // 通信题开关（连接方式 / 通信量上限）在「测试数据」卡片里：切类型时同步显隐
    const commCfg = document.getElementById('comm-config');
    if (commCfg) commCfg.style.display = isComm ? 'block' : 'none';
    if (ptypeHint) ptypeHint.textContent = '题目类型说明：' + (PTYPE_HINT[t] || PTYPE_HINT.standard);
    applySpj();
  };
  if (ptypeSel) ptypeSel.addEventListener('change', applyProblemType);
  if (spjCb) spjCb.addEventListener('change', applySpj);
  applyProblemType();
  bindLivePreview('f-ihint', 'pv-ihint');

  // 交互器 / grader：选择本地文件读入文本框（与 checker.cpp 的用法一致，仍需点击「保存题目信息」写入服务器）
  const bindSourceFile = (btnId, inputId, textareaId, label) => {
    const btn = document.getElementById(btnId);
    const input = document.getElementById(inputId);
    const ta = document.getElementById(textareaId);
    if (!btn || !input || !ta) return;
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        ta.value = String(reader.result || '');
        if (ta.value.length > INTERACTIVE_SRC_MAX) toast(`${label} 超过 200KB，保存会被拒绝`, 'error');
        else toast(`已载入 ${file.name}，点击「保存题目信息」写入服务器`, 'success');
      };
      reader.readAsText(file);
      input.value = '';
    });
  };
  bindSourceFile('itr-file', 'itr-file-input', 'f-interactor', 'interactor.cpp');
  bindSourceFile('grd-file', 'grd-file-input', 'f-grader', 'grader.cpp');

  // 头文件列表：增删 + 每项选择本地文件（事件委托，覆盖动态新增的行）
  const hdrContainer = document.getElementById('headers-container');
  const bindHeaderRow = (row) => {
    if (!row || row.dataset.bound) return;
    row.dataset.bound = '1';
    const del = row.querySelector('.hdr-del');
    if (del) del.addEventListener('click', () => {
      row.remove();
      if (hdrContainer) hdrContainer.dataset.empty = '1';
    });
    const fileBtn = row.querySelector('.hdr-file');
    const hidden = document.createElement('input');
    hidden.type = 'file';
    hidden.accept = '.h,.hpp,.hh,.txt,.cpp';
    hidden.style.display = 'none';
    row.appendChild(hidden);
    if (fileBtn) {
      fileBtn.addEventListener('click', () => hidden.click());
      hidden.addEventListener('change', () => {
        const file = hidden.files && hidden.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const ta = row.querySelector('.hdr-content');
          if (ta) ta.value = String(reader.result || '');
          const nameInput = row.querySelector('.hdr-name');
          // 名称为空时按文件名自动填入，省一次输入
          if (nameInput && !nameInput.value.trim()) nameInput.value = file.name;
        };
        reader.readAsText(file);
        hidden.value = '';
      });
    }
  };
  if (hdrContainer) hdrContainer.querySelectorAll('.hdr-row').forEach(bindHeaderRow);
  const addHeaderBtn = document.getElementById('add-header');
  if (addHeaderBtn && hdrContainer) {
    addHeaderBtn.addEventListener('click', () => {
      hdrContainer.querySelectorAll('.muted').forEach((el) => { if (el.textContent.includes('暂未添加头文件')) el.remove(); });
      const i = hdrContainer.querySelectorAll('.hdr-row').length;
      hdrContainer.insertAdjacentHTML('beforeend', headerRowHtml({ name: '', content: '' }, i));
      bindHeaderRow(hdrContainer.querySelector(`.hdr-row[data-i="${i}"]`));
    });
  }
  /** 收集头文件列表（名称为空的行会提示并中止保存） */
  const collectHeaders = () => {
    const rows = hdrContainer ? [...hdrContainer.querySelectorAll('.hdr-row')] : [];
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const name = (rows[i].querySelector('.hdr-name') || {}).value || '';
      const content = (rows[i].querySelector('.hdr-content') || {}).value || '';
      if (!name.trim()) {
        if (!content.trim()) continue;   // 名称与内容都为空的行直接忽略
        return { error: `第 ${i + 1} 个头文件没有填写名称（如 problem.h）` };
      }
      if (content.length > INTERACTIVE_SRC_MAX) return { error: `头文件 ${name.trim()} 内容过长（最多 200KB）` };
      out.push({ name: name.trim(), content });
    }
    return { headers: out };
  };
  // checker 编辑器状态（显隐由上面的 applySpj() 统一处理，这里只保留状态文案）
  const ckStatus = document.getElementById('ck-status');
  const setCkStatus = (txt, color) => {
    if (ckStatus) {
      ckStatus.textContent = txt ? '  ' + txt : '';
      if (color) ckStatus.style.color = color; else ckStatus.style.color = '';
    }
  };
  if (id) {
    if (checkerExists) setCkStatus('✓ 已找到 checker.cpp', 'var(--green)');
    else if (problem && problem.spj) setCkStatus('（未找到 checker.cpp，请在下方编写或上传含 checker.cpp 的数据包）', 'var(--orange)');
  }
  // 保存 / 重新加载 checker.cpp
  const ckSave = document.getElementById('ck-save');
  if (ckSave) {
    ckSave.addEventListener('click', async () => {
      if (!id) return toast('请先保存题目信息以获取题目 ID', 'error');
      const content = document.getElementById('f-checker').value;
      if (content.length > 100 * 1024) return toast('checker.cpp 内容过长（最多 100KB）', 'error');
      try {
        const r = await api.put(`/api/problems/${id}/checker`, { content });
        checkerExists = r.has_checker;
        setCkStatus(checkerExists ? '✓ 已保存 checker.cpp，评测时将自动编译' : '（已清空 checker.cpp）', checkerExists ? 'var(--green)' : 'var(--orange)');
        toast(checkerExists ? 'checker.cpp 已保存' : 'checker.cpp 已清空', 'success');
      } catch (e) { toast(e.message, 'error'); }
    });
  }
  const ckReload = document.getElementById('ck-reload');
  if (ckReload) {
    ckReload.addEventListener('click', async () => {
      if (!id) return;
      try {
        const cdata = await api.get(`/api/problems/${id}/checker`);
        checkerContent = cdata.content || '';
        checkerExists = !!cdata.content;
        document.getElementById('f-checker').value = checkerContent;
        setCkStatus(checkerExists ? '✓ 已找到 checker.cpp' : '（未找到 checker.cpp）', checkerExists ? 'var(--green)' : 'var(--orange)');
      } catch (e) { toast(e.message, 'error'); }
    });
  }
  // 直接选择本地 checker.cpp 文件载入编辑器（仍需点击「保存 checker.cpp」写入服务器）
  const ckFileBtn = document.getElementById('ck-file');
  const ckFileInput = document.getElementById('ck-file-input');
  if (ckFileBtn && ckFileInput) {
    ckFileBtn.addEventListener('click', () => ckFileInput.click());
    ckFileInput.addEventListener('change', () => {
      const file = ckFileInput.files && ckFileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const content = String(reader.result || '');
        document.getElementById('f-checker').value = content;
        if (content.length > 100 * 1024) {
          setCkStatus('（文件超过 100KB，保存将被拒绝）', 'var(--red)');
        } else {
          setCkStatus('已载入文件，请点击「保存 checker.cpp」写入服务器', 'var(--accent)');
        }
      };
      reader.readAsText(file);
    });
  }

  function bindRemove(btnSel, rowSel) {
    document.querySelectorAll(btnSel).forEach((b) => b.addEventListener('click', () => {
      b.closest(rowSel).remove();
      renumber(rowSel);
    }));
  }
  function renumber(rowSel) {
    document.querySelectorAll(rowSel).forEach((r, idx) => {
      r.querySelector('strong').textContent = (rowSel === '.tc-row' ? '测试点 ' : '样例 ') + (idx + 1);
    });
  }

  // 逐测试点文件上传：读取文件内容填入对应文本域（同时清除“保留原文件”标志，改用新内容）
  function bindTcFiles() {
    document.querySelectorAll('.tc-file-btn').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      const k = btn.dataset.k;
      const row = btn.closest('.tc-row');
      const textarea = row ? row.querySelector(`textarea[data-k="${k}"]`) : null;
      const hidden = document.createElement('input');
      hidden.type = 'file';
      hidden.style.display = 'none';
      btn.insertAdjacentElement('afterend', hidden);
      btn.addEventListener('click', () => hidden.click());
      hidden.addEventListener('change', () => {
        const file = hidden.files && hidden.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          if (textarea) textarea.value = String(reader.result || '');
          if (row) row.dataset[`keep${k === 'input' ? 'Input' : 'Output'}`] = '0';
        };
        reader.readAsText(file);
      });
    });
  }
  // 用户在文本域中输入新内容时，视为替换原数据，清除保留标志（事件委托，覆盖动态新增行）
  const tcContainerEl = document.getElementById('tc-container');
  if (tcContainerEl) {
    tcContainerEl.addEventListener('input', (e) => {
      const ta = e.target;
      if (!ta.matches || !ta.matches('textarea[data-k]')) return;
      const row = ta.closest('.tc-row');
      if (!row) return;
      const k = ta.dataset.k;
      row.dataset[`keep${k === 'input' ? 'Input' : 'Output'}`] = '0';
    });
  }

  // ZIP 测试数据包上传
  document.getElementById('zip-upload-btn').addEventListener('click', () => {
    document.getElementById('zip-file-input').click();
  });
  document.getElementById('zip-file-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!id) return toast('请先保存题目信息以获取题目 ID', 'error');
    try {
      const base64 = await fileToBase64(file);
      const overwrite = document.getElementById('zip-overwrite').checked;
      const r = await api.post(`/api/problems/${id}/testdata/upload`, { zip_base64: base64, overwrite });
      const ck = r.has_checker ? '；已找到并写入 checker.cpp ✓' : '';
      if (r.overwrite === false) {
        toast(`已合并 ${r.pairs} 组测试数据（覆盖 ${r.merged_count} 组、保留其余，共 ${r.count} 个测试点）${ck}`, 'success');
      } else {
        toast(`已上传 ${r.pairs} 组测试数据（整体替换）${ck}`, 'success');
      }
      renderAdminProblemEditor(id);
    } catch (err) { toast(err.message, 'error'); }
  });

  // ---------------- 题目附件（管理员上传 / 删除） ----------------
  const attList = document.getElementById('att-list');
  const renderAttList = (items) => {
    if (!attList) return;
    attList.innerHTML = items.length
      ? items.map((a) => {
          const ic = attIcon(a.name);
          return `<div class="att-item att-item-admin">
            <span class="att-ico" style="color:${ic.c}"><i class="fa-solid ${ic.i}"></i></span>
            <span class="att-main">
              <a class="att-name" href="/api/problems/${id}/attachments/${encodeURIComponent(a.name)}" download>${escapeHtml(a.name)}</a>
              <span class="att-meta">${fmtBytes(a.size)}${a.mtime ? ' · 上传于 ' + fmtTime(a.mtime) : ''}</span>
            </span>
            <button class="btn btn-ghost btn-sm att-del" data-name="${escapeHtml(a.name)}" type="button" title="删除该附件"><i class="fa-solid fa-trash"></i>删除</button>
          </div>`;
        }).join('')
      : '<div class="att-empty"><i class="fa-regular fa-folder-open"></i> 暂无附件</div>';
    attList.querySelectorAll('.att-del').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`确定删除附件「${b.dataset.name}」吗？`)) return;
      try {
        const r = await api.del(`/api/problems/${id}/attachments/${encodeURIComponent(b.dataset.name)}`);
        renderAttList(r.items || []);
        toast('附件已删除', 'success');
      } catch (e) { toast(e.message, 'error'); }
    }));
  };
  const uploadAttFiles = async (files) => {
    if (!id || !files.length) return;
    let done = 0;
    for (const f of files) {
      if (f.size > 20 * 1024 * 1024) { toast(`「${f.name}」超过 20MB，已跳过`, 'error'); continue; }
      try {
        const b64 = await fileToBase64(f);
        const r = await api.post(`/api/problems/${id}/attachments`, { name: f.name, data_base64: b64 });
        renderAttList(r.items || []);
        done++;
      } catch (e) { toast(`「${f.name}」上传失败：${e.message}`, 'error'); }
    }
    if (done) toast(`已上传 ${done} 个附件`, 'success');
  };
  if (attList) {
    api.get(`/api/problems/${id}/attachments`).then((r) => renderAttList(r.items || [])).catch(() => renderAttList([]));
    const drop = document.getElementById('att-drop');
    const input = document.getElementById('att-file-input');
    if (drop && input && id) {
      drop.addEventListener('click', () => input.click());
      input.addEventListener('change', () => { uploadAttFiles(Array.from(input.files || [])); input.value = ''; });
      ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
      ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave') drop.classList.remove('drag'); }));
      drop.addEventListener('drop', (e) => {
        drop.classList.remove('drag');
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
        if (files.length) uploadAttFiles(files);
      });
    }
  }

  // 保存题目信息
  document.getElementById('save-problem').addEventListener('click', async () => {
    const samples = [];
    document.querySelectorAll('.sample-row').forEach((r) => {
      const input = r.querySelector('textarea[data-k="input"]').value;
      const output = r.querySelector('textarea[data-k="output"]').value;
      if (input || output) samples.push({ input, output });
    });
    // 交互题 / 通信题：题目类型 + 说明始终提交；交互器 / grader / 头文件仅在该类型下提交
    //（普通题不提交这些字段 → 服务端保持原样，不会因为切回普通题而误删文件）
    const curType = ptypeSel ? ptypeSel.value : 'standard';
    const curComm = curType === 'communication';
    const curInteractive = curType === 'interactive_io' || curType === 'interactive_func' || curComm;
    const interactorVal = document.getElementById('f-interactor') ? document.getElementById('f-interactor').value : '';
    const graderVal = document.getElementById('f-grader') ? document.getElementById('f-grader').value : '';
    const payload = {
      title: document.getElementById('f-title').value.trim(),
      difficulty: parseInt(document.getElementById('f-difficulty').value, 10),
      tags: document.getElementById('f-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      source: document.getElementById('f-source').value.trim(),
      time_limit_ms: parseInt(document.getElementById('f-time').value, 10),
      memory_limit_mb: parseInt(document.getElementById('f-mem').value, 10),
      is_public: document.getElementById('f-public').checked,
      show_score: document.getElementById('f-score').checked,
      editorial_closed: document.getElementById('f-ed-closed').checked,
      enable_o2: document.getElementById('f-o2').checked,
      // SPJ：五种题目类型共用的一个开关（页面顶部「基本信息」区），checker 也共用同一份 checker.cpp
      spj: !!(spjCb && spjCb.checked),
      // 题目类型共 5 种；output_only 由类型推导（两者都发，以 problem_type 为准，兼容旧后端）
      problem_type: curType,
      output_only: curType === 'output_only',
      description: document.getElementById('f-desc').value,
      background: document.getElementById('f-bg').value,
      input_format: document.getElementById('f-infmt').value,
      output_format: document.getElementById('f-outfmt').value,
      hint: document.getElementById('f-hint').value,
      samples,
      // 交互说明 / 通信说明（Markdown）：会展示在题目页对应区块
      interactive_hint: document.getElementById('f-ihint') ? document.getElementById('f-ihint').value : '',
    };
    if (curInteractive) {
      const res = collectHeaders();
      if (res.error) return toast(res.error, 'error');
      // 交互器 / grader / 头文件：空字符串表示删除对应文件；头文件一旦提交即整体替换。
      // 只提交当前类型用得到的配套文件（切类型时不会误删另一种文件，服务端对未出现的字段保持原样）。
      if (curType === 'interactive_io') {
        if (interactorVal.length > INTERACTIVE_SRC_MAX) return toast('interactor.cpp 内容过长（最多 200KB）', 'error');
        payload.interactor_source = interactorVal;
      }
      // grader.cpp：函数式交互题必填（与选手代码链接）；通信题可选（评测端中转程序）
      if (curType === 'interactive_func' || curComm) {
        if (graderVal.length > INTERACTIVE_SRC_MAX) return toast('grader.cpp 内容过长（最多 200KB）', 'error');
        payload.grader_source = graderVal;
      }
      payload.interactive_headers = res.headers || [];
    }
    try {
      if (id) {
        await api.put('/api/problems/' + id, payload);
        toast('题目信息已保存', 'success');
      } else {
        const r = await api.post('/api/problems', payload);
        toast('题目已创建，请继续添加测试数据', 'success');
        // 新建后进入编辑页；顶部返回按钮按来源显示「返回题目」或「返回管理后台」。
        // 题库来源时「返回题目」指向刚创建的题目详情页
        if (problemEditorBack && problemEditorBack.fromProblems) {
          problemEditorBack.href = '#/problem/' + r.id;
        }
        nav('admin/problem/' + r.id);
      }
    } catch (e) { toast(e.message, 'error'); }
  });

  // 迁移题号：把该题整体搬到新题号（提交 / 题解 / 讨论 / 收藏 / 比赛关联 / 测试数据一起搬）
  const migrateBtn = document.getElementById('migrate-problem');
  if (migrateBtn && problem) {
    migrateBtn.addEventListener('click', async () => {
      const input = prompt(
        `把题目 #${problem.id}「${problem.title}」迁移到新题号。\n\n请输入新的题号（正整数；该题号必须未被占用）：`,
        String(problem.id + 1)
      );
      if (input === null) return;
      const target = parseInt(String(input).trim(), 10);
      if (!Number.isFinite(target) || target <= 0) return toast('新题号必须是正整数', 'error');
      if (target === problem.id) return toast('新题号与当前题号相同', 'error');
      try {
        const chk = await api.get('/api/problems/' + target + '/exists');
        if (chk.exists) return toast(`题号 ${target} 已被「${chk.title}」占用`, 'error');
        if (!confirm(`确认把 #${problem.id}「${problem.title}」迁移到 #${target} 吗？\n\n提交记录、题解、讨论、收藏、比赛关联与测试数据都会一起迁移，原题号将释放。`)) return;
        const r = await api.post(`/api/problems/${problem.id}/migrate`, { new_id: target });
        const mv = r.moved || {};
        toast(`已迁移到 #${r.id}（提交 ${mv.submissions || 0}、题解 ${mv.editorials || 0}、讨论 ${mv.discussions || 0}、收藏 ${mv.favorites || 0}、比赛关联 ${mv.contest_problems || 0}）`, 'success');
        nav('admin/problem/' + r.id);
      } catch (e) { toast(e.message, 'error'); }
    });
  }
  // 保存测试数据
  document.getElementById('save-tc').addEventListener('click', async () => {
    if (!id) return toast('请先保存题目信息', 'error');
    const tcs = [];
    document.querySelectorAll('.tc-row').forEach((r) => {
      // 注意：行内还有 data-k 的「选择文件」按钮，必须限定 textarea 选择器
      const input = r.querySelector('textarea[data-k="input"]').value;
      const output = r.querySelector('textarea[data-k="output"]').value;
      const subtask = parseInt(r.querySelector('.tc-subtask').value, 10);
      const keepInput = r.dataset.keepInput === '1';
      const keepOutput = r.dataset.keepOutput === '1';
      const orig = parseInt(r.dataset.orig, 10);
      // v2.5.3 点级限额：留空（或非正数）→ null = 继承题目级限额
      const tlEl = r.querySelector('.tc-tl');
      const memEl = r.querySelector('.tc-mem');
      const tl = tlEl ? parseInt(tlEl.value, 10) : NaN;
      const mem = memEl ? parseInt(memEl.value, 10) : NaN;
      tcs.push({
        // 保留标志为真时，服务端忽略 input/output 内容，直接沿用磁盘上的完整数据
        input,
        output,
        subtask: Number.isFinite(subtask) ? subtask : undefined,
        keep_input: keepInput,
        keep_output: keepOutput,
        keep_from: Number.isFinite(orig) ? orig : undefined,
        time_limit_ms: Number.isFinite(tl) && tl > 0 ? tl : null,
        memory_limit_mb: Number.isFinite(mem) && mem > 0 ? mem : null,
      });
    });
    if (tcs.length === 0) return toast('至少需要一个测试点', 'error');
    const scoresRaw = document.getElementById('tc-subtask-scores').value.trim();
    const typesRaw = document.getElementById('tc-subtask-types').value.trim();
    const meta = {};
    if (scoresRaw) {
      meta.subtask_scores = scoresRaw.split(/[,，]/).map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
    }
    if (typesRaw) {
      meta.subtask_types = typesRaw.split(/[,，]/).map((s) => s.trim().toLowerCase()).filter((t) => ['sum', 'min', 'max', 'bundle'].includes(t));
    }
    // 通信题的题目侧开关（连接方式 / 程序一输出上限 / duplex）随测试数据一起保存进 meta.json
    const pmEl = document.getElementById('f-pipemode');
    if (pmEl) {
      meta.pipe_mode = pmEl.value === 'direct' ? 'direct' : 'relay';
      const limEl = document.getElementById('f-prog1limit');
      const lim = limEl ? parseInt(limEl.value, 10) : 0;
      meta.prog1_output_limit_bytes = Number.isFinite(lim) && lim > 0 ? lim : 0;
      const dxEl = document.getElementById('f-duplex');
      meta.duplex = !!(dxEl && dxEl.checked);
    }
    try {
      const r = await api.put(`/api/problems/${id}/testcases`, { testcases: tcs, meta });
      toast(`已保存 ${r.count} 个测试点`, 'success');
      renderAdminProblemEditor(id);
    } catch (e) { toast(e.message, 'error'); }
  });
}

/* ---------- 比赛 ---------- */
function toLocalInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(s) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}
const CONTEST_STATUS_COLOR = { upcoming: '#1890ff', running: '#52c41a', ended: '#8c8c8c' };
const CONTEST_TYPE_COLOR = { ACM: '#722ed1', IOI: '#eb2f96', OI: '#13c2c2' };
// IOI/OI 分数四档配色：≥80%（满分）绿 · ≥60% 黄 · ≥40% 橙 · 其余红
const ioiScoreColor = (s) => s >= 80 ? 'var(--green)' : s >= 60 ? 'var(--yellow)' : s >= 40 ? 'var(--orange)' : 'var(--red)';
// 用时格式化：距离比赛开始的时间，格式 (MM:SS)
const fmtElapsed = (ms) => {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `(${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')})`;
};

async function renderContests(query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const page = parseInt(query.get('page') || '1', 10);
  const search = (query.get('search') || '').trim();
  const params = new URLSearchParams({ page: String(page), size: '20' });
  if (search) params.set('search', search);
  if (Store.user && Store.user.is_admin) params.set('all', '1');
  const data = await api.get('/api/contests?' + params.toString());
  setPageTitle('比赛');

  const rows = data.items.length === 0
    ? '<tr><td colspan="6" class="empty">暂无比赛</td></tr>'
    : data.items.map((c) => `
      <tr data-id="${c.id}">
        <td><a href="#/contest/${c.id}" target="_blank" rel="noopener">${escapeHtml(c.title)}</a> ${c.rated ? '<span class="badge" style="background:#52c41a;color:#fff">Rated</span>' : '<span class="badge" style="background:#8c8c8c;color:#fff">Unrated</span>'}</td>
        <td><span class="badge" style="background:${CONTEST_TYPE_COLOR[c.type] || '#722ed1'};color:#fff">${escapeHtml(c.type)}</span></td>
        <td><span class="badge" style="background:${CONTEST_STATUS_COLOR[c.status]};color:#fff">${escapeHtml(c.status_label)}</span></td>
        <td class="num muted">${fmtTime(c.start_time)} ~ ${fmtTime(c.end_time)}</td>
        <td class="num">${c.problem_count}</td>
        <td class="num">${c.participant_count}</td>
      </tr>`).join('');

  app.innerHTML = `
    <div class="page-header">
      <div class="ph-left">
        <h1 class="page-title">比赛</h1>
        <div class="muted page-sub">共 ${data.total} 场比赛</div>
      </div>
      <div class="spacer"></div>
      ${(Store.user && hasP('contest')) ? '<a class="btn" href="#/admin/contest/new"><i class="fa-solid fa-plus"></i>新建比赛</a>' : ''}
    </div>
    <div class="filter-bar filter-search" style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
      <input class="input" id="contest-search" placeholder="搜索比赛名称…" value="${escapeHtml(search)}" style="flex:0 1 260px;min-width:180px" />
      <button class="btn" id="contest-search-btn"><i class="fa-solid fa-magnifying-glass"></i>搜索</button>
      ${search ? '<a class="btn btn-ghost" href="#/contests"><i class="fa-solid fa-xmark"></i>清除</a>' : ''}
    </div>
    <div class="card table-scroll" style="padding:0;margin-top:16px">
      <table class="table table-left contest-list-table">
        <thead><tr><th>比赛名称</th><th>赛制</th><th>状态</th><th class="num">时间</th><th class="num">题目数</th><th class="num">参与人数</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderPagination(data.total, data.page, data.size)}`;

  bindPagination((p) => nav('contests', { page: p }));
  // 比赛列表搜索
  const cSearch = document.getElementById('contest-search');
  const cSearchBtn = document.getElementById('contest-search-btn');
  const doContestSearch = () => {
    const kw = (cSearch.value || '').trim();
    nav('contests', kw ? { search: kw } : {});
  };
  if (cSearchBtn) cSearchBtn.addEventListener('click', doContestSearch);
  if (cSearch) {
    cSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') doContestSearch(); });
    cSearch.focus();
  }
  document.querySelectorAll('tbody tr[data-id]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') return;
    window.open('#/contest/' + tr.dataset.id, '_blank', 'noopener');
  }));
}

async function renderContestDetail(id, query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const data = await api.get('/api/contests/' + id);
  const c = data.contest;
  setPageTitle(c.title);
  let standings = null;
  try {
    const s = await api.get(`/api/contests/${id}/standings`);
    standings = s.standings;
  } catch { /* ignore */ }

  // 比赛题目状态：按赛制显示（ACM=✓/✗ 仅符号，IOI=得分数字（四档配色），OI=已提交/未提交；未提交统一显示「未提交」）
  const problemRows = c.problems.map((p) => {
    let statusHtml;
    if (!p.submitted) {
      statusHtml = '<span class="muted">未提交</span>';
    } else if (c.type === 'ACM') {
      statusHtml = p.user_ac
        ? '<span style="color:var(--green);font-weight:700"><i class="fa-solid fa-check"></i></span>'
        : '<span style="color:var(--red);font-weight:700"><i class="fa-solid fa-xmark"></i></span>';
    } else if (c.type === 'IOI') {
      statusHtml = `<span style="color:${ioiScoreColor(p.score)};font-weight:700">${p.score}</span>`;
    } else {
      // OI：仅显示是否提交（赛中不公开得分）
      statusHtml = '<span style="color:var(--blue);font-weight:700"><i class="fa-solid fa-paper-plane"></i> 已提交</span>';
    }
    return `<tr data-pid="${p.problem_id}">
      <td style="width:60px;font-weight:700">${escapeHtml(p.letter)}</td>
      <td><a href="#/problem/${p.problem_id}?contest=${c.id}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a></td>
      <td style="width:90px">${statusHtml}</td>
    </tr>`;
  }).join('');

  const isScoreType = c.type === 'IOI' || c.type === 'OI';
  const canBrown = hasP('user');
  const canContest = hasP('contest');
  const isSuper = hasP('contest'); // 排行榜「操作」列（棕名）仅具备比赛管理权限可见
  const STANDINGS_PAGE_SIZE = 30; // 排行榜每页 30 名
  // 排行榜渲染（按页）：standings.rows 已按后端排序；自己的行置顶高亮一份，同时保留在列表原位
  const renderStandingsBox = (page) => {
    if (!standings || standings.hidden) {
      return '<div class="empty">暂无数据</div>';
    }
    const rows = standings.rows || [];
    if (rows.length === 0) return '<div class="empty">暂无数据</div>';
    const letters = standings.problems.map((p) => p.letter);
    const headCells = letters.map((l) => `<th class="num">${l}</th>`).join('');
    const myRow = (Store.user && Store.user.id)
      ? rows.find((r) => r.user_id === Store.user.id) || null
      : null;
    const others = rows; // 自己在完整排行榜中原位保留（分页计入），仅额外置顶一份
    const totalPages = Math.max(1, Math.ceil(others.length / STANDINGS_PAGE_SIZE));
    const pg = Math.min(Math.max(1, page), totalPages);
    const pageRows = others.slice((pg - 1) * STANDINGS_PAGE_SIZE, pg * STANDINGS_PAGE_SIZE);
    const standingRow = (r, mine) => {
      let cells = '';
      for (const l of letters) {
        const pr = r.problem_results[l];
        if (isScoreType) {
          // 已提交（含 0 分）显示分数并按四档配色，下方显示用时 (MM:SS)；未提交显示 —
          const submitted = !!(pr && pr.attempts > 0);
          const first = !!(pr && pr.first_solver);
          let cellHtml = '<span class="muted">—</span>';
          if (submitted) {
            cellHtml = `<div><span style="color:${ioiScoreColor(pr.score)};font-weight:700">${pr.score}</span></div><div class="muted" style="font-size:11px;line-height:1.2">${fmtElapsed(pr.time_ms)}</div>`;
          }
          cells += `<td class="num" ${first ? 'style="background:rgba(82,196,26,.15)" title="首个通过本题（首杀）"' : ''}>${cellHtml}</td>`;
        } else {
          if (pr && pr.accepted) {
            // ACM：首次提交即 AC 显示对号（不计罚时）；失败 n 次后 AC 显示 +n（罚时 20*n，CE 不计）
            const cell = pr.first_ac
              ? '<i class="fa-solid fa-check" title="首次提交即 AC，完全不计罚时"></i>'
              : `+${pr.penalty_wrong}`;
            const first = !!pr.first_solver;
            cells += `<td class="num" style="color:var(--green);font-weight:700${first ? ';background:rgba(82,196,26,.15)' : ''}" ${first ? 'title="首个通过本题（首杀）"' : ''}><div>${cell}</div><div class="muted" style="font-size:11px;line-height:1.2">${fmtElapsed(pr.time_ms)}</div></td>`;
          } else if (pr && pr.attempts > 0) {
            // ACM 未通过：不计算用时，仅显示 -n（加粗）
            cells += `<td class="num" style="color:var(--red);font-weight:700"><div>-${pr.attempts}</div></td>`;
          } else {
            cells += '<td class="num muted">—</td>';
          }
        }
      }
      const metric = isScoreType
        ? `<td class="num"><div><strong>${r.total_score}</strong></div><div class="muted" style="font-size:11px;line-height:1.2">${fmtElapsed(r.total_time_ms)}</div></td>`
        // ACM：解题数下方显示总用时（含罚时）
        : `<td class="num"><div><strong>${r.solved}</strong></div><div class="muted" style="font-size:11px;line-height:1.2">${fmtElapsed(r.total_time_ms)}</div></td><td class="num"><div>${r.penalty}</div></td>`;
      const brownCell = (canBrown && r.username !== 'admin')
        ? `<td style="white-space:nowrap;width:1%">
            <button class="btn btn-sm st-brown btn-brown" data-user="${r.user_id}" data-uname="${escapeHtml(r.username)}" data-type="cheat" title="比赛作弊：本场判-1分并棕名14天"><i class="fa-solid fa-user-shield"></i>棕名·作弊</button>
          </td>`
        : '';
      return `<tr${mine ? ' style="background:rgba(24,144,255,0.10)"' : ''}>
        <td class="num" style="font-weight:800;width:50px">${mine ? '<span class="badge" style="background:var(--blue);color:#fff;margin-right:4px">我</span>' : ''}${r.rank == null ? '<span class="muted">—</span>' : (r.rank <= 3 ? ['<i class="fa-solid fa-medal" style="color:#f5b301"></i>','<i class="fa-solid fa-medal" style="color:#c0c0c0"></i>','<i class="fa-solid fa-medal" style="color:#cd7f32"></i>'][r.rank - 1] : r.rank)}</td>
        <td>${userSpan({ uid: r.user_id, username: r.username, nickname: r.username })}</td>
        ${metric}${cells}${brownCell}
      </tr>`;
    };
    const myRowHtml = myRow ? standingRow(myRow, true) : '';
    const bodyRows = pageRows.map((r) => standingRow(r, false)).join('');
    const note = c.type === 'ACM'
      ? '<div class="muted" style="font-size:12px;margin-top:8px">✓ 表示首次提交即 AC，完全不计罚时；+n 表示 AC 前有 n 次错误提交（编译错误不计入），每次罚时 20 分钟；-n 表示尚未 AC 且已有 n 次非编译错误提交；淡绿色背景单元格表示该题首个通过（首杀）；各题下方 (MM:SS) 为该题用时（距离比赛开始，未通过题不计）；总用时 = 各通过题用时之和 + 罚时</div>'
      : '<div class="muted" style="font-size:12px;margin-top:8px">淡绿色背景单元格表示该题首个通过（首杀）；各题下方 (MM:SS) 为该题用时（距离比赛开始）</div>';
    const pager = others.length > STANDINGS_PAGE_SIZE ? renderPagination(others.length, pg, STANDINGS_PAGE_SIZE) : '';
    return `<div style="overflow:auto"><table class="table" style="width:max-content;min-width:100%">
      <thead><tr><th class="num">排名</th><th>用户</th>${isScoreType ? '<th class="num">总分</th>' : '<th class="num">解题数</th><th class="num">罚时</th>'}${headCells}${isSuper ? '<th style="width:1%">操作</th>' : ''}</tr></thead>
      <tbody>${myRowHtml}${bodyRows}</tbody>
    </table></div>${note}${pager}`;
  };
  let standingsHtml = '<div class="empty">暂无数据</div>';
  if (standings && standings.hidden) {
    standingsHtml = (standings.hidden_reason === 'signup')
      ? '<div class="empty" style="padding:30px 0"><i class="fa-solid fa-lock"></i> 报名后可查看排行榜</div>'
      : '<div class="empty" style="padding:30px 0"><i class="fa-solid fa-lock"></i> OI 赛制比赛中不公布排行榜与成绩，比赛结束后公布完整排名与得分</div>';
  } else if (standings && standings.rows && standings.rows.length > 0) {
    standingsHtml = renderStandingsBox(1);
  }

  // 页面标签页（比赛描述 / 比赛题目 / 比赛排名）；默认进入「比赛描述」
  const viewerIsAdmin = !!(Store.user && Store.user.is_admin);
  const signedUpViewer = !!c.signed_up;
  // 未报名用户只能看到比赛描述：题目与排行榜全部锁定，仅保留「比赛描述」页签
  const canSeeAll = viewerIsAdmin || signedUpViewer;
  const iSubmitted = (c.problems || []).some((p) => p.submitted); // 我是否在本场提交过
  const tabQ = query && query.get('tab');
  const initialTab = (!canSeeAll || !tabQ) ? 'desc' : tabQ;
  const fmtDuration = (ms) => {
    const min = Math.max(1, Math.round((ms || 0) / 60000));
    if (min < 60) return min + ' 分钟';
    const h = Math.floor(min / 60), m = min % 60;
    if (h < 24) return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
    const d = Math.floor(h / 24), rh = h % 24;
    return rh ? `${d} 天 ${rh} 小时` : `${d} 天`;
  };
  const fmtCountdown = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const hh = String(h).padStart(2, '0'), mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return d > 0 ? `${d} 天 ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
  };
  const tabsBar = `<div class="profile-tabs contest-tabs" style="margin-top:16px">
      <a class="${initialTab === 'desc' ? 'active' : ''}" data-tab="desc">比赛描述</a>
      ${canSeeAll
        ? '<a class="' + (initialTab === 'problems' ? 'active' : '') + '" data-tab="problems">比赛题目</a><a class="' + (initialTab === 'rank' ? 'active' : '') + '" data-tab="rank">比赛排名</a>'
        : ''}
    </div>`;
  const signupLockNote = !canSeeAll
    ? `<div class="card" style="margin-top:16px"><div class="empty" style="padding:26px 0"><i class="fa-solid fa-lock"></i> 报名后可查看比赛题目与排行榜<div class="muted" style="font-size:12px;margin-top:6px">${c.status === 'ended' ? '本场比赛报名已截止，仅报名用户可见题目与榜单' : (c.status === 'upcoming' ? '比赛尚未开始，报名进行中' : '比赛进行中，报名后即可查看题目并提交')}</div></div></div>`
    : '';
  const descTab = `<div id="ctab-desc" ${initialTab === 'desc' ? '' : 'style="display:none"'}>
      ${c.description_html ? `<div class="card statement">${c.description_html}</div>` : '<div class="card"><div class="empty">暂无比赛描述</div></div>'}
      ${signupLockNote}
    </div>`;
  const problemsTab = canSeeAll ? `<div id="ctab-problems" ${initialTab === 'problems' ? '' : 'style="display:none"'}>
      <div class="card">
        <h2 class="card-title">比赛题目</h2>
        ${c.can_view_problems
          ? (c.problems.length ? `<table class="table"><thead><tr><th>题号</th><th>题目</th><th>状态</th></tr></thead><tbody>${problemRows}</tbody></table>` : '<div class="empty">暂无题目</div>')
          : `<div class="empty">${c.status === 'upcoming' ? '<i class="fa-solid fa-lock"></i> 比赛尚未开始，题目列表暂不可见' : '<i class="fa-solid fa-lock"></i> 请先报名比赛后查看题目'}</div>`}
      </div>
    </div>` : '';
  // 已报名但未提交：本人不在排行榜中（排名为 — 的行不显示），给出说明
  const ownNotRanked = signedUpViewer && standings && !standings.hidden && Store.user
    && !(standings.rows || []).some((r) => r.user_id === Store.user.id);
  const rankTab = canSeeAll ? `<div id="ctab-rank" ${initialTab === 'rank' ? '' : 'style="display:none"'}>
      <div class="card">
        <h2 class="card-title">排行榜</h2>
        <div id="standings-box">${standingsHtml}</div>
        ${ownNotRanked ? '<div class="muted" style="font-size:12px;margin-top:8px">你未在本场比赛提交，无排名（排名为 — 的行不显示在排行榜中）</div>' : ''}
      </div>
    </div>` : '';

  // 右侧栏：报名状态与报名操作
  // 「已报名」与「是否计算等级分」分成两块（两行）展示，避免挤在同一个徽章里
  const signupBadge = c.signed_up
    ? '<span class="badge" style="background:var(--green);color:#fff">已报名 <i class="fa-solid fa-check"></i></span>'
    : (c.status === 'ended' ? '<span class="muted">报名已截止</span>' : '<span class="muted">未报名</span>');
  const ratedChoiceRow = c.signed_up
    ? `<div class="info-row" style="border-bottom:none"><span class="il">是否计算等级分</span><span class="iv">${
      !c.rated
        ? '<span class="badge" style="background:#8c8c8c;color:#fff">Unrated（本场不计等级分）</span>'
        : (c.my_rated === 0
          ? '<span class="badge" style="background:#8c8c8c;color:#fff"><i class="fa-solid fa-xmark"></i> 不计等级分</span>'
          : '<span class="badge" style="background:var(--green);color:#fff"><i class="fa-solid fa-check"></i> 计算等级分</span>')
    }</span></div>`
    : '';
  const highRating = c.rated && c.rating_threshold > 0 && Store.user && (Store.user.rating || 0) >= c.rating_threshold;
  const canTickRate = c.rated && !highRating;
  // 阈值比赛：报名/信息区展示「我的等级分是否符合阈值要求」
  const thrRule = c.rated && c.rating_threshold > 0;
  const myRating = (Store.user && (Store.user.rating || 0)) != null ? (Store.user.rating || 0) : null;
  let thrStatusHtml = '';
  if (thrRule) {
    if (myRating == null) {
      thrStatusHtml = '<span class="muted">—（登录后查看）</span>';
    } else {
      const meet = myRating < c.rating_threshold;
      const optedOut = signedUpViewer && c.my_rated === 0;
      let badgeHtml, tip;
      if (!meet) {
        badgeHtml = '<span class="badge" style="background:#fa8c16;color:#fff">不符合阈值</span>';
        tip = optedOut ? '本场不计等级分' : '超出阈值，报名后不计等级分';
      } else if (optedOut) {
        badgeHtml = '<span class="badge" style="background:#8c8c8c;color:#fff">不计等级分</span>';
        tip = '你已选择不计等级分';
      } else {
        badgeHtml = '<span class="badge" style="background:var(--green);color:#fff">符合阈值</span>';
        tip = signedUpViewer ? '本场计入等级分' : '报名后计入等级分';
      }
      thrStatusHtml = `${myRating} ${badgeHtml} <span class="muted" style="font-size:12px">${tip}</span>`;
    }
  }
  const signupAction = (!c.signed_up && c.status !== 'ended')
    ? (Store.user
        ? `<div class="row mt" style="gap:8px"><label class="switch"><input type="checkbox" id="signup-rated" ${canTickRate ? 'checked' : 'disabled'} /><span class="slider"></span><span class="switch-label">计算等级分</span></label><button class="btn btn-sm" id="signup-btn"><i class="fa-solid fa-flag-checkered"></i>报名比赛</button></div>`
          + (highRating ? `<div class="muted" style="font-size:12px;margin-top:6px;line-height:1.5">你的等级分（${Store.user.rating}）已达本场阈值 ${c.rating_threshold}，报名后不计等级分</div>` : '')
        : '<a class="btn btn-ghost btn-sm mt" href="#/login"><i class="fa-solid fa-right-to-bracket"></i>登录后报名</a>')
    : '';
  const sideInfo = `<div class="card">
      <h2 class="card-title"><i class="fa-solid fa-hourglass-half"></i> 倒计时</h2>
      <div id="contest-countdown">
        <div class="muted" id="cd-label">计算中…</div>
        <div class="countdown-time" id="cd-time">--:--:--</div>
      </div>
    </div>
    <div class="card">
      <h2 class="card-title"><i class="fa-solid fa-circle-info"></i> 比赛信息</h2>
      <div class="info-row"><span class="il">赛制</span><span class="iv"><span class="badge" style="background:${CONTEST_TYPE_COLOR[c.type] || '#722ed1'};color:#fff">${escapeHtml(c.type)}</span></span></div>
      <div class="info-row"><span class="il">状态</span><span class="iv"><span class="badge" style="background:${CONTEST_STATUS_COLOR[c.status]};color:#fff">${escapeHtml(c.status_label)}</span></span></div>
      <div class="info-row"><span class="il">开始时间</span><span class="iv">${fmtTime(c.start_time)}</span></div>
      <div class="info-row"><span class="il">结束时间</span><span class="iv">${fmtTime(c.end_time)}</span></div>
      <div class="info-row"><span class="il">时长</span><span class="iv">${fmtDuration(c.end_time - c.start_time)}</span></div>
      <div class="info-row"><span class="il">报名</span><span class="iv">需报名 · 已报名 ${c.signup_count} 人</span></div>
      <div class="info-row"><span class="il">等级分</span><span class="iv">${c.rated ? `<span class="badge" style="background:${c.rating_threshold > 0 ? '#fa8c16' : '#52c41a'};color:#fff">${c.rating_threshold > 0 ? `Rated（等级分 &lt; ${c.rating_threshold}）` : 'Rated'}</span>` : '<span class="badge" style="background:#8c8c8c;color:#fff">Unrated</span>'}</span></div>
      ${thrRule
        ? `<div class="info-row"><span class="il">阈值要求</span><span class="iv">等级分 &lt; ${c.rating_threshold} 才计入等级分</span></div>
      <div class="info-row"><span class="il">我的等级分</span><span class="iv">${thrStatusHtml}</span></div>`
        : ''}
      <div class="info-row"><span class="il">题目数</span><span class="iv">${c.can_view_problems ? c.problems.length + ' 题' : (signedUpViewer ? '比赛开始后可见' : '报名后可查看')}</span></div>
      ${(signedUpViewer && c.status === 'ended' && c.rated && c.my_rated === 1)
        ? (c.my_rating_change
            ? `<div class="info-row"><span class="il">本场等级分</span><span class="iv">${c.my_rating_change.before} → ${c.my_rating_change.after} <b style="color:${c.my_rating_change.delta > 0 ? 'var(--green)' : (c.my_rating_change.delta < 0 ? 'var(--red)' : 'var(--text-light)')}">(${c.my_rating_change.delta > 0 ? '+' : ''}${c.my_rating_change.delta})</b></span></div>`
            : (iSubmitted && !c.ratings_applied
                ? `<div class="info-row"><span class="il">本场等级分</span><span class="iv"><span class="muted">待管理员结算后显示变化</span></span></div>`
                : ''))
        : ''}
      <div class="info-row"${ratedChoiceRow ? '' : ' style="border-bottom:none"'}><span class="il">我的报名</span><span class="iv">${signupBadge}</span></div>
      ${ratedChoiceRow}
      ${signupAction}
    </div>`;

  app.innerHTML = `
    <div class="crumb"><a href="#/contests"><i class="fa-solid fa-arrow-left"></i> 返回比赛列表</a></div>
    <div class="row mt" style="margin-top:8px;align-items:baseline">
      <h1 class="page-heading">${escapeHtml(c.title)}</h1>
      <span class="badge" style="background:${CONTEST_TYPE_COLOR[c.type] || '#722ed1'};color:#fff">${escapeHtml(c.type)}</span>
      <span class="badge" style="background:${CONTEST_STATUS_COLOR[c.status]};color:#fff">${escapeHtml(c.status_label)}</span>
      <div class="spacer"></div>
      ${Store.user ? `<button class="btn btn-ghost btn-sm" id="fav-contest-btn" title="收藏本比赛"><i class="fa-${c.is_favorite ? 'solid' : 'regular'} fa-star" style="color:${c.is_favorite ? '#faad14' : ''}"></i>${c.is_favorite ? '已收藏' : '收藏'}</button>` : ''}
      ${canSeeAll ? `<a class="btn btn-ghost btn-sm" href="#/submissions?contest=${c.id}"><i class="fa-solid fa-list"></i>比赛提交记录</a>` : ''}
      ${Store.user && Store.user.is_admin ? `<button class="btn btn-ghost btn-sm" id="dl-standings-btn" title="下载排行榜（CSV）"><i class="fa-solid fa-download"></i>下载排行榜</button>` : ''}
      ${Store.user && hasP('contest') ? `<a class="btn btn-ghost btn-sm" href="#/admin/contest/${c.id}"><i class="fa-solid fa-pen"></i>编辑比赛</a>` : ''}
      ${Store.user && hasP('contest') ? '<button class="btn btn-danger btn-sm" id="contest-del-btn"><i class="fa-solid fa-trash"></i>删除比赛</button>' : ''}
      ${(Store.user && Store.user.is_admin && c.status === 'ended' && c.signup_count > 0) ? `<button class="btn btn-sm" id="apply-rating-btn">${c.ratings_applied ? '重新计算等级分' : '计算等级分'}</button>` : ''}
      ${(canContest && c.status === 'running') ? `<button class="btn btn-ghost btn-sm" id="end-contest-btn"><i class="fa-solid fa-flag-checkered"></i>提前结束</button>` : ''}
    </div>
    <div class="contest-grid">
      <div class="cg-main">
        ${tabsBar}
        ${descTab}
        ${problemsTab}
        ${rankTab}
      </div>
      <div class="cg-side">
        ${sideInfo}
      </div>
    </div>`;

  // 标签页切换（描述 / 题目 / 排名，页面内切换）
  const getCurTab = () => { const a = document.querySelector('.contest-tabs a.active'); return a ? a.dataset.tab : 'desc'; };
  document.querySelectorAll('.contest-tabs a[data-tab]').forEach((a) => a.addEventListener('click', () => {
    const t = a.dataset.tab;
    document.querySelectorAll('.contest-tabs a[data-tab]').forEach((x) => x.classList.toggle('active', x === a));
    ['desc', 'problems', 'rank'].forEach((k) => {
      const el = document.getElementById('ctab-' + k);
      if (el) el.style.display = (k === t) ? '' : 'none';
    });
  }));
  // 倒计时：距开始 / 距结束 / 已结束（每秒刷新；状态跨越时自动重绘页面）
  const cdBox = document.getElementById('contest-countdown');
  if (cdBox) {
    const cdLabel = document.getElementById('cd-label');
    const cdTime = document.getElementById('cd-time');
    let cdTimer = null;
    const tick = () => {
      const now = Date.now();
      if (!document.getElementById('contest-countdown')) { if (cdTimer) clearInterval(cdTimer); return; }
      if ((c.status === 'upcoming' && now >= c.start_time) || (c.status === 'running' && now >= c.end_time)) {
        if (cdTimer) clearInterval(cdTimer);
        renderContestDetail(id, new URLSearchParams({ tab: getCurTab() }));
        return;
      }
      if (now < c.start_time) {
        cdLabel.textContent = '距离开始还有';
        cdTime.textContent = fmtCountdown(c.start_time - now);
        cdTime.style.color = 'var(--accent)';
      } else if (now < c.end_time) {
        cdLabel.textContent = '距离结束还有';
        cdTime.textContent = fmtCountdown(c.end_time - now);
        cdTime.style.color = 'var(--accent)';
      } else {
        cdLabel.textContent = '比赛已结束';
        cdTime.textContent = '已结束';
        cdTime.style.color = 'var(--text-light)';
        if (cdTimer) clearInterval(cdTimer);
      }
    };
    tick();
    cdTimer = setInterval(tick, 1000);
  }

  document.querySelectorAll('tbody tr[data-pid]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') return;
    nav(`problem/${tr.dataset.pid}?contest=${c.id}`);
  }));
  // 排行榜分页：30 名一页，翻页时仅重渲染排行榜区块
  const standingsBox = document.getElementById('standings-box');
  if (standingsBox && standings && !standings.hidden && standings.rows && standings.rows.length > STANDINGS_PAGE_SIZE) {
    let standingsPage = 1;
    const bindStandingsPager = () => {
      bindPagination((p) => {
        standingsPage = p;
        standingsBox.innerHTML = renderStandingsBox(p);
        bindStandingsPager();
        // 重新绑定棕名处罚按钮
        standingsBox.querySelectorAll('.st-brown').forEach((b) => b.addEventListener('click', async () => {
          const type = b.dataset.type;
          const uid = b.dataset.user;
          const uname = b.dataset.uname;
          if (type === 'plagiarism') {
            if (!confirm(`确定对 ${uname} 执行棕名处罚（抄题解）？将清空其练习积分并将所有题目置为未通过，棕名 14 天。`)) return;
          } else {
            if (!confirm(`确定对 ${uname} 执行棕名处罚（比赛作弊）？本场比赛（#${c.id}）判 -1 分，棕名 14 天。`)) return;
          }
          try {
            await api.post(`/api/admin/users/${uid}/brown`, { type, contest_id: type === 'cheat' ? c.id : undefined });
            toast('已执行棕名处罚', 'success');
            renderContestDetail(id, new URLSearchParams({ tab: getCurTab() }));
          } catch (e) { toast(e.message, 'error'); }
        }));
      });
    };
    bindStandingsPager();
  }
  const signupBtn = document.getElementById('signup-btn');
  if (signupBtn) {
    signupBtn.addEventListener('click', async () => {
      const ratedCheck = document.getElementById('signup-rated');
      const rated = ratedCheck ? ratedCheck.checked : true;
      if (!confirm(rated ? '确定报名本场比赛吗？报名后将计入等级分计算。' : '确定报名本场比赛吗？（不计等级分）')) return;
      try {
        const resp = await api.post(`/api/contests/${c.id}/signup`, { rated });
        toast((resp && resp.note) || (rated ? '报名成功（计入等级分）' : '报名成功（不计等级分）'), 'success');
        renderContestDetail(id, new URLSearchParams({ tab: getCurTab() }));
      } catch (e) { toast(e.message, 'error'); }
    });
  }
  const favContestBtn = document.getElementById('fav-contest-btn');
  if (favContestBtn) favContestBtn.addEventListener('click', async () => {
    try {
      if (c.is_favorite) {
        await api.del('/api/favorites/contest/' + c.id);
        toast('已取消收藏', 'info');
      } else {
        await api.post('/api/favorites', { type: 'contest', id: c.id });
        toast('已收藏', 'success');
      }
      renderContestDetail(id, new URLSearchParams({ tab: getCurTab() }));
    } catch (e) { toast(e.message, 'error'); }
  });

  // 超管：直接在排行榜上对用户执行棕名处罚
  document.querySelectorAll('.st-brown').forEach((b) => b.addEventListener('click', async () => {
    const type = b.dataset.type;
    const uid = b.dataset.user;
    const uname = b.dataset.uname;
    if (type === 'plagiarism') {
      if (!confirm(`确定对 ${uname} 执行棕名处罚（抄题解）？将清空其练习积分并将所有题目置为未通过，棕名 14 天。`)) return;
    } else {
      if (!confirm(`确定对 ${uname} 执行棕名处罚（比赛作弊）？本场比赛（#${c.id}）判 -1 分，棕名 14 天。`)) return;
    }
    try {
      await api.post(`/api/admin/users/${uid}/brown`, { type, contest_id: type === 'cheat' ? c.id : undefined });
      toast('已执行棕名处罚', 'success');
      renderContestDetail(id, new URLSearchParams({ tab: getCurTab() }));
    } catch (e) { toast(e.message, 'error'); }
  }));

  // 比赛管理权限：删除比赛（连带赛题关联、报名记录与赛时提交）
  const contestDelBtn = document.getElementById('contest-del-btn');
  if (contestDelBtn) contestDelBtn.addEventListener('click', async () => {
    if (!confirm(`确定删除比赛「${c.title}」吗？\n将同时删除该比赛的赛题关联、报名记录与全部赛时提交，此操作不可恢复。`)) return;
    try {
      await api.del('/api/contests/' + c.id);
      toast('比赛已删除', 'success');
      nav('contests');
    } catch (e) { toast(e.message, 'error'); }
  });

  // 管理员：计算等级分 / 提前结束
  const applyBtn = document.getElementById('apply-rating-btn');
  if (applyBtn) applyBtn.addEventListener('click', async () => {
    const again = c.ratings_applied;
    if (!confirm(again
      ? '该比赛已结算过。确定「重新计算」吗？将回滚上次结算的等级分变化并重新按当前名次计算。'
      : '确定计算该比赛的等级分吗？（Rated 比赛按当前名次写入等级分；非 Rated 比赛只刷新名次缓存，不产生等级分变化）')) return;
    try {
      const r = await api.post(`/api/contests/${c.id}/apply-ratings`);
      if (r.skipped) toast('已结算（参赛人数不足，未产生等级分变化）', 'success');
      else toast(again ? `已重新计算：等级分 ${r.count} 人` : `已结算：等级分 ${r.count} 人`, 'success');
      renderContestDetail(id, new URLSearchParams({ tab: getCurTab() }));
    } catch (e) { toast(e.message, 'error'); }
  });
  const endBtn = document.getElementById('end-contest-btn');
  if (endBtn) endBtn.addEventListener('click', async () => {
    if (!confirm('确定提前结束该比赛？结束后可进行等级分结算。')) return;
    try {
      await api.post(`/api/contests/${c.id}/end`);
      toast('比赛已结束', 'success');
      renderContestDetail(id, new URLSearchParams({ tab: getCurTab() }));
    } catch (e) { toast(e.message, 'error'); }
  });
  // 管理员：下载排行榜（CSV，带 BOM，Excel 可直接打开）
  const dlBtn = document.getElementById('dl-standings-btn');
  if (dlBtn) dlBtn.addEventListener('click', () => {
    if (!standings) { toast('排行榜尚未加载', 'info'); return; }
    const rows = standings.rows || [];
    const letters = standings.problems ? standings.problems.map((p) => p.letter) : [];
    const csvCell = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const head = ['排名', '用户名'].concat(isScoreType ? ['总分'] : ['解题数', '罚时'], ['总用时']);
    for (const l of letters) head.push(l + ' 分数', l + ' 用时');
    const lines = [head.join(',')];
    for (const r of rows) {
      const row = [r.rank == null ? '' : r.rank, r.username];
      if (isScoreType) row.push(r.total_score);
      else row.push(r.solved, r.penalty);
      row.push(fmtElapsed(r.total_time_ms));
      for (const l of letters) {
        const pr = r.problem_results[l];
        let val = '';
        let tm = '';
        if (pr) {
          if (isScoreType) val = pr.attempts > 0 ? pr.score : '';
          else if (pr.accepted) val = '1';
          else if (pr.attempts > 0) val = '-' + pr.attempts;
          tm = pr.time_ms ? fmtElapsed(pr.time_ms) : '';
        }
        row.push(val, tm);
      }
      lines.push(row.map(csvCell).join(','));
    }
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `排行榜_${c.id}_${String(c.title || '').replace(/[\\/:*?"<>|]/g, '_')}.csv`;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(a.href);
    a.remove();
    toast(`已下载排行榜（${rows.length} 人）`, 'success');
  });
  // 页面内直接重渲染（报名/收藏/结算等）不走 route()，需手动重跑 KaTeX 与代码复制按钮
  renderMath();
  bindCodeCopy();
}

async function renderAdminContestEditor(id) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  setPageTitle(id ? '编辑比赛' : '新建比赛');
  if (!Store.user || !Store.user.is_admin) {
    app.innerHTML = '<div class="empty">需要管理员权限</div>';
    return;
  }
  const allProbs = await api.get('/api/problems?size=100&all=1');
  let contestData = null;
  if (id) {
    const d = await api.get('/api/contests/' + id);
    contestData = d.contest;
  }
  const selected = new Set((contestData ? contestData.problems : []).map((p) => p.problem_id));

  const problemChecks = allProbs.items.map((p) => `
    <label class="switch" style="padding:6px 4px;border-bottom:1px solid var(--border)">
      <input type="checkbox" class="cp-check" value="${p.id}" ${selected.has(p.id) ? 'checked' : ''} />
      <span class="slider"></span>
      <span class="switch-label" style="font-size:13px">#${p.id} ${escapeHtml(p.title)}</span>
    </label>`).join('');

  app.innerHTML = `
    ${adminHead({
      title: id ? '编辑比赛' : '新建比赛',
      actions: `<a class="btn btn-ghost" href="${backHref('#/admin/contests')}"><i class="fa-solid fa-arrow-left"></i> ${backLabel('返回比赛管理')}</a>`,
    })}
    <div class="card">
      <div class="form-group"><label>比赛名称 *</label><input class="input" id="c-title" value="${contestData ? escapeHtml(contestData.title) : ''}" /></div>
      <div class="row" style="gap:16px">
        <div class="form-group" style="flex:1"><label>赛制</label>
          <select class="input" id="c-type">
            <option value="ACM" ${contestData && contestData.type === 'ACM' ? 'selected' : ''}>ACM（按解题数+罚时排名）</option>
            <option value="OI" ${contestData && contestData.type === 'OI' ? 'selected' : ''}>OI（取每题最后一次提交成绩，部分分）</option>
            <option value="IOI" ${contestData && contestData.type === 'IOI' ? 'selected' : ''}>IOI（取每题最高分，部分分）</option>
          </select>
        </div>
        <div class="form-group" style="flex:1;padding-top:26px"><label class="switch"><input type="checkbox" id="c-public" ${(!contestData || contestData.is_public) ? 'checked' : ''} /><span class="slider"></span><span class="switch-label">公开可见</span></label></div>
        <div class="form-group" style="flex:1;padding-top:26px"><label class="switch"><input type="checkbox" id="c-rated" ${(contestData && contestData.rated) ? 'checked' : ''} /><span class="slider"></span><span class="switch-label">Rated（计算等级分）</span></label></div>
        <div class="form-group" style="flex:1"><label>等级分阈值（0=无限制，高于阈值不参与）</label><input class="input" id="c-threshold" type="number" min="0" value="${contestData ? contestData.rating_threshold : 0}" /></div>
      </div>
      <div class="row" style="gap:16px">
        <div class="form-group" style="flex:1"><label>开始时间</label><input class="input" id="c-start" type="datetime-local" value="${contestData ? toLocalInput(contestData.start_time) : toLocalInput(Date.now())}" /></div>
        <div class="form-group" style="flex:1"><label>结束时间</label><input class="input" id="c-end" type="datetime-local" value="${contestData ? toLocalInput(contestData.end_time) : toLocalInput(Date.now() + 2 * 3600 * 1000)}" /></div>
      </div>
      <div class="form-group"><label>比赛说明（Markdown，右侧实时预览）</label><div class="live-preview"><textarea class="textarea mono" id="c-desc" rows="4">${contestData ? escapeHtml(contestData.description || '') : ''}</textarea><div class="live-preview-pane statement" id="pv-cdesc"></div></div></div>
    </div>
    <div class="card">
      <h2 class="card-title">比赛题目（输入题号，逗号分隔，按顺序编号 A/B/C…）</h2>
      <div class="form-group"><label>题目 ID（逗号隔开，如：1,2,3）</label><input class="input" id="c-problems" value="${contestData ? (contestData.problems.map((p) => p.problem_id).join(',')) : ''}" /></div>
      <div class="muted" style="font-size:12px">可用题目：#${allProbs.items.map((p) => p.id).join(' · #')}</div>
      <div class="row mt">
        <button class="btn btn-lg" id="save-contest"><i class="fa-solid fa-floppy-disk"></i>保存比赛</button>
      </div>
    </div>`;

  bindLivePreview('c-desc', 'pv-cdesc');
  document.getElementById('save-contest').addEventListener('click', async () => {
    const payload = {
      title: document.getElementById('c-title').value.trim(),
      type: document.getElementById('c-type').value,
      is_public: document.getElementById('c-public').checked,
      rated: document.getElementById('c-rated').checked,
      rating_threshold: parseInt(document.getElementById('c-threshold').value, 10) || 0,
      start_time: fromLocalInput(document.getElementById('c-start').value),
      end_time: fromLocalInput(document.getElementById('c-end').value),
      description: document.getElementById('c-desc').value,
    };
    const problemIds = document.getElementById('c-problems').value.split(/[,，\s]+/).map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
    try {
      let cid = id;
      if (id) {
        await api.put('/api/contests/' + id, payload);
      } else {
        const r = await api.post('/api/contests', payload);
        cid = r.id;
      }
      await api.put(`/api/contests/${cid}/problems`, { problem_ids: problemIds });
      toast('比赛已保存', 'success');
      nav('contest/' + cid);
    } catch (e) { toast(e.message, 'error'); }
  });
}

/* ---------- 题解与专栏 ---------- */
const ED_STATUS_BADGE = {
  draft: '<span class="badge" style="background:#8c8c8c;color:#fff">草稿</span>',
  pending: '<span class="badge" style="background:#fa8c16;color:#fff">待审核</span>',
  approved: '<span class="badge" style="background:#52c41a;color:#fff">已通过</span>',
  rejected: '<span class="badge" style="background:#ff4d4f;color:#fff">已驳回</span>',
};

async function renderEditorialDetail(id, query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const page = parseInt((query && query.get('page')) || '1', 10);
  const [data, cdata] = await Promise.all([
    api.get('/api/editorials/' + id),
    api.get(`/api/editorials/${id}/comments?page=${page}&size=10`).catch(() => ({ comments: { items: [], total: 0 } })),
    loadTaxonomy(), // 分类标签按配置表显示名渲染（改名 / 删除凭此处刷新）
  ]);
  const e = data.editorial;
  setPageTitle(e.title);
  // 编辑/删除：仅作者本人或具备对应「管理」权限；审核权限不能编辑删除
  const managePerm = e.is_article ? 'article' : 'editorial';
  const canEdit = e.is_owner || (Store.user && hasP(managePerm));
  // 重新审核：待审核/已通过/已驳回均可再次审核（草稿除外，草稿需先提交）
  const canReview = Store.user && e.status !== 'draft' && (hasP(e.is_article ? 'article_review' : 'editorial_review') || hasP(managePerm));

  // 评论接口返回 { comments: { items, total, page, size } }；兼容旧格式数组
  let commentData;
  if (cdata && cdata.comments && Array.isArray(cdata.comments.items)) commentData = cdata.comments;
  else if (cdata && Array.isArray(cdata.comments)) commentData = { items: cdata.comments, total: cdata.comments.length };
  else commentData = { items: [], total: 0 };
  const comments = commentData.items || [];
  const commentsHtml = comments.length === 0
    ? '<div class="empty" style="padding:12px 0">暂无评论</div>'
    : comments.map((c) => `
      <div class="reply-item">
        <div class="row" style="margin-bottom:4px">
          <span class="avatar" style="width:24px;height:24px;font-size:12px">${escapeHtml((c.username || '?')[0])}</span>
          ${userSpan({ uid: c.user_id, username: c.username, nickname: c.username, points_num: 0 })}
          <span class="muted">${fmtTime(c.created_at)}</span>
          <div class="spacer"></div>
          ${(Store.user && (Store.user.is_admin || Store.user.id === c.user_id)) ? `<button class="btn btn-danger btn-sm ed-del-comment" data-id="${c.id}"><i class="fa-solid fa-trash-can"></i>删除</button>` : ''}
        </div>
        <div class="statement" style="font-size:14px">${c.content_html}</div>
      </div>`).join('');

  const commentPages = renderPagination(commentData.total || 0, page, 10);

  app.innerHTML = `
    <div class="crumb"><a href="#/articles"><i class="fa-solid fa-arrow-left"></i> 返回题解与专栏</a></div>
    <div class="card" style="margin-top:8px;max-width:880px;margin-left:auto;margin-right:auto">
      <div class="row" style="align-items:baseline;gap:10px">
        <h1 class="page-heading">${escapeHtml(e.title)}</h1>
        ${ED_STATUS_BADGE[e.status] || `<span class="badge" style="background:#8c8c8c;color:#fff">${escapeHtml(e.status_label)}</span>`}
        ${e.category ? `<span class="tag" style="color:var(--accent);font-weight:600">${escapeHtml(categoryLabel(e.category))}</span>` : ''}
      </div>
      ${e.status === 'draft' && e.is_owner ? '<div class="muted mb" style="font-size:13px">这是草稿，仅自己可见；完善后点击右上角「编辑」提交审核</div>' : ''}
      ${e.status === 'pending' && e.is_owner ? `<div class="muted mb" style="font-size:13px">${e.is_article ? '文章' : '题解'}正在等待管理员审核，审核通过后对所有人可见</div>` : ''}
      ${e.status === 'rejected' && e.is_owner ? '<div class="muted mb" style="font-size:13px">该文章未通过审核，可编辑修改后重新提交</div>' : ''}
      <div class="row muted" style="gap:12px">
        ${userSpan({ uid: e.user_id, username: e.username, nickname: e.username, points_num: 0 })}
        <span>${fmtTime(e.created_at)}</span>
        ${e.is_article
          ? '<span class="tag" style="color:var(--blue)">专栏文章</span>'
          : `<a href="#/problem/${e.problem_id}">题目：${escapeHtml(e.problem_title)}</a>`}
      </div>
      <hr style="border:none;border-top:1px solid var(--border);margin:14px 0" />
      <div class="statement">${e.content_html}</div>
      <div class="row mt" style="justify-content:flex-end;gap:10px">
        ${Store.user ? `<button class="btn btn-ghost" id="like-btn">${e.liked ? '<i class="fa-solid fa-heart" style="color:var(--red)"></i>已赞' : '<i class="fa-regular fa-heart"></i>点赞'} ${e.like_count}</button>` : ''}
        ${Store.user ? `<button class="btn btn-ghost" id="fav-editorial-btn">${e.is_favorite ? '<i class="fa-solid fa-star" style="color:#faad14"></i>已收藏' : '<i class="fa-regular fa-star"></i>收藏'}</button>` : ''}
        ${canReview ? `
          <button class="btn btn-sm btn-approve" id="ed-review-approve"><i class="fa-solid fa-check"></i>通过</button>
          <button class="btn btn-danger btn-sm" id="ed-review-reject"><i class="fa-solid fa-xmark"></i>驳回</button>` : ''}
        ${canEdit ? `<a class="btn btn-ghost" href="#/editorial/edit/${e.id}"><i class="fa-solid fa-pen"></i>编辑</a>
          <button class="btn btn-danger" id="del-editorial"><i class="fa-solid fa-trash-can"></i>删除</button>` : ''}
      </div>
    </div>
    <div class="card" style="max-width:880px;margin-left:auto;margin-right:auto">
      <h2 class="card-title">评论（${commentData.total || comments.length}）<span class="muted" style="font-size:12px;font-weight:400">支持 @uid 提及</span></h2>
      ${commentsHtml}
      ${commentPages}
      <div class="mt">
        ${Store.user
          ? `<textarea class="textarea" id="ed-comment" rows="2" placeholder="写下你的评论…（支持 Markdown 与 @uid）"></textarea>
             <div class="row mt"><div class="spacer"></div><button class="btn" id="ed-comment-btn"><i class="fa-solid fa-comment"></i>评论</button></div>`
          : '<div class="empty">请先 <a href="#/login">登录</a> 后评论</div>'}
      </div>
    </div>`;

  bindPagination((p) => nav('editorial/' + id, { page: p }));

  if (Store.user) {
    document.getElementById('like-btn').addEventListener('click', async () => {
      try {
        const r = await api.post(`/api/editorials/${e.id}/like`);
        toast(r.liked ? '已点赞' : '已取消点赞', 'success');
        renderEditorialDetail(id);
      } catch (err) { toast(err.message, 'error'); }
    });
    // 收藏 / 取消收藏文章
    const favEdBtn = document.getElementById('fav-editorial-btn');
    if (favEdBtn) favEdBtn.addEventListener('click', async () => {
      try {
        if (e.is_favorite) {
          await api.del('/api/favorites/article/' + e.id);
          toast('已取消收藏', 'info');
        } else {
          await api.post('/api/favorites', { type: 'article', id: e.id });
          toast('已收藏', 'success');
        }
        renderEditorialDetail(id);
      } catch (err) { toast(err.message, 'error'); }
    });
    const cb = document.getElementById('ed-comment-btn');
    if (cb) cb.addEventListener('click', async () => {
      const content = document.getElementById('ed-comment').value.trim();
      if (!content) return toast('评论不能为空', 'error');
      try {
        await api.post(`/api/editorials/${e.id}/comments`, { content });
        toast('评论成功', 'success');
        renderEditorialDetail(id);
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  if (canEdit) {
    document.getElementById('del-editorial').addEventListener('click', async () => {
      if (!confirm('确定删除该文章吗？')) return;
      try {
        await api.del('/api/editorials/' + e.id);
        toast('已删除', 'success');
        nav(e.is_article ? 'my-articles' : 'problem/' + e.problem_id);
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  // 管理员在文章/题解页直接审核；审核完自动跳转下一篇待审核
  const revApprove = document.getElementById('ed-review-approve');
  const revReject = document.getElementById('ed-review-reject');
  if (revApprove || revReject) {
    const kind = e.is_article ? 'article' : 'editorial';
    const doReview = async (status) => {
      let reason = '';
      if (status === 'rejected') {
        reason = prompt('请填写驳回原因（必填）');
        if (!reason || !reason.trim()) return toast('驳回必须填写原因', 'error');
      }
      try {
        await api.post(`/api/editorials/${e.id}/review`, { status, reason });
        toast(status === 'approved' ? '已通过' : '已驳回', 'success');
        // 自动跳转到下一篇待审核（同类型：专栏/题解）
        const next = await api.get(`/api/admin/editorials/next-pending?kind=${kind}&after=${e.id}`);
        if (next && next.id) {
          nav('editorial/' + next.id);
        } else {
          toast('已审核完所有待审核' + (kind === 'article' ? '专栏文章' : '题解'), 'success');
          nav(kind === 'article' ? 'admin/articles' : 'admin/editorials');
        }
      } catch (err) { toast(err.message, 'error'); }
    };
    if (revApprove) revApprove.addEventListener('click', () => doReview('approved'));
    if (revReject) revReject.addEventListener('click', () => doReview('rejected'));
  }
  document.querySelectorAll('.ed-del-comment').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确定删除该评论吗？')) return;
    try { await api.del('/api/editorial-comments/' + b.dataset.id); toast('已删除', 'success'); renderEditorialDetail(id); }
    catch (err) { toast(err.message, 'error'); }
  }));
  // 评论/点赞等重渲染发生在路由外，需手动升级数学渲染，保证与正文一致
  renderMath();
}

/* 题目题解列表（独立分页页） */
async function renderEditorialsList(problemId, query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const page = parseInt(query.get('page') || '1', 10);
  const params = new URLSearchParams({ page: String(page), size: '10' });
  const [data, pd] = await Promise.all([
    api.get(`/api/problems/${problemId}/editorials/all?${params.toString()}`),
    api.get('/api/problems/' + problemId).catch(() => null),
  ]);
  const edClosed = pd && pd.problem ? !!pd.problem.editorial_closed : false;
  const artOff = Store.features && Store.features.article_enabled === false;
  const rows = data.items.length === 0
    ? '<tr><td colspan="4" class="empty">暂无题解</td></tr>'
    : data.items.map((e) => `
      <tr data-id="${e.id}">
        <td><a href="#/editorial/${e.id}" target="_blank" rel="noopener">${escapeHtml(e.title)}</a></td>
        <td>${userSpan({ uid: e.user_id, username: e.username, nickname: e.username, points_num: 0 })}</td>
        <td class="num"><i class="fa-solid fa-thumbs-up"></i> ${e.like_count} · <i class="fa-solid fa-comments"></i> ${e.comment_count || 0}</td>
        <td class="num muted">${fmtTime(e.created_at)}</td>
      </tr>`).join('');
  app.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">题解列表</h1>
      <a class="muted" href="${backHref('#/problem/' + problemId)}">← ${backLabel('返回题目')}</a>
      <div class="spacer"></div>
      ${artOff
        ? '<span class="tag" style="color:var(--red)">题解功能已关闭</span>'
        : (edClosed
          ? '<span class="tag" style="color:var(--red)">题解通道已关闭</span>'
          : `<a class="btn" href="#/editorial/new/${problemId}"><i class="fa-solid fa-pen"></i>写题解</a>`)}
    </div>
    ${edClosed ? '<div class="status-banner warn"><span style="font-weight:700"><i class="fa-solid fa-lock"></i> 本题题解提交通道已关闭</span></div>' : ''}
    <div class="card table-scroll" style="padding:0">
      <table class="table">
        <thead><tr><th>标题</th><th>作者</th><th class="num">互动</th><th class="num">时间</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderPagination(data.total, data.page, data.size)}`;
  bindPagination((p) => nav(`editorials/problem/${problemId}`, { page: p }));
  document.querySelectorAll('tbody tr[data-id]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') return;
    window.open('#/editorial/' + tr.dataset.id, '_blank', 'noopener');
  }));
}

async function renderEditorialEditor(id, problemId) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  setPageTitle(id ? '编辑文章' : (problemId ? '写题解' : '写文章'));
  if (!Store.user) {
    app.innerHTML = '<div class="empty">请先 <a href="#/login">登录</a></div>';
    return;
  }
  // 功能关闭：禁止发布新文章/题解（管理员同样受限；编辑已有内容不受限）
  if (!id && Store.features && Store.features.article_enabled === false) {
    app.innerHTML = '<div class="empty">题解与专栏功能已关闭，无法发布新内容</div>';
    return;
  }
  let existing = null;
  let pid = problemId && String(problemId) !== '0' ? parseInt(problemId, 10) : null;
  await loadTaxonomy(); // 分类下拉来自接口（后台可增删改），确保拿到最新分类
  if (id) {
    const d = await api.get('/api/editorials/' + id);
    existing = d.editorial;
    pid = existing.problem_id || null;
  }
  // 文章模式：不关联题目（#/editorial/new/0）
  const isArticle = !pid;
  let problemLink = '';
  if (!isArticle) {
    try {
      const problem = await api.get('/api/problems/' + pid);
      problemLink = `<a class="muted" href="#/problem/${pid}">题目：${escapeHtml(problem.problem.title)}</a>`;
    } catch { /* ignore */ }
  }

  // 分类选项：题解固定系统分类「题解」（key = CAT_SOLUTION）；专栏仅提供真实分类（不含「未分类 / 题解」），
  // 新建文章须先选择。
  // v2.7.0：分类改为读接口（后台「专栏管理 → 分类管理」可增删改），option 的 value 始终是**内部 key**，
  // 显示的是配置表里的显示名 —— 因此分类改名不影响已有文章的分类引用；内置分类的 key 是英文 slug。
  const ARTICLE_CATS = categoryList().filter((c) => c.key !== CAT_UNCATEGORIZED && c.key !== CAT_SOLUTION);
  let catOptions;
  if (!isArticle) {
    catOptions = `<option value="${CAT_SOLUTION}" selected>${escapeHtml(categoryLabel(CAT_SOLUTION))}（关联题目）</option>`;
  } else {
    const current = existing ? existing.category : '';
    const legacyWc = existing && existing.category === CAT_UNCATEGORIZED;
    // v2.7.8：专栏广场的「写文章」页也允许直接选择「题解」——选中后会自动要求填写关联题目
    // （服务端 createArticle 对 category=solution + problem_id 的组合是支持的）
    catOptions = '<option value="">请选择分类…</option>'
      + ARTICLE_CATS.map((c) => `<option value="${escapeHtml(c.key)}" ${current === c.key ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')
      + `<option value="${CAT_SOLUTION}" ${current === CAT_SOLUTION ? 'selected' : ''}>${escapeHtml(categoryLabel(CAT_SOLUTION))}（需关联题目）</option>`
      + (legacyWc ? `<option value="${CAT_UNCATEGORIZED}" selected>${escapeHtml(categoryLabel(CAT_UNCATEGORIZED))}（原分类，提交前请重新选择）</option>` : '');
  }
  const isDraft = existing && existing.status === 'draft';
  // 分类「题解」必须关联题目；其它分类不能关联题目
  const initCat = (!isArticle || (existing && existing.category === CAT_SOLUTION)) ? CAT_SOLUTION : '';
  const initProb = existing && existing.problem_id ? existing.problem_id : (isArticle ? '' : pid);
  const problemField = `
    <div class="form-group" id="problem-field">
      <label>关联题目 <span id="problem-req" style="color:var(--red)">${initCat === CAT_SOLUTION ? '（必填）' : ''}</span></label>
      <input class="input" id="e-problem" placeholder="填写题目 ID" value="${initProb}" style="width:200px" ${initCat === CAT_SOLUTION ? '' : 'disabled'} />
      <div class="muted" style="font-size:12px">分类为「题解」时必须关联题目；其它分类不能关联题目。</div>
    </div>`;

  app.innerHTML = `
    <div class="crumb"><a href="${isArticle ? '#/articles' : (pid ? '#/problem/' + pid : '#/my-articles')}"><i class="fa-solid fa-arrow-left"></i> ${isArticle ? '返回题解与专栏' : (pid ? '返回题目' : '返回我的文章')}</a></div>
    <div class="page-header">
      <h1 class="page-title">${id ? (isArticle ? '编辑文章' : '编辑题解') : (isArticle ? '写文章' : '写题解')}</h1>
      ${isArticle ? '<span class="tag" style="color:var(--blue)">专栏文章</span>' : problemLink}
      ${isDraft ? '<span class="badge" style="background:#8c8c8c;color:#fff">草稿</span>' : ''}
    </div>
    <div class="card">
      <div class="form-group"><label>标题 *</label><input class="input" id="e-title" value="${existing ? escapeHtml(existing.title) : ''}" /></div>
      ${problemField}
      <div class="form-group"><label>分类 *（提交审核时必须选择；保存草稿可不选）</label>
        <select class="input" id="e-category" style="width:auto">${catOptions}</select>
      </div>
      <div class="form-group"><label>内容（Markdown/LaTeX）*（左侧输入，右侧实时预览）</label>
        <div class="live-preview editor-preview">
          <textarea class="textarea mono" id="e-content" rows="14">${existing ? escapeHtml(existing.content || '') : ''}</textarea>
          <div class="live-preview-pane statement" id="e-preview-box"></div>
        </div>
      </div>
      <div class="row">
        <div class="spacer"></div>
        <button class="btn btn-ghost" id="e-save-draft"><i class="fa-regular fa-floppy-disk"></i>保存草稿</button>
        <button class="btn btn-lg" id="e-save"><i class="fa-solid fa-paper-plane"></i>提交审核</button>
      </div>
    </div>`;

  async function save(submit) {
    const title = document.getElementById('e-title').value.trim();
    const content = document.getElementById('e-content').value;
    const category = document.getElementById('e-category').value;
    if (!title || !content.trim()) return toast('标题和内容不能为空', 'error');
    if (submit && (!category || category === CAT_UNCATEGORIZED)) return toast('提交审核前请选择有效分类（不能为「未分类」）', 'error');
    const payload = { title, content, category, submit };
    // 分类「题解」必须关联题目；其它分类不能关联题目
    const probInput = document.getElementById('e-problem');
    if (probInput) {
      if (category === CAT_SOLUTION) {
        if (!probInput.value.trim()) return toast('分类「题解」必须填写关联题目 ID', 'error');
        payload.problem_id = probInput.value.trim();
      } else {
        payload.problem_id = null;
      }
    }
    try {
      if (id) {
        const r = await api.put('/api/editorials/' + id, payload);
        toast(submit ? '已提交审核' : '已保存草稿', 'success');
        nav('editorial/' + id);
      } else if (isArticle) {
        const r = await api.post('/api/articles', payload);
        toast(submit ? '已提交，等待管理员审核' : '已保存草稿', 'success');
        nav('editorial/' + r.id);
      } else {
        const r = await api.post(`/api/problems/${pid}/editorials`, payload);
        toast(submit ? '已提交，等待管理员审核' : '已保存草稿', 'success');
        nav('editorial/' + r.id);
      }
    } catch (e) { toast(e.message, 'error'); }
  }

  document.getElementById('e-save').addEventListener('click', () => save(true));
  document.getElementById('e-save-draft').addEventListener('click', () => save(false));
  // 分类联动：题解 → 关联题目必填；其它分类 → 不能关联
  const catSel = document.getElementById('e-category');
  if (catSel) {
    catSel.addEventListener('change', () => {
      const isSol = catSel.value === CAT_SOLUTION;
      const req = document.getElementById('problem-req');
      const pInput = document.getElementById('e-problem');
      if (req) req.textContent = isSol ? '（必填）' : '';
      if (pInput) {
        pInput.disabled = !isSol;
        if (!isSol) pInput.value = '';
      }
    });
  }

  // Markdown/LaTeX 实时预览
  bindLivePreview('e-content', 'e-preview-box');
}

/* ---------- 管理后台（按权限位展示） ---------- */
const PERM_KEYS = ['problem', 'user', 'editorial_review', 'article_review', 'contest', 'discussion', 'article', 'editorial'];
const PERM_NAMES = { problem: '题目管理', user: '用户管理', editorial_review: '题解审核', article_review: '专栏审核', contest: '比赛管理', discussion: '讨论管理', article: '专栏管理', editorial: '题解管理' };

function hasP(key) {
  if (!Store.user) return false;
  if (Store.user.is_superadmin) return true;
  return Array.isArray(Store.user.permissions) && Store.user.permissions.includes(key);
}

function adminTabs(active) {
  const tabs = [];
  if (hasP('problem')) tabs.push(['problems', '题目管理', '#/admin', 'fa-file-code']);
  if (hasP('editorial_review') || hasP('editorial')) tabs.push(['editorials', '题解管理', '#/admin/editorials', 'fa-book-open']);
  if (hasP('article_review') || hasP('article')) tabs.push(['articles', '专栏管理', '#/admin/articles', 'fa-newspaper']);
  if (hasP('contest')) tabs.push(['contests', '比赛管理', '#/admin/contests', 'fa-trophy']);
  if (hasP('user')) tabs.push(['users', '用户管理', '#/admin/users', 'fa-users']);
  if (hasP('discussion')) tabs.push(['discussions', '讨论管理', '#/admin/discussions', 'fa-comments']);
  if (Store.user && Store.user.is_superadmin) tabs.push(['rejudge', '题目重判', '#/admin/rejudge', 'fa-rotate-right']);
  // v2.7.0：「清理多余数据」「批量生成用户」「批量删除」都不是管理后台的独立入口，
  // 已并入**系统设置**（#/settings/cleanup、#/settings/batch-users、#/settings/batch-delete）。
  // 旧地址 #/admin/cleanup、#/admin/batch-users、#/admin/batch-delete 保留为重定向（见 route()），
  // 因此下面这份后台管理菜单里不会出现这三项。
  if (Store.user && Store.user.username === 'admin') tabs.push(['feedbacks', '反馈审核', '#/admin/feedbacks', 'fa-flag']);
  if (tabs.length === 0) return '<div class="empty">你没有管理后台权限</div>';
  // v2.7.3 两侧按钮对齐：这一行最左边的分块按钮与最右边的「使用说明」按钮必须**同高、同一基线**
  // （原来「使用说明」用 btn-sm，只有约 33px 高，比左侧的 38px 按钮矮一截、上下都不齐），
  // 左侧贴齐容器左内边缘、右侧贴齐容器右内边缘（.spacer 把右侧按钮顶到最右）。
  return `<div class="row admin-tabs" style="gap:8px;margin:20px 0 22px;flex-wrap:wrap">
    ${tabs.map(([k, label, href, icon]) => `<a class="btn ${active === k ? '' : 'btn-ghost'}" href="${href}"><i class="fa-solid ${icon}"></i>${label}</a>`).join('')}
    <div class="spacer"></div>
    <a class="btn btn-ghost" href="/docs/USAGE.md#三管理员其他后台功能" target="_blank" rel="noopener"><i class="fa-solid fa-book"></i>使用说明</a>
  </div>`;
}

/* 后台「父页面 → 子页面」二级导航（v2.7.0）：讨论管理下的「帖子管理 / 板块管理」、
   专栏管理下的「文章审核 / 分类管理」。用 <a href="#/…"> 走站内 hash 路由：切换不整页刷新，
   浏览器前进 / 后退天然可用，地址可分享、刷新可直达。父页面列表项恒为第一个（key='list'）。
   注意：只渲染调用方已判定可见的子标签 —— 两个子页面都仅超级管理员可用，非超管整条子导航不渲染。 */
const ADMIN_SUBTABS = {
  discussions: [
    ['list', '帖子管理', '#/admin/discussions', 'fa-list'],
    ['boards', '板块管理', '#/admin/discussions/boards', 'fa-layer-group'],
  ],
  articles: [
    ['list', '文章审核', '#/admin/articles', 'fa-list-check'],
    ['categories', '分类管理', '#/admin/articles/categories', 'fa-tags'],
  ],
};

/** 子页面导航 HTML；active 为当前子页面 key（父页面列表用 'list'）。当前项高亮 .chip.active */
function adminSubTabs(parent, active) {
  const items = ADMIN_SUBTABS[parent];
  if (!items) return '';
  return `<div class="tag-chips admin-subtabs">
    ${items.map(([k, label, href, icon]) =>
      `<a class="chip${active === k ? ' active' : ''}" href="${href}"><i class="fa-solid ${icon}"></i>${label}</a>`).join('')}
  </div>`;
}

/**
 * 后台**统一页头**（v2.7.0）：管理后台所有页面都走这一个骨架，保证各页标题与按钮位置一一对应。
 * 结构（顺序固定，CSS 见 style.css 的“后台统一页头”）：
 *   .admin-head
 *     ├─ .admin-head-row      ← 大标题（.page-title，最上面 / 固定字号 24px / 固定左边距）+ 同行右侧的 .admin-head-actions
 *     ├─ .admin-head-desc     ← 可选：标题下的一句话说明
 *     ├─ .admin-subtabs       ← 可选：子标签，**紧跟标题之后**（在搜索条之前）
 *     └─ .admin-filter        ← 可选：搜索 / 筛选条，统一在标题下方
 * 之后再接页面内容（卡片 / 表格 / 分页）。
 * @param {{title?:string, actions?:string, meta?:string, desc?:string, subtabs?:string, filter?:string}} opts
 */
function adminHead(opts) {
  const o = opts || {};
  return `<div class="admin-head">
    <div class="admin-head-row">
      <h1 class="page-title">${o.title || ''}</h1>
      ${o.meta ? `<span class="admin-head-meta">${o.meta}</span>` : ''}
      <div class="spacer"></div>
      ${o.actions ? `<div class="admin-head-actions">${o.actions}</div>` : ''}
    </div>
    ${o.desc ? `<p class="admin-head-desc muted">${o.desc}</p>` : ''}
    ${o.subtabs || ''}
    ${o.filter ? `<div class="admin-filter">${o.filter}</div>` : ''}
  </div>`;
}

/** 带子页面的后台标签：tab → { 子页面 key: 子页面标题 }（仅超管可见的子页面，标题用于浏览器标签页）。
 *  v2.7.7：用户要求**子页面的页面标题一律显示父级名称** —— 讨论线的两个子页面（帖子管理 / 板块管理）
 *  浏览器标签页都写「讨论管理」，专栏线的两个子页面（文章审核 / 分类管理）都写「专栏管理」。
 *  注意：只统一**页面标题**（document.title + 页头 <h1>）；页面顶部的子标签按钮文字保持
 *  「帖子管理 / 板块管理 / 文章审核 / 分类管理」不变（见 ADMIN_SUBTABS），否则用户无法区分当前在哪一页；
 *  子页面卡片内部的 <h2 class="card-title"> 也仍是「板块管理 / 分类管理」，它是**内容块标题**不是页面标题。 */
const ADMIN_SUB_TITLES = {
  discussions: { boards: '讨论管理' },
  articles: { categories: '专栏管理' },
};

async function renderAdminPanel(tab, sub) {
  if (!Store.user || !Store.user.is_admin) {
    app.innerHTML = '<div class="empty">需要管理员权限</div>';
    return;
  }
  const ADMIN_TITLES = { problems: '题目管理', users: '用户管理', editorials: '题解管理', articles: '专栏管理', contests: '比赛管理', discussions: '讨论管理', settings: '系统设置', feedbacks: '反馈审核', rejudge: '题目重判' };
  const subTitle = (ADMIN_SUB_TITLES[tab] || {})[sub || ''];
  setPageTitle(subTitle || ADMIN_TITLES[tab] || '管理后台');
  const deny = (perm, label) => {
    app.innerHTML = `${adminTabs(tab)}<div class="empty">${label}需要「${perm}」权限</div>`;
  };
  if (tab === 'rejudge') {
    if (!Store.user.is_superadmin) {
      app.innerHTML = `${adminTabs(tab)}<div class="empty">题目重判需要超级管理员权限</div>`;
      return;
    }
    return renderAdminRejudge();
  }
  if (tab === 'users') {
    if (!hasP('user')) return deny('用户管理', '用户管理');
    return renderAdminUsers();
  }
  if (tab === 'discussions') {
    if (!hasP('discussion')) return deny('讨论管理', '讨论管理');
    return renderAdminDiscussions(sub || '');
  }
  if (tab === 'settings') { nav('settings'); return; } // 系统设置已独立
  if (false) {
    if (Store.user.username !== 'admin') {
      app.innerHTML = `${adminTabs(tab)}<div class="empty">系统设置仅最高管理员（admin）可用</div>`;
      return;
    }
    return renderAdminSettings();
  }
  if (tab === 'feedbacks') {
    if (Store.user.username !== 'admin') {
      app.innerHTML = `${adminTabs(tab)}<div class="empty">反馈审核仅最高管理员（admin）可用</div>`;
      return;
    }
    return renderAdminFeedbacks();
  }
  if (tab === 'editorials') {
    if (!hasP('editorial_review') && !hasP('editorial')) return deny('题解审核', '题解管理');
    return renderAdminEditorials('editorial');
  }
  if (tab === 'articles') {
    if (!hasP('article_review') && !hasP('article')) return deny('专栏审核', '专栏管理');
    return renderAdminEditorials('article', sub || '');
  }
  if (tab === 'contests') {
    if (!hasP('contest')) return deny('比赛管理', '比赛管理');
    return renderAdminContests();
  }
  if (tab === 'problems') {
    if (!hasP('problem')) {
      // 无题目管理权限：跳转到第一个可用模块
      const first = ['editorials', 'articles', 'contests', 'users', 'discussions'].find((t) => {
        if (t === 'editorials') return hasP('editorial_review') || hasP('editorial');
        if (t === 'articles') return hasP('article_review') || hasP('article');
        if (t === 'contests') return hasP('contest');
        if (t === 'users') return hasP('user');
        if (t === 'discussions') return hasP('discussion');
        return false;
      });
      if (first) return nav('admin/' + first);
      app.innerHTML = '<div class="empty">你没有管理后台权限</div>';
      return;
    }
    return renderAdminList();
  }
  return renderAdminList();
}

/* ---------- 系统设置（仅超级管理员） ---------- */
/* ---------- 系统设置：独立页面 + 分块导航（不再挂在管理后台的标签里） ---------- */
const SETTINGS_SECTIONS = [
  { key: 'appearance', name: '网站外观', icon: 'fa-palette', match: ['网站外观'] },
  { key: 'mail', name: '邮箱与验证', icon: 'fa-envelope-circle-check', match: ['邮箱验证与邮件服务'] },
  // 本块由「功能开关」改名为「功能设置」（图标由 fa-toggle-on 改为齿轮 fa-gear）；路由 key 仍是 features，地址不变。
  { key: 'features', name: '功能设置', icon: 'fa-gear', match: ['功能设置', '功能开关'] },
  { key: 'judge', name: '评测设置', icon: 'fa-gauge-high', match: ['评测设置', '评测性能'] },
  { key: 'site', name: '页面与版权', icon: 'fa-file-lines', match: ['站点页面与版权'] },
  { key: 'update', name: '版本更新', icon: 'fa-cloud-arrow-down', match: ['版本更新'] },
];
/** 独立子页面（点分类直接进入，不再作为设置里的卡片）。
 *  v2.7.0：清理多余数据 / 批量生成用户 / 批量删除全部并入系统设置 —— 地址统一为 #/settings/*，
 *  进入后侧边栏高亮「系统设置」；旧的 #/admin/cleanup 与 #/admin/batch-* 保留为重定向（见 route()），
 *  后台管理菜单（adminTabs）里不再出现这三项，不会留下死链接。 */
const SETTINGS_PAGE_LINKS = [
  // v2.8.2：「全站积分结算」从「功能设置」页里搬出来，成为独立子页面；v2.8.5 起它归属「功能设置」，
  // 作为**二级页面** #/settings/features/points 注册在下面的 SETTINGS_SUBPAGES（不再是本数组的一级分区）。
  { key: 'cleanup', name: '清理多余数据', icon: 'fa-broom', href: '#/settings/cleanup' },
  { key: 'batch-users', name: '批量生成用户', icon: 'fa-users-gear', href: '#/settings/batch-users' },
  { key: 'batch-delete', name: '批量删除', icon: 'fa-triangle-exclamation', href: '#/settings/batch-delete' },
];
/** 一级分区下的**二级页面**（v2.8.5）：父分区 key → 子页面列表。
 *  渲染位置：在 settingsTabs 里紧跟父项（父项保持可见、可点回父页面），子项本身才是「当前项」；
 *  地址形如 #/settings/<父 key>/<子 key>，路由与侧边栏高亮仍按 parts[1]==='settings' 走「系统设置」。
 *  目前只有「功能设置 → 积分计算」一项（站长要求：积分计算是功能设置的二级页面）。 */
const SETTINGS_SUBPAGES = {
  features: [
    // v2.9.0：站长要求删除上方导航里的「积分计算」子项 —— 入口只保留「功能设置」卡片里的那个按钮
  ],
};
const SETTINGS_DEFAULT_SECTION = 'appearance';

/** 当前站点版本号（带缓存；用于系统设置导航显示版本徽章） */
let _siteVersion = '';
async function siteVersion() {
  if (_siteVersion) return _siteVersion;
  try { const d = await api.get('/api/version'); _siteVersion = (d && d.current) || ''; } catch { /* 离线忽略 */ }
  return _siteVersion;
}

/** 系统设置的分块导航：走后台统一页头（adminHead）——大标题在最上面、版本号与右侧链接跟在标题同行，
 *  说明文字在标题下方，分块按钮作为「子标签」紧跟其后；因此系统设置各页与其它后台页面标题位置一致。
 *  v2.8.5：第三参数 sub 表示「二级页面」（如 active='features', sub='points' → #/settings/features/points）。
 *  此时**父项与子项都会渲染在子标签行里**：父项「功能设置」保持可见（btn-ghost，点回父页面），
 *  子项「积分计算」紧跟其后并作为当前项高亮（btn + aria-current），中间用 › 表示归属关系。 */
function settingsTabs(active, version, sub) {
  const allKeys = [...SETTINGS_SECTIONS.map((s) => s.key), ...SETTINGS_PAGE_LINKS.map((p) => p.key)];
  const subItem = (sub && (SETTINGS_SUBPAGES[active] || []).find((x) => x.key === sub)) || null;
  // 当前项：二级页面用「父/子」键，否则为一级分区键（非法值回落到默认分区）
  const cur = subItem ? `${active}/${sub}` : (allKeys.includes(active) ? active : SETTINGS_DEFAULT_SECTION);
  const items = [];
  for (const s of SETTINGS_SECTIONS) {
    items.push({ key: s.key, name: s.name, icon: s.icon, href: '#/settings/' + s.key });
    // 二级页面紧跟自己的父项插入，读起来就是「功能设置 › 积分计算」
    if (subItem && s.key === active) {
      items.push({ key: cur, name: subItem.name, icon: subItem.icon, href: subItem.href, child: true, parentName: s.name });
    }
  }
  for (const p of SETTINGS_PAGE_LINKS) items.push({ key: p.key, name: p.name, icon: p.icon, href: p.href });
  // 分块按钮与后台子标签用同一套骨架（.admin-subtabs）：位置固定在标题（与说明）之后、内容之前
  const chips = `<div class="row settings-nav-chips admin-subtabs" style="gap:8px;margin:12px 0 20px;flex-wrap:wrap">
      ${items.map((it) => {
        const on = it.key === cur;
        // 二级页面：父项保持可见（ghost 可点回），子项前面加 › 并作为当前项
        const icon = it.child ? '<i class="fa-solid fa-angle-right" style="opacity:.55"></i>' : `<i class="fa-solid ${it.icon}"></i>`;
        const title = it.child ? ` title="${escapeHtml(it.parentName + ' 的二级页面')}"` : '';
        return `<a class="btn ${on ? '' : 'btn-ghost'}" href="${it.href}"${title}${on ? ' aria-current="page"' : ''}>${icon}${it.name}</a>`;
      }).join('')}
    </div>`;
  return `<div class="settings-nav">
    ${adminHead({
      title: '系统设置',
      meta: version ? `<span class="badge" style="background:var(--accent-soft,#eaf4ff);color:var(--accent);font-size:11px;font-weight:700">v${escapeHtml(version)}</span> <span id="ver-latest" style="font-size:12px"></span>` : '<span id="ver-latest" style="font-size:12px"></span>',
      actions: `<a class="muted" style="font-size:12px" href="/docs/CHANGELOG.md" target="_blank" rel="noopener">版本日志</a>`,
      desc: '网站级配置（与「管理后台」分开）：点下面的分类逐块查看与修改，改完记得点各块底部的保存按钮。',
      subtabs: chips,
    })}
  </div>`;
}

/** 把已渲染的卡片按分块归入各分块，只显示当前分块（其余 display:none，DOM 保留以便绑定事件）
 *  卡片分块以 HTML 上的 data-sec 为准（各卡片标题已按需求删除，改为纯导航切换）。 */
function applySettingsSection(active) {
  try {
    const allKeys = [...SETTINGS_SECTIONS.map((s) => s.key), ...SETTINGS_PAGE_LINKS.map((p) => p.key)];
  const cur = allKeys.includes(active) ? active : SETTINGS_DEFAULT_SECTION;
    const cards = [...document.querySelectorAll('.settings-body > .card')];
    if (!cards.length) return;
    const known = new Set();
    for (const card of cards) {
      // 优先用 data-sec；没有标记时回退到旧的「按卡片标题关键字匹配」
      let key = card.dataset.sec || '';
      if (!key) {
        const title = (card.querySelector('.card-title') || {}).textContent || '';
        const sec = SETTINGS_SECTIONS.find((s) => s.match.some((kw) => title.includes(kw)));
        key = sec ? sec.key : 'other';
      }
      known.add(key);
      card.dataset.sec = key;
      card.style.display = key === cur ? '' : 'none';
    }
  } catch { /* ignore */ }
}

/* ---------- 全站积分结算 / 积分计算：换算 / 状态渲染工具（模块级，供「功能设置 → 积分计算」页使用） ----------
 * v2.8.2：这一块原来定义在 renderAdminSettings 内部（「功能设置」页里的嵌块），现在整块 UI 搬到
 * 独立页面；v2.8.5 起该页面是「功能设置」的二级页面 #/settings/features/points（见 renderAdminPointsSettle），
 * 所以工具函数抽到模块级共用，避免在页面之间复制一份。
 * 对**全部用户**跑一遍 computePoints 并落库快照（points_settlement），供排行榜 / 个人中心读取。
 * 模式三选一：**realtime 实时（默认）/ interval 定时自动 / manual 手动结算**。
 * 存储统一用**分钟**（既有键 points_settle_interval_minutes 不变），但**界面与提示一律用「小时 / 天」**：
 *   · 数值输入 + 单位下拉（小时 / 天），范围 **1 小时 ~ 30 天**（60 ~ 43200 分钟）；
 *   · 读回时反向换算成最自然的单位（2880 → 2 天，360 → 6 小时，90 → 1.5 小时）；
 *   · 状态行「下次预计」同样用小时 / 天表述（不出现「分钟」字样）。
 * 取值必须与 src/users.js 的 POINTS_SETTLE_* 常量保持一致。 */
const PS_MIN_MINUTES = 60;       // = users.POINTS_SETTLE_MIN_MINUTES（1 小时）
const PS_MAX_MINUTES = 43200;    // = users.POINTS_SETTLE_MAX_MINUTES（30 天）
const PS_DEFAULT_MINUTES = 360;  // = users.POINTS_SETTLE_DEFAULT_MINUTES（6 小时）
const PS_MODES = ['manual', 'interval', 'realtime'];
/** 分钟 → 最自然的「小时 / 天」单位（整除 1 天 → 天；整除 1 小时 → 小时；否则小数小时） */
const psNatural = (minutes) => {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m > 0 && m % 1440 === 0) return { value: m / 1440, unit: 'day', label: '天' };
  if (m > 0 && m % 60 === 0) return { value: m / 60, unit: 'hour', label: '小时' };
  return { value: Math.round((m / 60) * 100) / 100, unit: 'hour', label: '小时' };
};
/** 分钟 → 中文「小时 / 天」文案（如 360 → 「6 小时」、2880 → 「2 天」） */
const psText = (minutes) => { const u = psNatural(minutes); return `${u.value} ${u.label}`; };
/** 距某个时间戳还有多久（小时 / 天口径，不足 1 小时说「不到 1 小时」） */
const psRemainText = (ms) => {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 3600) return '不到 1 小时后';
  if (sec < 86400) return `${Math.max(1, Math.round(sec / 3600))} 小时后`;
  const d = sec / 86400;
  return `${d >= 10 ? Math.round(d) : Math.round(d * 10) / 10} 天后`;
};
/** 分钟值夹到合法区间（非法 / 未设置 → 默认 6 小时） */
const psClampMinutes = (v) => Math.max(PS_MIN_MINUTES, Math.min(PS_MAX_MINUTES, parseInt(v, 10) || PS_DEFAULT_MINUTES));
/** 状态区：一句模式说明 + 4 枚信息芯片（上次结算 / 耗时 / 覆盖人数 / 下次预计） */
const pointsStatusHtml = (st) => {
  const mode = PS_MODES.includes(st.points_settle_mode) ? st.points_settle_mode : 'realtime';
  const minutes = psClampMinutes(st.points_settle_interval_minutes);
  const last = st.points_settle_last_run ? fmtTime(Number(st.points_settle_last_run)) : '从未结算';
  const cost = Number(st.points_settle_last_ms) > 0 ? `${(Number(st.points_settle_last_ms) / 1000).toFixed(2)} 秒` : '—';
  const covered = Number(st.points_settle_last_users) > 0 ? `${Number(st.points_settle_last_users)} 人` : `${Number(st.points_snapshot_users) || 0} 人（快照）`;
  const modeLine = mode === 'realtime' ? '实时结算（默认）：显示始终取实时计算值，快照只作历史'
    : mode === 'interval' ? `每 ${psText(minutes)} 自动结算：距上次结算超过该间隔自动重算一次快照`
      : '手动结算：只在点「立即结算全站积分」时重算一次快照';
  const next = mode === 'manual' ? '手动触发'
    : mode === 'realtime' ? '实时（每分钟刷新快照）'
      : (st.points_settle_next_run ? psRemainText(Number(st.points_settle_next_run) - Date.now()) : '不到 1 小时后');
  const chip = (k, v) => `<span class="settle-chip"><span class="settle-chip-k">${k}</span><span class="settle-chip-v">${escapeHtml(String(v))}</span></span>`;
  return `<div class="settle-mode-line">${escapeHtml(modeLine)}</div>
      <div class="settle-chips">${chip('上次结算', last)}${chip('耗时', cost)}${chip('覆盖人数', covered)}${chip('下次预计', next)}</div>`;
};

async function renderAdminSettings(section) {
  // v2.9.0：系统设置（含各二级页）此前没有设置**浏览器标签页标题**（站长反馈）→ 统一为「系统设置」
  setPageTitle('系统设置');
  app.innerHTML = '<div class="loading">加载中…</div>';
  let s = null;
  try { s = await api.get('/api/settings'); } catch (e) {
    app.innerHTML = `${settingsTabs(section)}<div class="empty">加载设置失败：${escapeHtml(e.message)}</div>`;
    return;
  }

  const logoPreview = s.site_logo
    ? `<img src="${escapeHtml(s.site_logo)}" style="height:36px;border-radius:6px" onerror="this.style.display='none'" />`
    : '<span class="muted">未设置，使用默认图标</span>';

  /* v2.8.3（⑨）：站点 Logo 的文本框是系统设置里唯一会出现「内容过大」的输入框 ——
   * 上传图片后前端写进 #s-logo-url 的是完整 data URL（1MB 图片 ≈ 19.6 万字符，本机实测库值 147187 字符），
   * 这种长串既没法用键盘编辑、又极易被误删一个字符而静默损坏。
   * 处置（与「测试数据过大」同一套思路）：值长度 > 200 时把**真实值渲染出来并设为只读**
   * （不可编辑、可选中 / 复制，旁边给「复制」按钮与说明），短 URL / 空值依旧可正常编辑。
   * 关键点：1) readonly 只挡用户输入，程序写入 .value 照常；2) 保存读的是 .value（apVal），
   * 所以「保存网站外观」会把原值原样提交 —— 顺带修掉「data URL 不渲染进输入框 → 点保存把已上传的 Logo 清空」的老问题。 */
  const LOGO_LONG_LIMIT = 200;
  const logoRaw = String(s.site_logo || '');
  const logoLong = logoRaw.length > LOGO_LONG_LIMIT;

  /* 后台保存的各页面宽度（JSON 字符串或对象） */
  const apWidthCfg = (() => {
    let v = s.page_widths;
    if (typeof v === 'string') { try { v = JSON.parse(v || '{}'); } catch { v = {}; } }
    return v && typeof v === 'object' ? v : {};
  })();

  /* 积分计算：整块 UI 是「功能设置」的二级页面（#/settings/features/points，见 renderAdminPointsSettle），
   * 本页（#/settings/features）只提供一眼可见的入口卡片；
   * 换算 / 状态渲染的工具函数在模块级 ps* / pointsStatusHtml 中共用，本页不再包含该区块。 */

  /* ---------- 网站外观：颜色 / 字体字段小工具 ---------- */
  const FONT_OPTIONS = [['', '默认（系统字体）'],
    ['-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif', '无衬线（系统默认）'],
    ['"PingFang SC","Microsoft YaHei",sans-serif', '黑体 / 无衬线'],
    ['Georgia,"Times New Roman",serif', '衬线（Georgia）'],
    ['"KaiTi","STKaiti",serif', '楷体'],
    ['"SimSun","Songti SC",serif', '宋体'],
    ['"Comic Sans MS","Segoe UI",cursive', '手写体（Comic Sans）']];
  const CODE_FONT_OPTIONS = [['', '默认（等宽）'],
    ['Consolas,"Courier New",monospace', 'Consolas'],
    ['"JetBrains Mono","Fira Code",Consolas,monospace', 'JetBrains Mono / Fira Code'],
    ['Menlo,Monaco,"Courier New",monospace', 'Menlo / Monaco'],
    ['"Cascadia Code",Consolas,monospace', 'Cascadia Code']];
  const colorField = (id, label, val, defColor) => {
    const v = String(val || '');
    const pick = /^#[0-9a-fA-F]{6}$/.test(v) ? v : defColor;
    return `<div class="form-group" style="flex:0 0 210px"><label>${label}</label>
      <div class="row" style="gap:8px;align-items:center">
        <input type="color" id="${id}-picker" value="${pick}" style="width:44px;height:34px;padding:2px;border:1px solid var(--border);border-radius:8px;background:none" />
        <input class="input" id="${id}" value="${escapeHtml(v)}" placeholder="留空=默认" style="flex:1" />
      </div></div>`;
  };
  const fontSelect = (id, label, val, options) => `<div class="form-group" style="flex:1 1 240px"><label>${label}</label>
      <select class="input" id="${id}">
        ${options.map(([v, text]) => `<option value="${escapeHtml(v)}" ${String(val || '') === v ? 'selected' : ''}>${text}</option>`).join('')}
      </select></div>`;

  app.innerHTML = `${settingsTabs(section, s.version || await siteVersion())}
    <div class="settings-body">

    <div class="card" data-sec="update">
      <div class="muted" style="font-size:12px;margin-bottom:12px">
        更新只覆盖程序文件；数据库、题库测试数据、题目附件与用户头像保存在数据目录中，不受影响。
        更新前默认会先把数据库备份到 <code>data/backup/</code>，更新完成后服务会自动重启（页面随后自动刷新）。
        详细步骤与手动更新方法见 <a href="/docs/UPDATE.md" target="_blank" rel="noopener">版本更新指南</a>。
      </div>
      <div id="upd-box"><span class="muted" style="font-size:13px">正在检查版本信息…</span></div>
    </div>

    <div class="card" data-sec="appearance">
      <div class="muted" style="font-size:12px;margin-bottom:12px">
        集中定制网站外观：站名与 Logo、标题样式、主题配色、夜间配色、排版与字体、全站页面宽度。
        留空的项表示使用默认样式；修改时即时预览，点「保存网站外观」后对所有访客生效。
      </div>
      <h3 class="ap-sub">站名与 Logo</h3>
      <div class="form-group"><label>网站名称（显示在侧边栏与浏览器标题）</label><input class="input" id="s-site-name" value="${escapeHtml(s.site_name || '')}" maxlength="40" /></div>
      <div class="form-group">
        <label>站点 Logo（上传图片或填写 URL；留空使用默认图标）</label>
        <div class="row" style="gap:12px;align-items:center">
          <span id="s-logo-preview">${logoPreview}</span>
          <input type="file" id="s-logo-file" accept="image/png,image/jpeg,image/gif,image/webp" />
          <input class="input${logoLong ? ' is-readonly' : ''}" id="s-logo-url" value="${escapeHtml(logoRaw)}" placeholder="或输入 Logo URL" style="flex:1"${logoLong ? ' readonly' : ''}${logoLong ? ' title="内容较长，已设为只读，可复制（需要修改请重新上传图片或点「清除」）"' : ''} />
          <button class="btn btn-ghost btn-sm" id="s-logo-copy" type="button"${logoLong ? '' : ' hidden'}><i class="fa-regular fa-copy"></i>复制</button>
          ${s.site_logo ? '<button class="btn btn-ghost btn-sm" id="s-logo-clear" type="button"><i class="fa-solid fa-eraser"></i>清除</button>' : ''}
        </div>
        <div class="muted" style="font-size:12px">Logo 图片 ≤ 1MB，将替换侧边栏顶部的默认图标</div>
        <div class="muted logo-readonly-hint" id="s-logo-hint" style="font-size:12px"${logoLong ? '' : ' hidden'}><i class="fa-solid fa-lock"></i> 内容较长（<span id="s-logo-len">${logoRaw.length}</span> 字符），已设为只读，可复制；保存时原样提交，不会被清空。</div>
      </div>
      <h3 class="ap-sub">网站图标（favicon）</h3>
      <div class="form-group">
        <label>浏览器标签页图标（png / jpg / svg / ico / webp，≤ 512KB；不上传则使用站点默认图标）</label>
        <div class="row favicon-row">
          <span class="favicon-preview" id="s-favicon-preview"><img src="/api/favicon?t=${Date.now()}" alt="favicon" /></span>
          <input type="file" id="s-favicon-file" accept="image/png,image/jpeg,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,image/webp" />
          <button class="btn" id="s-favicon-upload" type="button"><i class="fa-solid fa-upload"></i>上传图标</button>
          <button class="btn btn-ghost" id="s-favicon-reset" type="button"><i class="fa-solid fa-rotate-left"></i>恢复默认</button>
          <span class="muted" id="s-favicon-state">${s.site_favicon ? `当前：自定义图标（${escapeHtml(s.site_favicon)}）` : '当前：站点默认图标'}</span>
        </div>
        <div class="muted" style="font-size:12px">上传成功后浏览器标签页图标立即变化（无需刷新页面）；「恢复默认」回到内置的 ⚖️ 图标。</div>
      </div>
      <div class="row" style="gap:24px;flex-wrap:wrap">
        <div class="form-group" style="flex:1 1 300px;min-width:250px">
          <label>Logo 大小</label>
          <div class="row brand-size-row">
            <span class="brand-size-tick">${BRAND_LOGO_MIN}</span>
            <input type="range" id="s-logo-size" min="18" max="60" step="1" value="${brandLogoSize(s.site_logo_size)}" aria-label="Logo 大小（像素）" />
            <span class="brand-size-tick">${BRAND_LOGO_MAX}</span>
            <span class="brand-size-val" id="s-logo-size-val">${brandLogoSize(s.site_logo_size)}px</span>
          </div>
          <div class="muted" style="font-size:12px">侧边栏顶部图标 / 上传的 Logo 图片尺寸（18~60px，默认 28），拖动即时预览；拖回 28 即恢复默认。</div>
        </div>
        <div class="form-group" style="flex:1 1 300px;min-width:250px">
          <label>侧栏站名字号</label>
          <div class="row brand-size-row">
            <span class="brand-size-tick">${BRAND_TITLE_MIN}</span>
            <input type="range" id="s-title-size" min="12" max="40" step="1" value="${brandTitleSize(s.site_title_size)}" aria-label="侧栏站名字号（像素）" />
            <span class="brand-size-tick">${BRAND_TITLE_MAX}</span>
            <span class="brand-size-val" id="s-title-size-val">${brandTitleSize(s.site_title_size)}px</span>
          </div>
          <div class="muted" style="font-size:12px">侧边栏站名标题的字号（12~40px，默认 24），与 Logo 大小各自独立、互不联动；拖回 24 即恢复默认。</div>
        </div>
      </div>
      <h3 class="ap-sub">标题样式（首页大标题）</h3>
      <div class="muted" style="font-size:12px;margin-bottom:10px">留空表示使用默认样式；下面的预览与前台首页大标题同步生效（侧栏站名字号见上方滑块）。</div>
      <div class="row" style="gap:16px;flex-wrap:wrap">
        <div class="form-group" style="flex:0 0 150px"><label>首页大标题字号 (px)</label><input class="input" id="st-hero-size" value="${escapeHtml(s.site_title_hero_size || '')}" placeholder="默认 42" /></div>
        <div class="form-group" style="flex:0 0 150px"><label>字重</label>
          <select class="input" id="st-weight">
            ${[['', '默认'], ['400', '常规 400'], ['500', '中等 500'], ['600', '半粗 600'], ['700', '加粗 700'], ['800', '特粗 800'], ['900', '超粗 900']]
              .map(([v, label]) => `<option value="${v}" ${String(s.site_title_weight || '') === v ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="flex:0 0 150px"><label>字间距 (px)</label><input class="input" id="st-spacing" value="${escapeHtml(s.site_title_spacing || '')}" placeholder="默认 0.5" /></div>
        <div class="form-group" style="flex:0 0 170px"><label>颜色</label>
          <div class="row" style="gap:8px;align-items:center">
            <input type="color" id="st-color-picker" value="${/^#[0-9a-fA-F]{6}$/.test(String(s.site_title_color || '')) ? escapeHtml(s.site_title_color) : '#1890ff'}" style="width:44px;height:34px;padding:2px;border:1px solid var(--border);border-radius:8px;background:none" />
            <input class="input" id="st-color" value="${escapeHtml(s.site_title_color || '')}" placeholder="留空=默认" style="flex:1" />
          </div>
        </div>
        <div class="form-group" style="flex:1 1 240px"><label>字体</label>
          <select class="input" id="st-font">
            ${[['', '默认（系统字体）'],
              ['"PingFang SC","Microsoft YaHei",sans-serif', '黑体 / 无衬线'],
              ['Georgia,"Times New Roman",serif', '衬线（Georgia）'],
              ['"KaiTi","STKaiti",serif', '楷体'],
              ['"SimSun","Songti SC",serif', '宋体'],
              ['Consolas,"Courier New",monospace', '等宽（Consolas）'],
              ['"Comic Sans MS","Segoe UI",cursive', '手写体（Comic Sans）']]
              .map(([v, label]) => `<option value="${escapeHtml(v)}" ${String(s.site_title_font || '') === v ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group"><label>预览（侧栏站名 / 首页大标题）</label>
        <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:12px 14px;border:1px dashed var(--border);border-radius:12px">
          <span id="st-preview-side" style="font-size:18px;font-weight:700">${escapeHtml(s.site_name || 'LCZOJ')}</span>
          <span id="st-preview-hero" style="font-size:32px;font-weight:700">${escapeHtml(s.site_name || 'LCZOJ')}</span>
        </div>
      </div>
      <h3 class="ap-sub">主题配色（浅色模式）</h3>
      <div class="form-group">
        <label>固定主题（一键套用；也可选「自定义」后手动调色）</label>
        <div class="preset-row" id="ap-presets">
          ${THEME_PRESETS.map((p) => `<button type="button" class="theme-preset" data-preset="${p.key}">
            <i style="background:${p.colors.accent || 'linear-gradient(135deg,#0a8dff,#6a5af9)'}"></i><span>${p.name}</span>
          </button>`).join('')}
          <button type="button" class="theme-preset" data-preset="custom">
            <i style="background:linear-gradient(135deg,#ff6600,#12b886,#2f54eb)"></i><span>自定义</span>
          </button>
        </div>
        <div class="muted" style="font-size:12px;margin-top:6px">预设主题各自包含配色（浅色＋夜间）；套用后仍可继续微调下面的颜色，圆角 / 字号 / 字体与页面宽度不会被预设改动。</div>
      </div>
      <div class="muted" style="font-size:12px;margin-bottom:8px">主题色影响按钮、链接、选中态等强调元素；设置「页面背景色」后会关闭默认的背景光晕装饰层。</div>
      <div class="row" style="gap:16px;flex-wrap:wrap">
        ${AP_COLOR_FIELDS.slice(0, 8).map(([id, key, label, def]) => colorField(id, label, s[key], def)).join('')}
      </div>

      <h3 class="ap-sub">夜间模式配色</h3>
      <div class="muted" style="font-size:12px;margin-bottom:8px">夜间模式的侧边栏（手机端底部导航栏）务必用深色，否则会和暗色页面不协调。</div>
      <div class="row" style="gap:16px;flex-wrap:wrap">
        ${AP_COLOR_FIELDS.slice(8).map(([id, key, label, def]) => colorField(id, label, s[key], def)).join('')}
      </div>

      <h3 class="ap-sub">排版与尺寸</h3>
      <div class="row" style="gap:16px;flex-wrap:wrap">
        <div class="form-group" style="flex:0 0 150px"><label>全站字号 (px)</label><input class="input" id="ap-font-size" value="${escapeHtml(s.theme_font_size || '')}" placeholder="默认 14（12~20）" /></div>
        <div class="form-group" style="flex:0 0 150px"><label>圆角 (px)</label><input class="input" id="ap-radius" value="${escapeHtml(s.theme_radius || '')}" placeholder="默认 10（0~40）" /></div>
        ${fontSelect('ap-font', '全站正文字体', s.theme_font, FONT_OPTIONS)}
        ${fontSelect('ap-code-font', '代码字体', s.theme_code_font, CODE_FONT_OPTIONS)}
      </div>

      <h3 class="ap-sub">页面宽度</h3>
      <div class="row" style="gap:16px;flex-wrap:wrap">
        <div class="form-group" style="flex:0 0 260px">
          <label>全站页面宽度（px）</label>
          <input class="input" id="s-content-width" value="${escapeHtml(s.content_max_width || '')}" placeholder="默认 1320（范围 760~2600）" />
          <div class="muted" style="font-size:12px">全站默认：题库、提交记录、比赛、后台等「其它页面」</div>
        </div>
        <div class="form-group" style="flex:0 0 260px">
          <label>首页宽度（px，单独设置）</label>
          <input class="input" id="s-home-width" value="${escapeHtml(s.home_max_width || '')}" placeholder="留空=原始自适应宽度" />
          <div class="muted" style="font-size:12px">只作用于首页（大标题 / 统计 / 首页两栏内容），与全站宽度互不影响</div>
        </div>
      </div>
      <div class="form-group">
        <label>各页面宽度（px，留空=使用内置默认值）</label>
        <div class="row" style="gap:12px;flex-wrap:wrap">
          ${PAGE_WIDTH_LIST.filter(([k]) => k !== 'home').map(([k, label]) => {
            const builtin = PAGE_WIDTH_BUILTIN[k] ? PAGE_WIDTH_BUILTIN[k] + '（默认）' : '跟随全站';
            return `<div class="form-group" style="flex:0 0 190px;margin:0">
              <label style="font-size:12px">${label}</label>
              <input class="input pw-input" id="pw-${k}" data-key="${k}" value="${escapeHtml((apWidthCfg[k] || ''))}" placeholder="${builtin}" />
            </div>`;
          }).join('')}
        </div>
        <div class="muted" style="font-size:12px;margin-top:6px">博客文章与题解详情默认 860px，便于阅读；这里填写的宽度对全站访客生效，留空表示用内置默认值。</div>
      </div>
      <div class="row" style="gap:10px">
        <button class="btn" id="ap-save"><i class="fa-solid fa-floppy-disk"></i>保存网站外观</button>
        <button class="btn btn-ghost" id="ap-reset"><i class="fa-solid fa-rotate-left"></i>恢复默认外观</button>
        <span class="muted" style="font-size:12px">保存后立即对全站访客生效（含配色、字号、圆角、字体与页面宽度）</span>
      </div>
    </div>

    <div class="card" data-sec="mail">
      <div class="form-group"><label class="switch"><input type="checkbox" id="s-email-verify" ${s.email_verify_required ? 'checked' : ''} /><span class="slider"></span><span class="switch-label">开启注册邮箱验证<span class="muted">新用户注册后需验证邮箱才能登录</span></span></label></div>
      <div class="row" style="gap:16px">
        <div class="form-group" style="flex:1"><label>SMTP 服务器</label><input class="input" id="s-smtp-host" value="${escapeHtml(s.smtp_host || '')}" placeholder="smtp.126.com" /></div>
        <div class="form-group" style="flex:0 0 120px"><label>端口</label><input class="input" id="s-smtp-port" value="${escapeHtml(s.smtp_port || '465')}" /></div>
        <div class="form-group" style="flex:0 0 120px;padding-top:26px"><label class="switch"><input type="checkbox" id="s-smtp-secure" ${s.smtp_secure ? 'checked' : ''} /><span class="slider"></span><span class="switch-label">SSL</span></label></div>
      </div>
      <div class="row" style="gap:16px">
        <div class="form-group" style="flex:1"><label>发件邮箱</label><input class="input" id="s-smtp-user" value="${escapeHtml(s.smtp_user || '')}" placeholder="yourname@126.com" /></div>
        <div class="form-group" style="flex:1"><label>授权码（SMTP 密码）</label>
          <input class="input" id="s-smtp-pass" type="text" value="${escapeHtml(s.smtp_pass || '')}" autocomplete="off" placeholder="邮箱服务商提供的授权码" />
          <div class="muted" style="font-size:12px;margin-top:4px">此处始终显示已保存的授权码，直接修改即可；清空表示不使用密码。</div>
        </div>
      </div>
      <div class="row" style="gap:10px">
        <button class="btn" id="s-smtp-save"><i class="fa-solid fa-floppy-disk"></i>保存 SMTP 配置</button>
        <button class="btn btn-ghost" id="s-smtp-test"><i class="fa-solid fa-paper-plane"></i>发送测试邮件</button>
        <span class="muted" style="font-size:12px">验证码邮件由系统通过上述 SMTP 发送；未配置或发送失败时，验证码会在页面直接展示，不影响注册流程</span>
      </div>
      <div id="s-smtp-test-result" class="mt"></div>
    </div>

    <div class="card" data-sec="features">
      <!-- v2.8.5：积分计算是「功能设置」的**二级页面**（#/settings/features/points），入口放在本卡片最上面，
           一眼可见、一次点击直达，不需要先保存本页开关，也不会退化成「必须点两层才能改积分结算」。 -->
      <div class="row" id="s-points-entry" style="gap:12px;align-items:center;flex-wrap:wrap;margin:0 0 16px;padding:12px 14px;border:1px solid var(--border);border-radius:10px">
        <i class="fa-solid fa-calculator" style="font-size:17px;color:var(--accent)"></i>
        <div style="flex:1 1 260px;min-width:200px">
          <div style="font-weight:700;font-size:13.5px">积分计算 <span class="muted" style="font-weight:400;font-size:12px">（功能设置的二级页面）</span></div>
          <div class="muted" style="font-size:12px">全站积分的结算模式（实时 / 定时自动 / 手动结算）与结算间隔，改完立即生效。</div>
        </div>
        <a class="btn" id="s-points-open" href="#/settings/features/points"><i class="fa-solid fa-sliders"></i>积分计算 <i class="fa-solid fa-arrow-right"></i></a>
      </div>
      <div class="form-group"><label class="switch"><input type="checkbox" id="s-discussion" ${s.discussion_enabled ? 'checked' : ''} /><span class="slider"></span><span class="switch-label">启用讨论区<span class="muted">关闭后普通用户不能发布讨论/回复，侧边栏入口隐藏</span></span></label></div>
      <div class="form-group"><label class="switch"><input type="checkbox" id="s-article" ${s.article_enabled ? 'checked' : ''} /><span class="slider"></span><span class="switch-label">启用题解与专栏文章<span class="muted">关闭后普通用户不能发布文章</span></span></label></div>
      <div class="form-group"><label class="switch"><input type="checkbox" id="s-points" ${s.points_enabled !== false ? 'checked' : ''} /><span class="slider"></span><span class="switch-label">启用积分系统<span class="muted">关闭后隐藏所有积分相关内容，用户名颜色改由等级分决定；管理员颜色不变</span></span></label></div>
      <div class="form-group"><label class="switch"><input type="checkbox" id="s-pm" ${s.pm_enabled !== false ? 'checked' : ''} /><span class="slider"></span><span class="switch-label">启用私信<span class="muted">关闭后隐藏私信入口（侧边栏 / 手机端），直接访问私信页面或调用私信接口都会被拦截；已收发的私信数据保留</span></span></label></div>

      <div class="row" style="margin-top:12px"><button class="btn" id="s-feature-save"><i class="fa-solid fa-floppy-disk"></i>保存功能设置</button></div>
    </div>

    <div class="card" data-sec="judge">
      <p class="muted card-lead">评测设置：改动<strong>立即生效</strong>（判题侧每次现读），无需重启。留空 = 使用括号里的默认值（默认值与历史行为完全一致）。</p>
      <div class="row" style="gap:16px;align-items:flex-end;flex-wrap:wrap">
        <div class="form-group" style="flex:0 0 220px;margin:0">
          <label>并行判题数（同时评测的提交数，1~16）</label>
          <input class="input" id="s-judge-concurrency" value="${escapeHtml(s.judge_concurrency || '4')}" placeholder="默认 4" />
        </div>
        <span class="muted" style="font-size:12px">当前生效：<strong id="s-judge-current">${escapeHtml(s.judge_concurrency || '4')}</strong> 路并行</span>
      </div>
      <div class="row" style="gap:14px;flex-wrap:wrap;margin-top:12px">
        <div class="form-group" style="flex:1;min-width:200px"><label>编译超时（ms，10000~600000）</label><input class="input" id="s-jt-compile-timeout" type="number" min="10000" max="600000" value="${escapeHtml(s.judge_compile_timeout_ms)}" placeholder="默认 120000" /></div>
        <div class="form-group" style="flex:1;min-width:200px"><label>交互题编译超时（ms，10000~600000）</label><input class="input" id="s-jt-interactive-compile-timeout" type="number" min="10000" max="600000" value="${escapeHtml(s.judge_interactive_compile_timeout_ms)}" placeholder="默认 60000" /></div>
        <div class="form-group" style="flex:1;min-width:200px"><label>SPJ/checker 基础超时（ms，1000~60000）</label><input class="input" id="s-jt-checker-base" type="number" min="1000" max="60000" value="${escapeHtml(s.judge_checker_timeout_base_ms)}" placeholder="默认 5000" /></div>
        <div class="form-group" style="flex:1;min-width:200px"><label>SPJ/checker 超时上限（ms，5000~600000）</label><input class="input" id="s-jt-checker-max" type="number" min="5000" max="600000" value="${escapeHtml(s.judge_checker_timeout_max_ms)}" placeholder="默认 60000" /></div>
        <div class="form-group" style="flex:1;min-width:200px"><label>判题总兜底超时（ms，5000~600000）</label><input class="input" id="s-jt-total-timeout" type="number" min="5000" max="600000" value="${escapeHtml(s.judge_total_timeout_ms)}" placeholder="默认 30000" /></div>
        <div class="form-group" style="flex:1;min-width:200px"><label>单测试点输出上限（MB，1~1024）</label><input class="input" id="s-jt-output-limit" type="number" min="1" max="1024" value="${escapeHtml(s.judge_output_limit_mb)}" placeholder="默认 16" /></div>
        <div class="form-group" style="flex:1;min-width:200px"><label>编译日志上限（KB，64~65536）</label><input class="input" id="s-jt-log-limit" type="number" min="64" max="65536" value="${escapeHtml(s.judge_compile_log_limit_kb)}" placeholder="默认 4096" /></div>
        <div class="form-group" style="flex:1;min-width:200px"><label>TLE 判定余量（ms，0~5000）</label><input class="input" id="s-jt-time-extra" type="number" min="0" max="5000" value="${escapeHtml(s.judge_time_extra_ms)}" placeholder="默认 0" /></div>
        <div class="form-group" style="flex:1;min-width:220px"><label>每测试点时限系数（1.0~3.0，步进 0.05）</label><input class="input" id="s-jt-time-factor" type="number" min="1" max="3" step="0.05" value="${escapeHtml(s.judge_time_factor)}" placeholder="默认 1.2" /></div>
        <div class="form-group" style="flex:1;min-width:200px"><label>内存判定百分比（%，50~200）</label><input class="input" id="s-jt-mem-pct" type="number" min="50" max="200" value="${escapeHtml(s.judge_memory_tolerance_pct)}" placeholder="默认 100" /></div>
        <div class="form-group" style="flex:1;min-width:200px"><label>内存采样间隔（ms，0~50）</label><input class="input" id="s-jt-mem-interval" type="number" min="0" max="50" value="${escapeHtml(s.judge_mem_sample_interval_ms)}" placeholder="默认 1" /></div>
        <div class="form-group" style="flex:1;min-width:240px"><label>C++ 追加编译参数</label><input class="input mono" id="s-jt-cpp-flags" value="${escapeHtml(s.judge_cpp_flags || '')}" placeholder="留空 = 不加，如 -O2 -std=c++17" /></div>
        <div class="form-group" style="flex:1;min-width:240px"><label>C 追加编译参数</label><input class="input mono" id="s-jt-c-flags" value="${escapeHtml(s.judge_c_flags || '')}" placeholder="留空 = 不加，如 -O2 -std=c11" /></div>
        <div class="form-group" style="flex:1;min-width:240px"><label>Python 解释器（命令名或路径）</label><input class="input mono" id="s-jt-python-cmd" value="${escapeHtml(s.judge_python_cmd || '')}" placeholder="留空 = 自动探测（python / python3 / py）" /></div>
      </div>
      <div class="muted" style="font-size:12px;margin-top:2px" id="s-jt-time-factor-note">每测试点默认时限 = 题目时限 × <strong>${(Number(s.judge_time_factor) || 1.2).toFixed(2)}</strong>；单个测试点若在「测试数据」中单独配置了时限，则以配置为准；内存不受该系数影响。</div>
      <div class="form-group"><label class="switch"><input type="checkbox" id="s-jt-mem-enabled" ${s.judge_mem_sample_enabled !== false ? 'checked' : ''} /><span class="slider"></span><span class="switch-label">启用内存采样<span class="muted">关闭后不再启动采样器，memory_kb 记 0（也就是不判 MLE）；默认开启</span></span></label></div>
      <div class="row"><button class="btn" id="s-judge-save"><i class="fa-solid fa-floppy-disk"></i>保存评测设置</button><span class="muted" style="font-size:12px">非法值会被服务端拒绝并提示（不会静默改成别的数字）</span></div>
      <div class="muted" style="font-size:12px;margin-top:8px">
        说明：TLE 余量与内存判定百分比只放宽「判定门槛」，不改变量测口径（时限与内存峰值仍是真实测量值）；
        输出上限超限按 RE「输出过大」处理；编译日志上限超限会强制结束编译器（判定仍为 CE）。
        评测已做过的加速：同一提交的全部测试点合并在少量包装器进程里批量执行（省去每个测试点的进程启动与 WMI 预热）；
        Windows 判定使用 PowerShell 包装器采样内存与精确超时。机器 CPU 核数较多时可把并行数调大（建议 ≤ CPU 核心数）。
      </div>
    </div>

    <div class="card" data-sec="site">
      <div class="form-group"><label>页脚版权文字</label><input class="input" id="s-footer" value="${escapeHtml(s.footer_text || '')}" /></div>
      <div class="form-group"><label>帮助中心（Markdown，右侧实时预览）</label><div class="live-preview"><textarea class="textarea mono" id="s-help" rows="6">${escapeHtml(s.help_content || '')}</textarea><div class="live-preview-pane statement" id="pv-help"></div></div></div>
      <div class="form-group"><label>用户协议（Markdown）</label><div class="live-preview"><textarea class="textarea mono" id="s-agreement" rows="6">${escapeHtml(s.agreement_content || '')}</textarea><div class="live-preview-pane statement" id="pv-agreement"></div></div></div>
      <div class="form-group"><label>联系我们（Markdown）</label><div class="live-preview"><textarea class="textarea mono" id="s-contact" rows="6">${escapeHtml(s.contact_content || '')}</textarea><div class="live-preview-pane statement" id="pv-contact"></div></div></div>
      <div class="form-group"><label>关于网站（Markdown）</label><div class="live-preview"><textarea class="textarea mono" id="s-about" rows="6">${escapeHtml(s.about_content || '')}</textarea><div class="live-preview-pane statement" id="pv-about"></div></div></div>
      <div class="form-group"><label>社区规则（Markdown）</label><div class="live-preview"><textarea class="textarea mono" id="s-rules" rows="6">${escapeHtml(s.rules_content || '')}</textarea><div class="live-preview-pane statement" id="pv-rules"></div></div></div>
      <div class="row"><button class="btn" id="s-pages-save"><i class="fa-solid fa-floppy-disk"></i>保存站点页面</button></div>
      <div class="muted" style="font-size:12px;margin-top:6px">这些内容展示在页脚的「帮助中心 / 用户协议 / 联系我们 / 关于网站 / 社区规则」链接（新标签页打开）中。</div>
    </div>
    </div>`;

  /* ---------- 站点 Logo：只读态同步 + 复制（v2.8.3 ⑨） ----------
     值 > 200 字符（上传后的 data URL）→ 只读 + 显示「复制」与说明；短 URL / 空值 → 恢复可编辑。
     只读只挡键盘输入，程序写 .value 不受影响；保存读 .value，因此原值会被原样提交。 */
  const syncLogoField = () => {
    const el = document.getElementById('s-logo-url');
    if (!el) return;
    const len = String(el.value || '').length;
    const long = len > LOGO_LONG_LIMIT;
    el.readOnly = long;
    el.classList.toggle('is-readonly', long);
    el.title = long ? '内容较长，已设为只读，可复制（需要修改请重新上传图片或点「清除」）' : '';
    const hint = document.getElementById('s-logo-hint');
    if (hint) hint.hidden = !long;
    const lenEl = document.getElementById('s-logo-len');
    if (lenEl) lenEl.textContent = String(len);
    const cp = document.getElementById('s-logo-copy');
    if (cp) cp.hidden = !long;
  };
  syncLogoField();
  const logoCopy = document.getElementById('s-logo-copy');
  if (logoCopy) logoCopy.addEventListener('click', async () => {
    const el = document.getElementById('s-logo-url');
    if (await copyText(el ? String(el.value) : '')) toast('Logo 内容已复制到剪贴板', 'success');
  });

  // Logo 上传
  const logoFile = document.getElementById('s-logo-file');
  if (logoFile) {
    logoFile.addEventListener('change', () => {
      const file = logoFile.files && logoFile.files[0];
      if (!file) return;
      if (file.size > 1024 * 1024) return toast('Logo 图片不能超过 1MB', 'error');
      const reader = new FileReader();
      reader.onload = () => {
        document.getElementById('s-logo-url').value = String(reader.result || '');
        syncLogoField(); // 刚写入的是 data URL（长串）→ 立即切到只读 + 复制
        const prev = document.getElementById('s-logo-preview');
        if (prev) prev.innerHTML = `<img src="${escapeHtml(String(reader.result))}" style="height:36px;border-radius:6px" />`;
      };
      reader.readAsDataURL(file);
    });
  }
  const logoClear = document.getElementById('s-logo-clear');
  if (logoClear) logoClear.addEventListener('click', () => {
    document.getElementById('s-logo-url').value = '';
    syncLogoField(); // 清空 = 短值 → 自动恢复可编辑
    const prev = document.getElementById('s-logo-preview');
    if (prev) prev.innerHTML = '<span class="muted">未设置，使用默认图标</span>';
  });

  /* ---------- 网站图标（favicon）：上传 / 恢复默认 ----------
     图标由后端 /api/favicon 统一提供（未自定义 → 默认图标，绝不 404）：
       · 上传：读成 data URL → POST /api/admin/favicon（仅超级管理员）→ 服务端按魔数校验后落盘；
       · 成功后立刻把 index.html 里**已有**的 <link rel="icon"> 的 href 换成 /api/favicon?v=<新版本号>，
         标签页图标当场变化，不需要刷新页面，也不需要点「保存网站外观」。 */
  const faviconState = (f) => {
    const el = document.getElementById('s-favicon-state');
    if (!el) return;
    const name = (f && f.name) || '';
    // 图标通常只有几百字节：< 1KB 时直接显示字节数，避免显示成「0KB」
    const size = f && f.size ? (f.size < 1024 ? `${f.size}B` : `${Math.round(f.size / 1024)}KB`) : '';
    el.textContent = name ? `当前：自定义图标（${name}${size ? '，' + size : ''}）` : '当前：站点默认图标';
  };
  const faviconPreview = (ver) => {
    const box = document.getElementById('s-favicon-preview');
    if (box) box.innerHTML = `<img src="${faviconUrl(ver || Date.now())}" alt="favicon" />`;
  };
  const faviconFile = document.getElementById('s-favicon-file');
  const faviconUpload = document.getElementById('s-favicon-upload');
  if (faviconUpload && faviconFile) faviconUpload.addEventListener('click', () => {
    const file = faviconFile.files && faviconFile.files[0];
    if (!file) return toast('请先选择图标文件', 'error');
    if (file.size > 512 * 1024) return toast('图标文件不能超过 512KB', 'error');
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const d = await api.post('/api/admin/favicon', { data: String(reader.result || '') });
        const f = (d && d.favicon) || {};
        applyFavicon(f.ver, f.name || f.mime); // href 立即带 ?v= 时间戳 + type 跟随实际格式 → 浏览器当场换图标
        faviconPreview(f.ver);
        faviconState(f);
        faviconFile.value = '';
        toast('网站图标已更新（标签页图标已生效）', 'success');
      } catch (e) { toast(e.message, 'error'); }
    };
    reader.onerror = () => toast('读取图标文件失败', 'error');
    reader.readAsDataURL(file);
  });
  const faviconReset = document.getElementById('s-favicon-reset');
  if (faviconReset) faviconReset.addEventListener('click', async () => {
    if (!confirm('恢复为站点默认图标（⚖️）？')) return;
    try {
      const d = await api.del('/api/admin/favicon');
      applyFavicon('');               // 回到**默认图标**（地址带默认版本号 ?v=285，服务端返回默认 SVG）
      faviconPreview(Date.now());
      faviconState((d && d.favicon) || {});
      toast('已恢复默认图标', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });

  /* ---------- 网站外观：固定主题预设 + 即时预览 + 保存 + 恢复默认 ---------- */
  const apVal = (id) => { const el = document.getElementById(id); return el ? String(el.value).trim() : ''; };
  const AP_COLORS = AP_COLOR_FIELDS.map(([id, key]) => [id, key]);
  const apRead = () => {
    const cfg = { radius: apVal('ap-radius'), font_size: apVal('ap-font-size'), font: apVal('ap-font'), code_font: apVal('ap-code-font') };
    AP_COLORS.forEach(([id, key]) => { cfg[key] = apVal(id); });
    return cfg;
  };
  const apApplyLive = () => {
    applyAppearance(apRead()); // 配色 / 圆角 / 字号 / 字体即时预览
    applyContentWidth(apVal('s-content-width'));
    applyHomeWidth(apVal('s-home-width'));
    applySitePageWidths(apPageWidths());
    applySiteTitleStyle(stRead());
    markPresetActive();
  };
  /** 读取后台「各页面宽度」输入（key → px 字符串，留空表示用内置默认） */
  const apPageWidths = () => {
    const obj = {};
    PAGE_WIDTH_LIST.forEach(([key]) => {
      const el = document.getElementById('pw-' + key);
      if (!el) return;
      const v = String(el.value || '').trim();
      if (v && Number.isFinite(parseFloat(v))) obj[key] = String(Math.max(600, Math.min(2600, Math.round(parseFloat(v)))));
    });
    return obj;
  };
  /* 固定主题预设：点击套用；下方颜色被手动改动时自动落到「自定义」 */
  const presetRow = document.getElementById('ap-presets');
  const markPresetActive = () => {
    if (!presetRow) return;
    const cur = apVal('ap-accent').toLowerCase();
    let active = 'custom';
    if (!cur) active = 'default';
    else {
      const hit = THEME_PRESETS.find((p) => p.colors && p.colors.accent && p.colors.accent.toLowerCase() === cur);
      if (hit) active = hit.key;
    }
    presetRow.querySelectorAll('.theme-preset').forEach((b) => b.classList.toggle('active', b.dataset.preset === active));
  };
  if (presetRow) {
    presetRow.querySelectorAll('.theme-preset').forEach((btn) => btn.addEventListener('click', () => {
      const key = btn.dataset.preset;
      if (key === 'custom') { // 保留当前颜色，仅切到自定义（方便手动改色）
        presetRow.querySelectorAll('.theme-preset').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        return;
      }
      const preset = THEME_PRESETS.find((p) => p.key === key) || { name: key, colors: {} };
      // 预设没有给出的颜色 → 文本框留空（表示「用站点默认色」），
      // 但取色器必须回显该字段的默认色，否则点「默认蓝」后所有取色器都会变成白色。
      AP_COLOR_FIELDS.forEach(([id, sKey, , defColor]) => {
        const short = sKey.replace(/^theme_/, '');
        const v = (preset.colors && preset.colors[short]) || '';
        const el = document.getElementById(id);
        const picker = document.getElementById(id + '-picker');
        if (el) el.value = v;
        if (picker) picker.value = /^#[0-9a-fA-F]{6}$/.test(v) ? v : defColor;
      });
      apApplyLive();
      toast(`已套用主题「${preset.name}」，点「保存网站外观」后对全站生效`, 'info');
    }));
    markPresetActive();
  }
  /* 颜色选择器 ↔ 文本输入 双向同步 */
  AP_COLORS.forEach(([id]) => {
    const el = document.getElementById(id);
    const picker = document.getElementById(id + '-picker');
    if (el && picker) {
      picker.addEventListener('input', () => { el.value = picker.value; apApplyLive(); });
      el.addEventListener('input', () => {
        const v = el.value.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(v)) picker.value = v;
        apApplyLive();
      });
    } else if (el) {
      el.addEventListener('input', apApplyLive);
    }
  });
  ['ap-radius', 'ap-font-size', 'ap-font', 'ap-code-font', 's-content-width', 's-home-width'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', apApplyLive);
    el.addEventListener('change', apApplyLive);
  });
  /* Logo 大小 / 侧栏站名字号：滑块拖动即预览（写 --brand-logo-size / --brand-title-size），
     滑块旁实时显示当前生效的 px 数值。注意必须在 stApply 定义之后绑定（站名字号要同步预览）。 */
  /** 写 --pct（可读的百分比）与 --pct-n（0~1 无单位比例）：
   *  CSS 用 --pct-n 精确算出「左主题色 / 右浅灰」的分界点（与滑块头圆心重合），初始渲染也写一次。 */
  const syncRangeFill = (el) => {
    const min = parseFloat(el.min), max = parseFloat(el.max), v = parseFloat(el.value);
    const ratio = (Number.isFinite(min) && Number.isFinite(max) && max > min)
      ? Math.max(0, Math.min(1, (v - min) / (max - min))) : 0;
    el.style.setProperty('--pct', (ratio * 100).toFixed(2) + '%');
    el.style.setProperty('--pct-n', ratio.toFixed(4));
  };
  const bindBrandSlider = (id, apply) => {
    const el = document.getElementById(id);
    const out = document.getElementById(id + '-val');
    if (!el) return;
    const sync = () => {
      const size = apply(el.value);
      if (out) out.textContent = size + 'px';
      syncRangeFill(el);
    };
    el.addEventListener('input', sync);
    el.addEventListener('change', sync);
    sync();
  };

  /* 网站标题样式（字体 / 字重 / 颜色 / 字间距 / 首页大标题字号）：预览
     侧栏站名字号已独立为上方滑块（--brand-title-size），这里只负责其余样式与预览。 */
  const stIds = ['st-hero-size', 'st-weight', 'st-spacing', 'st-color', 'st-font'];
  const stRead = () => ({
    hero_size: document.getElementById('st-hero-size').value.trim(),
    weight: document.getElementById('st-weight').value,
    spacing: document.getElementById('st-spacing').value.trim(),
    color: document.getElementById('st-color').value.trim(),
    font: document.getElementById('st-font').value,
  });
  const stApply = () => {
    const v = stRead();
    applySiteTitleStyle(v); // 前台全局变量：立即生效
    const side = document.getElementById('st-preview-side');
    const hero = document.getElementById('st-preview-hero');
    const style = (el, size) => {
      if (!el) return;
      el.style.fontSize = size + 'px';
      el.style.fontWeight = v.weight || '700';
      el.style.color = v.color || 'var(--text)';
      el.style.letterSpacing = (v.spacing !== '' ? v.spacing : 0) + 'px';
      el.style.fontFamily = v.font || '';
    };
    // 侧栏预览用当前滑块生效的字号；首页大标题预览用配置值（未配置时 32）
    style(side, brandTitleSize(document.getElementById('s-title-size') ? document.getElementById('s-title-size').value : ''));
    style(hero, v.hero_size && Number.isFinite(parseFloat(v.hero_size)) ? Math.round(parseFloat(v.hero_size)) : 32);
  };
  stIds.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => stApply());
    el.addEventListener('change', () => stApply());
  });
  const stColor = document.getElementById('st-color');
  const stPicker = document.getElementById('st-color-picker');
  if (stPicker && stColor) {
    stPicker.addEventListener('input', () => { stColor.value = stPicker.value; stApply(); });
    stColor.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(stColor.value.trim())) stPicker.value = stColor.value.trim(); stApply(); });
  }
  stApply();
  // 两个尺寸滑块：绑定事件并初始化数值显示（站名字号变化时同步刷新预览）
  bindBrandSlider('s-logo-size', applyLogoSize);
  bindBrandSlider('s-title-size', (v) => { const n = applyTitleSize(v); stApply(); return n; });
  apApplyLive(); // 初始套用一次（配色 / 圆角 / 字号 / 字体 / 页面宽度）
  /* 网站外观：保存（站名 / Logo / 标题样式 / 配色 / 排版 / 页面宽度）
     注意：apRead() 返回的是「简称」键（radius / font_size / font / code_font），
     必须映射回后台设置用的 theme_* 键名，否则服务端不识别、圆角与字体保存会静默丢失。 */
  const apPayload = () => {
    const a = apRead();
    const t = stRead();
    return {
      site_name: apVal('s-site-name'),
      site_logo: apVal('s-logo-url'),
      site_logo_size: apVal('s-logo-size'),
      site_title_size: apVal('s-title-size'),
      content_max_width: apVal('s-content-width'),
      home_max_width: apVal('s-home-width'),
      page_widths: apPageWidths(),
      // 旧版「标题样式」里的侧栏站名字号文本框已由上方滑块取代：保存时清掉历史值，避免两处配置打架
      site_title_sidebar_size: '',
      site_title_hero_size: t.hero_size,
      site_title_weight: t.weight,
      site_title_spacing: t.spacing,
      site_title_color: t.color,
      site_title_font: t.font,
      theme_radius: a.radius,
      theme_font_size: a.font_size,
      theme_font: a.font,
      theme_code_font: a.code_font,
      theme_accent: a.theme_accent,
      theme_accent_hover: a.theme_accent_hover,
      theme_bg: a.theme_bg,
      theme_card: a.theme_card,
      theme_sidebar: a.theme_sidebar,
      theme_text: a.theme_text,
      theme_text_light: a.theme_text_light,
      theme_border: a.theme_border,
      theme_dark_bg: a.theme_dark_bg,
      theme_dark_card: a.theme_dark_card,
      theme_dark_sidebar: a.theme_dark_sidebar,
      theme_dark_text: a.theme_dark_text,
    };
  };
  const apSave = document.getElementById('ap-save');
  if (apSave) apSave.addEventListener('click', async () => {
    try {
      // Logo 大小 / 侧栏站名字号现在是滑块（min/max 已在元素上限定），这里只做一次兜底夹取；
      // 滑块值等于默认值（30 / 24）时服务端会存成空值，等价于「恢复默认」。
      await api.put('/api/settings', apPayload());
      toast('网站外观已保存', 'success');
      await applySiteBrand(); // 重新拉取 /api/home，站名 / Logo / 标题样式 / 外观全部套用
    } catch (e) { toast(e.message, 'error'); }
  });
  const apReset = document.getElementById('ap-reset');
  if (apReset) apReset.addEventListener('click', async () => {
    if (!confirm('恢复到默认网站外观？（配色 / 字号 / 圆角 / 字体 / 标题样式 / 页面宽度全部清空，站名与 Logo 保留）')) return;
    try {
      const cleared = {};
      AP_COLORS.forEach(([, key]) => { cleared[key] = ''; });
      Object.assign(cleared, {
        theme_radius: '', theme_font_size: '', theme_font: '', theme_code_font: '',
        content_max_width: '', home_max_width: '',
        site_logo_size: '', site_title_size: '',
        site_title_sidebar_size: '', site_title_hero_size: '', site_title_weight: '',
        site_title_spacing: '', site_title_color: '', site_title_font: '',
      });
      await api.put('/api/settings', cleared);
      applyAppearance({});
      applyContentWidth('');
      applyHomeWidth('');
      applySitePageWidths({});
      applySiteTitleStyle({});
      applyLogoSize('');
      applyTitleSize('');
      savedLook = { appearance: {}, contentWidth: '', homeWidth: '', pageWidths: {}, titleStyle: {}, logoSize: '', titleSize: '' }; // 已恢复默认 → 同步快照
      toast('已恢复默认网站外观', 'success');
      renderAdminSettings();
    } catch (e) { toast(e.message, 'error'); }
  });

  /* 评测设置（M17）：所有可调项一次提交；留空 = 恢复默认（服务端会做类型 / 范围校验，非法值 400 提示） */
  const judgeSave = document.getElementById('s-judge-save');
  if (judgeSave) judgeSave.addEventListener('click', async () => {
    const payload = {
      judge_concurrency: apVal('s-judge-concurrency'),
      judge_compile_timeout_ms: apVal('s-jt-compile-timeout'),
      judge_interactive_compile_timeout_ms: apVal('s-jt-interactive-compile-timeout'),
      judge_checker_timeout_base_ms: apVal('s-jt-checker-base'),
      judge_checker_timeout_max_ms: apVal('s-jt-checker-max'),
      judge_total_timeout_ms: apVal('s-jt-total-timeout'),
      judge_output_limit_mb: apVal('s-jt-output-limit'),
      judge_compile_log_limit_kb: apVal('s-jt-log-limit'),
      judge_time_extra_ms: apVal('s-jt-time-extra'),
      judge_time_factor: apVal('s-jt-time-factor'),
      judge_memory_tolerance_pct: apVal('s-jt-mem-pct'),
      judge_mem_sample_interval_ms: apVal('s-jt-mem-interval'),
      judge_mem_sample_enabled: document.getElementById('s-jt-mem-enabled').checked,
      judge_cpp_flags: apVal('s-jt-cpp-flags'),
      judge_c_flags: apVal('s-jt-c-flags'),
      judge_python_cmd: apVal('s-jt-python-cmd'),
    };
    judgeSave.disabled = true;
    try {
      await api.put('/api/settings', payload);
      const cur = document.getElementById('s-judge-current');
      if (cur) cur.textContent = payload.judge_concurrency;
      // 时限系数保存后同步刷新说明行里显示的倍数（服务端留空会落成默认 1.2）
      const factorNote = document.getElementById('s-jt-time-factor-note');
      if (factorNote) {
        const f = Number(payload.judge_time_factor);
        const shown = (Number.isFinite(f) && f >= 1 && f <= 3 ? f : 1.2).toFixed(2);
        factorNote.innerHTML = `每测试点默认时限 = 题目时限 × <strong>${shown}</strong>；单个测试点若在「测试数据」中单独配置了时限，则以配置为准；内存不受该系数影响。`;
        const input = document.getElementById('s-jt-time-factor');
        if (input) input.value = shown;
      }
      toast('评测设置已保存（立即生效）', 'success');
    } catch (e) { toast(e.message, 'error'); }
    judgeSave.disabled = false;
  });

  /* v2.8.0：smtp_pass 处理 —— 服务端 GET /api/settings 直接回真实值，输入框始终带出该值。
     规则：**原样提交输入框的值**（不 trim，保证「打开页面 → 直接保存」逐字节回写、不会改坏密码）；
     清空输入框 = 提交空串 = 不再使用密码。已无掩码 / 「留空保持不变」逻辑。 */
  const smtpPassPayload = () => {
    const input = document.getElementById('s-smtp-pass');
    return { smtp_pass: input ? input.value : '' };
  };

  const smtpSave = document.getElementById('s-smtp-save');
  if (smtpSave) smtpSave.addEventListener('click', async () => {
    try {
      const payload = smtpPassPayload();
      await api.put('/api/settings', {
        email_verify_required: document.getElementById('s-email-verify').checked,
        smtp_host: document.getElementById('s-smtp-host').value.trim(),
        smtp_port: parseInt(document.getElementById('s-smtp-port').value, 10) || 465,
        smtp_user: document.getElementById('s-smtp-user').value.trim(),
        smtp_secure: document.getElementById('s-smtp-secure').checked,
        ...payload,
      });
      // v2.8.0：保存后输入框继续显示刚保存的授权码（与服务端 slice(0,200) 落库口径一致），不再清空
      const input = document.getElementById('s-smtp-pass');
      if (input) input.value = String(payload.smtp_pass == null ? '' : payload.smtp_pass).slice(0, 200);
      toast('SMTP 配置已保存', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });

  const smtpTest = document.getElementById('s-smtp-test');
  if (smtpTest) smtpTest.addEventListener('click', async () => {
    const resultBox = document.getElementById('s-smtp-test-result');
    resultBox.innerHTML = '<span class="muted">正在发送测试邮件…</span>';
    try {
      const r = await api.post('/api/settings/test-email', {
        email_verify_required: document.getElementById('s-email-verify').checked,
        smtp_host: document.getElementById('s-smtp-host').value.trim(),
        smtp_port: parseInt(document.getElementById('s-smtp-port').value, 10) || 465,
        smtp_user: document.getElementById('s-smtp-user').value.trim(),
        smtp_secure: document.getElementById('s-smtp-secure').checked,
        ...smtpPassPayload(),
      });
      resultBox.innerHTML = r.sent
        ? '<span style="color:var(--green);font-weight:600">测试邮件已发送至发件邮箱，请查收</span>'
        : `<span style="color:var(--red)">发送失败：${escapeHtml(r.reason || '未知错误')}</span>`;
    } catch (e) {
      resultBox.innerHTML = `<span style="color:var(--red)">发送失败：${escapeHtml(e.message)}</span>`;
    }
  });

  /* 说明：积分计算的输入 / 状态 / 按钮绑定全部随 UI 搬到二级页面 #/settings/features/points
   * （见 renderAdminPointsSettle），本页只保留「积分计算 →」入口与四个功能开关的保存。 */

  const featSave = document.getElementById('s-feature-save');
  if (featSave) featSave.addEventListener('click', async () => {
    try {
      const pmOn = document.getElementById('s-pm').checked;
      await api.put('/api/settings', {
        discussion_enabled: document.getElementById('s-discussion').checked,
        article_enabled: document.getElementById('s-article').checked,
        points_enabled: document.getElementById('s-points').checked,
        pm_enabled: pmOn,
      });
      toast('功能设置已保存', 'success');
      Store.features.points_enabled = document.getElementById('s-points').checked;
      // 私信开关立即生效：隐藏 / 恢复入口（顶栏动作区按功能开关签名重建）
      Store.features.pm_enabled = pmOn;
      lastTopbarSig = '';
      renderTopbar();
    } catch (e) { toast(e.message, 'error'); }
  });

  // 站点页面与版权
  bindLivePreview('s-help', 'pv-help');
  bindLivePreview('s-agreement', 'pv-agreement');
  bindLivePreview('s-contact', 'pv-contact');
  bindLivePreview('s-about', 'pv-about');
  bindLivePreview('s-rules', 'pv-rules');
  const pagesSave = document.getElementById('s-pages-save');
  if (pagesSave) pagesSave.addEventListener('click', async () => {
    try {
      await api.put('/api/settings', {
        footer_text: document.getElementById('s-footer').value.trim(),
        help_content: document.getElementById('s-help').value,
        agreement_content: document.getElementById('s-agreement').value,
        contact_content: document.getElementById('s-contact').value,
        about_content: document.getElementById('s-about').value,
        rules_content: document.getElementById('s-rules').value,
      });
      toast('站点页面已保存', 'success');
      const ft = document.getElementById('footer-text');
      if (ft) ft.textContent = document.getElementById('s-footer').value.trim();
    } catch (e) { toast(e.message, 'error'); }
  });
  const batchBtn = document.getElementById('s-batch-open');
  if (batchBtn) batchBtn.addEventListener('click', () => renderAdminBatchDelete());
  const batchUsersBtn = document.getElementById('s-batch-users-open');
  if (batchUsersBtn) batchUsersBtn.addEventListener('click', () => renderAdminBatchUsers());

  // 版本更新提示：向官方仓库问一下有没有新版本（失败就静默，不打扰用户）
  (async () => {
    const host = document.getElementById('ver-latest');
    if (host) {
      try {
        const d = await api.get('/api/version');
        if (d && d.latest) {
          if (d.has_update) {
            host.innerHTML = ` <a class="badge" style="background:var(--green,#52c41a);color:#fff;font-size:11px;text-decoration:none"
              href="#/settings/update" title="可在「系统设置 → 版本更新」中一键更新">发现新版本 v${escapeHtml(d.latest)}</a>`;
          } else {
            host.innerHTML = ' <span class="muted">已是最新版本</span>';
          }
        }
      } catch { /* 离线 / 无法访问更新源：什么都不显示 */ }
    }
    renderUpdateBox();
  })();
  applySettingsSection(section);
}

/* 积分计算页面（仅最高管理员）——**属于「功能设置」的二级页面**：路由 #/settings/features/points，
 * 侧边栏高亮「系统设置」（renderTopbar 按 parts[1]==='settings' 判定），子标签里父项「功能设置」可见、本页为当前项。
 * v2.8.2：整块 UI 从「功能设置」页搬出来独立成页；v2.8.5：按站长要求改为「功能设置」的二级页面
 * （一级地址 #/settings/points 保留为重定向），页头仍走 settingsTabs('features', …, 'points')。
 * 现在直接放在本页的 .card 内，间距 / 字号 / 按钮尺寸沿用既有 .settle-* 类与站点变量，
 * 浅色与暗黑主题自动跟随，1440px 与 390px 都不横向溢出。 */
async function renderAdminPointsSettle() {
  app.innerHTML = '<div class="loading">加载中…</div>';
  setPageTitle('积分计算');
  if (!Store.user || Store.user.username !== 'admin') {
    app.innerHTML = '<div class="empty">仅最高管理员（admin）可访问此页面</div>';
    return;
  }
  const __ver = await siteVersion();
  // 二级页面：父项 = features（功能设置），子项 = points（积分计算）
  const ptsCrumb = `<div class="crumb" style="margin-top:6px"><a href="#/settings/features"><i class="fa-solid fa-arrow-left"></i> 功能设置</a> <span class="muted">/</span> <span class="muted">积分计算</span></div>`;
  let s = null;
  try { s = await api.get('/api/settings'); } catch (e) {
    app.innerHTML = `${settingsTabs('features', __ver, 'points')}${ptsCrumb}<div class="empty">加载设置失败：${escapeHtml(e.message)}</div>`;
    return;
  }
  const psMode = PS_MODES.includes(s.points_settle_mode) ? s.points_settle_mode : 'realtime';
  const psInitMinutes = psClampMinutes(s.points_settle_interval_minutes);
  const psNat = psNatural(psInitMinutes);

  app.innerHTML = `${settingsTabs('features', __ver, 'points')}
    ${ptsCrumb}
    <div class="card">
      <p class="muted card-lead">
        对<strong>全部用户</strong>重算四维积分并落库快照，供排行榜 / 个人中心读取与追溯历史。
        模式与间隔改完点「保存积分结算设置」；服务端每 60 秒现读一次设置，<strong>保存后立即生效</strong>（无需重启）。
      </p>

      <div class="settle-seg" id="s-points-settle-seg" role="radiogroup" aria-label="积分结算模式">
        <label class="settle-seg-item">
          <input type="radio" name="s-points-settle-mode" value="realtime" ${psMode === 'realtime' ? 'checked' : ''} />
          <span class="settle-seg-btn">实时<i class="settle-seg-tag">默认</i></span>
        </label>
        <label class="settle-seg-item">
          <input type="radio" name="s-points-settle-mode" value="interval" ${psMode === 'interval' ? 'checked' : ''} />
          <span class="settle-seg-btn">定时自动</span>
        </label>
        <label class="settle-seg-item">
          <input type="radio" name="s-points-settle-mode" value="manual" ${psMode === 'manual' ? 'checked' : ''} />
          <span class="settle-seg-btn">手动结算</span>
        </label>
      </div>

      <div class="settle-row" id="s-points-settle-interval-wrap">
        <span class="settle-row-label">结算间隔</span>
        <input class="input settle-num" id="s-points-settle-interval" type="number" inputmode="numeric" step="1" min="1" max="720" value="${psNat.value}" aria-label="结算间隔数值" />
        <select class="input settle-unit" id="s-points-settle-interval-unit" aria-label="结算间隔单位">
          <option value="hour" ${psNat.unit === 'hour' ? 'selected' : ''}>小时</option>
          <option value="day" ${psNat.unit === 'day' ? 'selected' : ''}>天</option>
        </select>
        <span class="settle-hint" id="s-points-settle-hint">= 每 ${psText(psInitMinutes)}（${psInitMinutes} 分钟）</span>
      </div>

      <div class="settle-status" id="s-points-settle-status">${pointsStatusHtml(s)}</div>

      <div class="settle-actions">
        <button class="btn" id="s-points-settle-save"><i class="fa-solid fa-floppy-disk"></i>保存积分结算设置</button>
        <button class="btn btn-ghost" id="s-points-settle-refresh"><i class="fa-solid fa-rotate"></i>刷新状态</button>
        <span class="settle-note">保存后立即生效（服务端每 60 秒现读一次设置，无需重启）</span>
      </div>

      <div class="settle-actions">
        <button class="btn btn-ghost" id="s-points-settle-now"><i class="fa-solid fa-calculator"></i>立即结算全站积分</button>
        <span class="settle-note" id="s-points-settle-result">对全部用户重算并写入快照（不改等级分、不动 rating_history）</span>
      </div>

      <div class="settle-foot">
        <strong>实时</strong>（默认）显示始终取实时计算值，快照只作历史；<strong>定时自动</strong>每隔设定的小时 / 天自动重算一次快照（排行榜与个人中心优先读快照）；<strong>手动结算</strong>只在点「立即结算全站积分」时写快照。<br />
        间隔范围 <strong>1 小时 ~ 30 天</strong>，留空使用默认 <strong>6 小时</strong>；服务端每 60 秒现读一次设置，保存后立即生效（无需重启）。
      </div>
    </div>`;

  /* 单位下拉（小时 / 天）→ 内部统一换算成分钟提交；
   * 空值 = 默认 6 小时；非法值在前端就按「小时 / 天」口径拦下（服务端还会再校验一次）。 */
  const psNumEl = () => document.getElementById('s-points-settle-interval');
  const psUnitEl = () => document.getElementById('s-points-settle-interval-unit');
  const psUnitKey = () => ((psUnitEl() || {}).value === 'day' ? 'day' : 'hour');
  /** 单位决定数值输入的上下限：小时 1~720，天 1~30（都等价于 1 小时 ~ 30 天） */
  const syncSettleUnitBounds = () => {
    const num = psNumEl();
    if (!num) return;
    const day = psUnitKey() === 'day';
    num.min = day ? '1' : '1';
    num.max = day ? '30' : '720';
  };
  /** 即时换算提示：= 每 2 天（2880 分钟）；越界 → 红字说明（仍不出现「分钟」单位口径） */
  const syncSettleHint = () => {
    const hint = document.getElementById('s-points-settle-hint');
    const num = psNumEl();
    if (!hint || !num) return;
    const raw = String(num.value == null ? '' : num.value).trim();
    const per = psUnitKey() === 'day' ? 1440 : 60;
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n) || n <= 0) {
      hint.textContent = '请输入 1 小时 ~ 30 天 之间的整数';
      hint.classList.add('is-bad');
      return;
    }
    const minutes = Math.round(n * per);
    if (minutes < PS_MIN_MINUTES || minutes > PS_MAX_MINUTES) {
      hint.textContent = `超出范围：需在 1 小时 ~ 30 天 之间（当前为 ${psText(minutes)}）`;
      hint.classList.add('is-bad');
      return;
    }
    hint.textContent = `= 每 ${psText(minutes)}（${minutes} 分钟）`;
    hint.classList.remove('is-bad');
  };
  /** 用服务端真值回填间隔输入（换算回最自然单位）并刷新状态芯片 */
  const applySettleFromSettings = (st) => {
    const box = document.getElementById('s-points-settle-status');
    if (box) box.innerHTML = pointsStatusHtml(st);
    const nat = psNatural(psClampMinutes(st.points_settle_interval_minutes));
    const num = psNumEl();
    const unit = psUnitEl();
    if (num) num.value = String(nat.value);
    if (unit) unit.value = nat.unit;
    syncSettleUnitBounds();
    syncSettleHint();
  };

  // 仅「定时自动」时启用间隔输入（实时 / 手动下禁用并降低不透明度，占位不塌陷）
  const pointsSettleRadios = [...document.querySelectorAll('input[name="s-points-settle-mode"]')];
  const psModeOf = () => (pointsSettleRadios.find((r) => r.checked) || {}).value || 'realtime';
  const syncPointsSettleInterval = () => {
    const on = psModeOf() === 'interval';
    const wrap = document.getElementById('s-points-settle-interval-wrap');
    if (wrap) wrap.classList.toggle('is-disabled', !on);
    for (const el of [psNumEl(), psUnitEl()]) if (el) el.disabled = !on;
    syncSettleUnitBounds();
    syncSettleHint();
  };
  pointsSettleRadios.forEach((r) => r.addEventListener('change', syncPointsSettleInterval));
  syncPointsSettleInterval();
  const psNumInput = psNumEl();
  if (psNumInput) psNumInput.addEventListener('input', syncSettleHint);
  const psUnitSelect = psUnitEl();
  if (psUnitSelect) psUnitSelect.addEventListener('change', () => { syncSettleUnitBounds(); syncSettleHint(); });

  // 「保存积分结算设置」：只提交本页两个键（模式 + 间隔分钟），不影响「功能设置」里的四个开关
  const psSaveBtn = document.getElementById('s-points-settle-save');
  if (psSaveBtn) psSaveBtn.addEventListener('click', async () => {
    try {
      const psIvRaw = String((psNumEl() || {}).value == null ? '' : psNumEl().value).trim();
      let psIvMinutes = '';
      if (psIvRaw !== '') {
        const n = Number(psIvRaw);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
          toast('请输入整数（定时间隔单位可选「小时 / 天」，范围 1 小时 ~ 30 天）', 'error');
          return;
        }
        psIvMinutes = n * (psUnitKey() === 'day' ? 1440 : 60);
        if (psIvMinutes < PS_MIN_MINUTES || psIvMinutes > PS_MAX_MINUTES) {
          toast(`定时间隔需在 1 小时 ~ 30 天 之间：当前为 ${psText(psIvMinutes)}`, 'error');
          return;
        }
      }
      psSaveBtn.disabled = true;
      await api.put('/api/settings', {
        points_settle_mode: psModeOf(),
        points_settle_interval_minutes: psIvMinutes,
      });
      toast('积分结算设置已保存', 'success');
      // 状态区按保存后的真实值刷新（模式说明 + 芯片 + 间隔归一到最自然单位）
      try { applySettleFromSettings(await api.get('/api/settings')); } catch { /* 刷新失败不影响保存结果 */ }
    } catch (e) { toast(e.message, 'error'); } finally { psSaveBtn.disabled = false; }
  });

  // 「刷新状态」：重新拉一次设置（上次结算时间 / 耗时 / 覆盖人数 / 下次预计）
  const psRefreshBtn = document.getElementById('s-points-settle-refresh');
  if (psRefreshBtn) psRefreshBtn.addEventListener('click', async () => {
    psRefreshBtn.disabled = true;
    try {
      applySettleFromSettings(await api.get('/api/settings'));
      toast('状态已刷新', 'success');
    } catch (e) { toast(e.message, 'error'); } finally { psRefreshBtn.disabled = false; }
  });

  // 「立即结算全站积分」：对全部用户重算并落库快照（不改等级分、不动 rating_history）
  const pointsSettleBtn = document.getElementById('s-points-settle-now');
  if (pointsSettleBtn) pointsSettleBtn.addEventListener('click', async () => {
    const out = document.getElementById('s-points-settle-result');
    pointsSettleBtn.disabled = true;
    if (out) out.textContent = '正在结算全站积分…（1371 人约需 3 秒）';
    try {
      const r = await api.post('/api/points/settle', {});
      if (out) out.innerHTML = `本次结算 <strong>${r.settled}</strong> / ${r.users} 人`
        + `，耗时 <strong>${(Number(r.ms) / 1000).toFixed(2)} 秒</strong>`
        + `，单批最长 ${Number(r.max_chunk_ms) || 0} ms，快照共 <strong>${r.snapshot_users}</strong> 行`
        + (r.failed ? `<br /><span style="color:var(--red)">失败 ${r.failed} 批</span>` : '');
      toast(`已结算全站积分（${r.settled} 人，${(Number(r.ms) / 1000).toFixed(1)} 秒）`, 'success');
      try { applySettleFromSettings(await api.get('/api/settings')); } catch { /* 刷新失败不影响结算结果 */ }
    } catch (e) {
      if (out) out.textContent = '结算失败：' + e.message;
      toast(e.message, 'error');
    } finally { pointsSettleBtn.disabled = false; }
  });
}

/** 系统设置页的「版本更新」区块：检查更新、一键更新、显示进度（仅最高管理员） */
async function renderUpdateBox() {
  const box = document.getElementById('upd-box');
  if (!box) return;
  if (!Store.user || Store.user.username !== 'admin') {
    box.innerHTML = '<span class="muted" style="font-size:13px">版本更新仅最高管理员（admin）可操作。</span>';
    return;
  }

  let timer = null;
  const stopPoll = () => { if (timer) { clearInterval(timer); timer = null; } };
  const fmtTime = (ts) => { try { return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }); } catch { return '—'; } };

  const paint = (info) => {
    const st = (info && info.state) || {};
    const running = !!st.running;
    const has = !!(info && info.has_update);
    const rows = [];
    // Docker 部署：容器内的代码来自镜像且属主为 root，无法在容器内覆盖，改为给出宿主机更新命令
    // （在 error 分支里也会用到，所以提前声明，避免 TDZ）
    const dockerHint = (info && info.docker_hint) || st.docker_hint || null;
    const inDocker = !!(info && info.in_docker) || !!st.in_docker || !!dockerHint;
    rows.push(`<div style="font-size:13px;line-height:2">
      <div>当前版本：<b>v${escapeHtml((info && info.current) || st.current || '未知')}</b>
        ${info && info.latest ? `　最新版本：<b>v${escapeHtml(info.latest)}</b>` : ''}</div>
      <div class="muted">服务启动方式：${escapeHtml({ pm2: 'PM2 守护', systemd: 'systemd 服务', pidfile: '面板脚本后台进程', none: '直接运行（更新后由重启助手拉起）' }[(info && info.supervisor) || st.supervisor || 'none'] || '未知')}
        ${info && info.checked_at ? `　最后检查：${escapeHtml(fmtTime(info.checked_at))}` : ''}
        ${info && info.source_label ? `　来源：${escapeHtml(info.source_label)}` : ''}</div>
    </div>`);

    // 更新源异常提示（源内容格式异常 / 所有源都不可用）
    if (info && info.error) {
      const tried = (info.tried || []).map((t) => `<div class="muted" style="font-size:12px">· ${escapeHtml(t.label)}：${escapeHtml(t.error || '失败')}</div>`).join('');
      rows.push(`<div class="status-banner warn" style="margin-top:10px;display:block">
        <div><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(info.error)}</div>${tried}</div>`);
    } else if (info && info.warn) {
      rows.push(`<div class="status-banner warn" style="margin-top:10px;display:block">
        <div><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(info.warn)}</div>
        ${(info.tried || []).map((t) => `<div class="muted" style="font-size:12px">· ${escapeHtml(t.label)}：${t.ok ? '正常返回' : escapeHtml(t.error || '失败')}</div>`).join('')}
      </div>`);
    }

    if (st.log && st.log.length) {
      const tail = st.log.slice(-14).map((l) => escapeHtml(l)).join('\n');
      rows.push(`<pre class="code-block" style="margin:10px 0 0;padding:10px;max-height:220px;font-size:12px;line-height:1.6">${tail}</pre>`);
    }

    if (running) {
      rows.push(`<div class="status-banner blue" style="margin-top:12px"><span><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(st.message || '正在更新…')}</span></div>`);
    } else if (st.phase === 'done' && st.restarted) {
      rows.push(`<div class="status-banner" style="margin-top:12px"><span>更新已完成，服务正在重启，页面将自动刷新…</span></div>`);
    } else if (st.phase === 'done' && st.restartRequired) {
      const cmd = escapeHtml(st.restartCommand || 'sudo systemctl restart lczoj');
      rows.push(`<div class="status-banner warn" style="margin-top:12px;display:block">
        <div><i class="fa-solid fa-triangle-exclamation"></i> 程序代码已更新完成，但自动重启未成功（常见原因是当前进程没有重启服务的权限），请手动执行以下命令使新版本生效：</div>
        <pre class="code-block" style="margin:8px 0 0;padding:8px 10px;font-size:12px">${cmd}</pre>
        <div class="muted" style="font-size:12px;margin-top:6px">如需今后在管理后台自动重启（systemd 部署），可在服务器上执行一次：
          <code>sudo bash deploy/grant-restart-permission.sh</code>，该脚本会为服务运行用户配置仅允许重启本服务的 sudo 权限。</div>
      </div>`);
    } else if (st.phase === 'error') {
      rows.push(`<div class="status-banner warn" style="margin-top:12px"><span>更新失败：${escapeHtml(st.error || '未知错误')}</span></div>`);
      // 写权限受阻（Linux ProtectSystem=strict 的 EROFS、属主问题 EACCES、Docker 容器）：
      // 直接给出可复制的解决办法，而不是只丢一句「无写入权限」
      const wb = st.write_block || null;
      if (wb && !inDocker && (wb.commands || wb.note)) {
        rows.push(`<div class="status-banner blue" style="margin-top:10px;display:block">
          <div><i class="fa-solid fa-circle-info"></i> ${escapeHtml(wb.title || '如何解决')}</div>
          ${(wb.commands || []).length ? `<pre class="code-block" style="margin:8px 0 0;padding:8px 10px;font-size:12px;line-height:1.7">${(wb.commands || []).map((c) => escapeHtml(c)).join('\n')}</pre>` : ''}
          ${wb.note ? `<div class="muted" style="font-size:12px;margin-top:6px">${escapeHtml(wb.note)}</div>` : ''}
        </div>`);
      }
    }

    const checking = !!box.dataset.checking;
    const disable = running || checking ? ' disabled' : '';
    const btnLabel = checking ? '<i class="fa-solid fa-spinner fa-spin"></i> 正在检查…' : '<i class="fa-solid fa-rotate"></i> 重新检查';

    // Docker 部署：容器内的代码来自镜像且属主为 root，无法在容器内覆盖，改为给出宿主机更新命令
    if (inDocker && dockerHint) {
      const cmds = (dockerHint.commands || []).map((c) => escapeHtml(c)).join('\n');
      rows.push(`<div class="status-banner blue" style="margin-top:12px;display:block">
        <div><i class="fa-solid fa-cube"></i> ${escapeHtml(dockerHint.title || 'Docker 部署请在宿主机更新')}</div>
        <div class="muted" style="font-size:12px;margin-top:4px">${escapeHtml(dockerHint.reason || '')}</div>
        <pre class="code-block" style="margin:8px 0 0;padding:8px 10px;font-size:12px;line-height:1.6">${cmds}</pre>
        ${dockerHint.dataSafe ? `<div class="muted" style="font-size:12px;margin-top:6px">${escapeHtml(dockerHint.dataSafe)}</div>` : ''}
      </div>`);
    }

    if (has) {
      rows.push(`<div style="margin-top:12px">
        <label class="muted" style="font-size:12px;display:inline-flex;align-items:center;gap:6px;margin-right:12px">
          <input type="checkbox" id="upd-backup" checked${inDocker ? ' disabled' : ''} /> 更新前备份数据库
        </label>
        ${inDocker
          ? `<button class="btn btn-ghost btn-sm" disabled title="容器内的代码来自镜像，请在宿主机重建"><i class="fa-solid fa-cube"></i>请在宿主机更新（见上方命令）</button>
             <button class="btn btn-ghost btn-sm" id="upd-check"${disable}>${btnLabel}</button>`
          : `<button class="btn btn-primary btn-sm" id="upd-start"${running ? ' disabled' : ''}><i class="fa-solid fa-download"></i>立即更新到 v${escapeHtml(info.latest)}</button>
             <button class="btn btn-ghost btn-sm" id="upd-check"${disable}>${btnLabel}</button>`}
      </div>`);
    } else {
      rows.push(`<div style="margin-top:12px">
        <button class="btn btn-ghost btn-sm" id="upd-check"${disable}>${btnLabel}</button>
        <label class="muted" style="font-size:12px;display:inline-flex;align-items:center;gap:6px;margin-left:12px">
          <input type="checkbox" id="upd-backup" checked${inDocker ? ' disabled' : ''} /> 更新前备份数据库
        </label>
        ${inDocker
          ? `<button class="btn btn-ghost btn-sm" disabled title="容器内的代码来自镜像，请在宿主机重建"><i class="fa-solid fa-cube"></i>请在宿主机更新（见上方命令）</button>`
          : `<button class="btn btn-ghost btn-sm" id="upd-force"${running ? ' disabled' : ''}><i class="fa-solid fa-rotate-right"></i>强制重新拉取代码</button>`}
      </div>`);
    }
    box.innerHTML = rows.join('');

    const checkBtn = document.getElementById('upd-check');
    if (checkBtn) checkBtn.addEventListener('click', () => load(true));
    const startBtn = document.getElementById('upd-start');
    const forceBtn = document.getElementById('upd-force');
    const doStart = async (force) => {
      const backup = (document.getElementById('upd-backup') || {}).checked !== false;
      const tip = force ? '确定要强制重新拉取并覆盖程序代码吗？（数据不受影响）' : '确定现在更新吗？更新期间网站会短暂重启（约 5~20 秒）。';
      if (!confirm(tip)) return;
      try {
        await api.post('/api/admin/update/start', { backup, restart: true, force });
        box.insertAdjacentHTML('beforeend', '<div class="status-banner blue" style="margin-top:12px"><span>更新任务已开始，正在执行…</span></div>');
        poll();
      } catch (e) { toast(e.message, 'error'); }
    };
    if (startBtn) startBtn.addEventListener('click', () => doStart(false));
    if (forceBtn) forceBtn.addEventListener('click', () => doStart(true));
  };

  const load = async (force) => {
    // 立即给出「正在检查」的反馈：重新检查接口最长会等两个更新源各 8 秒
    box.dataset.checking = '1';
    const btn = document.getElementById('upd-check');
    if (btn) { btn.setAttribute('disabled', 'disabled'); btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在检查…'; }
    try {
      const info = await api.get('/api/admin/update' + (force ? '?force=1' : ''));
      delete box.dataset.checking;
      paint(info);
      if (info && info.state && info.state.running) poll();
      else if (force) toast(info && info.latest ? `已检查：最新版本 v${info.latest}` : '已检查：未能获取最新版本信息', info && info.latest ? 'success' : 'error');
    } catch (e) {
      delete box.dataset.checking;
      paint({ current: (Store && Store.version) || '未知', error: `检查更新失败：${e.message}`, tried: [] });
      toast('检查更新失败：' + e.message, 'error');
    }
  };

  const poll = () => {
    stopPoll();
    let restarted = false;
    timer = setInterval(async () => {
      try {
        const r = await api.get('/api/admin/update/status');
        paint({ current: Store.version, ...(r.state || {}), state: r.state });
        if (r.state && r.state.phase === 'done' && r.state.restarted) {
          if (!restarted) {
            restarted = true;
            stopPoll();
            let left = 10;
            const banner = document.createElement('div');
            banner.className = 'status-banner blue';
            banner.style.marginTop = '12px';
            banner.innerHTML = `<span>服务正在重启，<b id="upd-count">${left}</b> 秒后自动刷新…</span>`;
            box.appendChild(banner);
            const t = setInterval(() => {
              left--;
              const el = document.getElementById('upd-count');
              if (el) el.textContent = String(Math.max(0, left));
              if (left <= 0) { clearInterval(t); location.reload(); }
            }, 1000);
          }
        }
        if (r.state && !r.state.running && r.state.phase === 'error') stopPoll();
      } catch {
        // 服务重启期间请求会失败，这是正常的：等几秒后自动刷新
        if (!restarted) {
          restarted = true;
          stopPoll();
          setTimeout(() => location.reload(), 8000);
        }
      }
    }, 1500);
  };

  load(false);
}

/* 批量删除 / 重置页面（仅 admin，系统设置隐藏入口进入） */
async function renderAdminBatchDelete() {
  app.innerHTML = '<div class="loading">加载中…</div>';
  setPageTitle('批量删除 / 重置');
  if (!Store.user || Store.user.username !== 'admin') {
    app.innerHTML = '<div class="empty">仅最高管理员（admin）可访问此页面</div>';
    return;
  }
  const __ver = await siteVersion();
  // 与 #/settings 保持一致：顶部只保留 settingsTabs 里的「系统设置」标题，本页不再重复显示页面标题
  app.innerHTML = `${settingsTabs('batch-delete', __ver)}
    <div class="card">
      <p class="muted card-lead">在下方输入要删除的 ID（逗号分隔），或先勾选「全选该类」后由页面读取列表。</p>
      <div class="form-group"><label>删除类型</label>
        <select class="input" id="bd-type" style="width:auto">
          <option value="articles">文章（题解 / 专栏）</option>
          <option value="feedbacks">反馈 / 投稿 / 举报</option>
          <option value="problems">题目</option>
          <option value="contests">比赛</option>
          <option value="discussions">讨论</option>
          <option value="users">用户</option>
        </select>
      </div>
      <div class="form-group"><label>ID 列表（逗号分隔，支持范围，如 1,3,5-8）</label><input class="input" id="bd-ids" placeholder="1,3,5-8" /></div>
      <div class="row"><button class="btn btn-danger" id="bd-run"><i class="fa-solid fa-trash-can"></i>执行批量删除</button><span class="muted">将同时删除关联数据（提交、回复、收藏等）</span></div>
    </div>
    <div class="card">
      <p class="muted card-lead">按用户名 / 昵称 / 邮箱搜索用户，逐个删除。删除用户会同时清理其提交、回复、收藏等关联数据；内置 admin 账号不可删除。</p>
      <div class="row" style="gap:8px">
        <input class="input" id="bd-user-search" placeholder="搜索用户名 / 昵称 / 邮箱" style="flex:1" />
        <button class="btn" id="bd-user-search-btn" type="button"><i class="fa-solid fa-magnifying-glass"></i>搜索</button>
      </div>
      <div id="bd-user-list" class="mt"></div>
    </div>
    <div class="card" style="border-color:rgba(255,77,79,.5)">
      <p class="muted card-lead">删除全部题目 / 文章 / 反馈 / 比赛 / 讨论 / 提交 / 用户（保留 admin 账号与系统设置），回到首次启动状态。此操作不可恢复！</p>
      <button class="btn btn-danger" id="bd-clear"><i class="fa-solid fa-triangle-exclamation"></i>清空全部数据</button>
    </div>`;

    // 删除用户：搜索 + 列表 + 逐个删除
  const userSearch = document.getElementById('bd-user-search');
  const userListBox = document.getElementById('bd-user-list');
  const renderUserSearch = async (search) => {
    userListBox.innerHTML = '<div class="muted">搜索中…</div>';
    try {
      const q = new URLSearchParams({ search: search || '', page: '1', size: '10' });
      const r = await api.get('/api/admin/users?' + q.toString());
      const items = r.items || [];
      if (!items.length) { userListBox.innerHTML = '<div class="empty">未找到匹配用户</div>'; return; }
      userListBox.innerHTML = `<div style="overflow:auto"><table class="table"><thead><tr><th>ID</th><th>用户名</th><th>昵称</th><th>邮箱</th><th>权限</th><th>操作</th></tr></thead><tbody>${items.map((u) => `
        <tr>
          <td class="num">${u.id}</td>
          <td>${escapeHtml(u.username)}${u.is_superadmin ? ' <span class="badge" style="background:#722ed1;color:#fff;font-size:11px">超管</span>' : ''}</td>
          <td>${escapeHtml(u.nickname || '—')}</td>
          <td>${escapeHtml(u.email || '—')}</td>
          <td class="muted" style="font-size:12px">${(u.permissions || []).length ? `${u.permissions.length} 项权限` : '普通用户'}</td>
          <td>${u.username === 'admin' ? '<span class="muted" style="font-size:12px">不可删除</span>' : `<button class="btn btn-danger btn-sm bd-user-del" data-id="${u.id}" data-name="${escapeHtml(u.username)}"><i class="fa-solid fa-trash-can"></i>删除</button>`}</td>
        </tr>`).join('')}</tbody></table></div>`;
      userListBox.querySelectorAll('.bd-user-del').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm(`确定删除用户「${b.dataset.name}」（ID ${b.dataset.id}）吗？将同时删除其提交、回复、收藏等全部关联数据，不可恢复。`)) return;
        try {
          const r = await api.post('/api/admin/batch-delete', { type: 'users', ids: [parseInt(b.dataset.id, 10)] });
          toast(`已删除用户 ${r.count || 0} 个`, 'success');
          renderUserSearch(search);
        } catch (e) { toast(e.message, 'error'); }
      }));
    } catch (e) { userListBox.innerHTML = `<div class="empty">搜索失败：${escapeHtml(e.message)}</div>`; }
  };
  document.getElementById('bd-user-search-btn').addEventListener('click', () => renderUserSearch(userSearch.value.trim()));
  userSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') renderUserSearch(userSearch.value.trim()); });
  document.getElementById('bd-run').addEventListener('click', async () => {
    const type = document.getElementById('bd-type').value;
    // ID 列表支持范围：如 "1,3,5-8" → [1,3,5,6,7,8]
    const ids = [];
    for (const part of document.getElementById('bd-ids').value.split(/[,，\s]+/)) {
      const m = String(part).trim().match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        const lo = Math.min(a, b), hi = Math.max(a, b);
        for (let i = lo; i <= hi; i++) ids.push(i);
      } else {
        const n = parseInt(part, 10);
        if (Number.isFinite(n) && n > 0) ids.push(n);
      }
    }
    if (!ids.length) return toast('请输入要删除的 ID（支持范围，如 1,3,5-8）', 'error');
    if (!confirm(`确定删除 ${ids.length} 条${document.getElementById('bd-type').selectedOptions[0].text}？此操作不可恢复。`)) return;
    try {
      const r = await api.post('/api/admin/batch-delete', { type, ids });
      toast(`已删除 ${r.count || 0} 条数据`, 'success');
      document.getElementById('bd-ids').value = '';
    } catch (e) { toast(e.message, 'error'); }
  });
  document.getElementById('bd-clear').addEventListener('click', async () => {
    if (!confirm('确定清空网站全部数据到初始状态吗？此操作不可恢复！\n将删除所有题目、文章、反馈、比赛、讨论、提交与普通用户，仅保留 admin 账号。')) return;
    if (!confirm('再次确认：真的要清空吗？')) return;
    try {
      const r = await api.post('/api/admin/batch-delete', { type: 'clear_all' });
      toast(r.cleared ? '网站已清空到初始状态' : '操作完成', 'success');
      nav('home');
    } catch (e) { toast(e.message, 'error'); }
  });
}

/* 清理多余数据页面（仅 admin）——**属于系统设置**：路由 #/settings/cleanup，侧边栏高亮「系统设置」，
 * 页头直接用系统设置的统一页头（settingsTabs('cleanup')），因此本页不再单独渲染页面标题。
 * 旧地址 #/admin/cleanup 由 route() 重定向到这里（不留死链接）。
 * 只清理「缓存 / 临时 / 孤儿 / 过期」数据：每一项先给数量与占用空间预览，再由管理员确认执行；
 * 服务端（src/cleanup.js）用白名单实现——users / problems / contests / submissions / editorials /
 * discussions / notifications 这些用户内容一行都不会删。 */
async function renderAdminCleanup() {
  app.innerHTML = '<div class="loading">加载中…</div>';
  setPageTitle('清理多余数据');
  if (!Store.user || Store.user.username !== 'admin') {
    app.innerHTML = '<div class="empty">仅最高管理员（admin）可访问此页面</div>';
    return;
  }
  const __ver = await siteVersion();
  app.innerHTML = `${settingsTabs('cleanup', __ver)}
    <div class="card" style="border-color:rgba(52,152,219,.45)">
      <p class="muted card-lead">
        本页只清理<strong>缓存、评测临时产物、孤儿文件与已过期记录</strong>。执行前每一项都会先给出数量与占用空间，
        清理结果会逐项列出「删除条数 / 释放空间 / 失败项」，并写入审计（管理记录，动作名 <span class="mono">cleanup_data</span>）。
      </p>
      <div class="muted" style="font-size:12px">
        <strong>安全边界</strong>：服务端只允许删除
        <span class="mono">data/judge</span>（评测临时目录）、
        <span class="mono">data/spj_cache</span> / <span class="mono">data/interactor_cache</span>（不被任何题目引用的编译缓存）、
        <span class="mono">data/testdata</span> 中<strong>题库里已不存在的题目目录</strong>、
        <span class="mono">data/avatars</span> 中<strong>账号已不存在的头像</strong>，以及
        <span class="mono">logs/</span> 下过大日志的尾部截断；
        另有已过期的登录会话 / 待验证注册 / 登录失败计数。
        <br />用户、题目、比赛、提交、题解、讨论、通知等<strong>内容数据一行都不会删</strong>；
        <span class="mono">data/</span> 下其它任何路径（附件、Go 缓存、数据库及备份……）<strong>不碰</strong>。
      </div>
    </div>

    <div class="card">
      <p class="muted card-lead">清理阈值（改完点「重新预览」即可看到新的可清理量；执行时按当前填写的值生效）</p>
      <div class="row" style="gap:14px;flex-wrap:wrap">
        <div class="form-group" style="flex:1;min-width:190px"><label>日志阈值（KB，64~1048576）</label><input class="input" id="cl-log-max" type="number" min="64" value="2048" /></div>
        <div class="form-group" style="flex:1;min-width:190px"><label>日志保留最新（KB，16~）</label><input class="input" id="cl-log-keep" type="number" min="16" value="256" /></div>
        <div class="form-group" style="flex:1;min-width:190px"><label>最小静置时间（分钟，0~1440）</label><input class="input" id="cl-min-age" type="number" min="0" max="1440" value="10" /><span class="muted" style="font-size:12px">刚用过 / 可能正在评测的缓存与临时目录会被跳过</span></div>
        <div class="form-group" style="flex:1;min-width:190px"><label>grader 缓存过期天数（1~3650）</label><input class="input" id="cl-grader-days" type="number" min="1" value="7" /><span class="muted" style="font-size:12px">grader 缓存键含选手源码，无法静态判断引用，只按天数清</span></div>
      </div>
      <div class="status-banner warn" style="margin-top:6px">
        <span style="font-weight:700"><i class="fa-solid fa-triangle-exclamation"></i> 强制全清（默认关闭）</span>
        <span>
          勾选后，<strong>SPJ checker 缓存</strong>与<strong>交互器 / grader 缓存</strong>会<strong>连同仍被题目引用的编译产物一起删除</strong>
          —— 这些文件是纯可再生产物（判定口径、提交记录、题目数据都不受影响），但<strong>下次判题需要重新用 g++ 编译，
          首次判题会明显变慢（通常每个 checker 多几秒，机器繁忙时更久）</strong>。
          正在评测中的 checker / 交互器由判题器「缓存缺失即重新编译」兜底，不会因此误判。
        </span>
      </div>
      <div class="row" style="gap:14px;flex-wrap:wrap;align-items:center">
        <label class="switch" title="连同被题目引用的缓存一起清空">
          <input type="checkbox" id="cl-force" /><span class="slider"></span>
          <span class="switch-label">强制全清缓存<span class="muted">含被题目引用的 checker / 交互器 / grader 产物，下次判题重新编译</span></span>
        </label>
        <span class="muted" style="font-size:12px" id="cl-force-tip"></span>
      </div>
      <div class="row"><button class="btn btn-ghost" id="cl-refresh"><i class="fa-solid fa-rotate"></i>重新预览</button>
        <button class="btn btn-danger" id="cl-run-all"><i class="fa-solid fa-broom"></i>一键全部清理</button>
        <span class="muted" style="font-size:12px" id="cl-total"></span></div>
    </div>

    <div class="card">
      <div id="cl-list"><div class="loading">扫描中…</div></div>
    </div>

    <div class="card" id="cl-result-card" style="display:none">
      <div class="card-title">清理结果</div>
      <div id="cl-result"></div>
    </div>`;

  const fmtBytes = (n) => {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(2)} MB`;
    return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };
  const clVal = (id) => { const el = document.getElementById(id); return el ? String(el.value).trim() : ''; };
  // 强制全清（默认不勾选）：传给服务端的是显式布尔，未勾选时不影响既有清理口径
  const clForce = () => { const el = document.getElementById('cl-force'); return !!(el && el.checked); };
  const clParams = () => ({
    log_max_kb: clVal('cl-log-max'), log_keep_kb: clVal('cl-log-keep'),
    min_age_min: clVal('cl-min-age'), grader_stale_days: clVal('cl-grader-days'),
    force: clForce() ? '1' : '0',
  });
  const runErrorToast = (e) => toast(e && e.message ? e.message : '操作失败', 'error');

  let last = { categories: [] };

  const renderResult = (r) => {
    const card = document.getElementById('cl-result-card');
    if (!card) return;
    card.style.display = '';
    const failed = r.failed || [];
    document.getElementById('cl-result').innerHTML = `
      <div class="muted mb" style="font-size:13px">
        共删除 <strong>${r.removed || 0}</strong> 项，释放 <strong>${fmtBytes(r.freedBytes)}</strong>${failed.length ? `，失败 <strong style="color:#ff4d4f">${failed.length}</strong> 项` : '，无失败项'}。
      </div>
      <div style="overflow:auto"><table class="table"><thead><tr><th>分类</th><th class="num">删除条数</th><th class="num">释放空间</th><th>失败</th></tr></thead><tbody>
        ${(r.results || []).map((x) => `<tr><td>${escapeHtml(x.name)}</td><td class="num">${x.removed || 0}</td><td class="num">${fmtBytes(x.freedBytes)}</td><td class="muted" style="font-size:12px">${(x.failed || []).length ? (x.failed || []).map((f) => escapeHtml(f.error)).join('；') : '—'}</td></tr>`).join('')}
      </tbody></table></div>
      ${failed.length ? `<div class="muted mt" style="font-size:12px">失败明细：${failed.slice(0, 20).map((f) => `${escapeHtml(f.name)}：${escapeHtml(f.error)}`).join('；')}</div>` : ''}`;
  };

  const renderList = (data) => {
    last = data;
    const cats = data.categories || [];
    const forceOn = !!(data.params && data.params.force);
    const box = document.getElementById('cl-list');
    box.innerHTML = cats.map((c) => {
      // 强制模式下这两类的口径变成「连被引用的缓存一起清」：在行内明确标出来，避免误判
      const forced = forceOn && (c.key === 'spj_cache' || c.key === 'interactor_cache');
      return `
      <div class="cl-row" style="border-top:1px solid var(--border,#eee);padding:12px 0">
        <div class="row" style="gap:10px;align-items:baseline;flex-wrap:wrap">
          <strong>${escapeHtml(c.name)}</strong>
          ${forced ? '<span class="badge" style="background:#ffe9e6;color:#ff4d4f;font-size:11px;font-weight:700">强制全清</span>' : ''}
          <span class="badge" style="background:var(--accent-soft,#eaf4ff);color:var(--accent);font-size:11px">${c.count} 项</span>
          <span class="muted" style="font-size:12px">${c.bytes ? `占用 ${fmtBytes(c.bytes)}` : '不占磁盘空间'}</span>
          <div class="spacer"></div>
          <button class="btn btn-sm ${c.count ? 'btn-danger' : 'btn-ghost'} cl-run-one" data-key="${escapeHtml(c.key)}" ${c.count ? '' : 'disabled'}>${c.count ? '<i class="fa-solid fa-broom"></i>单独清理' : '无需清理'}</button>
        </div>
        <div class="muted" style="font-size:12px;margin-top:4px">${escapeHtml(c.desc)}${c.detail ? `（${escapeHtml(c.detail)}）` : ''}</div>
        ${c.items && c.items.length ? `<div class="muted mono" style="font-size:11px;margin-top:4px;word-break:break-all">示例：${c.items.slice(0, 5).map((i) => escapeHtml(i.name) + (i.kind ? `（${escapeHtml(i.kind)}）` : '')).join('、')}${c.count > 5 ? ` …共 ${c.count} 项` : ''}</div>` : ''}
      </div>`;
    }).join('');
    document.getElementById('cl-total').textContent = `当前可清理 ${data.total_count || 0} 项，约 ${fmtBytes(data.total_bytes)}`;
    box.querySelectorAll('.cl-run-one').forEach((b) => b.addEventListener('click', async () => {
      const key = b.dataset.key;
      const cat = (last.categories || []).find((x) => x.key === key) || { name: key, count: 0, bytes: 0 };
      const force = clForce();
      const forceNote = force && (key === 'spj_cache' || key === 'interactor_cache')
        ? '\n\n⚠ 已勾选「强制全清」：将连同「仍被题目引用」的编译产物一起删除，\n下次判题需要用 g++ 重新编译，首次判题会变慢（判定口径不变）。' : '';
      if (!confirm(`确定清理「${cat.name}」吗？\n共 ${cat.count} 项，约 ${fmtBytes(cat.bytes)}。\n此操作不可恢复（但只会删除缓存 / 临时 / 孤儿 / 过期数据，不影响用户内容）。${forceNote}`)) return;
      b.disabled = true;
      try {
        const r = await api.post('/api/admin/cleanup', { categories: [key], params: clParams() });
        renderResult(r);
        toast(`「${cat.name}」已清理 ${r.removed || 0} 项，释放 ${fmtBytes(r.freedBytes)}`, 'success');
        await refresh();
      } catch (e) { runErrorToast(e); b.disabled = false; }
    }));
  };

  async function refresh() {
    const box = document.getElementById('cl-list');
    if (box) box.innerHTML = '<div class="loading">扫描中…</div>';
    try {
      const q = new URLSearchParams(clParams());
      const data = await api.get('/api/admin/cleanup/preview?' + q.toString());
      renderList(data);
    } catch (e) {
      if (box) box.innerHTML = `<div class="empty">扫描失败：${escapeHtml(e && e.message ? e.message : '')}</div>`;
    }
  }

  document.getElementById('cl-refresh').addEventListener('click', refresh);
  // 勾选 / 取消「强制全清」：立即重新预览，让管理员看到强制模式下真正会被删除的条数与空间
  document.getElementById('cl-force').addEventListener('change', () => {
    const tip = document.getElementById('cl-force-tip');
    if (tip) tip.innerHTML = clForce()
      ? '<span style="color:#ff4d4f;font-weight:700">强制全清已开启：预览与执行都会包含被题目引用的缓存</span>'
      : '';
    refresh();
  });
  document.getElementById('cl-run-all').addEventListener('click', async () => {
    const total = last.total_count || 0;
    if (!total) return toast('当前没有可清理的数据', 'error');
    const forceAll = clForce();
    if (!confirm(`确定一键清理全部 ${total} 项（约 ${fmtBytes(last.total_bytes)}）吗？\n只会删除缓存 / 临时 / 孤儿 / 过期数据，用户、题目、比赛、提交、题解、讨论等内容数据不会被删除。`
      + (forceAll ? '\n\n⚠ 已勾选「强制全清」：SPJ checker 缓存与交互器 / grader 缓存会连同仍被题目引用的编译产物一起删除，\n下次判题需要用 g++ 重新编译，首次判题会变慢（判定口径不变）。' : ''))) return;
    if (!confirm('再次确认：立即执行全部清理？此操作不可恢复。')) return;
    const btn = document.getElementById('cl-run-all');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 清理中…';
    try {
      const r = await api.post('/api/admin/cleanup', { categories: [], params: clParams() });
      renderResult(r);
      toast(`已清理 ${r.removed || 0} 项，释放 ${fmtBytes(r.freedBytes)}`, 'success');
      await refresh();
    } catch (e) { runErrorToast(e); }
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-broom"></i> 一键全部清理';
  });

  await refresh();
}

/* 批量生成用户页面（仅 admin，系统设置入口） */
async function renderAdminBatchUsers() {
  app.innerHTML = '<div class="loading">加载中…</div>';
  setPageTitle('批量生成用户');
  if (!Store.user || Store.user.username !== 'admin') {
    app.innerHTML = '<div class="empty">仅最高管理员（admin）可访问此页面</div>';
    return;
  }
  const __ver = await siteVersion();
  // 与 #/settings 保持一致：顶部只保留 settingsTabs 里的「系统设置」标题，本页不再重复显示页面标题
  app.innerHTML = `${settingsTabs('batch-users', __ver)}
    <div class="card">
      <p class="muted card-lead">用户名 = <strong>前缀 + 编号（按位数补零） + 后缀</strong>，例如前缀 <code>stu</code>、后缀 <code>test</code>、编号 1-3、位数 3 → <code>stu001test</code>、<code>stu002test</code>、<code>stu003test</code>。已存在的用户名自动跳过。</p>
      <div class="row" style="gap:16px;flex-wrap:wrap">
        <div class="form-group" style="flex:1;min-width:120px"><label>用户名前缀</label><input class="input" id="bu-prefix" placeholder="如 stu" /></div>
        <div class="form-group" style="flex:1;min-width:120px"><label>用户名后缀</label><input class="input" id="bu-suffix" placeholder="如 test" /></div>
        <div class="form-group" style="flex:0 0 100px"><label>起始编号</label><input class="input" id="bu-start" type="number" min="1" value="1" /></div>
        <div class="form-group" style="flex:0 0 100px"><label>结束编号</label><input class="input" id="bu-end" type="number" min="1" value="10" /></div>
        <div class="form-group" style="flex:0 0 90px"><label>编号位数（补零）</label><input class="input" id="bu-digits" type="number" min="1" max="6" value="3" /></div>
      </div>
      <div class="row" style="gap:16px;flex-wrap:wrap">
        <div class="form-group" style="flex:1;min-width:160px"><label>默认密码（不限强度，账号首次登录会要求改密）</label><input class="input" id="bu-password" type="text" placeholder="留空则需勾选下方「随机生成」" /></div>
        <div class="form-group" style="flex:0 0 auto;padding-top:26px"><label class="switch"><input type="checkbox" id="bu-random" /><span class="slider"></span><span class="switch-label">每个账号随机生成密码<span class="muted">12 位，含字母 / 数字 / 符号</span></span></label></div>
        <div class="form-group" style="flex:1;min-width:160px"><label>邮箱域名（可选，如 126.com）</label><input class="input" id="bu-domain" placeholder="如 example.com（留空不填邮箱）" /></div>
      </div>
      <div class="row">
        <button class="btn btn-lg" id="bu-run"><i class="fa-solid fa-wand-magic-sparkles"></i>批量生成</button>
        <span class="muted" style="font-size:12px;align-self:center">单次最多 500 个；生成后可在下方复制 / 导出账号列表</span>
      </div>
    </div>
    <div class="card" id="bu-result-card" style="display:none">
      <div class="muted mb" id="bu-summary" style="font-size:13px"></div>
      <div class="row mb" style="gap:8px">
        <button class="btn btn-ghost btn-sm" id="bu-copy"><i class="fa-solid fa-copy"></i>复制全部账号</button>
        <button class="btn btn-ghost btn-sm" id="bu-export"><i class="fa-solid fa-download"></i>导出 .txt</button>
        <button class="btn btn-ghost btn-sm" id="bu-csv"><i class="fa-solid fa-file-csv"></i>下载 CSV</button>
      </div>
      <div id="bu-list" style="max-height:420px;overflow:auto"></div>
    </div>`;
  const runBtn = document.getElementById('bu-run');
  runBtn.addEventListener('click', async () => {
    const payload = {
      prefix: document.getElementById('bu-prefix').value.trim(),
      suffix: document.getElementById('bu-suffix').value.trim(),
      start: parseInt(document.getElementById('bu-start').value, 10),
      end: parseInt(document.getElementById('bu-end').value, 10),
      digits: parseInt(document.getElementById('bu-digits').value, 10),
      password: document.getElementById('bu-password').value,
      random_password: document.getElementById('bu-random').checked,
      email_domain: document.getElementById('bu-domain').value.trim(),
    };
    if (!payload.prefix && !payload.suffix) return toast('请至少填写用户名前缀或后缀', 'error');
    if (!payload.random_password && !payload.password) return toast('请填写默认密码，或勾选「每个账号随机生成密码」', 'error');
    runBtn.disabled = true;
    runBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 生成中…';
    try {
      const r = await api.post('/api/admin/batch-users', payload);
      document.getElementById('bu-result-card').style.display = '';
      const created = r.created || [];
      const skipped = r.skipped || [];
      document.getElementById('bu-summary').textContent = `成功创建 ${r.total} 个，跳过 ${skipped.length} 个（已存在或不符合规则）`;
      document.getElementById('bu-list').innerHTML = created.length
        ? `<table class="table"><thead><tr><th class="num">#</th><th>用户名</th><th>密码</th><th>邮箱</th></tr></thead><tbody>${created.map((u, i) => `
            <tr><td class="num">${i + 1}</td><td class="mono">${escapeHtml(u.username)}</td><td class="mono">${escapeHtml(u.password)}</td><td class="mono muted">${payload.email_domain ? escapeHtml(u.username + '@' + payload.email_domain) : '—'}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">没有生成任何用户</div>';
      if (skipped.length) {
        document.getElementById('bu-list').insertAdjacentHTML('beforeend', `<div class="muted mt" style="font-size:12px">已跳过：${skipped.map((s) => escapeHtml(s.username)).join('、')}</div>`);
      }
      toast(`已生成 ${r.total} 个用户`, 'success');
    } catch (e) { toast(e.message, 'error'); }
    runBtn.disabled = false;
    runBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 批量生成';
  });
  // 复制全部账号（用户名 密码 每行一个）
  document.getElementById('bu-copy').addEventListener('click', async () => {
    const rows = Array.from(document.querySelectorAll('#bu-list tbody tr')).map((tr) => {
      const tds = tr.querySelectorAll('td');
      return `${tds[1].textContent} ${tds[2].textContent}`;
    });
    if (!rows.length) return toast('没有可复制的账号', 'error');
    const text = rows.join('\n');
    let ok = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; } } catch { /* ignore */ }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    toast(ok ? '已复制全部账号（每行：用户名 密码）' : '复制失败', ok ? 'success' : 'error');
  });
  // 导出 .txt
  document.getElementById('bu-export').addEventListener('click', () => {
    const rows = Array.from(document.querySelectorAll('#bu-list tbody tr')).map((tr) => {
      const tds = tr.querySelectorAll('td');
      return `${tds[1].textContent}\t${tds[2].textContent}${tds[3].textContent !== '—' ? '\t' + tds[3].textContent : ''}`;
    });
    if (!rows.length) return toast('没有可导出的账号', 'error');
    const blob = new Blob(['用户名\t密码\t邮箱\n' + rows.join('\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '批量用户账号.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  // 下载 CSV（Excel 可直接打开：用户名,密码,邮箱）
  document.getElementById('bu-csv').addEventListener('click', () => {
    const esc = (s) => {
      const v = String(s == null ? '' : s);
      return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    const rows = Array.from(document.querySelectorAll('#bu-list tbody tr')).map((tr) => {
      const tds = tr.querySelectorAll('td');
      const mail = tds[3].textContent.trim() === '—' ? '' : tds[3].textContent;
      return [esc(tds[1].textContent), esc(tds[2].textContent), esc(mail)].join(',');
    });
    if (!rows.length) return toast('没有可下载的账号', 'error');
    const lines = ['用户名,密码,邮箱'].concat(rows);
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '批量用户账号.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(`已下载 CSV（${rows.length} 个账号）`, 'success');
  });
}

/* ---------- 外观「已保存」快照：后台里未保存的预览不会带到其它页面 ----------
   后台「网站外观」是即时预览（改一下就立即全站生效），但只有点「保存网站外观」才算保存。
   这里记录最近一次从 /api/home 拿到的已保存配置，路由切换时用它回滚，避免未保存的改动留在其它页面上。 */
let savedLook = {
  appearance: {}, contentWidth: '', homeWidth: '', pageWidths: {}, titleStyle: {}, logoSize: '', titleSize: '',
};

/** 用 /api/home 的返回更新「已保存」快照并立即套用（启动、保存成功后调用） */
function setSavedLook(home) {
  savedLook = {
    appearance: (home && home.appearance) || {},
    contentWidth: (home && home.content_max_width) || '',
    homeWidth: (home && home.home_max_width) || '',
    pageWidths: (home && home.page_widths) || {},
    titleStyle: (home && home.title_style) || {},
    logoSize: (home && home.site_logo_size) || '',
    titleSize: (home && home.site_title_size) || '',
  };
  applySavedLook();
}

/** 套用「已保存」快照（离开后台设置页 / 路由切换时调用） */
function applySavedLook() {
  applySiteTitleStyle(savedLook.titleStyle);
  applyLogoSize(savedLook.logoSize);
  applyTitleSize(savedLook.titleSize);
  applySitePageWidths(savedLook.pageWidths);
  applyContentWidth(savedLook.contentWidth);
  applyHomeWidth(savedLook.homeWidth);
  applyAppearance(savedLook.appearance);
}

/* 将站点名称 / Logo 应用到侧边栏与浏览器标题 */
async function applySiteBrand() {
  try {
    const home = await api.get('/api/home');
    if (home.site_name) {
      SITE_NAME = home.site_name;
      document.getElementById('site-brand').textContent = home.site_name;
      // v2.8.1：站点名变了 → 用**当前页标题**重算 document.title，不能清空
      //（清空会让「系统设置 - 站点名」变成只有「站点名」）
      setPageTitle(LAST_PAGE_TITLE);
    }
    const icon = document.getElementById('brand-icon');
    if (icon) {
      if (home.site_logo) {
        icon.innerHTML = `<img class="site-logo-img" src="${escapeHtml(home.site_logo)}" alt="logo" onerror="this.style.display='none'" />`;
      } else {
        // 未自定义 Logo → 站点默认 Logo（与 favicon 默认图标同一份字节，见 public/img/logo.svg）；
        // 渲染方式与自定义 Logo 完全一致（同一个 .site-logo-img，跟着「Logo 大小」滑块缩放）
        icon.innerHTML = '<img class="site-logo-img" src="/img/logo.svg?v=296" alt="logo" />';
      }
    }
    setSavedLook(home); // 标题样式 / 页面宽度 / 首页宽度 / 网站外观 / Logo 大小一并套用并记入「已保存」快照
  } catch { /* ignore */ }
}

/* ---------- 题目重判（仅超级管理员） ---------- */
async function renderAdminRejudge() {
  setPageTitle('题目重判');
  app.innerHTML = `${adminTabs('rejudge')}<div class="loading">加载中…</div>`;

  // 支持从题目管理页跳转时预填： #/admin/rejudge?problem=16
  const hashQuery = new URLSearchParams((location.hash.split('?')[1] || ''));
  const preProblem = hashQuery.get('problem') || '';
  const preContest = hashQuery.get('contest') || '';

  app.innerHTML = `${adminTabs('rejudge')}
    ${adminHead({
      title: '<i class="fa-solid fa-rotate-right"></i> 题目重判',
      meta: '仅超级管理员可用，单次最多 5000 条提交',
    })}
    <div class="status-banner warn" style="margin-top:6px">
      <span style="font-weight:700"><i class="fa-solid fa-triangle-exclamation"></i> 重判会清空原评测结果</span>
      <span class="muted">所选提交将重新排队评测（状态重置为 Pending，分数 / 用时 / 内存 / 编译信息清空后重新计算），题目通过数与比赛排名会随新结果更新。</span>
    </div>

    <div class="card">
      <h2 class="card-title">1. 选择重判范围</h2>
      <div class="row" style="gap:8px;flex-wrap:wrap" id="rj-scopes">
        <a class="chip active" data-scope="problem"><i class="fa-solid fa-file-code"></i> 某道题目的全部提交</a>
        <a class="chip" data-scope="contest_problem"><i class="fa-solid fa-trophy"></i> 比赛中某道题目的全部提交</a>
        <a class="chip" data-scope="range"><i class="fa-solid fa-list-ol"></i> 自定义提交 ID 区间</a>
      </div>

      <div class="rj-form" data-for="problem" style="margin-top:14px">
        <div class="row" style="gap:16px;flex-wrap:wrap">
          <div class="form-group" style="flex:0 0 220px"><label>题目 ID</label>
            <input class="input" id="rj-problem-id" type="number" min="1" step="1" value="${escapeHtml(preProblem)}" placeholder="输入题号，如 16" />
            <div class="muted" style="font-size:12px" id="rj-problem-hint">填题库中的题目 ID（题号），不是标题</div>
          </div>
          <div class="form-group" style="flex:0 0 220px"><label>提交类型</label>
            <select class="input" id="rj-contest-mode">
              <option value="all">全部提交（含比赛提交）</option>
              <option value="normal">仅普通提交</option>
              <option value="contest">仅比赛提交</option>
            </select>
          </div>
        </div>
      </div>

      <div class="rj-form" data-for="contest_problem" style="margin-top:14px;display:none">
        <div class="row" style="gap:16px;flex-wrap:wrap">
          <div class="form-group" style="flex:0 0 200px"><label>比赛 ID</label>
            <input class="input" id="rj-contest-id" type="number" min="1" step="1" value="${escapeHtml(preContest)}" placeholder="输入比赛 ID" /></div>
          <div class="form-group" style="flex:0 0 200px"><label>题目 ID</label>
            <input class="input" id="rj-cp-problem-id" type="number" min="1" step="1" value="${escapeHtml(preProblem)}" placeholder="输入题目 ID" />
            <div class="muted" style="font-size:12px" id="rj-cp-problem-hint">比赛内题目按题库中的实际题目 ID 填写</div></div>
        </div>
      </div>

      <div class="rj-form" data-for="range" style="margin-top:14px;display:none">
        <div class="row" style="gap:16px;flex-wrap:wrap">
          <div class="form-group" style="flex:0 0 170px"><label>起始提交 ID</label><input class="input" id="rj-from" placeholder="如 1" /></div>
          <div class="form-group" style="flex:0 0 170px"><label>结束提交 ID</label><input class="input" id="rj-to" placeholder="如 100" /></div>
          <div class="form-group" style="flex:0 0 170px"><label>限定题目 ID（可选）</label><input class="input" id="rj-range-problem" placeholder="留空=不限" /></div>
          <div class="form-group" style="flex:0 0 170px"><label>限定比赛 ID（可选）</label><input class="input" id="rj-range-contest" placeholder="留空=不限" /></div>
          <div class="form-group" style="flex:0 0 170px"><label>限定用户 ID（可选）</label><input class="input" id="rj-range-user" placeholder="留空=不限" /></div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">2. 预览并执行</h2>
      <div class="row" style="gap:10px;align-items:center">
        <button class="btn btn-ghost" id="rj-preview"><i class="fa-solid fa-magnifying-glass"></i>预览匹配数量</button>
        <button class="btn btn-danger" id="rj-run" disabled><i class="fa-solid fa-rotate-right"></i>确认重判</button>
        <span class="muted" style="font-size:12px" id="rj-progress"></span>
      </div>
      <div id="rj-result" class="mt"></div>
    </div>`;

  const scopeOf = () => {
    const el = document.querySelector('#rj-scopes .chip.active');
    return el ? el.dataset.scope : 'problem';
  };
  document.querySelectorAll('#rj-scopes .chip').forEach((c) => c.addEventListener('click', () => {
    document.querySelectorAll('#rj-scopes .chip').forEach((x) => x.classList.toggle('active', x === c));
    document.querySelectorAll('.rj-form').forEach((f) => { f.style.display = f.dataset.for === c.dataset.scope ? '' : 'none'; });
    document.getElementById('rj-run').disabled = true;
    document.getElementById('rj-result').innerHTML = '';
  }));
  // 输入题号后展示对应的题目标题，便于确认（只读提示，不改变重判范围）
  const bindProblemHint = (inputId, hintId) => {
    const input = document.getElementById(inputId);
    const hint = document.getElementById(hintId);
    if (!input || !hint) return;
    let timer = null;
    const lookup = async () => {
      const id = input.value.trim();
      if (!/^\d+$/.test(id)) { hint.textContent = '填题库中的题目 ID（题号），不是标题'; hint.style.color = ''; return; }
      hint.textContent = '查询中…'; hint.style.color = '';
      try {
        const p = await api.get('/api/problems/' + id);
        hint.textContent = `#${id} ${p.problem ? p.problem.title : (p.title || '')}`.trim();
        hint.style.color = '';
      } catch {
        hint.textContent = `题库中没有题号 ${id}`; hint.style.color = 'var(--red)';
      }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(lookup, 400); });
    input.addEventListener('blur', lookup);
    if (input.value.trim()) lookup();
  };
  bindProblemHint('rj-problem-id', 'rj-problem-hint');
  bindProblemHint('rj-cp-problem-id', 'rj-cp-problem-hint');

  const valOf = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const buildBody = () => {
    const scope = scopeOf();
    if (scope === 'problem') {
      return { scope, problem_id: valOf('rj-problem-id'), contest_mode: valOf('rj-contest-mode') };
    }
    if (scope === 'contest_problem') {
      return { scope, contest_id: valOf('rj-contest-id'), problem_id: valOf('rj-cp-problem-id') };
    }
    return {
      scope, from_id: valOf('rj-from'), to_id: valOf('rj-to'),
      problem_id: valOf('rj-range-problem'), contest_id: valOf('rj-range-contest'), user_id: valOf('rj-range-user'),
    };
  };

  const result = document.getElementById('rj-result');
  let lastPreview = null;
  let lastCount = 0;
  document.getElementById('rj-preview').addEventListener('click', async () => {
    const body = buildBody();
    result.innerHTML = '<span class="muted">正在统计…</span>';
    document.getElementById('rj-run').disabled = true;
    try {
      const r = await api.post('/api/rejudge', Object.assign({ dry_run: true }, body));
      lastPreview = body;
      lastCount = r.count;
      result.innerHTML = `<div class="status-banner blue"><span style="font-weight:700"><i class="fa-solid fa-list-check"></i> 匹配到 ${r.count} 条提交</span>
        <span class="muted">${escapeHtml(r.label)}${r.truncated ? `（仅回显前 ${r.ids.length} 个 ID）` : ''}</span></div>
        <div class="muted mono" style="font-size:12px;word-break:break-all">提交 ID：${r.ids.join(', ')}${r.truncated ? ' …' : ''}</div>`;
      document.getElementById('rj-run').disabled = false;
    } catch (e) {
      lastPreview = null;
      result.innerHTML = `<div class="status-banner warn"><span style="font-weight:700">无法重判</span><span class="muted">${escapeHtml(e.message)}</span></div>`;
    }
  });

  document.getElementById('rj-run').addEventListener('click', async () => {
    if (!lastPreview) return;
    const body = buildBody();
    if (JSON.stringify(body) !== JSON.stringify(lastPreview)) {
      toast('范围已修改，请重新预览后再重判', 'error');
      document.getElementById('rj-run').disabled = true;
      return;
    }
    if (!confirm(`确认重判这 ${lastCount} 条提交？原评测结果会被清空并重新评测。`)) return;
    result.innerHTML = '<span class="muted">正在提交重判任务…</span>';
    try {
      const r = await api.post('/api/rejudge', Object.assign({ dry_run: false }, body));
      toast(`已将 ${r.count} 条提交加入重判队列`, 'success');
      result.innerHTML = `<div class="status-banner ac"><span style="font-weight:700"><i class="fa-solid fa-circle-check"></i> 已提交重判</span>
        <span class="muted">${escapeHtml(r.label)}，共 ${r.count} 条提交正在重新评测</span></div>
        <div class="muted" style="font-size:12px">评测结果将在队列中依次更新，可在「提交记录」页查看；下方显示剩余队列进度。</div>`;
      document.getElementById('rj-run').disabled = true;
      pollProgress();
    } catch (e) {
      result.innerHTML = `<div class="status-banner warn"><span style="font-weight:700">重判失败</span><span class="muted">${escapeHtml(e.message)}</span></div>`;
    }
  });

  let progressTimer = null;
  async function pollProgress() {
    const box = document.getElementById('rj-progress');
    const tick = async () => {
      try {
        const p = await api.get('/api/rejudge/progress');
        box.textContent = p.total > 0 ? `队列中 ${p.pending} 条待评测、${p.judging} 条评测中…` : '评测队列已清空，重判完成';
        if (p.total === 0 && progressTimer) { clearInterval(progressTimer); progressTimer = null; }
      } catch { /* ignore */ }
    };
    await tick();
    if (!progressTimer) progressTimer = setInterval(tick, 2500);
  }
}

/* ---------- 反馈 / 举报审核（仅超级管理员） ---------- */
async function renderAdminFeedbacks() {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const q = parseHash().query;
  const page = parseInt(q.get('page') || '1', 10);
  const status = q.get('status') || '';
  const search = q.get('search') || '';
  const params = new URLSearchParams({ page: String(page), size: '20' });
  if (status) params.set('status', status);
  if (search) params.set('search', search);
  const data = await api.get('/api/admin/feedbacks?' + params.toString());
  const rows = data.items.length === 0
    ? '<tr><td colspan="7" class="empty">暂无反馈</td></tr>'
    : data.items.map((f, i) => {
      // v2.8.3：已处理 / 已关闭的反馈同样可以再次处理（入口文案「再次处理」，弹窗预填上次回复与状态）
      const handled = f.status !== 'pending';
      const times = f.handle_count > 0 ? f.handle_count : (handled ? 1 : 0);
      const timesTip = times > 1 ? ` · 第 ${times} 次处理` : '';
      return `
      <tr data-fb-id="${f.id}">
        <td><span class="badge" style="background:${f.type === 'report' ? '#ff4d4f' : (f.type === 'bug' ? '#fa8c16' : '#1890ff')};color:#fff">${escapeHtml(f.type_label)}</span></td>
        <td>${userSpan({ uid: f.user_id, username: f.username, nickname: f.username })}</td>
        <td style="max-width:360px">${escapeHtml(f.content.slice(0, 100))}${f.content.length > 100 ? '…' : ''}</td>
        <td><span class="badge" style="background:${f.status === 'pending' ? '#fa8c16' : '#52c41a'};color:#fff">${escapeHtml(f.status_label)}</span>${timesTip ? `<span class="muted" style="font-size:12px;margin-left:6px">${timesTip}</span>` : ''}</td>
        <td style="max-width:200px">${f.reply ? escapeHtml(f.reply.slice(0, 60)) : '<span class="muted">—</span>'}</td>
        <td class="num muted">${fmtTime(f.created_at)}</td>
        <td class="num"><button class="btn btn-sm js-fb-op" data-fb-op="${i}" title="${handled ? '再次处理这条反馈（可改回复 / 改状态）' : '处理这条反馈'}"><i class="fa-solid fa-${handled ? 'rotate-right' : 'reply'}"></i>${handled ? '再次处理' : '处理'}</button></td>
      </tr>`;
    }).join('');

  app.innerHTML = `${adminTabs('feedbacks')}
    ${adminHead({
      title: '反馈审核',
      filter: `<div class="filter-bar">
        <input class="input" id="fb-search" placeholder="搜索内容 / 用户名 / 用户ID…" value="${escapeHtml(search)}" style="flex:0 0 200px" />
        <button class="btn" id="fb-search-btn"><i class="fa-solid fa-magnifying-glass"></i>搜索</button>
        <select class="input" id="fb-status" style="width:auto">
          <option value="">全部状态</option>
          <option value="pending" ${status === 'pending' ? 'selected' : ''}>待处理</option>
          <option value="resolved" ${status === 'resolved' ? 'selected' : ''}>已处理</option>
          <option value="closed" ${status === 'closed' ? 'selected' : ''}>已关闭</option>
        </select>
      </div>`,
    })}
    <div class="card table-scroll" style="padding:0;margin-top:8px">
      <table class="table">
        <thead><tr><th>类型</th><th>用户</th><th>内容</th><th>状态</th><th>回复</th><th class="num">时间</th><th class="num">操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderPagination(data.total, data.page, data.size)}`;

  bindPagination((p) => nav('admin/feedbacks', { status, search, page: p }));
  const doFbFilter = () => nav('admin/feedbacks', {
    status: document.getElementById('fb-status').value,
    search: document.getElementById('fb-search').value.trim(),
    page: 1,
  });
  document.getElementById('fb-search-btn').addEventListener('click', doFbFilter);
  document.getElementById('fb-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') doFbFilter(); });
  document.getElementById('fb-status').addEventListener('change', (e) => {
    nav('admin/feedbacks', { status: e.target.value, search, page: 1 });
  });
  // 点击行 / 行内「处理 / 再次处理」按钮都打开处理弹窗
  data.items.forEach((f, i) => {
    const tr = document.querySelector(`tbody tr:nth-child(${i + 1})`);
    if (!tr) return;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => showFeedbackHandler(f));
    const opBtn = tr.querySelector('.js-fb-op');
    if (opBtn) opBtn.addEventListener('click', (e) => { e.stopPropagation(); showFeedbackHandler(f); });
  });
}

/* 反馈处理弹窗：回复并标记已处理 / 关闭；已处理 / 已关闭的反馈可「再次处理」
 * v2.8.3：弹窗预填上一次的处理回复与状态，管理员可改回复 / 改状态后再次提交 */
function showFeedbackHandler(f) {
  const FB_STATUS_TEXT = { pending: '待处理', resolved: '已处理', closed: '已关闭' };
  const handled = f.status !== 'pending';
  const times = f.handle_count > 0 ? f.handle_count : (handled ? 1 : 0);
  const curStatus = handled ? f.status : 'resolved';
  const lastLine = handled
    ? `<div class="muted" style="font-size:12px;margin:-6px 0 10px">上次处理：${escapeHtml(f.handled_by_name || '管理员')} · ${escapeHtml(f.status_label)} · ${fmtTime(f.handled_at)} · 累计处理 <b>${times}</b> 次（本次为第 <b>${times + 1}</b> 次处理）</div>`
    : '';
  app.insertAdjacentHTML('beforeend', `
    <div class="modal-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200;display:flex;align-items:center;justify-content:center">
      <div class="card" style="width:560px;max-width:92vw;margin:0">
        <h2 class="card-title">${handled ? '再次处理' : '处理'}反馈 #${f.id} <span class="muted" style="font-size:12px">${escapeHtml(f.type_label)} · ${escapeHtml(f.username)} · ${fmtTime(f.created_at)}</span>${handled ? ` <span class="badge" style="background:#1890ff;color:#fff;font-size:11px">第 ${times + 1} 次处理</span>` : ''}</h2>
        <div class="statement" style="font-size:14px;border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:12px;white-space:pre-wrap">${escapeHtml(f.content)}</div>
        ${lastLine}
        <div class="form-group"><label>处理回复（将展示给提交者）</label><textarea class="textarea" id="fh-reply" rows="3">${escapeHtml(f.reply || '')}</textarea></div>
        <div class="form-group"><label>处理状态</label>
          <select class="input" id="fh-status" style="width:auto">
            <option value="resolved" ${curStatus === 'resolved' ? 'selected' : ''}>已处理</option>
            <option value="closed" ${curStatus === 'closed' ? 'selected' : ''}>已关闭</option>
          </select>
          <span class="muted" style="font-size:12px;margin-left:8px">当前状态：<span id="fh-cur-status">${escapeHtml(FB_STATUS_TEXT[f.status] || '待处理')}</span></span>
        </div>
        <div class="row">
          <button class="btn btn-ghost" id="fh-close"><i class="fa-solid fa-xmark"></i>取消</button>
          ${handled ? '' : `<button class="btn btn-danger btn-sm" id="fh-closed"><i class="fa-solid fa-xmark"></i>标记关闭</button>`}
          <div class="spacer"></div>
          <button class="btn" id="fh-resolve"><i class="fa-solid fa-reply"></i>${handled ? '再次处理' : '回复并标记已处理'}</button>
        </div>
      </div>
    </div>`);
  const backdrop = document.querySelector('.modal-backdrop');
  const doAction = async (status, reply) => {
    try {
      const r = await api.put('/api/admin/feedbacks/' + f.id, { status, reply });
      toast(r && r.rehandled ? `已再次处理（第 ${r.handle_count} 次）` : '已处理', 'success');
      backdrop.remove();
      renderAdminFeedbacks();
    } catch (e) { toast(e.message, 'error'); }
  };
  document.getElementById('fh-close').addEventListener('click', () => backdrop.remove());
  // 「再次处理」用弹窗里的状态下拉框（默认 = 上次状态），首次处理按既有行为走两个按钮
  document.getElementById('fh-resolve').addEventListener('click', () => doAction(
    handled ? document.getElementById('fh-status').value : 'resolved',
    document.getElementById('fh-reply').value.trim()
  ));
  const closeBtn = document.getElementById('fh-closed');
  if (closeBtn) closeBtn.addEventListener('click', () => doAction('closed', document.getElementById('fh-reply').value.trim()));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
}

async function renderAdminUsers() {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const search = parseHash().query.get('search') || '';
  const page = parseInt(parseHash().query.get('page') || '1', 10);
  const params = new URLSearchParams({ page: String(page), size: '20' });
  if (search) params.set('search', search);
  const data = await api.get('/api/admin/users?' + params.toString());

  const roleBadge = { user: '<span class="badge" style="background:#8c8c8c;color:#fff">普通用户</span>', admin: '<span class="badge" style="background:var(--blue);color:#fff">管理员</span>', superadmin: '<span class="badge" style="background:#722ed1;color:#fff">超级管理员</span>' };
  const canManage = hasP('user');

  const rows = data.items.length === 0
    ? '<tr><td colspan="8" class="empty">暂无用户</td></tr>'
    : data.items.map((u) => {
      // v2.7.5：管理权限列**简略显示**。原来把权限名全部列出来
      // （最长「题目管理、用户管理、题解审核、专栏审核、比赛管理、讨论管理、专栏管理、题解管理」，
      //  1440px 下实测「管理权限」列只有 268.8px，该按钮 198px + 「编辑资料」78px 塞不进
      //  252.8px 的内层宽度 → 折成 2 行、单元格高度 56px、整行从 43px 涨到 73px）。
      // 现在只显示**第 1 个权限名 + 「等 N 项」**（N>1 时），完整列表放进 title（悬浮可见）；
      // 该单元格同时加了 .cell-perm（内层 flex 不换行），保证这一列永远 1 行、不再撑高行高。
      const permNames = (u.permissions || []).map((p) => PERM_NAMES[p] || p);
      const permFull = permNames.join('、');
      const permBrief = permNames.length > 1 ? `${permNames[0]} 等 ${permNames.length} 项` : permFull;
      const permText = u.is_superadmin
        ? '<span class="badge" style="background:#722ed1;color:#fff">超管</span>'
        : (permNames.length
          ? `<span class="perm-brief">${escapeHtml(permBrief)}</span>`
          : '<span class="muted">无</span>');
      // 剩余时长提示
      const fmtUntil = (until) => {
        if (!until) return '（永久）';
        const left = until - Date.now();
        if (left <= 0) return '';
        const d = Math.ceil(left / 86400000);
        return d > 0 ? `（剩 ${d} 天）` : '（即将到期）';
      };
      const speakTip = u.can_speak ? '' : fmtUntil(u.can_speak_until);
      const edTip = u.can_editorial ? '' : fmtUntil(u.can_editorial_until);
      const banTip = u.banned ? fmtUntil(u.banned_until) : '';
      // 棕名状态可见化：显示「棕名」徽章 + 剩余天数（brown_name_until 由接口返回；
      // 此前后台列表既没有棕名徽章也不显示剩余时长，处罚状态在界面里几乎看不出来）
      const brownTip = u.brown_name ? fmtUntil(u.brown_name_until) : '';
      const brownBadge = u.brown_name ? ` <span class="badge" style="background:#8b5e3c;color:#fff">棕名</span><span class="muted" style="font-size:12px">${brownTip}</span>` : '';
      // v2.7.0 修复：两列操作单元格改用 .cell-actions（不再写死 style="white-space:nowrap"）。
      // 原因：样式表里 `.main .card .table td { max-width:340px; overflow:hidden; text-overflow:ellipsis }`
      // 会把按钮多的操作列裁成省略号 —— 5 个按钮（含「棕名·抄题解」「棕名·作弊」）实测 594px 内容塞进
      // 340px 的单元格，最后两个按钮被裁掉、只剩「…」；棕名用户的「解除棕名」同样被裁。
      // .cell-actions 去掉 340px 上限并允许按钮换行，按钮文字完整可见（见 style.css 的 .cell-actions）。
      return `
      <tr>
        <td>#${u.id}</td>
        <td>${userSpan({ uid: u.id, username: u.username, nickname: u.username })}${u.banned ? ' <span class="badge" style="background:#ff4d4f;color:#fff">已封禁</span>' : ''}${brownBadge}</td>
        <td>${roleBadge[u.role] || roleBadge.user}</td>
        <td><span style="color:${u.can_speak ? 'var(--green)' : 'var(--red)'}">${u.can_speak ? '✔ 允许' : '✘ 撤销' + speakTip}</span></td>
        <td><span style="color:${u.can_editorial ? 'var(--green)' : 'var(--red)'}">${u.can_editorial ? '✔ 允许' : '✘ 撤销' + edTip}</span></td>
        <td class="muted">${fmtTime(u.created_at)}${banTip ? '<br/>' + banTip : ''}</td>
        <td class="cell-actions"><div class="cell-actions-inner">
          <button class="btn btn-ghost btn-sm" data-act="toggle_speak" data-id="${u.id}">${u.can_speak ? '<i class="fa-solid fa-comment-slash"></i>撤销自由发言' : '<i class="fa-solid fa-comment"></i>恢复自由发言'}</button>
          <button class="btn btn-ghost btn-sm" data-act="toggle_editorial" data-id="${u.id}">${u.can_editorial ? '<i class="fa-solid fa-ban"></i>撤销题解' : '<i class="fa-solid fa-book-open"></i>恢复题解'}</button>
          ${u.banned
            ? `<button class="btn btn-ghost btn-sm" data-act="unban" data-id="${u.id}"><i class="fa-solid fa-lock-open"></i>解封</button>`
            : `<button class="btn btn-danger btn-sm" data-act="ban" data-id="${u.id}"><i class="fa-solid fa-ban"></i>封禁</button>`}
          ${canManage && u.username !== 'admin' && !u.brown_name
            ? `<button class="btn btn-sm btn-brown" data-act="brown_plagiarism" data-id="${u.id}" title="抄题解处罚：清空练习分并棕名14天"><i class="fa-solid fa-user-shield"></i>棕名·抄题解</button>
               <button class="btn btn-sm btn-brown" data-act="brown_cheat" data-id="${u.id}" title="比赛作弊：指定场次判-1分并棕名14天"><i class="fa-solid fa-user-shield"></i>棕名·作弊</button>`
            : (canManage && u.username !== 'admin' && u.brown_name
              ? `<button class="btn btn-ghost btn-sm" data-act="unbrown" data-id="${u.id}" data-uname="${escapeHtml(u.username)}" title="解除棕名处罚"><i class="fa-solid fa-user-check"></i>解除棕名</button>`
              : '')}
        </div></td>
        <td class="cell-actions cell-perm"><div class="cell-actions-inner">
          ${canManage && u.username !== 'admin'
            ? `<button class="btn btn-ghost btn-sm perm-btn" data-perm-edit="${u.id}" data-uname="${escapeHtml(u.username)}" data-perms="${escapeHtml((u.permissions || []).join(','))}" title="设置管理员权限（勾选全部 8 项=超级管理员）&#10;当前权限（${permNames.length} 项）：${escapeHtml(permFull || '无')}"><i class="fa-solid fa-key"></i>${permText}</button>`
            : permText}
          ${canManage && u.username !== 'admin'
            ? `<button class="btn btn-ghost btn-sm" data-profile-edit="${u.id}" data-uname="${escapeHtml(u.username)}" title="编辑该用户的昵称/邮箱/简介与重置密码"><i class="fa-solid fa-user-pen"></i>编辑资料</button>`
            : ''}
        </div></td>
      </tr>`;
    }).join('');

  app.innerHTML = `${adminTabs('users')}
    ${adminHead({
      title: '用户管理',
      filter: `<div class="filter-bar">
        <input class="input" id="u-search" placeholder="搜索用户名/邮箱…" value="${escapeHtml(search)}" />
        <button class="btn" id="u-search-btn"><i class="fa-solid fa-magnifying-glass"></i>搜索</button>
      </div>`,
    })}
    <div class="card table-scroll" style="padding:0">
      <table class="table table-users">
        <thead><tr><th>ID</th><th>用户</th><th>等级</th><th>自由发言</th><th>发布题解</th><th>注册时间</th><th>权限操作</th><th>管理权限</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderPagination(data.total, data.page, data.size)}
    <p class="muted">自由发言权限涵盖发布讨论与参与讨论；撤销后发帖/回复均被拒绝。所有权限操作均需填写原因并写入社区管理记录与通知。棕名处罚：抄题解→清空练习分并棕名 14 天；比赛作弊→指定场次判 -1 分并棕名 14 天。站点名称 / Logo / 邮箱验证 / SMTP 等请前往「系统设置」。</p>`;

  bindPagination((p) => nav('admin/users', { search, page: p }));
  document.getElementById('u-search-btn').addEventListener('click', () => {
    nav('admin/users', { search: document.getElementById('u-search').value.trim(), page: 1 });
  });
  document.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.act;
    const uid = b.dataset.id;
    const payload = {};
    let reason = '';
    // 撤销/封禁时长（天）：0 = 永久
    const askDays = (label) => {
      const v = prompt(`${label}时长（天）：留空或 0 表示永久`, '');
      if (v === null) return null;
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    if (act === 'toggle_speak') {
      if (b.textContent.includes('恢复')) { payload.can_speak = true; reason = prompt('请填写操作原因（可选）') || ''; }
      else { const days = askDays('撤销自由发言'); if (days === null) return; payload.can_speak = false; payload.days = days; reason = prompt('请填写操作原因（可选）') || ''; }
    }
    else if (act === 'toggle_editorial') {
      if (b.textContent.includes('恢复')) { payload.can_editorial = true; reason = prompt('请填写操作原因（可选）') || ''; }
      else { const days = askDays('撤销题解发布权限'); if (days === null) return; payload.can_editorial = false; payload.days = days; reason = prompt('请填写操作原因（可选）') || ''; }
    }
    else if (act === 'ban') {
      const days = askDays('封禁'); if (days === null) return;
      if (!confirm(days > 0 ? `确定封禁该用户 ${days} 天？` : '确定永久封禁该用户？')) return;
      payload.banned = true; payload.days = days; reason = prompt('请填写封禁原因（可选）') || '';
    }
    else if (act === 'unban') { payload.banned = false; reason = prompt('请填写解封原因（可选）') || ''; }
    else if (act === 'brown_plagiarism') {
      if (!confirm('确定棕名处罚（抄题解）？将清空其练习积分并将所有题目置为未通过，棕名 14 天。')) return;
      try {
        await api.post(`/api/admin/users/${uid}/brown`, { type: 'plagiarism' });
        toast('已执行棕名处罚（抄题解）', 'success');
        renderAdminUsers();
      } catch (e) { toast(e.message, 'error'); }
      return;
    }
    else if (act === 'brown_cheat') {
      const contestId = prompt('请输入作弊的比赛场次 ID（必填）');
      if (!contestId || !/^\d+$/.test(contestId)) return toast('请输入有效的比赛场次 ID', 'error');
      if (!confirm(`确定对该用户执行比赛作弊棕名处罚（场次 #${contestId} 判 -1 分，棕名 14 天）？`)) return;
      try {
        await api.post(`/api/admin/users/${uid}/brown`, { type: 'cheat', contest_id: contestId });
        toast('已执行棕名处罚（比赛作弊）', 'success');
        renderAdminUsers();
      } catch (e) { toast(e.message, 'error'); }
      return;
    }
    else if (act === 'unbrown') {
      if (!confirm(`确定解除用户「${b.dataset.uname || uid}」的棕名处罚吗？`)) return;
      try {
        await api.post(`/api/admin/users/${uid}/unbrown`);
        toast('已解除棕名', 'success');
        renderAdminUsers();
      } catch (e) { toast(e.message, 'error'); }
      return;
    }
    if (reason) payload.reason = reason;
    try {
      await api.put('/api/admin/users/' + uid, payload);
      toast('操作成功', 'success');
      renderAdminUsers();
    } catch (e) { toast(e.message, 'error'); }
  }));
  document.querySelectorAll('button[data-perm-edit]').forEach((b) => b.addEventListener('click', () => {
    showPermEditor(b.dataset.permEdit, b.dataset.uname);
  }));
  document.querySelectorAll('button[data-profile-edit]').forEach((b) => b.addEventListener('click', () => {
    showAdminProfileEditor(b.dataset.profileEdit, b.dataset.uname);
  }));
}

/* 管理员编辑用户资料 / 重置密码弹窗 */
async function showAdminProfileEditor(uid, uname) {
  let cur = { nickname: '', email: '', bio: '' };
  try {
    const r = await api.get('/api/users/' + uid);
    cur = r.user || cur;
  } catch { /* ignore */ }
  app.insertAdjacentHTML('beforeend', `
    <div class="modal-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200;display:flex;align-items:center;justify-content:center">
      <div class="card" style="width:520px;max-width:94vw;margin:0">
        <h2 class="card-title">编辑用户资料 — ${escapeHtml(uname)}</h2>
        <div class="form-group"><label>用户名（管理员可修改，不受次数限制）</label><input class="input" id="ap-username" value="${escapeHtml(cur.username || uname)}" /></div>
        <div class="form-group"><label>邮箱</label><input class="input" id="ap-email" value="${escapeHtml(cur.email || '')}" /></div>
        <div class="form-group"><label>简介</label><textarea class="textarea" id="ap-bio" rows="2">${escapeHtml(cur.bio || '')}</textarea></div>
        <div class="form-group"><label>重置密码（留空则不修改，至少 6 位）</label><input class="input" id="ap-pwd" type="password" placeholder="输入新密码" /></div>
        <div class="row">
          <button class="btn btn-ghost" id="ap-cancel"><i class="fa-solid fa-xmark"></i>取消</button>
          <div class="spacer"></div>
          <button class="btn" id="ap-save"><i class="fa-solid fa-floppy-disk"></i>保存</button>
        </div>
      </div>
    </div>`);
  const backdrop = document.querySelector('.modal-backdrop');
  document.getElementById('ap-cancel').addEventListener('click', () => backdrop.remove());
  document.getElementById('ap-save').addEventListener('click', async () => {
    const username = document.getElementById('ap-username').value.trim();
    const email = document.getElementById('ap-email').value.trim();
    const bio = document.getElementById('ap-bio').value.trim();
    const newPwd = document.getElementById('ap-pwd').value;
    try {
      if (username || email || bio) {
        await api.put(`/api/admin/users/${uid}/profile`, { username, email, bio });
      }
      if (newPwd) {
        await api.put(`/api/admin/users/${uid}/password`, { new_password: newPwd });
      }
      toast('已保存', 'success');
      backdrop.remove();
      renderAdminUsers();
    } catch (e) { toast(e.message, 'error'); }
  });
  // 仅通过「取消」按钮关闭，避免误触遮罩丢失已填写内容
  // （点击遮罩不关闭）
}

/* 权限编辑器弹窗（全部 8 项 = 超级管理员） */
function showPermEditor(uid, uname) {
  /* v2.7.7 修复：管理权限列自 v2.7.5 起**简略显示**（「第 1 个权限名 等 N 项」，整列不再撑高行高），
   * 而旧代码是从按钮的可见文字里 `rowText.includes(PERM_NAMES[k])` 反推已勾选项 —— 文字里只剩第一个
   * 权限名，于是多权限用户重新打开弹窗时**只有第一个权限被勾选**（实测 3 项 → 只勾 1 项）。
   * 现在把完整权限 key 列表直接放在按钮的 data-perms 上（接口本来就返回 u.permissions 数组），
   * 回显只认这份数据；按钮文字解析仅作为老 DOM（没有 data-perms）的兜底保留。 */
  let current = [];
  const btn = document.querySelector(`button[data-perm-edit="${uid}"]`);
  if (btn) {
    const rawPerms = btn.dataset.perms;
    if (rawPerms !== undefined) {
      const set = new Set(String(rawPerms).split(',').filter(Boolean));
      current = PERM_KEYS.filter((k) => set.has(k));
    } else {
      const rowText = btn.textContent;   // 兜底：仅当按钮上没有 data-perms 时
      if (rowText.includes('超管')) current = PERM_KEYS.slice();
      else current = PERM_KEYS.filter((k) => rowText.includes(PERM_NAMES[k]));
    }
  }
  app.insertAdjacentHTML('beforeend', `
    <div class="modal-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200;display:flex;align-items:center;justify-content:center">
      <div class="card" style="width:540px;max-width:94vw;margin:0">
        <h2 class="card-title">设置管理员权限 — ${escapeHtml(uname)}</h2>
        <p class="muted" style="font-size:12px">勾选该用户的管理权限；拥有全部 8 项即为<b>超级管理员</b>。xx审核 = 只能审核，不能更改/删除。</p>
        <div class="perm-grid">
          ${PERM_KEYS.map((k) => `<label class="switch" style="padding:8px 4px;border-bottom:1px solid var(--border)"><input type="checkbox" class="perm-cb" value="${k}" ${current.includes(k) ? 'checked' : ''} /><span class="slider"></span><span class="switch-label">${PERM_NAMES[k]}</span></label>`).join('')}
        </div>
        <div class="row" style="margin-top:14px">
          <button class="btn btn-ghost btn-sm" id="perm-all" type="button"><i class="fa-solid fa-check-double"></i>全选（设为超管）</button>
          <button class="btn btn-ghost btn-sm" id="perm-none" type="button"><i class="fa-solid fa-eraser"></i>清空（降为普通用户）</button>
          <div class="spacer"></div>
          <button class="btn btn-ghost" id="perm-cancel" type="button"><i class="fa-solid fa-xmark"></i>取消</button>
          <button class="btn" id="perm-save" type="button"><i class="fa-solid fa-floppy-disk"></i>保存</button>
        </div>
    </div>
    </div>`);
  const backdrop = document.querySelector('.modal-backdrop');
  document.getElementById('perm-cancel').addEventListener('click', () => backdrop.remove());
  document.getElementById('perm-all').addEventListener('click', () => document.querySelectorAll('.perm-cb').forEach((c) => { c.checked = true; }));
  document.getElementById('perm-none').addEventListener('click', () => document.querySelectorAll('.perm-cb').forEach((c) => { c.checked = false; }));
  document.getElementById('perm-save').addEventListener('click', async () => {
    const perms = [...document.querySelectorAll('.perm-cb:checked')].map((c) => c.value);
    const reason = prompt('请填写变更原因（可选）') || '';
    try {
      await api.put('/api/admin/users/' + uid, { permissions: perms, reason });
      toast('权限已更新', 'success');
      backdrop.remove();
      renderAdminUsers();
    } catch (e) { toast(e.message, 'error'); }
  });
}

/* ---------- 板块 / 分类管理卡片（仅超级管理员，v2.7.0） ----------
 * 讨论区板块与专栏文章分类都改为**可配置**：可以新建 / 重命名（只改显示名）/ 调整顺序 /
 * 删除（带迁移），数据来自 /api/discussion-boards 与 /api/article-categories（仅超管可写）。
 * 删除保护：目标下仍有内容 → 弹窗要求选择迁移目标（同一事务内批量改归属后再删除配置行）；
 * 系统内置项（is_system，如分类「题解」、板块「学术版」）在表格里带「系统」标记。
 * 落位：两个后台**子页面** —— 板块管理是「讨论管理」（#/admin/discussions）的子页面
 *   #/admin/discussions/boards，文章分类管理是「专栏管理」（#/admin/articles）的子页面
 *   #/admin/articles/categories；父页面顶部有一条子标签导航（adminSubTabs，仅超管渲染），
 *   两块都由调用方先判 is_superadmin，非超管不渲染子标签、直接访问子页面路由会被送回父页面列表
 *   （服务端写接口仍是 requireSuperAdmin + CSRF + 审计，行为不变）。 */

/** 迁移目标选择弹窗：resolve 目标 key；点取消 / 关闭返回 null */
function askMoveTarget(kind, item) {
  return new Promise((resolve) => {
    const isBoard = kind === 'board';
    const label = isBoard ? '板块' : '分类';
    const contentLabel = isBoard ? '讨论' : '文章';
    const targets = (isBoard ? boardList() : categoryList()).filter((x) => x.key !== item.key);
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200;display:flex;align-items:center;justify-content:center';
    backdrop.innerHTML = `<div class="card" style="width:540px;max-width:94vw;margin:0">
      <h2 class="card-title">删除${label}「${escapeHtml(item.name)}」</h2>
      <p class="muted">该${label}下有 <strong>${item.count}</strong> 条${contentLabel}，删除前必须先把它们迁移到另一个${label}；迁移与删除在同一次操作中完成（失败会整体回滚）。</p>
      ${targets.length
        ? `<div class="form-group"><label>迁移目标${label}</label>
            <select class="input" id="mv-target" style="width:100%">${targets.map((x) => `<option value="${escapeHtml(x.key)}">${escapeHtml(x.name)}（现有 ${x.count} 条${contentLabel}）</option>`).join('')}</select>
          </div>`
        : `<div class="status-banner warn">没有可选的迁移目标，请先新建一个${label}再删除。</div>`}
      <div class="row">
        <button class="btn btn-ghost" id="mv-cancel"><i class="fa-solid fa-xmark"></i>取消</button>
        <div class="spacer"></div>
        <button class="btn btn-danger" id="mv-ok" ${targets.length ? '' : 'disabled'}><i class="fa-solid fa-trash-can"></i>迁移并删除</button>
      </div>
    </div>`;
    document.body.appendChild(backdrop);
    const done = (v) => { backdrop.remove(); resolve(v); };
    backdrop.querySelector('#mv-cancel').addEventListener('click', () => done(null));
    backdrop.querySelector('#mv-ok').addEventListener('click', () => {
      const sel = backdrop.querySelector('#mv-target');
      done(sel ? sel.value : null);
    });
  });
}

/* 两类配置的文案 / 接口路径 / 卡片 id（与 src/taxonomy.js 的 KINDS 一一对应） */
const TAXO_META = {
  board: {
    label: '板块', contentLabel: '讨论', base: '/api/discussion-boards', card: 'taxo-board',
    title: '讨论管理',
    hint: '板块的内部 key 就是 discussions.board 的取值：重命名只改显示名、key 不变，已有讨论不会失联。删除时若板块下仍有讨论，必须选择迁移目标（帖子会整体迁到目标板块）。「学术版」是系统默认兜底板块，只允许改名、不允许删除。',
  },
  category: {
    label: '分类', contentLabel: '文章', base: '/api/article-categories', card: 'taxo-category',
    title: '专栏管理',
    hint: '分类的内部 key 就是 editorials.category 的取值：重命名只改显示名、key 不变，已有文章的分类引用不变。删除时若分类下仍有文章，必须选择迁移目标。系统分类「题解」被题解流程使用，不允许删除，也不允许改名。',
  },
};

/** 板块 / 分类管理的**主操作按钮**（新建板块 / 新建分类）。
 *  v2.7.0：按钮从卡片底部移到**页头标题同行右侧**的统一位置（与「新建题目」「新建比赛」等一致），
 *  三个输入框仍留在卡片里；bindTaxonomyCard 会跨卡片查找这个按钮（全页唯一）。 */
function taxonomyNewButtonHtml(kind) {
  const meta = TAXO_META[kind];
  return `<button class="btn new-btn"><i class="fa-solid fa-plus"></i>新建${meta.label}</button>`;
}

/** 板块 / 分类管理卡片的 HTML（表格 + 新建表单）。调用前需保证 loadTaxonomy() 已取到最新列表 */
function taxonomyCardHtml(kind) {
  const meta = TAXO_META[kind];
  const list = kind === 'board' ? boardList() : categoryList();
  const rows = list.length === 0
    ? `<tr><td colspan="5" class="empty">暂无${meta.label}</td></tr>`
    : list.map((it) => `
      <tr>
        <td><span class="mono">${escapeHtml(it.key)}</span>${it.is_system ? ' <span class="badge" style="background:#722ed1;color:#fff;font-size:11px">系统</span>' : ''}${it.is_protected ? ` <span class="badge" style="background:#fa8c16;color:#fff;font-size:11px" title="${kind === 'category' ? '题解流程依赖该系统分类' : '系统默认兜底板块'}">不可删除</span>` : ''}</td>
        <td><input class="input tx-name" data-key="${escapeHtml(it.key)}" value="${escapeHtml(it.name)}" maxlength="40" style="width:190px" ${it.can_rename ? '' : 'disabled title="系统分类「题解」不允许改名（题解流程依赖它）"'} /></td>
        <td><input class="input tx-sort" data-key="${escapeHtml(it.key)}" type="number" min="0" max="999999" value="${it.sort_order}" style="width:92px" /></td>
        <td class="num">${it.count} 条${meta.contentLabel}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm tx-save" data-key="${escapeHtml(it.key)}"><i class="fa-solid fa-floppy-disk"></i>保存</button>
          <button class="btn btn-danger btn-sm tx-del" data-key="${escapeHtml(it.key)}" ${it.can_delete ? '' : 'disabled title="系统项不允许删除"'}><i class="fa-solid fa-trash-can"></i>删除</button>
        </td>
      </tr>`).join('');

  return `<div class="card" id="${meta.card}">
      <h2 class="card-title"><i class="fa-solid ${kind === 'board' ? 'fa-layer-group' : 'fa-tags'}"></i> ${meta.title}</h2>
      <p class="muted card-lead" style="font-size:12px">${escapeHtml(meta.hint)}</p>
      <div class="table-scroll" style="padding:0">
        <table class="table">
          <thead><tr><th>内部 key</th><th>显示名</th><th>顺序</th><th>内容</th><th>操作</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <hr style="border:none;border-top:1px dashed var(--border);margin:14px 0" />
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
        <input class="input new-key" placeholder="内部 key（英文 / 数字 slug，可留空自动生成）" style="width:280px" maxlength="32" />
        <input class="input new-name" placeholder="显示名（必填）" style="width:180px" maxlength="40" />
        <input class="input new-sort" type="number" min="0" max="999999" placeholder="顺序（留空 = 排到最后）" style="width:190px" />
        <span class="muted" style="font-size:12px">填好后点右上角「新建${meta.label}」</span>
      </div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">操作结果会写入审计（管理记录），动作名 <span class="mono">${kind === 'board' ? 'board_create / board_rename / board_delete' : 'category_create / category_rename / category_delete'}</span>。</p>
    </div>`;
}

/** 绑定卡片里的保存 / 删除 / 新建（交互与原独立页面完全一致）；
 *  after 是写操作成功后「重新渲染当前页面」的回调（讨论管理页 / 专栏管理页各自传入）。 */
function bindTaxonomyCard(kind, card, after) {
  if (!card) return;
  const meta = TAXO_META[kind];
  const rerender = () => { if (typeof after === 'function') after(); };
  const list = kind === 'board' ? boardList() : categoryList();
  const byKey = new Map(list.map((x) => [x.key, x]));

  card.querySelectorAll('.tx-save').forEach((btn) => btn.addEventListener('click', async () => {
    const it = byKey.get(btn.dataset.key);
    if (!it) return;
    const name = [...card.querySelectorAll('.tx-name')].find((el) => el.dataset.key === it.key);
    const sort = [...card.querySelectorAll('.tx-sort')].find((el) => el.dataset.key === it.key);
    try {
      const r = await api.put(meta.base + '/' + encodeURIComponent(it.key), {
        name: (name ? name.value : it.name).trim(),
        sort_order: sort ? sort.value : it.sort_order,
      });
      toast(r.updated ? `${meta.label}「${r.name}」已保存` : `${meta.label}「${r.name}」没有变化`, 'success');
      await loadTaxonomy(true);
      rerender();
    } catch (e) { toast(e.message, 'error'); }
  }));

  card.querySelectorAll('.tx-del').forEach((btn) => btn.addEventListener('click', async () => {
    const it = byKey.get(btn.dataset.key);
    if (!it) return;
    // 系统内置项（删除必须指定迁移目标）或仍有内容的项：弹窗选迁移目标，取消即放弃删除
    let moveTo = '';
    if (it.is_system || it.count > 0) {
      moveTo = await askMoveTarget(kind, it);
      if (!moveTo) return;
    } else if (!confirm(`确定删除${meta.label}「${it.name}」吗？（该${meta.label}下没有${meta.contentLabel}）`)) {
      return;
    }
    try {
      const q = moveTo ? '?move_to=' + encodeURIComponent(moveTo) : '';
      const r = await api.del(meta.base + '/' + encodeURIComponent(it.key) + q);
      toast(`已删除${meta.label}「${it.name}」${r.moved ? `，同时迁移 ${r.moved} 条${meta.contentLabel}` : ''}`, 'success');
      await loadTaxonomy(true);
      rerender();
    } catch (e) { toast(e.message, 'error'); }
  }));

  // 主操作按钮在**页头**（.admin-head-actions）里，不在卡片内：全页只有一个 .new-btn
  const createBtn = document.querySelector('.new-btn');
  if (createBtn) createBtn.addEventListener('click', async () => {
    const kEl = card.querySelector('.new-key');
    const nEl = card.querySelector('.new-name');
    const sEl = card.querySelector('.new-sort');
    const payload = {
      key: (kEl.value || '').trim(),
      name: (nEl.value || '').trim(),
      sort_order: (sEl.value || '').trim(),
    };
    if (!payload.name) return toast(`${meta.label}显示名不能为空`, 'error');
    try {
      const r = await api.post(meta.base, payload);
      toast(`已新建${meta.label}「${r.name}」（key=${r.key}）`, 'success');
      await loadTaxonomy(true);
      rerender();
    } catch (e) { toast(e.message, 'error'); }
  });
}

/* 题解管理（kind=editorial）与专栏管理（kind=article）分开，普通管理员即可审核。
   sub='categories' 时是专栏管理的子页面「分类管理」（仅超级管理员）。
   v2.7.0 起两者严格互不混入：专栏管理只列普通专栏文章（服务端按 kind=article 排除分类「题解」），
   题解只出现在题解管理页。 */
async function renderAdminEditorials(kind, sub = '') {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const isArticle = kind === 'article';
  // 分类管理子页面：只对超级管理员开放（父页面「文章审核」本身其它管理员照常可用）
  const isSuper = !!(Store.user && Store.user.is_superadmin);
  const baseNav = isArticle ? 'admin/articles' : 'admin/editorials';
  const q = parseHash().query;
  // 子页面归属：categories 只在专栏管理下有意义；题解管理忽略该值
  const subPage = isArticle && sub === 'categories' ? 'categories' : '';
  // 旧地址兼容：上一轮的 #/admin/articles?taxo=category（内嵌区块入口）→ 分类管理子页面
  if (!subPage && isArticle && q.get('taxo') === 'category') { nav('admin/articles/categories'); return; }
  if (subPage && !isSuper) {
    // 非超管直接访问子页面路由：给出提示并送回父页面列表（不渲染子标签、不发写请求）
    toast('「分类管理」仅超级管理员可用，已返回文章审核列表', 'error');
    nav('admin/articles');
    return;
  }
  if (subPage) {
    await loadTaxonomy(); // 分类表来自接口
    app.innerHTML = `${adminTabs('articles')}
      ${adminHead({
        title: '专栏管理',   // v2.7.7：子页面的**页面标题**统一显示父级名称（子标签按钮仍是「分类管理」）
        // 与专栏管理（父页面）的标题位置完全一致；主操作按钮统一放在标题同行右侧
        actions: taxonomyNewButtonHtml('category'),
        subtabs: adminSubTabs('articles', 'categories'),
      })}
      ${taxonomyCardHtml('category')}`;
    bindTaxonomyCard('category', document.getElementById('taxo-category'), () => renderAdminEditorials(kind, sub));
    return;
  }
  const status = q.get('status') || '';
  const search = q.get('search') || '';
  // 专栏管理只看普通专栏文章：分类「题解」（key = CAT_SOLUTION）属于题解管理页。
  // 兼容上一版中文 key 的旧地址：?category=题解 与 ?category=solution 都按「全部分类」处理。
  const rawCategory = q.get('category') || '';
  const category = isArticle && (rawCategory === CAT_SOLUTION || rawCategory === '题解') ? '' : rawCategory;
  const problem = q.get('problem') || '';
  const page = parseInt(q.get('page') || '1', 10);
  const params = new URLSearchParams({ page: String(page), size: '20' });
  if (status) params.set('status', status);
  if (search) params.set('search', search);
  if (kind) params.set('kind', kind);
  if (category) params.set('category', category);
  if (problem) params.set('problem', problem);
  await loadTaxonomy(); // 分类筛选条来自接口
  const data = await api.get('/api/admin/editorials?' + params.toString());

  const statusFilter = ['', 'pending', 'approved', 'rejected'].map((s) =>
    `<span class="chip ${status === s ? 'active' : ''}" data-s="${s}">${s === '' ? '全部' : (s === 'pending' ? '待审核' : s === 'approved' ? '已通过' : '已驳回')}</span>`).join('');

  // 专栏管理：分类筛选（不含「未分类 / 题解」，来自接口配置表，题解只在题解管理页）；题解管理：按题目筛选（输入题号）
  const kindFilter = isArticle
    ? [['', '全部分类'], ...categoryList().filter((c) => c.key !== CAT_UNCATEGORIZED && c.key !== CAT_SOLUTION).map((c) => [c.key, c.name])].map(([k, label]) =>
        `<span class="chip ${category === k ? 'active' : ''}" data-cat="${escapeHtml(k)}">${escapeHtml(label)}</span>`).join('')
    : `<div class="row" style="gap:8px">
        <input class="input" id="ed-problem" placeholder="输入题号筛选" value="${escapeHtml(problem)}" style="flex:0 0 150px" />
        <button class="btn btn-ghost btn-sm" id="ed-problem-btn"><i class="fa-solid fa-filter"></i>按题目筛选</button>
        ${problem ? `<a class="muted" href="#/${baseNav}${status ? '?status=' + encodeURIComponent(status) : ''}">清除筛选</a>` : ''}
      </div>`;

  const rows = data.items.length === 0
    ? '<tr><td colspan="8" class="empty">暂无' + (isArticle ? '专栏文章' : '题解') + '</td></tr>'
    : data.items.map((e) => `
      <tr>
        <td>#${e.id}</td>
        <td>${isArticle
          ? '<span class="tag" style="color:var(--blue)">专栏文章</span>'
          : (e.problem_id ? `<a href="#/problem/${e.problem_id}">#${e.problem_id} ${escapeHtml(e.problem_title)}</a>` : '<span class="muted">—</span>')}</td>
        <td>${userSpan({ uid: e.user_id, username: e.username, nickname: e.username })}</td>
        <td><a href="#/editorial/${e.id}">${escapeHtml(e.title)}</a></td>
        <td>${e.category ? `<span class="tag" style="color:var(--accent);font-weight:600">${escapeHtml(categoryLabel(e.category))}</span>` : '<span class="muted">—</span>'}</td>
        <td>${ED_STATUS_BADGE[e.status] || e.status}</td>
        <td class="muted">${fmtTime(e.created_at)}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm btn-approve" data-review="approved" data-id="${e.id}"><i class="fa-solid fa-check"></i>通过</button>
          <button class="btn btn-danger btn-sm" data-review="rejected" data-id="${e.id}"><i class="fa-solid fa-ban"></i>驳回</button>
          <a class="btn btn-ghost btn-sm" href="#/editorial/${e.id}" title="进入文章页面审核"><i class="fa-solid fa-eye"></i>查看</a>
        </td>
      </tr>`).join('');

  // v2.7.4：专栏管理（与共用本函数的题解管理）页头里，**搜索框与筛选行排在同一行**——
  // 左侧是「状态 / 分类」筛选 chips，右侧是搜索框 + 搜索按钮（右缘贴齐页头右内边缘），
  // 两者基线对齐（flex align-items:center），不再一上一下错开。窄屏自动换行。
  app.innerHTML = `${adminTabs(isArticle ? 'articles' : 'editorials')}
    ${adminHead({
      title: isArticle ? '专栏管理' : '题解管理',
      subtabs: isArticle && isSuper ? adminSubTabs('articles', 'list') : '',
      filter: `<div class="filter-bar ed-head-filter">
        <div class="ed-head-chips">
          <div class="tag-chips" id="ed-status">${statusFilter}</div>
          <div class="row" style="gap:6px;flex-wrap:wrap" id="ed-kind">${kindFilter}</div>
        </div>
        <div class="ed-head-search">
          <input class="input" id="ed-search" placeholder="搜索标题 / 作者 / 用户ID / 题目ID…" value="${escapeHtml(search)}" />
          <button class="btn" id="ed-search-btn"><i class="fa-solid fa-magnifying-glass"></i>搜索</button>
        </div>
      </div>`,
    })}
    <div class="card table-scroll" style="padding:0">
      <table class="table">
        <thead><tr><th>ID</th><th>关联</th><th>作者</th><th>标题</th><th>分类</th><th>状态</th><th>提交时间</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderPagination(data.total, data.page, data.size)}`;

  bindPagination((p) => nav(baseNav, { status, search, category, problem, page: p }));
  document.querySelectorAll('#ed-status .chip').forEach((c) => c.addEventListener('click', () => {
    nav(baseNav, { status: c.dataset.s, search, category, problem, page: 1 });
  }));
  document.querySelectorAll('#ed-kind [data-cat]').forEach((c) => c.addEventListener('click', () => {
    nav(baseNav, { status, search, category: c.dataset.cat, page: 1 });
  }));
  const doEdSearch = () => nav(baseNav, { status, search: document.getElementById('ed-search').value.trim(), category, problem, page: 1 });
  document.getElementById('ed-search-btn').addEventListener('click', doEdSearch);
  document.getElementById('ed-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') doEdSearch(); });
  const edProblemBtn = document.getElementById('ed-problem-btn');
  if (edProblemBtn) {
    const doProblemFilter = () => {
      const n = parseInt((document.getElementById('ed-problem').value || '').trim(), 10);
      if (!Number.isFinite(n) || n <= 0) return toast('请输入有效题号', 'error');
      nav(baseNav, { status, search, problem: String(n), page: 1 });
    };
    edProblemBtn.addEventListener('click', doProblemFilter);
    document.getElementById('ed-problem').addEventListener('keydown', (e) => { if (e.key === 'Enter') doProblemFilter(); });
  }
  document.querySelectorAll('button[data-review]').forEach((b) => b.addEventListener('click', async () => {
    const status = b.dataset.review;
    let reason = '';
    if (status === 'rejected') {
      reason = prompt('请填写驳回原因（必填）');
      if (!reason || !reason.trim()) return toast('驳回必须填写原因', 'error');
    }
    try {
      await api.post(`/api/editorials/${b.dataset.id}/review`, { status, reason });
      toast(status === 'approved' ? '已通过' : '已驳回', 'success');
      renderAdminEditorials(kind, sub);
    } catch (e) { toast(e.message, 'error'); }
  }));
}

async function renderAdminContests() {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const q = parseHash().query;
  const search = q.get('search') || '';
  const page = parseInt(q.get('page') || '1', 10);
  const params = new URLSearchParams({ all: '1', page: String(page), size: '20' });
  if (search) params.set('search', search);
  const data = await api.get('/api/contests?' + params.toString());
  const isSuper = hasP('contest');
  const rows = data.items.length === 0
    ? '<tr><td colspan="8" class="empty">暂无比赛</td></tr>'
    : data.items.map((c) => `
      <tr>
        <td>#${c.id}</td>
        <td><a href="#/contest/${c.id}">${escapeHtml(c.title)}</a></td>
        <td><span class="badge" style="background:${CONTEST_TYPE_COLOR[c.type] || '#722ed1'};color:#fff">${escapeHtml(c.type)}</span></td>
        <td><span class="badge" style="background:${CONTEST_STATUS_COLOR[c.status]};color:#fff">${escapeHtml(c.status_label)}</span></td>
        <td>${c.is_public
          ? '<span class="badge" style="background:#52c41a;color:#fff">公开</span>'
          : '<span class="badge" style="background:#ff4d4f;color:#fff">私有</span>'}
          <button class="btn btn-ghost btn-sm" data-pub="${c.id}" data-cur="${c.is_public ? 1 : 0}" title="一键切换是否公开"><i class="fa-solid fa-arrows-rotate"></i>切换</button></td>
        <td>${c.rated
          ? (c.ratings_applied ? '<span class="badge" style="background:#52c41a;color:#fff">已结算</span>' : '<span class="badge" style="background:#fa8c16;color:#fff">Rated·未结算</span>')
          : '<span class="badge" style="background:#8c8c8c;color:#fff">Unrated</span>'}</td>
        <td class="num">${c.problem_count}</td>
        <td style="white-space:nowrap">
          <a class="btn btn-ghost btn-sm" href="#/admin/contest/${c.id}"><i class="fa-solid fa-pen"></i>编辑</a>
          ${(isSuper && c.status === 'running') ? `<button class="btn btn-ghost btn-sm" data-end="${c.id}" title="提前结束比赛"><i class="fa-solid fa-flag-checkered"></i>提前结束</button>` : ''}
          ${(c.status === 'ended' && c.participant_count > 0) ? `<button class="btn btn-sm" data-apply="${c.id}" title="计算/重新计算等级分">${c.ratings_applied ? '重新计算等级分' : '计算等级分'}</button>` : ''}
          <button class="btn btn-danger btn-sm" data-del="${c.id}"><i class="fa-solid fa-trash-can"></i>删除</button>
        </td>
      </tr>`).join('');

  app.innerHTML = `${adminTabs('contests')}
    ${adminHead({
      title: '比赛管理',
      actions: `<a class="btn" href="#/admin/contest/new"><i class="fa-solid fa-plus"></i>新建比赛</a>`,
      desc: '等级分结算：比赛结束后，由管理员在后台点击「计算等级分」计算（Rated 比赛按当前名次写入等级分；非 Rated 比赛只刷新名次缓存）。全站积分结算在「系统设置 → 功能设置 → 积分计算」里。',
      filter: `<div class="filter-bar">
        <input class="input" id="ac-search" placeholder="搜索比赛名称…" value="${escapeHtml(search)}" style="flex:0 0 200px" />
        <button class="btn" id="ac-search-btn"><i class="fa-solid fa-magnifying-glass"></i>搜索</button>
      </div>`,
    })}
    <div class="card table-scroll" style="padding:0">
      <table class="table">
        <thead><tr><th>ID</th><th>比赛名称</th><th>赛制</th><th>状态</th><th>是否公开</th><th>等级分</th><th class="num">题目数</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderPagination(data.total, data.page, data.size)}`;

  bindPagination((p) => nav('admin/contests', { search, page: p }));
  const doAcSearch = () => nav('admin/contests', { search: document.getElementById('ac-search').value.trim(), page: 1 });
  document.getElementById('ac-search-btn').addEventListener('click', doAcSearch);
  document.getElementById('ac-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAcSearch(); });

  document.querySelectorAll('button[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确定删除该比赛吗？\n将同时删除该比赛的赛题关联、报名记录与全部赛时提交，此操作不可恢复。')) return;
    try {
      await api.del('/api/contests/' + b.dataset.del);
      toast('已删除', 'success');
      renderAdminContests();
    } catch (e) { toast(e.message, 'error'); }
  }));
  document.querySelectorAll('button[data-end]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确定提前结束该比赛？结束后可进行等级分结算。')) return;
    try {
      await api.post(`/api/contests/${b.dataset.end}/end`);
      toast('比赛已结束', 'success');
      renderAdminContests();
    } catch (e) { toast(e.message, 'error'); }
  }));
  document.querySelectorAll('button[data-pub]').forEach((b) => b.addEventListener('click', async () => {
    const cid = b.dataset.pub;
    const next = b.dataset.cur === '1' ? '私有' : '公开';
    if (!confirm(`确定将比赛 #${cid} 切换为「${next}」吗？`)) return;
    try {
      await api.post(`/api/contests/${cid}/toggle-public`);
      toast(`已切换为「${next}」`, 'success');
      renderAdminContests();
    } catch (e) { toast(e.message, 'error'); }
  }));
  document.querySelectorAll('button[data-apply]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确定计算/重新计算该比赛的等级分吗？已结算过会先回滚上次的等级分变化再重算。')) return;
    try {
      const r = await api.post(`/api/contests/${b.dataset.apply}/apply-ratings`);
      if (r.skipped) toast('已结算（参赛人数不足，未产生等级分变化）', 'success');
      else toast(`等级分已计算（${r.count} 人）`, 'success');
      renderAdminContests();
    } catch (e) { toast(e.message, 'error'); }
  }));
}

/* ---------- 讨论管理（具备「讨论管理」权限的管理员即可进入）
   sub='boards' 时是子页面「板块管理」（仅超级管理员） ---------- */
async function renderAdminDiscussions(sub = '') {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const q = parseHash().query;
  // 板块管理子页面只对超级管理员开放（父页面「帖子管理」其它管理员照常可用）
  const isSuper = !!(Store.user && Store.user.is_superadmin);
  const subPage = sub === 'boards' ? 'boards' : '';
  // 旧地址兼容：上一轮的 #/admin/taxonomy → #/admin/discussions?taxo=board（内嵌区块入口）→ 板块管理子页面
  if (!subPage && q.get('taxo') === 'board') { nav('admin/discussions/boards'); return; }
  if (subPage && !isSuper) {
    // 非超管直接访问子页面路由：给出提示并送回父页面列表（不渲染子标签、不发写请求）
    toast('「板块管理」仅超级管理员可用，已返回帖子管理列表', 'error');
    nav('admin/discussions');
    return;
  }
  if (subPage) {
    await loadTaxonomy(); // 板块表来自接口
    app.innerHTML = `${adminTabs('discussions')}
      ${adminHead({
        title: '讨论管理',   // v2.7.7：子页面的**页面标题**统一显示父级名称（子标签按钮仍是「板块管理」）
        // 与帖子管理（父页面）的标题位置完全一致；主操作按钮统一放在标题同行右侧
        actions: taxonomyNewButtonHtml('board'),
        subtabs: adminSubTabs('discussions', 'boards'),
      })}
      ${taxonomyCardHtml('board')}`;
    bindTaxonomyCard('board', document.getElementById('taxo-board'), () => renderAdminDiscussions(sub));
    return;
  }
  const search = q.get('search') || '';
  const board = q.get('board') || '';
  const problem = q.get('problem') || '';
  const dPage = parseInt(q.get('dpage') || '1', 10);
  const params = new URLSearchParams({ page: String(dPage), size: '20' });
  if (search) params.set('search', search);
  if (board) params.set('board', board);
  if (problem) params.set('problem', problem);
  await loadTaxonomy(); // 板块筛选条来自接口
  const d = await api.get('/api/admin/discussions?' + params.toString());

  const dRows = d.items.length === 0
    ? '<tr><td colspan="7" class="empty">暂无讨论</td></tr>'
    : d.items.map((x) => `
      <tr>
        <td>#${x.id}</td>
        <td><a href="#/discussion/${x.id}">${escapeHtml(x.title)}</a></td>
        <td>${x.problem_id
          ? `<a class="tag" style="font-weight:600" href="#/discussions?problem=${x.problem_id}">#${x.problem_id} ${escapeHtml(x.problem_title || '')}</a>`
          : (x.board ? `<span class="tag" style="color:var(--blue)">${escapeHtml(boardLabel(x.board))}</span>` : '<span class="muted">—</span>')}</td>
        <td>${userSpan({ uid: x.user_id, username: x.username, nickname: x.username })}</td>
        <td class="num">${x.reply_count}</td>
        <td class="num muted">${fmtTime(x.created_at)}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-ghost btn-sm" data-edit-d="${x.id}"><i class="fa-solid fa-pen"></i>编辑</button>
          <button class="btn btn-danger btn-sm" data-del-d="${x.id}"><i class="fa-solid fa-trash-can"></i>删除</button>
        </td>
      </tr>`).join('');

  // 板块筛选（与讨论区一致）：题目总版 + 各板块（来自接口）；进入题目分板块时顶部高亮题目
  const boardChips = boardPairs().map(([k, label]) => {
    const active = !problem && board === k;
    return `<span class="chip ${active ? 'active' : ''}" data-board="${escapeHtml(k)}">${escapeHtml(label)}</span>`;
  }).join('');
  const problemChip = problem
    ? `<span class="chip active" data-problem="${escapeHtml(problem)}">#${escapeHtml(problem)}</span>`
    : '';

  app.innerHTML = `${adminTabs('discussions')}
    ${adminHead({
      title: '讨论管理',
      subtabs: isSuper ? adminSubTabs('discussions', 'list') : '',
      filter: `<div class="filter-bar">
        <input class="input" id="d-search" placeholder="搜索标题 / 作者名 / 用户 ID…" value="${escapeHtml(search)}" style="flex:0 0 220px" />
        <button class="btn" id="d-search-btn"><i class="fa-solid fa-magnifying-glass"></i>搜索</button>
        <div class="spacer"></div>
        <input class="input" id="d-problem" placeholder="输入题号" value="${escapeHtml(problem)}" style="flex:0 0 110px" />
        <button class="btn btn-ghost" id="d-problem-btn"><i class="fa-solid fa-filter"></i>题目筛选</button>
      </div>
      <div class="tag-chips" id="d-boards" style="margin-top:10px">${problemChip}${boardChips}</div>`,
    })}
    <div class="card" style="margin-top:8px">
      <h2 class="card-title">帖子（共 ${d.total} 条）</h2>
      <div class="table-scroll"><table class="table">
        <thead><tr><th>ID</th><th>标题</th><th>所属板块</th><th>作者</th><th class="num">回复</th><th class="num">发布时间</th><th>操作</th></tr></thead>
        <tbody>${dRows}</tbody>
      </table></div>
      ${renderPagination(d.total, d.page, d.size)}
    </div>`;

  bindPagination((p) => nav('admin/discussions', { search, board, problem, dpage: p }));
  document.querySelectorAll('#d-boards .chip').forEach((c) => c.addEventListener('click', () => {
    nav('admin/discussions', {
      search,
      board: c.dataset.board || '',
      problem: c.dataset.problem || '',
      dpage: 1,
    });
  }));
  const doFilter = () => nav('admin/discussions', {
    search: document.getElementById('d-search').value.trim(),
    board,
    problem,
    dpage: 1,
  });
  document.getElementById('d-search-btn').addEventListener('click', doFilter);
  document.getElementById('d-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') doFilter(); });
  const doProblemFilter = () => {
    const n = parseInt((document.getElementById('d-problem').value || '').trim(), 10);
    if (!Number.isFinite(n) || n <= 0) return toast('请输入有效题号', 'error');
    nav('admin/discussions', { search, board: '', problem: String(n), dpage: 1 });
  };
  document.getElementById('d-problem-btn').addEventListener('click', doProblemFilter);
  document.getElementById('d-problem').addEventListener('keydown', (e) => { if (e.key === 'Enter') doProblemFilter(); });

  document.querySelectorAll('button[data-del-d]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确定删除该帖子及其所有回复吗？')) return;
    try { await api.del('/api/discussions/' + b.dataset.delD); toast('已删除', 'success'); renderAdminDiscussions(); }
    catch (e) { toast(e.message, 'error'); }
  }));
  // 具备讨论管理权限的管理员可编辑讨论（标题 / 内容 / 板块）
  document.querySelectorAll('button[data-edit-d]').forEach((b) => b.addEventListener('click', () => {
    showAdminDiscussionEditor(b.dataset.editD);
  }));
}

/* 管理员编辑讨论弹窗 */
async function showAdminDiscussionEditor(id) {
  let cur = { title: '', content: '', board: 'academic' };
  try {
    const r = await api.get('/api/discussions/' + id);
    cur = r.discussion || cur;
  } catch { /* ignore */ }
  await loadTaxonomy(); // 板块下拉来自接口（后台可增删改）
  // 板块选项：该讨论当前的板块即使已不在配置表里（历史值）也保留一项，避免保存时被动改板块
  const opts = boardList().map((b) => [b.key, b.name]);
  if (cur.board && !opts.some(([k]) => k === cur.board)) opts.push([cur.board, cur.board]);
  const boardOptions = opts.length
    ? opts.map(([k, name]) =>
        `<option value="${escapeHtml(k)}" ${cur.board === k ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')
    : '<option value="">（暂无板块）</option>';
  app.insertAdjacentHTML('beforeend', `
    <div class="modal-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200;display:flex;align-items:center;justify-content:center">
      <div class="card" style="width:600px;max-width:94vw;margin:0">
        <h2 class="card-title">编辑讨论 #${id}</h2>
        <div class="form-group"><label>标题</label><input class="input" id="ed-title" value="${escapeHtml(cur.title || '')}" /></div>
        <div class="form-group"><label>所属板块</label><select class="input" id="ed-board" style="width:100%">${boardOptions}</select></div>
        <div class="form-group"><label>内容（支持 Markdown）</label><textarea class="textarea" id="ed-content" rows="6">${escapeHtml(cur.content || '')}</textarea></div>
        <div class="row">
          <button class="btn btn-ghost" id="ed-cancel"><i class="fa-solid fa-xmark"></i>取消</button>
          <div class="spacer"></div>
          <button class="btn" id="ed-save"><i class="fa-solid fa-floppy-disk"></i>保存</button>
        </div>
      </div>
    </div>`);
  const backdrop = document.querySelector('.modal-backdrop');
  document.getElementById('ed-cancel').addEventListener('click', () => backdrop.remove());
  document.getElementById('ed-save').addEventListener('click', async () => {
    const title = document.getElementById('ed-title').value.trim();
    const content = document.getElementById('ed-content').value.trim();
    const board = document.getElementById('ed-board').value;
    if (!title) return toast('标题不能为空', 'error');
    try {
      await api.put('/api/discussions/' + id, { title, content, board });
      toast('已保存', 'success');
      backdrop.remove();
      renderAdminDiscussions();
    } catch (e) { toast(e.message, 'error'); }
  });
}

/* ---------- 社区管理公布页（v2.8.6：**只**公示「用户权限变更」记录，含棕名处罚） ----------
   口径收敛：数据来自 GET /api/moderation-logs，服务端按动作白名单（src/users.js 的
   MOD_PERMISSION_ACTIONS）过滤，本页不可能再拿到非权限变更类记录；请求里的分类参数会被忽略。
   本页没有分类标签 / 筛选入口（收敛前也没有 Tab，只是把所有类别的记录混在一个列表里）。
   权限：**公开公示页** —— 未登录也能查看（v2.9.0 站长要求）；接口只返回「权限变更类」记录，白名单在服务端过滤。 */
async function renderModeration(query) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  setPageTitle('社区管理');
  // v2.9.0（站长要求）：本页是**公开公示页，未登录也能查看** —— 接口已改为公开只读，
  // 记录由服务端按「权限变更动作白名单」（MOD_PERMISSION_ACTIONS）过滤，故此处不做登录/管理员拦截。
  const page = parseInt((query && query.get('page')) || '1', 10);
  const params = new URLSearchParams({ page: String(page), size: '30' });
  const data = await api.get('/api/moderation-logs?' + params.toString());
  const rows = data.items.length === 0
    ? '<div class="empty">暂无用户权限变更记录</div>'
    : data.items.map((m) => {
      // 授予/解除类 → 绿色，撤销/封禁/棕名等处罚类 → 红色，其它权限变更（换权限项 / 权限等级）→ 蓝色
      const color = m.tone === 'good' ? '#52c41a' : (m.tone === 'bad' ? '#f5222d' : '#1890ff');
      return `
      <div class="reply-item">
        <div class="row" style="gap:10px;align-items:center">
          <span class="badge" style="background:${color};color:#fff">${escapeHtml(m.action_label)}</span>
          ${userSpan({ uid: m.admin_id, username: m.admin_name, nickname: m.admin_name })}
          <span class="muted">对</span>
          ${userSpan({ uid: m.user_id, username: m.username, nickname: m.username })}
          <span class="spacer"></span>
          <span class="muted">${fmtTime(m.created_at)}</span>
        </div>
        ${m.detail ? `<div class="muted" style="font-size:13px;margin-top:4px">${escapeHtml(m.detail)}</div>` : ''}
      </div>`;
    }).join('');

  app.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">社区管理</h1>
      <div class="page-sub">本页只公示用户权限变更记录：封禁 / 解除封禁、各权限位的授予与撤销、权限等级变更、棕名处罚 / 解除棕名（含处罚原因、期限与操作人）。</div>
    </div>
    <div class="card" style="padding:8px 20px">${rows}</div>
    ${renderPagination(data.total, data.page, data.size)}`;
  bindPagination((p) => nav('moderation', { page: p }));
}

/* ---------- 小工具 ---------- */
/* Markdown 实时预览（左右两栏）：监听输入，防抖渲染右侧预览 */
function bindLivePreview(textareaId, previewId) {
  const ta = document.getElementById(textareaId);
  const pv = document.getElementById(previewId);
  if (!ta || !pv) return;
  let timer = null;
  const render = async () => {
    try {
      const r = await api.post('/api/preview', { content: ta.value });
      pv.innerHTML = r.html || '<div class="empty">…</div>';
    } catch {
      pv.innerHTML = '<div class="empty">渲染失败</div>';
    }
    renderMath();
    bindCodeCopy(pv);
  };
  ta.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(render, 250);
  });
  render();
}

/* 站点公开页：帮助中心 / 用户协议 / 联系我们（内容由 admin 在后台维护） */
async function renderSitePage(kind) {
  app.innerHTML = '<div class="loading">加载中…</div>';
  const r = await api.get('/api/site-pages');
  const titles = { help: '帮助中心', agreement: '用户协议', contact: '联系我们', about: '关于网站', rules: '社区规则' };
  const content = r[kind] || '';
  setPageTitle(titles[kind] || '');
  app.innerHTML = `
    <div class="crumb"><a href="${backHref('#/home')}"><i class="fa-solid fa-arrow-left"></i> ${backLabel('返回首页')}</a></div>
    <h1 class="page-title" style="margin-top:8px">${titles[kind] || ''}</h1>
    <div class="card statement">${content}</div>`;
}

function langName(k) { return LANG_NAMES[k] || k; }

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = reader.result;
      const idx = String(res).indexOf(',');
      resolve(idx >= 0 ? String(res).slice(idx + 1) : String(res));
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

/* ---------- 启动 ---------- */
(async function main() {
  // 暗黑模式：默认按时间，可手动覆盖
  applyDarkMode();
  // 恢复侧边栏展开/折叠状态
  if (localStorage.getItem('oj_sidebar') === 'collapsed') document.body.classList.add('sidebar-collapsed');
  // 首屏优化：主页数据 / 页脚文案与登录态并行请求（原先为串行，首屏要多等 2~3 个往返）
  const homeP = api.get('/api/home').catch(() => null);
  const pagesP = api.get('/api/site-pages').catch(() => null);
  // 恢复手机端悬浮按钮的折叠状态
  if (localStorage.getItem('oj_fab') === 'collapsed') document.body.classList.add('fab-collapsed');
  await initStore();
  renderTopbar();
  // H3：已登录且 must_change_password → 首屏就给出强制改密横幅
  showPasswordWarning();
  // 说明：KaTeX 已改为按需加载（见 renderMath），无公式的页面不再请求这两个外链
  const st = document.getElementById('sidebar-toggle');
  if (st) {
    // 按钮状态与图标同步：收起时显示「向右展开」箭头，展开时显示「向左收起」箭头，并带文字提示
    const syncToggle = () => {
      const collapsed = document.body.classList.contains('sidebar-collapsed');
      const icon = st.querySelector('i');
      // 图标固定不换（保持原有图标），只更新提示文案
      st.title = collapsed ? '展开侧边栏' : '收起侧边栏';
      st.setAttribute('aria-label', st.title);
    };
    syncToggle();
    st.addEventListener('click', () => {
      document.body.classList.toggle('sidebar-collapsed');
      localStorage.setItem('oj_sidebar', document.body.classList.contains('sidebar-collapsed') ? 'collapsed' : '');
      syncToggle();
    });
  }
  try {
    const home = await homeP;
    if (home) {
      bootHomeData = home; // 供 renderHome 首次渲染复用，避免首屏重复请求
      Store.features = {
        discussion_enabled: home.discussion_enabled !== false,
        article_enabled: home.article_enabled !== false,
        points_enabled: home.points_enabled !== false,
        pm_enabled: home.pm_enabled !== false,
      };
      if (home.site_name) {
        SITE_NAME = home.site_name;
        document.getElementById('site-brand').textContent = home.site_name;
        document.title = SITE_NAME + ' - 在线评测系统';
        // 站名较长（>6 字符）时：logo 在上、标题在下换行展示
        const brand = document.querySelector('.sidebar .brand');
        if (brand) brand.classList.toggle('brand-long', home.site_name.length > 6);
      }
      const icon = document.getElementById('brand-icon');
      if (icon) {
        if (home.site_logo) {
          icon.innerHTML = `<img class="site-logo-img" src="${escapeHtml(home.site_logo)}" alt="logo" onerror="this.style.display='none'" />`;
        } else {
          // 未自定义 Logo → 默认站点 Logo /img/logo.svg（与后端默认 favicon 同一份字节）
          icon.innerHTML = '<img class="site-logo-img" src="/img/logo.svg?v=296" alt="logo" />';
        }
      }
      applySiteTitleStyle(home.title_style); // 后台自定义的网站标题样式
      applyFavicon(home.favicon_v, home.favicon); // 后台自定义的网站图标（未自定义时回默认图标 + 默认版本号）
      applyLogoSize(home.site_logo_size); // 后台自定义的侧边栏 Logo 大小（--brand-logo-size）
      applyTitleSize(home.site_title_size); // 后台自定义的侧栏站名字号（--brand-title-size）
      setSavedLook(home); // 记入「已保存」快照并套用（页面宽度 / 首页宽度 / 网站外观）
      renderTopbar(); // 功能开关影响侧边栏入口，重新渲染
    }
    // 页脚版权文字（与上面并行请求，这里只做等待）
    const sp = await pagesP;
    if (sp && sp.footer_text) {
      const ft = document.getElementById('footer-text');
      if (ft) ft.textContent = sp.footer_text;
    }
  } catch { /* ignore */ }
  window.addEventListener('hashchange', route);
  await route();
  bootHomeData = null; // 首屏之后失效，再次进入首页时重新拉取
})();

