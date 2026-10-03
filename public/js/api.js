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

function fmtMem(kb) {
  if (!kb) return '—';
  if (kb >= 1024) return (kb / 1024).toFixed(1) + ' MB';
  return kb + ' KB';
}

function fmtDuration(ms) {
  if (!ms) return '—';
  return ms + ' ms';
}

/* 大数据约数显示：≥1万 → X.X万（W），≥100万 → X.XM，≥1000 → X.XK；小于 1000 原样 */
function fmtCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + 'W';
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
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
}
