'use strict';

/* 全局状态 */
const Store = {
  user: null,
  difficulties: [],
  tags: [],
  sources: [],
  languages: [],
  userColors: {},
  features: { discussion_enabled: true, article_enabled: true },
  // v2.7.0：讨论板块 / 文章分类（后台「板块与分类管理」可配置，前端一律读接口，不再硬编码）
  // 元素形如 { key, name, sort_order, is_system, count, ... }；key 是稳定内部标识，name 只用于显示
  boards: [],
  categories: [],
};

async function request(method, path, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const msg = (data && data.message) || `请求失败 (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
};

/* 工具 */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, type = 'info') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2600);
  setTimeout(() => el.remove(), 3000);
}

const VERDICT_META = {
  'Pending': { label: 'Pending', cls: 'verdict-Pending', banner: '' },
  'Judging': { label: 'Judging', cls: 'verdict-Judging', banner: '' },
  'Accepted': { label: 'Accepted', cls: 'verdict-AC', banner: 'ac' },
  'Wrong Answer': { label: 'Wrong Answer', cls: 'verdict-WA', banner: 'wa' },
  'Time Limit Exceeded': { label: 'Time Limit Exceeded', cls: 'verdict-TLE', banner: 'tle' },
  'Memory Limit Exceeded': { label: 'Memory Limit Exceeded', cls: 'verdict-MLE', banner: 'tle' },
  'Runtime Error': { label: 'Runtime Error', cls: 'verdict-RE', banner: 're' },
  'Compile Error': { label: 'Compile Error', cls: 'verdict-CE', banner: 'ce' },
  'System Error': { label: 'System Error', cls: 'verdict-SE', banner: 're' },
  'Compiled': { label: '编译通过', cls: 'verdict-AC', banner: 'ac' },
};

const LANG_NAMES = {
  python: 'Python 3', javascript: 'JavaScript', cpp: 'C++ 14', c: 'C', java: 'Java', output: '提交答案',
};

function verdictInfo(v) {
  return VERDICT_META[v] || { label: v || '—', cls: 'verdict-Pending', banner: '' };
}

/** 提交记录列表的状态：只显示 Accepted（绿）/ Unaccepted（红）两种（评测中的状态原样显示）。
 *  真实判定保留在 title 里，鼠标悬停仍可看到 Wrong Answer / TLE 等具体结果。 */
function listStatusInfo(v) {
  if (v === 'Pending' || v === 'Judging') {
    const m = VERDICT_META[v];
    return { label: m.label, cls: m.cls, title: m.label };
  }
  if (v === 'Accepted') return { label: 'Accepted', cls: 'verdict-AC', title: 'Accepted' };
  const m = VERDICT_META[v];
  return { label: 'Unaccepted', cls: 'verdict-WA', title: m ? m.label : (v || '未知状态') };
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* 内存格式化（全站统一口径）：
 *   · sampled === false：本次评测**没采到内存**（采样器不可用等），显示 '—' —— 绝不能显示成 0 KB；
 *   · 已采样（sampled === true）：按 KB / MB 显示，包含 0~几百 KB 这类极小值；
 *   · sampled 缺省（老接口 / 无该字段）：0 视为「没有数据」（保持历史行为，避免把未采样显示成 0 KB）。
 */
function fmtMem(kb, sampled) {
  const v = Number(kb);
  const hasValue = !(kb == null || kb === '' || !Number.isFinite(v) || v < 0);
  if (sampled === false) return '—';
  if (!hasValue) return '—';
  if (sampled == null && v <= 0) return '—';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' MB';
  return v + ' KB';
}

/* 用时格式化（全站统一口径）：
 *   < 1000 ms  → "123 ms"（整数毫秒）
 *   ≥ 1000 ms  → "1.23 s"（保留 2 位小数）
 *   ≥ 60 s     → "1m02s"（分钟 + 补零秒；60 分钟显示为 "60m00s"，不再带毫秒，避免过长）
 *   无有效测量（null / undefined / '' / 0 / 非数字）→ '—'。
 *   注意：0 表示「根本没有运行」（编译错误 / 提交答案题 / 评测中），与「跑了 0 毫秒」无法区分，
 *   统一按无数据处理；判定与排序一律使用原始数字，绝不用格式化后的字符串。
 */
function fmtDuration(ms) {
  const v = Number(ms);
  if (ms == null || ms === '' || !Number.isFinite(v) || v <= 0) return '—';
  if (v < 1000) return Math.round(v) + ' ms';
  // 先按 2 位小数格式化，再用格式化后的秒数判断是否满 60 秒：
  // 避免 59999ms 显示成 "60.00 s" 这种越界文本（应显示 1m00s）。
  const secText = (v / 1000).toFixed(2);
  if (Number(secText) < 60) return secText + ' s';
  const total = Math.round(Number(secText));
  return Math.floor(total / 60) + 'm' + String(total % 60).padStart(2, '0') + 's';
}

/* 合计多条用时：只累加有效数字（未采到用时的测试点按 0 计），返回毫秒数 */
function sumDuration(list, pick) {
  let total = 0;
  for (const it of (list || [])) {
    const v = Number(pick ? pick(it) : it);
    if (Number.isFinite(v) && v > 0) total += v;
  }
  return total;
}

/* 大数据约数显示（首页统计方块统一用它）：
   · < 1000 原样显示；
   · ≥ 1000 → x.xxk（保留 2 位小数，四舍五入），如 1000 → 1.00k、1234 → 1.23k、12345 → 12.35k、5015 → 5.02k；
   · ≥ 1000000 → x.xxM。
   v2.6.0：首页 hero 的四个统计方块（道题目 / 位用户 / 次评测 / 场比赛）**共用这一个函数**，
   调用点见 app.js 的 renderHome（其它数字格式——判题用时 fmtDuration、内存 fmtMem、排行榜分数、提交 ID 等——不走这里）。
   注意：toFixed(2) 直接算会踩二进制浮点误差（5015/1000 = 5.0149999… → "5.01"），
   这里先乘 100 加极小量 1e-6 再取整，保证 5.015 这类“恰好半分”按四舍五入进位到 5.02。 */
function fmtCompact(n) {
  const v = Number(n) || 0;
  const round2 = (x) => (Math.round(x * 100 + 1e-6) / 100).toFixed(2);
  if (v >= 1000000) return round2(v / 1000000) + 'M';
  if (v >= 1000) return round2(v / 1000) + 'k';
  return String(v);
}

/* 分页组件：renderPagination 只生成 HTML，bindPagination 绑定事件（含页码输入跳转） */
function renderPagination(total, page, size) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return '';
  const jump = `<span class="pagination-jump">跳至 <input class="pagination-input" id="pg-jump-input" type="number" min="1" max="${pages}" value="${page}" /> 页 <button class="pagination-goto" id="pg-jump-btn" type="button">跳转</button></span>`;
  let html = '<div class="pagination">';
  html += `<button ${page <= 1 ? 'disabled' : ''} data-p="${page - 1}">上一页</button>`;
  html += `<span class="info">第 ${page} / ${pages} 页（共 ${total} 条）</span>`;
  html += `<button ${page >= pages ? 'disabled' : ''} data-p="${page + 1}">下一页</button>`;
  html += jump;
  html += '</div>';
  return html;
}

function bindPagination(onChange) {
  document.querySelectorAll('.pagination button[data-p]').forEach((b) => {
    b.addEventListener('click', () => onChange(parseInt(b.dataset.p, 10)));
  });
  // 页码输入跳转
  const input = document.getElementById('pg-jump-input');
  const btn = document.getElementById('pg-jump-btn');
  const go = () => {
    const p = parseInt(input.value, 10);
    if (Number.isFinite(p) && p >= 1) onChange(p);
  };
  if (btn) btn.addEventListener('click', go);
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

/* 初始化：加载当前用户与基础数据 */
async function initStore() {
  try {
    const me = await api.get('/api/me');
    Store.user = me.user;
  } catch { Store.user = null; }
  try {
    const tags = await api.get('/api/tags');
    Store.tags = tags.tags || [];
    Store.sources = tags.sources || [];
    Store.difficulties = tags.difficulties || [];
  } catch { /* ignore */ }
  try {
    const langs = await api.get('/api/languages');
    Store.languages = langs.languages || [];
  } catch { /* ignore */ }
  try {
    const uc = await api.get('/api/user-colors');
    Store.userColors = uc.colors || {};
  } catch { /* ignore */ }
  // 讨论板块 / 文章分类配置（公开可读）：讨论页 / 文章页 / 编辑器 / 后台都用它做 key → 显示名映射
  try {
    const [b, c] = await Promise.all([
      api.get('/api/discussion-boards'),
      api.get('/api/article-categories'),
    ]);
    Store.boards = (b && b.items) || [];
    Store.categories = (c && c.items) || [];
  } catch { /* 失败时保持空数组：前端回退显示原始 key，页面照常渲染不报错 */ }
}
