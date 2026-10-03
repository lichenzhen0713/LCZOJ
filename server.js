'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { PORT, HOST, DATA_DIR, PUBLIC_DIR, DOCS_DIR, VERDICTS, DIFFICULTIES, ensureDirs } = require('./src/config');
const { db } = require('./src/db');
const {
  currentUser, createSession, destroySession, registerUser, loginUser, setSessionCookie, clearSessionCookie,
  hasPerm, PERMISSION_LABELS,
} = require('./src/auth');
const { readJsonBody, ok, fail, sendJson, escapeHtml, contentDisposition } = require('./src/util');
const { markdownToHtml } = require('./src/markdown');
const problems = require('./src/problems');
const submissions = require('./src/submissions');
const ranking = require('./src/ranking');
const discussion = require('./src/discussion');
const users = require('./src/users');
const contest = require('./src/contest');
const editorial = require('./src/editorial');
const attachments = require('./src/attachments');
const notifications = require('./src/notifications');
const messages = require('./src/messages');

const { JudgeQueue, availableLanguages, cleanJudgeWorkDirs, cleanSpjCache, pruneGoCache } = require('./src/judge');

ensureDirs();
const queue = new JudgeQueue();
// 并行判题数：优先取系统设置里的 judge_concurrency，其次环境变量 / 默认值
try {
  const settings = require('./src/settings');
  const saved = parseInt(settings.getSetting('judge_concurrency', ''), 10);
  if (Number.isFinite(saved) && saved > 0) queue.setConcurrency(saved);
} catch { /* ignore */ }

/**
 * 定期清理评测缓存与临时文件（启动时执行一次，之后每 10 分钟一次）：
 *   1) data/judge 下超过 30 分钟的评测工作目录与散落临时文件（正常评测结束已即时删除，这里处理崩溃残留）
 *   2) data/spj_cache 里残留的 checker 编译产物（正常评测结束即时删除）
 *   3) data/gocache 里超过 1 天 / 总量超过 100MB 的 Go 构建缓存
 * 只清理缓存与临时产物；题库测试数据、附件、头像、数据库等数据一律不动。
 */
function maintainJudgeCaches(label) {
  const parts = [];
  try {
    const r = cleanJudgeWorkDirs(label === 'startup' ? 0 : 30 * 60 * 1000);
    if (r && r.removed) parts.push(`判题工作目录 ${r.removed} 个/${(r.freedBytes / 1024 / 1024).toFixed(1)}MB`);
  } catch { /* ignore */ }
  try {
    const n = cleanSpjCache();
    if (n) parts.push(`SPJ 编译缓存 ${n} 个`);
  } catch { /* ignore */ }
  try {
    const g = pruneGoCache(100, 1);
    if (g && g.removed) parts.push(`Go 构建缓存 ${g.removed} 个/${(g.freedBytes / 1024 / 1024).toFixed(1)}MB`);
  } catch { /* ignore */ }
  if (parts.length) console.log(`[OJ] 评测缓存清理（${label}）：` + parts.join('，'));
}

maintainJudgeCaches('startup');
setInterval(() => maintainJudgeCaches('定期'), 10 * 60 * 1000);

// 重启后重新入队未完成的提交
function requeueStale() {
  db.prepare("UPDATE submissions SET status = 'Pending', verdict = 'Pending' WHERE status = 'Judging'").run();
  const stale = db.prepare("SELECT id FROM submissions WHERE status = 'Pending'").all();
  for (const r of stale) queue.submit(r.id);
  if (stale.length) console.log(`[OJ] 重新入队 ${stale.length} 条未完成提交`);
}
requeueStale();

// ---------------- 中间件 ----------------

/** 按 UID 或用户名解析用户（用户标识统一为 uid，兼容用户名） */
function resolveUserIdent(ident) {
  // 个人中心统一以 UID 为标识，不再支持用户名访问
  const s = String(ident || '').trim();
  if (!/^\d+$/.test(s)) return null;
  return db.prepare('SELECT id, username FROM users WHERE id = ?').get(parseInt(s, 10));
}

function requireAuth(req, res) {
  const user = currentUser(req);
  if (!user) { fail(res, 401, '请先登录'); return null; }
  return user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (!user.is_admin) { fail(res, 403, '需要管理员权限'); return null; }
  return user;
}

function requireSuperAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (!user.is_superadmin) { fail(res, 403, '需要超级管理员权限'); return null; }
  return user;
}

/** 需要指定权限（超级管理员拥有全部权限） */
function requirePerm(key) {
  return (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return null;
    if (!hasPerm(user, key)) {
      fail(res, 403, `你没有「${PERMISSION_LABELS[key] || key}」权限`);
      return null;
    }
    return user;
  };
}

/** 需要任一权限 */
function requireAnyPerm(keys) {
  return (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return null;
    if (!keys.some((k) => hasPerm(user, k))) {
      fail(res, 403, '你没有执行该操作的权限');
      return null;
    }
    return user;
  };
}

// ---------------- 静态文件 ----------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// 站点版本号（与 package.json / CHANGELOG.md 保持一致，系统设置页会显示）
const VERSION = (() => {
  try { return require('./package.json').version || '0.0.0'; } catch { return '0.0.0'; }
})();

// 静态资源缓存：
//  - fileCache：文件内容按「路径 + mtime + 大小」缓存，命中时不再读磁盘（每次请求只做一次 statSync）
//  - staticGzipCache：gzip 结果缓存（键含 mtime，避免"等长修改"发出旧内容）
const staticFileCache = new Map();
const staticGzipCache = new Map();

/** 读取静态文件：优先内存缓存，文件变更（mtime/大小）后自动失效 */
function readStaticFile(filePath, cb) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { cb(null); return; }
    const key = filePath;
    const stamp = st.mtimeMs + ':' + st.size;
    const hit = staticFileCache.get(key);
    if (hit && hit.stamp === stamp) { cb(hit.data, stamp); return; }
    fs.readFile(filePath, (e2, data) => {
      if (e2) { cb(null); return; }
      if (staticFileCache.size > 120) staticFileCache.clear();
      staticFileCache.set(key, { stamp, data });
      cb(data, stamp);
    });
  });
}

/** 弱 ETag（mtime+size），用于 If-None-Match 判断，让重复访问直接回 304 */
function etagOf(stamp) {
  return '"' + require('crypto').createHash('sha1').update(String(stamp)).digest('hex').slice(0, 20) + '"';
}

function serveStatic(req, res, pathname) {  let rel = pathname === '/' ? '/index.html' : pathname;
  // 文档目录（docs/）：仅允许 Markdown 文件，渲染为带左侧目录导航的 HTML 页面，供站内「使用说明」等链接访问
  if (rel.startsWith('/docs/')) {
    const docRel = rel.slice(5);
    if (!docRel.toLowerCase().endsWith('.md')) { res.writeHead(404); res.end('Not Found'); return; }
    const docPath = path.resolve(DOCS_DIR, '.' + docRel);
    const docSafe = docPath === DOCS_DIR || docPath.startsWith(DOCS_DIR + path.sep);
    if (!docSafe) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.readFile(docPath, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
      const title = path.basename(docRel, '.md');
      const mdText = data.toString('utf8');
      const body = markdownToHtml(mdText, { headingIds: true });
      // 左侧目录：解析 Markdown 标题（#~###）生成锚点，当前文档高亮
      const toc = buildDocToc(mdText, docRel);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} - LCZOJ 文档</title><style>
        *{box-sizing:border-box}
        body{margin:0;font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#333;background:#fafafa}
        a{color:#3498db;text-decoration:none}a:hover{text-decoration:underline}
        .layout{display:flex;max-width:1200px;margin:0 auto;min-height:100vh}
        .sidebar{width:230px;flex-shrink:0;background:#fff;border-right:1px solid #eee;padding:18px 12px 40px;position:sticky;top:0;height:100vh;overflow-y:auto}
        .sidebar .brand{font-size:16px;font-weight:700;padding:2px 10px 12px;border-bottom:1px solid #eee;margin-bottom:8px;display:block}
        .sidebar .docs-link{display:block;padding:6px 10px;font-size:13px;color:#555}
        .sidebar .docs-link:hover{color:#3498db;text-decoration:none}
        .sidebar .docs-link.active{color:#fff;background:#3498db;border-radius:6px}
        .sidebar .toc{margin-top:6px}
        .sidebar .toc a{display:block;padding:4px 10px;font-size:13px;color:#555;border-left:2px solid transparent}
        .sidebar .toc a.lv2{margin-left:0;font-weight:600}
        .sidebar .toc a.lv3{margin-left:16px;font-size:12.5px}
        .sidebar .toc a:hover{color:#3498db;border-left-color:#3498db;text-decoration:none}
        .main{flex:1;min-width:0;padding:24px 32px 80px}
        .main h1{font-size:26px;border-bottom:1px solid #eee;padding-bottom:10px}.main h2{font-size:20px;margin-top:36px;border-bottom:1px solid #eee;padding-bottom:6px}.main h3{font-size:17px;margin-top:26px}
        .main h1,.main h2,.main h3{scroll-margin-top:16px}
        .main code{background:#f5f5f5;padding:2px 5px;border-radius:3px;font-size:13px}
        .main pre{background:#f7f7f9;padding:12px;border-radius:6px;overflow:auto}pre code{background:none;padding:0}
        .main table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #ddd;padding:8px 10px;text-align:left}th{background:#f5f5f5}
        .main blockquote{border-left:4px solid #ddd;margin:12px 0;padding:2px 14px;color:#666}
        .back-home{display:inline-block;font-size:13px;color:#888;margin-bottom:10px}
        @media(max-width:820px){.layout{display:block}.sidebar{position:static;width:100%;height:auto;border-right:none;border-bottom:1px solid #eee}}
      </style></head><body><div class="layout"><aside class="sidebar">
        <a class="brand" href="/">← ${'返回首页'}</a>
        ${buildDocsList(docRel)}
        <div class="toc">${toc}</div>
      </aside><main class="main">${body}</main></div></body></html>`);
    });
    return;
  }
  const filePath = path.resolve(PUBLIC_DIR, '.' + rel);
  const safe = filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep);
  if (!safe) { res.writeHead(403); res.end('Forbidden'); return; }
  readStaticFile(filePath, (data, stamp) => {
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    // 带 ?v= 版本号的静态资源可长期缓存；其余 HTML/JS/CSS 仍 no-cache 以便及时更新
    const versioned = /[?&]v=/.test(req.url || '');
    const cacheControl = (ext === '.html')
      ? 'no-cache'
      : (versioned && ['.js', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.woff2', '.woff', '.ttf'].includes(ext)
        ? 'public, max-age=31536000, immutable'
        : ([ '.js', '.css', '.json' ].includes(ext) ? 'no-cache' : 'public, max-age=3600'));
    const etag = stamp ? etagOf(stamp) : '';
    // 命中协商缓存：直接 304，不再传输正文（首屏 HTML 与未加版本号的 CSS/JS 受益最大）
    if (etag && String(req.headers['if-none-match'] || '').split(',').map((s) => s.trim()).includes(etag)) {
      res.writeHead(304, { 'ETag': etag, 'Cache-Control': cacheControl, 'Vary': 'Accept-Encoding' });
      res.end();
      return;
    }
    const baseHeaders = { 'Cache-Control': cacheControl, 'Vary': 'Accept-Encoding' };
    if (etag) baseHeaders['ETag'] = etag;
    const compressible = ['.js', '.css', '.html', '.json', '.svg', '.txt', '.map'].includes(ext);
    const accept = String(req.headers['accept-encoding'] || '');
    if (compressible && /\bgzip\b/.test(accept) && data.length >= 1024) {
      const key = filePath + '|' + stamp;
      let gz = staticGzipCache.get(key);
      if (!gz) {
        try {
          gz = require('zlib').gzipSync(data, { level: 6 });
          if (staticGzipCache.size > 60) staticGzipCache.clear(); // 简单容量控制
          staticGzipCache.set(key, gz);
        } catch { gz = null; }
      }
      if (gz) {
        res.writeHead(200, Object.assign({
          'Content-Type': type,
          'Content-Encoding': 'gzip',
          'Content-Length': gz.length,
        }, baseHeaders));
        res.end(gz);
        return;
      }
    }
    res.writeHead(200, Object.assign({
      'Content-Type': type,
      'Content-Length': data.length,
    }, baseHeaders));
    res.end(data);
  });
}

/** docs/ 文档列表（侧边栏导航） */
function buildDocsList(current) {
  const docs = [
    ['USAGE.md', '使用说明'],
    ['BEGINNERS.md', '新手教程'],
    ['DEPLOYMENT.md', '部署详解'],
    ['DOCKER.md', 'Docker 部署'],
    ['PANEL.md', '面板部署（宝塔 / 小皮）'],
    ['UPDATE.md', '版本更新指南'],
    ['LANGUAGES.md', '多语言配置'],
    ['CUSTOMIZATION.md', '自定义指南'],
    ['FAQ.md', '常见问题'],
    ['CONTRIBUTING.md', '贡献指南'],
    ['CHANGELOG.md', '版本日志'],
  ];
  return docs.map(([file, label]) => {
    const href = `/docs/${file}`;
    const active = file === current;
    return `<a class="docs-link${active ? ' active' : ''}" href="${href}">${label}</a>`;
  }).join('');
}

/** 从 Markdown 提取 #~### 标题生成左侧目录（锚点与 markdownToHtml 的 slugify 一致） */
function buildDocToc(md, currentFile) {
  const { slugify } = require('./src/markdown');
  const lines = String(md).split('\n');
  const items = [];
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.*)$/);
    if (!m) continue;
    const level = m[1].length;
    const titleText = m[2].replace(/[*_`~]/g, '');
    items.push(`<a class="lv${level}" href="#${slugify(titleText)}">${titleText}</a>`);
  }
  return items.join('');
}

// ---------------- 路由 ----------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const method = req.method.toUpperCase();
  const viewer = currentUser(req);
  res.__req = req; // 供 ok/fail 判断是否支持 gzip

  try {
    // API
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, url, method, viewer, pathname);
      return;
    }
    // 静态资源
    if (method === 'GET') {
      serveStatic(req, res, pathname);
      return;
    }
    res.writeHead(405); res.end('Method Not Allowed');
  } catch (e) {
    console.error('[OJ] 请求处理异常:', e);
    if (pathname.startsWith('/api/')) fail(res, 500, '服务器内部错误');
    else { res.writeHead(500); res.end('Internal Server Error'); }
  }
});

async function handleApi(req, res, url, method, viewer, pathname) {
  const seg = pathname.slice(5).split('/').filter(Boolean); // 去掉 /api/

  // 认证相关
  if (seg.length === 1) {
    if (seg[0] === 'register' && method === 'POST') {
      const body = await readJsonBody(req);
      const r = registerUser(body.username, body.email, body.password);
      if (r.error) return fail(res, 400, r.error);
      if (r.email_verify_required) {
        // 邮箱验证开启：验证码仅通过邮件发送，不在接口/页面展示
        return ok(res, {
          email_verify_required: true,
          user_id: r.id,
          email_sent: !!r.email_sent,
          message: '请使用邮箱中收到的验证码完成验证',
        });
      }
      const user = require('./src/auth').getUserById(r.id);
      const sess = createSession(user.id);
      setSessionCookie(res, sess.token, sess.expires);
      return ok(res, { user });
    }
    if (seg[0] === 'verify-email' && method === 'POST') {
      const body = await readJsonBody(req);
      const r = require('./src/auth').verifyEmail(body.code);
      if (r.error) return fail(res, 400, r.error);
      return ok(res);
    }
    // 忘记密码（仅开启邮箱验证时可用）
    if (seg[0] === 'forgot-password' && method === 'POST') {
      const body = await readJsonBody(req);
      const r = await require('./src/auth').forgotPassword(body.email);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { email_sent: r.email_sent, verify_code: r.verify_code, message: r.email_sent ? '找回验证码已发送至邮箱' : '请使用页面显示的验证码' });
    }
    // 反馈 / 举报
    if (seg[0] === 'feedback' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      const r = require('./src/feedback').createFeedback(user.id, user.username, body.type, body.content);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { id: r.id });
    }
    if (seg[0] === 'feedback' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      return ok(res, require('./src/feedback').listMyFeedbacks(user.id, url.searchParams));
    }
    if (seg[0] === 'login' && method === 'POST') {
      const body = await readJsonBody(req);
      const r = loginUser(body.username, body.password);
      if (r.error) return fail(res, 400, r.error);
      const sess = createSession(r.user.id);
      setSessionCookie(res, sess.token, sess.expires);
      return ok(res, { user: r.user });
    }
    if (seg[0] === 'logout' && method === 'POST') {
      const cookies = req.headers.cookie || '';
      const m = cookies.match(/oj_session=([^;]+)/);
      if (m) destroySession(decodeURIComponent(m[1].trim()));
      clearSessionCookie(res);
      return ok(res);
    }
    if (seg[0] === 'me' && method === 'GET') {
      return ok(res, { user: viewer });
    }
    if (seg[0] === 'me' && method === 'PUT') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      // 更换邮箱：body 携带 email + email_code 时才走邮箱验证流程（见 requestEmailChange / confirmEmailChange）
      if (body.email !== undefined) {
        const auth = require('./src/auth');
        if (body.email_code !== undefined && body.email_code !== '') {
          const r = auth.confirmEmailChange(user.id, body.email, body.email_code);
          if (r.error) return fail(res, 400, r.error);
        } else if (body.request_email_code === true) {
          const r = await auth.requestEmailChange(user.id, body.email);
          if (r.error) return fail(res, 400, r.error);
          // 验证码仅通过邮件发送，不在接口返回
          return ok(res, { email_code_sent: r.email_sent, message: r.email_sent ? '验证码已发送至新邮箱' : ('验证码邮件发送失败：' + r.reason) });
        }
      }
      const r = users.updateProfile(user.id, body);
      if (r.error) return fail(res, 400, r.error);
      // 用户名可能已修改，改用 ID 重新获取
      return ok(res, { user: users.getProfile(user.id, user) });
    }
    if (seg[0] === 'notifications' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const r = notifications.list(user.id, url.searchParams);
      return ok(res, r);
    }
    // 合并未读徽标（通知 + 私信），减少导航时的请求数
    if (seg[0] === 'badges' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      return ok(res, { notifications: notifications.unreadCount(user.id), messages: messages.unreadCount(user.id) });
    }
    if (seg[0] === 'health' && method === 'GET') {
      // 供面板（宝塔 / 小皮）、Docker healthcheck、监控探针使用：不泄露绝对路径等敏感信息
      let dataWritable = false;
      try { fs.accessSync(DATA_DIR, fs.constants.W_OK); dataWritable = true; } catch { /* ignore */ }
      const langs = availableLanguages();
      return ok(res, {
        status: 'up',
        version: VERSION,
        uptime: Math.round(process.uptime()),
        queue: queue.length,
        node: process.versions.node,
        platform: process.platform,
        data_writable: dataWritable,
        languages: Object.values(langs).filter((l) => l.available).map((l) => l.key),
      });
    }
    // 版本更新检查：站点设置页显示「已是最新 / 发现新版本」，deploy/update.js --check 复用同一逻辑
    if (seg[0] === 'version' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const r = await require('./src/version').checkLatest({ force: url.searchParams.get('force') === '1' });
      return ok(res, r);
    }
    if (seg[0] === 'stats' && method === 'GET') {
      const pc = db.prepare('SELECT COUNT(*) AS c FROM problems WHERE is_public = 1').get().c;
      const sc = db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c;
      const uc = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
      return ok(res, { problems: pc, submissions: sc, users: uc });
    }
    if (seg[0] === 'tags' && method === 'GET') {
      return ok(res, { tags: problems.allTags(), sources: problems.listSources(), difficulties: DIFFICULTIES });
    }
    if (seg[0] === 'languages' && method === 'GET') {
      const langs = availableLanguages();
      return ok(res, { languages: Object.values(langs).map((l) => ({ key: l.key, name: l.name, available: l.available, highlight: l.highlight })) });
    }
    if (seg[0] === 'problems' && method === 'GET') {
      // 拥有「题目管理」权限的用户在前台也能看到未公开题目
      const r = problems.listProblems(url.searchParams, viewer && viewer.id, viewer && viewer.is_admin, hasPerm(viewer, 'problem'));
      return ok(res, r);
    }
    if (seg[0] === 'problems' && method === 'POST') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const body = await readJsonBody(req);
      const r = problems.createProblem(body, admin.id);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { id: r.id });
    }
    if (seg[0] === 'submissions' && method === 'GET') {
      const r = submissions.listSubmissions(url.searchParams, viewer);
      return ok(res, r);
    }
    if (seg[0] === 'discussions' && method === 'GET') {
      const r = discussion.listDiscussions(url.searchParams);
      return ok(res, r);
    }
    if (seg[0] === 'discussions' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.can_speak) return fail(res, 403, '你已被撤销自由发言权限');
      const settings = require('./src/settings');
      if (settings.getSetting('discussion_enabled', '1') !== '1') {
        return fail(res, 403, '讨论功能已关闭');
      }
      const body = await readJsonBody(req);
      const r = discussion.createDiscussionWithProblem(user.id, body.problem_id, body.title, body.content, user.username, body.board, user.is_admin);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { id: r.id });
    }
    if (seg[0] === 'ranking' && method === 'GET') {
      return ok(res, ranking.getRanking(url.searchParams));
    }
    if (seg[0] === 'points-ranking' && method === 'GET') {
      return ok(res, users.getPointsRanking(url.searchParams));
    }
    if (seg[0] === 'rating-ranking' && method === 'GET') {
      return ok(res, users.getRatingRanking(url.searchParams));
    }
    if (seg[0] === 'settings' && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      // 系统设置仅最高管理员（admin 账号）可访问
      if (admin.username !== 'admin') return fail(res, 403, '系统设置仅最高管理员可访问');
      const settings = require('./src/settings');
      return ok(res, {
        version: VERSION,
        email_verify_required: settings.getSetting('email_verify_required', '0') === '1',
        site_name: settings.getSetting('site_name', 'LCZOJ'),
        site_logo: settings.getSetting('site_logo', ''),
        smtp_host: settings.getSetting('smtp_host', ''),
        smtp_port: settings.getSetting('smtp_port', '465'),
        smtp_user: settings.getSetting('smtp_user', ''),
        smtp_pass: settings.getSetting('smtp_pass', ''),
        smtp_secure: settings.getSetting('smtp_secure', '1') === '1',
        discussion_enabled: settings.getSetting('discussion_enabled', '1') === '1',
        article_enabled: settings.getSetting('article_enabled', '1') === '1',
        points_enabled: settings.getSetting('points_enabled', '1') === '1',
        footer_text: settings.getSetting('footer_text', ''),
        help_content: settings.getSetting('help_content', ''),
        agreement_content: settings.getSetting('agreement_content', ''),
        contact_content: settings.getSetting('contact_content', ''),
        about_content: settings.getSetting('about_content', ''),
        rules_content: settings.getSetting('rules_content', ''),
        // 网站标题自定义样式（侧栏站名 / 首页大标题）
        site_title_sidebar_size: settings.getSetting('site_title_sidebar_size', ''),
        site_title_hero_size: settings.getSetting('site_title_hero_size', ''),
        site_title_weight: settings.getSetting('site_title_weight', ''),
        site_title_color: settings.getSetting('site_title_color', ''),
        site_title_spacing: settings.getSetting('site_title_spacing', ''),
        site_title_font: settings.getSetting('site_title_font', ''),
        // 正文内容最大宽度（px，空=默认 1320）
        content_max_width: settings.getSetting('content_max_width', ''),
        // 首页宽度（px，空=保持原始宽度，不受全站页面宽度影响）
        home_max_width: settings.getSetting('home_max_width', ''),
        // 网站外观自定义（颜色 / 圆角 / 字号 / 字体，空=使用默认样式）
        theme_accent: settings.getSetting('theme_accent', ''),
        theme_accent_hover: settings.getSetting('theme_accent_hover', ''),
        theme_bg: settings.getSetting('theme_bg', ''),
        theme_card: settings.getSetting('theme_card', ''),
        theme_sidebar: settings.getSetting('theme_sidebar', ''),
        theme_text: settings.getSetting('theme_text', ''),
        theme_text_light: settings.getSetting('theme_text_light', ''),
        theme_border: settings.getSetting('theme_border', ''),
        theme_radius: settings.getSetting('theme_radius', ''),
        theme_font_size: settings.getSetting('theme_font_size', ''),
        theme_font: settings.getSetting('theme_font', ''),
        theme_code_font: settings.getSetting('theme_code_font', ''),
        theme_dark_bg: settings.getSetting('theme_dark_bg', ''),
        theme_dark_card: settings.getSetting('theme_dark_card', ''),
        theme_dark_sidebar: settings.getSetting('theme_dark_sidebar', ''),
        theme_dark_text: settings.getSetting('theme_dark_text', ''),
        // 评测性能：并行判题数（1~16）
        judge_concurrency: String(queue.stats().concurrency),
      });
    }
    if (seg[0] === 'settings' && method === 'PUT') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '系统设置仅最高管理员可访问');
      const body = await readJsonBody(req);
      const settings = require('./src/settings');
      if (body.email_verify_required !== undefined) settings.setSetting('email_verify_required', body.email_verify_required ? '1' : '0');
      if (body.site_name !== undefined) settings.setSetting('site_name', String(body.site_name).slice(0, 40));
      if (body.site_logo !== undefined) settings.setSetting('site_logo', String(body.site_logo).slice(0, 2 * 1024 * 1024));
      if (body.smtp_host !== undefined) settings.setSetting('smtp_host', String(body.smtp_host).slice(0, 200));
      if (body.smtp_port !== undefined) settings.setSetting('smtp_port', String(Math.max(1, parseInt(body.smtp_port, 10) || 465)));
      if (body.smtp_user !== undefined) settings.setSetting('smtp_user', String(body.smtp_user).slice(0, 200));
      if (body.smtp_pass !== undefined) settings.setSetting('smtp_pass', String(body.smtp_pass).slice(0, 200));
      if (body.smtp_secure !== undefined) settings.setSetting('smtp_secure', body.smtp_secure ? '1' : '0');
      if (body.discussion_enabled !== undefined) settings.setSetting('discussion_enabled', body.discussion_enabled ? '1' : '0');
      if (body.article_enabled !== undefined) settings.setSetting('article_enabled', body.article_enabled ? '1' : '0');
      if (body.points_enabled !== undefined) settings.setSetting('points_enabled', body.points_enabled ? '1' : '0');
      if (body.footer_text !== undefined) settings.setSetting('footer_text', String(body.footer_text).slice(0, 500));
      if (body.help_content !== undefined) settings.setSetting('help_content', String(body.help_content).slice(0, 50000));
      if (body.agreement_content !== undefined) settings.setSetting('agreement_content', String(body.agreement_content).slice(0, 50000));
      if (body.contact_content !== undefined) settings.setSetting('contact_content', String(body.contact_content).slice(0, 50000));
      if (body.about_content !== undefined) settings.setSetting('about_content', String(body.about_content).slice(0, 50000));
      if (body.rules_content !== undefined) settings.setSetting('rules_content', String(body.rules_content).slice(0, 50000));
      // 网站标题样式：数值类限制范围，颜色/字体只允许安全字符
      const numOrEmpty = (v, min, max) => {
        const s = String(v == null ? '' : v).trim();
        if (!s) return '';
        const n = parseFloat(s);
        if (!Number.isFinite(n)) return '';
        return String(Math.max(min, Math.min(max, Math.round(n))));
      };
      if (body.site_title_sidebar_size !== undefined) settings.setSetting('site_title_sidebar_size', numOrEmpty(body.site_title_sidebar_size, 10, 48));
      if (body.site_title_hero_size !== undefined) settings.setSetting('site_title_hero_size', numOrEmpty(body.site_title_hero_size, 16, 96));
      if (body.site_title_spacing !== undefined) settings.setSetting('site_title_spacing', numOrEmpty(body.site_title_spacing, -2, 20));
      if (body.site_title_weight !== undefined) {
        const w = String(body.site_title_weight || '').trim();
        settings.setSetting('site_title_weight', /^\d{3}$/.test(w) ? w : '');
      }
      if (body.site_title_color !== undefined) {
        const c = String(body.site_title_color || '').trim();
        settings.setSetting('site_title_color', /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '');
      }
      if (body.site_title_font !== undefined) {
        const f = String(body.site_title_font || '').trim().slice(0, 200);
        settings.setSetting('site_title_font', /^[-\w\s,'"()\u4e00-\u9fa5]+$/.test(f) ? f : '');
      }
      if (body.content_max_width !== undefined) {
        const w = String(body.content_max_width == null ? '' : body.content_max_width).trim();
        const n = parseFloat(w);
        settings.setSetting('content_max_width', (w && Number.isFinite(n)) ? String(Math.max(760, Math.min(2600, Math.round(n)))) : '');
      }
      // 首页宽度：与全站页面宽度各自独立（留空=保持原始宽度）
      if (body.home_max_width !== undefined) {
        const w = String(body.home_max_width == null ? '' : body.home_max_width).trim();
        const n = parseFloat(w);
        settings.setSetting('home_max_width', (w && Number.isFinite(n)) ? String(Math.max(760, Math.min(2600, Math.round(n)))) : '');
      }
      // 网站外观：颜色只接受 #RRGGBB / #RGB 形式，数值与字体做范围与字符校验
      const colorKeys = ['theme_accent', 'theme_accent_hover', 'theme_bg', 'theme_card', 'theme_sidebar',
        'theme_text', 'theme_text_light', 'theme_border', 'theme_dark_bg', 'theme_dark_card', 'theme_dark_sidebar', 'theme_dark_text'];
      for (const key of colorKeys) {
        if (body[key] === undefined) continue;
        const c = String(body[key] || '').trim();
        settings.setSetting(key, /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '');
      }
      const fontOk = (f) => /^[-\w\s,'"()\u4e00-\u9fa5]+$/.test(f);
      if (body.theme_radius !== undefined) settings.setSetting('theme_radius', numOrEmpty(body.theme_radius, 0, 40));
      if (body.theme_font_size !== undefined) settings.setSetting('theme_font_size', numOrEmpty(body.theme_font_size, 12, 20));
      if (body.theme_font !== undefined) {
        const f = String(body.theme_font || '').trim().slice(0, 200);
        settings.setSetting('theme_font', fontOk(f) ? f : '');
      }
      if (body.theme_code_font !== undefined) {
        const f = String(body.theme_code_font || '').trim().slice(0, 200);
        settings.setSetting('theme_code_font', fontOk(f) ? f : '');
      }
      // 评测性能：并行判题数（1~16），改完立即作用于判题队列
      if (body.judge_concurrency !== undefined) {
        const n = Math.max(1, Math.min(16, parseInt(body.judge_concurrency, 10) || 0));
        if (n > 0) {
          settings.setSetting('judge_concurrency', String(n));
          queue.setConcurrency(n);
        }
      }
      return ok(res);
    }
    if (seg[0] === 'contests' && method === 'GET') {
      const r = contest.listContests(url.searchParams, viewer && viewer.is_admin);
      return ok(res, r);
    }
    if (seg[0] === 'contests' && method === 'POST') {
      const admin = requirePerm('contest')(req, res);
      if (!admin) return;
      const body = await readJsonBody(req);
      const r = contest.createContest(body, admin.id);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { id: r.id });
    }
    if (seg[0] === 'preview' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      return ok(res, { html: markdownToHtml(body.content) });
    }
    if (seg[0] === 'checkin' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const r = users.doCheckin(user.id);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, r);
    }
    if (seg[0] === 'checkin' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      return ok(res, users.getCheckinStatus(user.id));
    }
    // 收藏（列表 / 添加）
    if (seg[0] === 'favorites' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      return ok(res, users.getFavorites(user.id, url.searchParams));
    }
    if (seg[0] === 'favorites' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      const r = users.addFavorite(user.id, body.type, body.id);
      if (r.error) return fail(res, 400, r.error);
      return ok(res);
    }
    // 题解与专栏：全站文章流
    if (seg[0] === 'articles' && method === 'GET') {
      return ok(res, editorial.listArticles(url.searchParams, viewer));
    }
    if (seg[0] === 'articles' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.can_editorial) return fail(res, 403, '你已被撤销发布文章的权限');
      const settings = require('./src/settings');
      if (settings.getSetting('article_enabled', '1') !== '1') return fail(res, 403, '专栏文章功能已关闭');
      const body = await readJsonBody(req);
      const r = editorial.createArticle(user.id, body.title, body.content, body.category, body.submit, body.problem_id);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { id: r.id, status: r.status });
    }
    if (seg[0] === 'home' && method === 'GET') {
      const settings = require('./src/settings');
      const pc = db.prepare('SELECT COUNT(*) AS c FROM problems WHERE is_public = 1').get().c;
      const uc = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
      // 评测数（含比赛提交）与比赛数量
      const sc = db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c;
      const cc = db.prepare('SELECT COUNT(*) AS c FROM contests WHERE is_public = 1').get().c;
      const recentContests = db.prepare('SELECT id, title, type, start_time, end_time, signup_required, rated FROM contests WHERE is_public = 1 ORDER BY id DESC LIMIT 5').all();
      const now = Date.now();
      return ok(res, {
        site_name: settings.getSetting('site_name', 'LCZOJ'),
        site_logo: settings.getSetting('site_logo', ''),
        // 网站标题自定义样式（前台启动时套用到侧栏站名与首页大标题）
        title_style: {
          sidebar_size: settings.getSetting('site_title_sidebar_size', ''),
          hero_size: settings.getSetting('site_title_hero_size', ''),
          weight: settings.getSetting('site_title_weight', ''),
          color: settings.getSetting('site_title_color', ''),
          spacing: settings.getSetting('site_title_spacing', ''),
          font: settings.getSetting('site_title_font', ''),
        },
        content_max_width: settings.getSetting('content_max_width', ''),
        home_max_width: settings.getSetting('home_max_width', ''),
        // 网站外观（颜色 / 圆角 / 字号 / 字体），前台启动时注入样式
        appearance: {
          accent: settings.getSetting('theme_accent', ''),
          accent_hover: settings.getSetting('theme_accent_hover', ''),
          bg: settings.getSetting('theme_bg', ''),
          card: settings.getSetting('theme_card', ''),
          sidebar: settings.getSetting('theme_sidebar', ''),
          text: settings.getSetting('theme_text', ''),
          text_light: settings.getSetting('theme_text_light', ''),
          border: settings.getSetting('theme_border', ''),
          radius: settings.getSetting('theme_radius', ''),
          font_size: settings.getSetting('theme_font_size', ''),
          font: settings.getSetting('theme_font', ''),
          code_font: settings.getSetting('theme_code_font', ''),
          dark_bg: settings.getSetting('theme_dark_bg', ''),
          dark_card: settings.getSetting('theme_dark_card', ''),
          dark_sidebar: settings.getSetting('theme_dark_sidebar', ''),
          dark_text: settings.getSetting('theme_dark_text', ''),
        },
        discussion_enabled: settings.getSetting('discussion_enabled', '1') === '1',
        article_enabled: settings.getSetting('article_enabled', '1') === '1',
        points_enabled: settings.getSetting('points_enabled', '1') === '1',
        stats: { problems: pc, users: uc, submissions: sc, contests: cc },
        recent_contests: recentContests.map((c) => ({
          id: c.id,
          title: c.title,
          type: c.type,
          start_time: c.start_time,
          end_time: c.end_time,
          signup_required: !!c.signup_required,
          rated: !!c.rated,
          status: contest.contestStatus(c, now),
          status_label: contest.contestStatus(c, now) === 'upcoming' ? '未开始' : (contest.contestStatus(c, now) === 'running' ? '进行中' : '已结束'),
        })),
        discussions: discussion.listHomeDiscussions(6),
      });
    }
    // 站点公开页（帮助中心/用户协议/联系我们/关于网站/社区规则）与页脚版权
    if (seg[0] === 'site-pages' && method === 'GET') {
      const settings = require('./src/settings');
      return ok(res, {
        site_name: settings.getSetting('site_name', 'LCZOJ'),
        footer_text: settings.getSetting('footer_text', ''),
        help: markdownToHtml(settings.getSetting('help_content', '')),
        agreement: markdownToHtml(settings.getSetting('agreement_content', '')),
        contact: markdownToHtml(settings.getSetting('contact_content', '')),
        about: markdownToHtml(settings.getSetting('about_content', '')),
        rules: markdownToHtml(settings.getSetting('rules_content', '')),
      });
    }
    if (seg[0] === 'user-colors' && method === 'GET') {
      return ok(res, { colors: users.getUserColors() });
    }
    // 题目重判（仅超级管理员）：比赛某题全部 / 某题全部 / 自定义提交 ID 区间
    if (seg[0] === 'rejudge' && method === 'POST') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readJsonBody(req);
      const dryRun = body.dry_run !== false; // 默认只预览数量，需显式 dry_run:false 才真正重判
      const r = require('./src/rejudge').runRejudge(body, dryRun);
      if (r.error) return fail(res, 400, r.error);
      if (!dryRun) {
        const allIds = r.all_ids || r.ids;
        delete r.all_ids;
        for (const id of allIds) queue.submit(id);
      }
      return ok(res, r);
    }
  }

  // 二级路径
  if (seg.length >= 2) {
    // 忘记密码：使用验证码重置密码（二级路径）
    if (seg[0] === 'forgot-password' && seg[1] === 'reset' && method === 'POST') {
      const body = await readJsonBody(req);
      const r = require('./src/auth').resetPassword(body.email, body.code, body.new_password);
      if (r.error) return fail(res, 400, r.error);
      return ok(res);
    }
    if (seg[0] === 'settings' && seg[1] === 'test-email' && method === 'POST') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '系统设置仅最高管理员可访问');
      const body = await readJsonBody(req);
      const settings = require('./src/settings');
      // 测试前先保存表单中的 SMTP 配置
      if (body.smtp_host !== undefined) settings.setSetting('smtp_host', String(body.smtp_host).slice(0, 200));
      if (body.smtp_port !== undefined) settings.setSetting('smtp_port', String(Math.max(1, parseInt(body.smtp_port, 10) || 465)));
      if (body.smtp_user !== undefined) settings.setSetting('smtp_user', String(body.smtp_user).slice(0, 200));
      if (body.smtp_pass !== undefined) settings.setSetting('smtp_pass', String(body.smtp_pass).slice(0, 200));
      if (body.smtp_secure !== undefined) settings.setSetting('smtp_secure', body.smtp_secure ? '1' : '0');
      const smtp = require('./src/smtp');
      const user = settings.getSetting('smtp_user', '');
      try {
        await smtp.sendMail({
          host: settings.getSetting('smtp_host', ''),
          port: settings.getSetting('smtp_port', '465'),
          secure: settings.getSetting('smtp_secure', '1') === '1',
          user,
          pass: settings.getSetting('smtp_pass', ''),
          fromName: settings.getSetting('site_name', 'LCZOJ'),
        }, {
          to: user,
          subject: 'SMTP 测试邮件',
          html: `<p>这是一封来自 ${escapeHtml(settings.getSetting('site_name', 'LCZOJ'))} 的测试邮件，说明 SMTP 配置可用。</p>`,
        });
        return ok(res, { sent: true });
      } catch (e) {
        return ok(res, { sent: false, reason: String(e.message || 'send_failed') });
      }
    }
    // ---------------- 题目导出：单个 / 指定若干（批量）/ 全部（ZIP，可直接用「题目导入」还原） ----------------
    if (seg[0] === 'problems' && seg[1] === 'export' && seg[2] === 'all' && method === 'GET') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const r = problems.exportAllProblems();
      if (r.error) return fail(res, 400, r.error);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition(r.filename),
        'Content-Length': r.buffer.length,
        'Cache-Control': 'no-store',
      });
      return res.end(r.buffer);
    }
    // 只导出题目清单（JSON，测试数据内联）：/api/problems/export/json?ids=1,2,3
    if (seg[0] === 'problems' && seg[1] === 'export' && seg[2] === 'json' && method === 'GET') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const raw = url.searchParams.get('ids');
      const ids = raw ? String(raw).split(/[,\s]+/).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n)) : null;
      const r = problems.exportProblemsJson(ids && ids.length ? ids : null);
      if (r.error) return fail(res, 400, r.error);
      const buf = Buffer.from(JSON.stringify({ version: require('./package.json').version, exported_at: new Date().toISOString(), problems: r.problems }, null, 2), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': contentDisposition(r.filename),
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
      });
      return res.end(buf);
    }
    // 批量导出指定题号：/api/problems/export?ids=1,2,3（不传 ids 时等同于导出全部）
    if (seg[0] === 'problems' && seg[1] === 'export' && seg.length === 2 && method === 'GET') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const raw = url.searchParams.get('ids');
      let ids = null;
      if (raw) {
        ids = String(raw).split(/[,\s]+/).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
        if (!ids.length) return fail(res, 400, 'ids 参数无效（示例：?ids=1,2,3）');
        if (ids.length > 500) return fail(res, 400, '单次最多导出 500 道题目');
      }
      const r = problems.exportProblemsZip(ids);
      if (r.error) return fail(res, 400, r.error);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition(r.filename),
        'Content-Length': r.buffer.length,
        'Cache-Control': 'no-store',
        'X-Exported-Count': String(r.count),
        'X-Exported-Testcases': String(r.testcases || 0),
      });
      return res.end(r.buffer);
    }
    if (seg[0] === 'problems' && seg[2] === 'export' && method === 'GET') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const r = problems.exportProblem(parseInt(seg[1], 10));
      if (r.error) return fail(res, 404, r.error);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition(r.filename),
        'Content-Length': r.buffer.length,
        'Cache-Control': 'no-store',
      });
      return res.end(r.buffer);
    }
    // ---------------- 题号迁移：把题目整体搬到新题号 ----------------
    if (seg[0] === 'problems' && seg[2] === 'migrate' && method === 'POST') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const body = await readJsonBody(req);
      const r = problems.migrateProblem(parseInt(seg[1], 10), parseInt(body && body.new_id, 10));
      if (r.error) return fail(res, 400, r.error);
      return ok(res, r);
    }
    // ---------------- 题号占用查询（迁移前检查） ----------------
    if (seg[0] === 'problems' && seg[2] === 'exists' && method === 'GET') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const pid = parseInt(seg[1], 10);
      const row = Number.isFinite(pid) ? db.prepare('SELECT id, title FROM problems WHERE id = ?').get(pid) : null;
      return ok(res, { exists: !!row, title: row ? row.title : null });
    }
    if (seg[0] === 'problems' && seg.length === 2 && method === 'GET') {
      const pid = parseInt(seg[1], 10);
      // 比赛上下文：未公开的赛题只能通过比赛进入查看
      let allowHidden = false;
      let contestCtx = null;
      const cidParam = parseInt(url.searchParams.get('contest') || '0', 10);
      if (Number.isFinite(cidParam) && cidParam > 0) {
        const v = contest.canViewProblemInContest(cidParam, pid, viewer && viewer.id, viewer && viewer.is_admin);
        if (v.ok) {
          allowHidden = true;
          const c = db.prepare('SELECT id, title, type FROM contests WHERE id = ?').get(cidParam);
          contestCtx = c ? { id: c.id, title: c.title, type: c.type } : null;
        }
      }
      // 拥有「题目管理」权限的用户可直接查看未公开题目（不必从比赛进入）
      const p = problems.getProblem(pid, viewer && viewer.id, viewer && viewer.is_admin, allowHidden || hasPerm(viewer, 'problem'));
      if (!p) return fail(res, 404, '题目不存在');
      if (p.forbidden) return fail(res, 403, '题目不可见（未公开的赛题请从对应比赛进入）');
      if (contestCtx) p.contest_context = contestCtx;
      return ok(res, { problem: p });
    }
    if (seg[0] === 'problems' && seg.length === 2 && method === 'PUT') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const body = await readJsonBody(req);
      const r = problems.updateProblem(parseInt(seg[1], 10), body);
      if (r.error) return fail(res, 400, r.error);
      return ok(res);
    }
    // ---------------- 题目批量导入（JSON / ZIP） ----------------
    // 导入预检：只解析、不写入，返回将导入的题目列表与同名冲突情况
    if (seg[0] === 'problems' && seg[1] === 'import' && seg[2] === 'preview' && method === 'POST') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const body = await readJsonBody(req, 128 * 1024 * 1024);
      const importer = require('./src/problem-import');
      let list = null;
      if (body.zip_base64) {
        const parsed = importer.problemsFromZip(body.zip_base64);
        if (parsed.error) return fail(res, 400, parsed.error);
        list = parsed.problems;
      } else if (Array.isArray(body.problems)) {
        list = body.problems;
      } else if (body.problems && typeof body.problems === 'object') {
        list = [body.problems];
      } else if (body.json) {
        try {
          const parsed = typeof body.json === 'string' ? JSON.parse(body.json) : body.json;
          list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.problems) ? parsed.problems : [parsed]);
        } catch (e) { return fail(res, 400, 'JSON 解析失败：' + e.message); }
      }
      if (!list || !list.length) return fail(res, 400, '没有可导入的题目（请提供 problems 数组或 zip_base64）');
      const items = importer.previewProblems(list);
      return ok(res, {
        items,
        total: items.length,
        new_count: items.filter((it) => !it.error && !it.exists).length,
        conflict_count: items.filter((it) => !it.error && it.exists).length,
        error_count: items.filter((it) => it.error).length,
        testcases: items.reduce((n, it) => n + (it.testcases || 0), 0),
      });
    }
    if (seg[0] === 'problems' && seg[1] === 'import' && method === 'POST') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const body = await readJsonBody(req, 128 * 1024 * 1024);
      const importer = require('./src/problem-import');
      let list = null;
      if (body.zip_base64) {
        const parsed = importer.problemsFromZip(body.zip_base64);
        if (parsed.error) return fail(res, 400, parsed.error);
        list = parsed.problems;
      } else if (Array.isArray(body.problems)) {
        list = body.problems;
      } else if (body.problems && typeof body.problems === 'object') {
        list = [body.problems];
      } else if (body.json) {
        try {
          const parsed = typeof body.json === 'string' ? JSON.parse(body.json) : body.json;
          list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.problems) ? parsed.problems : [parsed]);
        } catch (e) { return fail(res, 400, 'JSON 解析失败：' + e.message); }
      }
      if (!list || !list.length) return fail(res, 400, '没有可导入的题目（请提供 problems 数组或 zip_base64）');
      const r = importer.importProblems(list, {
        overwrite: body.overwrite === true,
        onConflict: typeof body.on_conflict === 'string' ? body.on_conflict : '',
        adminId: admin.id,
      });
      return ok(res, {
        created: r.created,
        skipped: r.skipped || [],
        errors: r.errors,
        count: r.created.length,
        skipped_count: (r.skipped || []).length,
      });
    }
    if (seg[0] === 'problems' && seg.length === 2 && method === 'DELETE') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const r = problems.deleteProblem(parseInt(seg[1], 10));
      if (r && r.error) return fail(res, 404, r.error);
      return ok(res);
    }
    if (seg[0] === 'problems' && seg[2] === 'editorial-closed' && method === 'POST') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const body = await readJsonBody(req);
      const r = problems.setEditorialClosed(parseInt(seg[1], 10), body.closed === true);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { editorial_closed: r.editorial_closed });
    }
    if (seg[0] === 'problems' && seg[2] === 'testcases' && method === 'GET') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      return ok(res, {
        testcases: problems.getTestcases(parseInt(seg[1], 10)),
        subtask_scores: problems.getSubtaskScores(parseInt(seg[1], 10)),
        subtask_types: problems.getSubtaskTypes(parseInt(seg[1], 10)),
      });
    }
    if (seg[0] === 'problems' && seg[2] === 'checker' && method === 'GET') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      return ok(res, { content: problems.getChecker(parseInt(seg[1], 10)) });
    }
    if (seg[0] === 'problems' && seg[2] === 'checker' && method === 'PUT') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const body = await readJsonBody(req);
      const r = problems.saveChecker(parseInt(seg[1], 10), body.content);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { has_checker: r.has_checker });
    }
    if (seg[0] === 'problems' && seg[2] === 'testdata' && seg[3] === 'upload' && method === 'POST') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      const body = await readJsonBody(req, 256 * 1024 * 1024); // 测试数据包可达数百 MB
      const r = problems.uploadTestdataZip(parseInt(seg[1], 10), body.zip_base64, body.meta, { overwrite: body.overwrite !== false });
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { count: r.count, pairs: r.pairs, subtasks: r.subtasks, overwrite: r.overwrite, merged_count: r.merged_count, has_checker: r.has_checker });
    }
    if (seg[0] === 'problems' && seg[2] === 'testcases' && method === 'PUT') {
      const admin = requirePerm('problem')(req, res);
      if (!admin) return;
      // 测试数据可达数百 MB（大数据包评测），放宽请求体上限
      const body = await readJsonBody(req, 256 * 1024 * 1024);
      const r = problems.setTestcases(parseInt(seg[1], 10), body.testcases, body.meta);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { count: r.count, subtasks: r.subtasks });
    }
    // ---------------- 题目附件：管理员上传 / 所有人下载 ----------------
    if (seg[0] === 'problems' && seg[2] === 'attachments') {
      const pid = parseInt(seg[1], 10);
      const isAdmin = !!(viewer && viewer.is_admin);
      // 可见性：公开题目任何人可看；未公开题目仅题目管理权限用户（或通过比赛上下文）可见
      const canManageProblem = isAdmin || hasPerm(viewer, 'problem');
      const p = problems.getProblem(pid, viewer && viewer.id, isAdmin, canManageProblem);
      if (!p || p.forbidden) return fail(res, canManageProblem ? 404 : 403, '题目不可见');
      if (seg.length === 3 && method === 'GET') {
        return ok(res, { items: attachments.list(pid), max_bytes: attachments.MAX_BYTES });
      }
      if (seg.length === 4 && method === 'GET') {
        let name;
        try { name = decodeURIComponent(seg[3]); } catch { name = seg[3]; }
        const file = attachments.filePath(pid, name);
        if (!file) return fail(res, 404, '附件不存在');
        const stat = require('fs').statSync(file);
        const safeAscii = String(name).replace(/[^\x20-\x7e]/g, '_');
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Cache-Control': 'no-store',
        });
        require('fs').createReadStream(file).pipe(res);
        return;
      }
      if (seg.length === 3 && method === 'POST') {
        const admin = requirePerm('problem')(req, res);
        if (!admin) return;
        const body = await readJsonBody(req, 64 * 1024 * 1024);
        const r = attachments.save(pid, body.name, body.data_base64);
        if (r.error) return fail(res, 400, r.error);
        return ok(res, { name: r.name, size: r.size, items: attachments.list(pid) });
      }
      if (seg.length === 4 && method === 'DELETE') {
        const admin = requirePerm('problem')(req, res);
        if (!admin) return;
        let name;
        try { name = decodeURIComponent(seg[3]); } catch { name = seg[3]; }
        const r = attachments.remove(pid, name);
        if (r.error) return fail(res, 400, r.error);
        return ok(res, { items: attachments.list(pid) });
      }
    }
    if (seg[0] === 'problems' && seg[2] === 'submit' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      // 提交答案题的答案文件上限 32MB（base64 后约 43MB），因此这里放宽请求体上限
      const body = await readJsonBody(req, 64 * 1024 * 1024);
      const problemId = parseInt(seg[1], 10);
      let contestId = null;
      if (body.contest_id) {
        const cid = parseInt(body.contest_id, 10);
        const v = contest.validateContestSubmit(cid, problemId, user.id, user.is_admin);
        if (v.error) return fail(res, 400, v.error);
        contestId = cid;
      }
      const r = submissions.createSubmission(user.id, problemId, body.language, body.code, contestId, body.answer_file, body.enable_o2);
      if (r.error) return fail(res, 400, r.error);
      queue.submit(r.id);
      return ok(res, { id: r.id });
    }
    if (seg[0] === 'submissions' && seg.length === 2 && method === 'GET') {
      const s = submissions.getSubmission(parseInt(seg[1], 10), viewer);
      if (!s) return fail(res, 404, '提交不存在');
      return ok(res, { submission: s });
    }
        // ---------------- 站内信（私信）----------------
if (seg[0] === 'messages' && seg[1] === 'conversations' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      return ok(res, { items: messages.listConversations(user.id) });
    }
    if (seg[0] === 'messages' && seg[1] === 'unread-count' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      return ok(res, { count: messages.unreadCount(user.id) });
    }
    if (seg[0] === 'messages' && seg[1] === 'conversation' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const other = parseInt(url.searchParams.get('with') || '0', 10);
      if (!other) return fail(res, 400, '缺少会话对象');
      const r = messages.getConversation(user.id, other, parseInt(url.searchParams.get('before') || '0', 10));
      if (r.error) return fail(res, 400, r.error);
      return ok(res, r);
    }
    if (seg[0] === 'messages' && seg[1] === 'send' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      const r = messages.send(user.id, body.to, body.content);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, r);
    }
    if (seg[0] === 'users' && seg[1] === 'lookup' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const r = messages.lookupUser(url.searchParams.get('q'));
      if (r.error) return fail(res, 404, r.error);
      return ok(res, { user: r });
    }
if (seg[0] === 'users' && seg.length === 2 && method === 'GET') {
      let username;
      try { username = decodeURIComponent(seg[1]); } catch { username = seg[1]; }
      const p = users.getProfile(username, viewer);
      if (!p) return fail(res, 404, '用户不存在');
      return ok(res, { user: p });
    }
    if (seg[0] === 'users' && seg[2] === 'activity' && method === 'GET') {
      const u = resolveUserIdent(seg[1]);
      if (!u) return fail(res, 404, '用户不存在');
      const days = Math.min(365, Math.max(7, parseInt(url.searchParams.get('days') || '180', 10)));
      return ok(res, { items: users.getActivity(u.id, days) });
    }
    if (seg[0] === 'users' && seg[2] === 'editorials' && method === 'GET') {
      const u = resolveUserIdent(seg[1]);
      if (!u) return fail(res, 404, '用户不存在');
      return ok(res, { editorials: users.getUserEditorials(u.id) });
    }
    if (seg[0] === 'users' && seg[2] === 'rating-history' && method === 'GET') {
      const u = resolveUserIdent(seg[1]);
      if (!u) return fail(res, 404, '用户不存在');
      // recent 省略 / 0 = 返回全部参加过的 Rated 比赛记录；显式给正整数则只取最近 N 场
      const raw = parseInt(url.searchParams.get('recent') || '0', 10);
      const recent = Number.isFinite(raw) && raw > 0 ? raw : 0;
      return ok(res, { items: users.getRatingHistory(u.id, recent), total: users.getRatingHistoryCount(u.id) });
    }

    // 用户头像文件（头像不再以 base64 存库；带 ?v= 版本号可长期缓存）
    if (seg[0] === 'avatars' && seg.length === 2 && method === 'GET') {
      const uid = parseInt(seg[1], 10);
      const file = Number.isFinite(uid) ? require('./src/avatars').filePath(uid) : null;
      if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
      let data;
      try { data = fs.readFileSync(file); } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
      res.writeHead(200, {
        'Content-Type': require('./src/avatars').mimeOf(file),
        'Content-Length': data.length,
        'Cache-Control': /[?&]v=/.test(req.url || '') ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      });
      res.end(data);
      return;
    }

    // 收藏
    if (seg[0] === 'favorites' && seg.length === 3 && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      users.removeFavorite(user.id, seg[1], seg[2]);
      return ok(res);
    }
    // 兼容旧路径 /api/favorites/:problemId
    if (seg[0] === 'favorites' && seg.length === 2 && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      users.removeFavorite(user.id, 'problem', seg[1]);
      return ok(res);
    }
    if (seg[0] === 'verify-email' && seg[1] === 'resend' && method === 'POST') {
      const body = await readJsonBody(req);
      const r = await require('./src/auth').resendVerifyCode(body.email);
      if (r.error) return fail(res, 400, r.error);
      // 验证码仅通过邮件发送，不在接口返回
      return ok(res, { email_sent: r.email_sent });
    }

    // 题解与专栏（全站文章流）
    if (seg[0] === 'me' && seg[1] === 'password' && method === 'PUT') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      const r = users.changePassword(user.id, body.old_password, body.new_password);
      if (r.error) return fail(res, 400, r.error);
      return ok(res);
    }
    if (seg[0] === 'notifications' && seg[1] === 'read-all' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      notifications.markAllRead(user.id);
      return ok(res);
    }
    if (seg[0] === 'notifications' && seg.length === 2 && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      notifications.markRead(user.id, parseInt(seg[1], 10));
      return ok(res);
    }
    if (seg[0] === 'discussions' && seg.length === 2 && method === 'GET') {
      const d = discussion.getDiscussion(parseInt(seg[1], 10), url.searchParams);
      if (!d) return fail(res, 404, '讨论不存在');
      if (viewer) d.is_favorite = users.isFavorite(viewer.id, 'discussion', d.id);
      return ok(res, { discussion: d });
    }
    if (seg[0] === 'discussions' && seg[2] === 'pin' && method === 'POST') {
      const user = requirePerm('discussion')(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      const r = discussion.pinDiscussion(parseInt(seg[1], 10), user, body.pinned);
      if (r.error) return fail(res, 403, r.error);
      return ok(res);
    }
    if (seg[0] === 'discussions' && seg.length === 2 && method === 'PUT') {
      const user = requirePerm('discussion')(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      const r = discussion.updateDiscussion(parseInt(seg[1], 10), body);
      if (r.error) return fail(res, 400, r.error);
      return ok(res);
    }
    if (seg[0] === 'discussions' && seg.length === 2 && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      const r = discussion.deleteDiscussion(parseInt(seg[1], 10), user.id, hasPerm(user, 'discussion'));
      if (r.error) return fail(res, 403, r.error);
      return ok(res);
    }
    if (seg[0] === 'discussion-replies' && seg.length === 2 && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      const r = discussion.deleteReply(parseInt(seg[1], 10), user.id, hasPerm(user, 'discussion'));
      if (r.error) return fail(res, 403, r.error);
      return ok(res);
    }
    if (seg[0] === 'discussions' && seg[2] === 'replies' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.can_speak) return fail(res, 403, '你已被撤销自由发言权限');
      const settings = require('./src/settings');
      if (settings.getSetting('discussion_enabled', '1') !== '1') {
        return fail(res, 403, '讨论功能已关闭');
      }
      const body = await readJsonBody(req);
      const r = discussion.createReply(user.id, parseInt(seg[1], 10), body.content, user.username);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { id: r.id });
    }

    // 比赛
    if (seg[0] === 'contests' && seg.length === 2 && method === 'GET') {
      const c = contest.getContest(parseInt(seg[1], 10), viewer && viewer.id, viewer && viewer.is_admin);
      if (!c) return fail(res, 404, '比赛不存在');
      if (c.forbidden) return fail(res, 403, '比赛不可见');
      if (viewer) c.is_favorite = users.isFavorite(viewer.id, 'contest', c.id);
      return ok(res, { contest: c });
    }
    if (seg[0] === 'contests' && seg.length === 2 && method === 'PUT') {
      const admin = requirePerm('contest')(req, res);
      if (!admin) return;
      const body = await readJsonBody(req);
      const r = contest.updateContest(parseInt(seg[1], 10), body);
      if (r.error) return fail(res, 400, r.error);
      return ok(res);
    }
    if (seg[0] === 'contests' && seg.length === 2 && method === 'DELETE') {
      const admin = requirePerm('contest')(req, res);
      if (!admin) return;
      const r = contest.deleteContest(parseInt(seg[1], 10));
      if (r && r.error) return fail(res, 404, r.error);
      return ok(res);
    }
    if (seg[0] === 'contests' && seg[2] === 'standings' && method === 'GET') {
      const s = contest.getStandings(parseInt(seg[1], 10), viewer);
      if (!s) return fail(res, 404, '比赛不存在');
      return ok(res, { standings: s });
    }
    if (seg[0] === 'contests' && seg[2] === 'signup' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      const r = contest.signup(parseInt(seg[1], 10), user.id, body.rated);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { rated: !!r.rated, note: r.note || null });
    }
    if (seg[0] === 'contests' && seg[2] === 'unsignup' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      contest.unsignup(parseInt(seg[1], 10), user.id);
      return ok(res);
    }
    if (seg[0] === 'contests' && seg[2] === 'problems' && method === 'PUT') {
      const admin = requirePerm('contest')(req, res);
      if (!admin) return;
      const body = await readJsonBody(req);
      const r = contest.setContestProblems(parseInt(seg[1], 10), body.problem_ids);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { count: r.count });
    }
    if (seg[0] === 'contests' && seg[2] === 'end' && method === 'POST') {
      const admin = requirePerm('contest')(req, res);
      if (!admin) return;
      db.prepare('UPDATE contests SET end_time = ? WHERE id = ?').run(Date.now(), parseInt(seg[1], 10));
      return ok(res);
    }
    if (seg[0] === 'contests' && seg[2] === 'apply-ratings' && method === 'POST') {
      const admin = requirePerm('contest')(req, res);
      if (!admin) return;
      const r = contest.applyRatings(parseInt(seg[1], 10));
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { count: r.count, skipped: !!r.skipped, points_only: !!r.points_only, rating_applied: !!r.rating_applied });
    }
    if (seg[0] === 'contests' && seg[2] === 'toggle-public' && method === 'POST') {
      const admin = requirePerm('contest')(req, res);
      if (!admin) return;
      const r = contest.toggleContestPublic(parseInt(seg[1], 10));
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { is_public: r.is_public });
    }

    // 题解
    if (seg[0] === 'problems' && seg[2] === 'editorials' && seg.length === 3 && method === 'GET') {
      const list = editorial.listEditorials(parseInt(seg[1], 10), viewer);
      return ok(res, { editorials: list });
    }
    if (seg[0] === 'problems' && seg[2] === 'editorials' && seg[3] === 'top' && method === 'GET') {
      const list = editorial.listTopEditorials(parseInt(seg[1], 10), viewer, 3);
      return ok(res, { editorials: list });
    }
    if (seg[0] === 'problems' && seg[2] === 'editorials' && seg[3] === 'all' && method === 'GET') {
      const r = editorial.listEditorialsPaged(parseInt(seg[1], 10), viewer, url.searchParams);
      return ok(res, r);
    }
    if (seg[0] === 'problems' && seg[2] === 'editorials' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.can_editorial) return fail(res, 403, '你已被撤销发布题解的权限');
      const settings = require('./src/settings');
      if (settings.getSetting('article_enabled', '1') !== '1') {
        return fail(res, 403, '题解与专栏功能已关闭');
      }
      const body = await readJsonBody(req);
      const r = editorial.createEditorial(parseInt(seg[1], 10), user.id, body.title, body.content, body.category, body.submit);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { id: r.id, status: r.status });
    }
    if (seg[0] === 'editorials' && seg.length === 2 && method === 'GET') {
      const e = editorial.getEditorial(parseInt(seg[1], 10), viewer);
      if (!e) return fail(res, 404, '题解不存在');
      if (e.forbidden) return fail(res, 403, '题解未通过审核，暂不可查看');
      return ok(res, { editorial: e });
    }
    if (seg[0] === 'editorials' && seg.length === 2 && method === 'PUT') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.can_editorial && !user.is_admin) return fail(res, 403, '你已被撤销发布题解的权限');
      // 管理员编辑他人文章需要对应「题解管理/专栏管理」权限
      const edRow = db.prepare('SELECT problem_id FROM editorials WHERE id = ?').get(parseInt(seg[1], 10));
      const canManage = edRow ? hasPerm(user, edRow.problem_id ? 'editorial' : 'article') : false;
      const body = await readJsonBody(req);
      const r = editorial.updateEditorial(parseInt(seg[1], 10), user.id, canManage, body.title, body.content, body.category, body.submit, body.problem_id);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { status: r.status });
    }
    if (seg[0] === 'editorials' && seg.length === 2 && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      const edRow = db.prepare('SELECT problem_id FROM editorials WHERE id = ?').get(parseInt(seg[1], 10));
      const canManage = edRow ? hasPerm(user, edRow.problem_id ? 'editorial' : 'article') : false;
      const r = editorial.deleteEditorial(parseInt(seg[1], 10), user.id, canManage);
      if (r.error) return fail(res, 400, r.error);
      return ok(res);
    }
    if (seg[0] === 'editorials' && seg[2] === 'comments' && method === 'GET') {
      return ok(res, { comments: editorial.listComments(parseInt(seg[1], 10), url.searchParams) });
    }
    if (seg[0] === 'editorials' && seg[2] === 'comments' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.can_speak) return fail(res, 403, '你已被撤销自由发言权限');
      const body = await readJsonBody(req);
      const r = editorial.createComment(parseInt(seg[1], 10), user.id, body.content, user.username);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { id: r.id });
    }
    if (seg[0] === 'editorial-comments' && seg.length === 2 && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      // 管理员删除评论需对应「题解管理/专栏管理」权限
      const cRow = db.prepare(`
        SELECT e.problem_id FROM editorial_comments c JOIN editorials e ON e.id = c.editorial_id WHERE c.id = ?
      `).get(parseInt(seg[1], 10));
      const canManage = cRow ? hasPerm(user, cRow.problem_id ? 'editorial' : 'article') : false;
      const r = editorial.deleteComment(parseInt(seg[1], 10), user.id, canManage);
      if (r.error) return fail(res, 403, r.error);
      return ok(res);
    }
    if (seg[0] === 'editorials' && seg[2] === 'like' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const r = editorial.toggleLike(parseInt(seg[1], 10), user.id);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, r);
    }
    if (seg[0] === 'editorials' && seg[2] === 'review' && method === 'POST') {
      // 审核权限与对应管理权限均可审核（审核权限不能编辑/删除，管理权限可编辑且可审核）
      const edRow = db.prepare('SELECT problem_id FROM editorials WHERE id = ?').get(parseInt(seg[1], 10));
      if (!edRow) return fail(res, 404, '题解不存在');
      const isEditorial = !!edRow.problem_id;
      const admin = requireAnyPerm(isEditorial ? ['editorial_review', 'editorial'] : ['article_review', 'article'])(req, res);
      if (!admin) return;
      const body = await readJsonBody(req);
      const r = editorial.reviewEditorial(parseInt(seg[1], 10), admin, body.status, body.reason);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { status: r.status });
    }

    // 管理端：下一篇待审核文章（审核后自动跳转）
    if (seg[0] === 'admin' && seg[1] === 'editorials' && seg[2] === 'next-pending' && method === 'GET') {
      const admin = requireAnyPerm(['editorial_review','article_review','editorial','article'])(req, res);
      if (!admin) return;
      const kind = url.searchParams.get('kind') || '';
      const after = url.searchParams.get('after') || '0';
      return ok(res, { id: editorial.nextPendingId(kind, after) });
    }
    // 管理端：题解审核列表（kind=article 只看专栏，kind=editorial 只看题解）
    if (seg[0] === 'admin' && seg[1] === 'editorials' && seg.length === 2 && method === 'GET') {
      const admin = requireAnyPerm(['editorial_review','article_review','editorial','article'])(req, res);
      if (!admin) return;
      const r = editorial.listAllEditorials(url.searchParams);
      return ok(res, r);
    }

    // 管理端：讨论管理（仅超级管理员）
    if (seg[0] === 'admin' && seg[1] === 'discussions' && method === 'GET') {
      const admin = requirePerm('discussion')(req, res);
      if (!admin) return;
      return ok(res, discussion.listAllDiscussions(url.searchParams));
    }
    if (seg[0] === 'admin' && seg[1] === 'replies' && method === 'GET') {
      const admin = requirePerm('discussion')(req, res);
      if (!admin) return;
      return ok(res, discussion.listAllReplies(url.searchParams));
    }

    // 管理端：用户管理（仅超级管理员）
    if (seg[0] === 'admin' && seg[1] === 'users' && method === 'GET') {
      const admin = requirePerm('user')(req, res);
      if (!admin) return;
      const r = users.listUsers(url.searchParams);
      return ok(res, r);
    }
    if (seg[0] === 'admin' && seg[1] === 'users' && seg.length === 3 && method === 'PUT') {
      const admin = requirePerm('user')(req, res);
      if (!admin) return;
      const body = await readJsonBody(req);
      const r = users.updateUserPermissions(admin, parseInt(seg[2], 10), body);
      if (r.error) return fail(res, 403, r.error);
      return ok(res, r);
    }
    // 管理端：编辑用户资料（昵称/邮箱/简介）
    if (seg[0] === 'admin' && seg[1] === 'users' && seg[3] === 'profile' && method === 'PUT') {
      const admin = requirePerm('user')(req, res);
      if (!admin) return;
      const body = await readJsonBody(req);
      const r = users.adminUpdateProfile(admin, parseInt(seg[2], 10), body);
      if (r.error) return fail(res, 400, r.error);
      return ok(res);
    }
    // 管理端：重置用户密码
    if (seg[0] === 'admin' && seg[1] === 'users' && seg[3] === 'password' && method === 'PUT') {
      const admin = requirePerm('user')(req, res);
      if (!admin) return;
      const body = await readJsonBody(req);
      const r = users.adminSetPassword(admin, parseInt(seg[2], 10), body.new_password);
      if (r.error) return fail(res, 400, r.error);
      return ok(res);
    }
    if (seg[0] === 'admin' && seg[1] === 'users' && seg[3] === 'brown' && method === 'POST') {
      const admin = requirePerm('user')(req, res);
      if (!admin) return;
      const body = await readJsonBody(req);
      const r = users.brownName(admin, parseInt(seg[2], 10), body.type, body.contest_id);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { detail: r.detail });
    }
    // 管理端：解除棕名
    if (seg[0] === 'admin' && seg[1] === 'users' && seg[3] === 'unbrown' && method === 'POST') {
      const admin = requirePerm('user')(req, res);
      if (!admin) return;
      const r = users.unBrown(admin, parseInt(seg[2], 10));
      if (r.error) return fail(res, 400, r.error);
      return ok(res, { ok: true });
    }
    // 题目重判进度（仅超级管理员）
    if (seg[0] === 'rejudge' && seg[1] === 'progress' && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      return ok(res, require('./src/rejudge').progress());
    }
    // 管理端：反馈 / 举报审核（仅超级管理员）
    if (seg[0] === 'admin' && seg[1] === 'feedbacks' && seg.length === 2 && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '反馈审核仅最高管理员可访问');
      return ok(res, require('./src/feedback').listAllFeedbacks(url.searchParams));
    }
    if (seg[0] === 'admin' && seg[1] === 'feedbacks' && seg.length === 3 && method === 'PUT') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '反馈审核仅最高管理员可访问');
      const body = await readJsonBody(req);
      const r = require('./src/feedback').handleFeedback(parseInt(seg[2], 10), body);
      if (r.error) return fail(res, 400, r.error);
      return ok(res);
    }
    // 管理端：批量删除 / 重置（仅 admin 账号，隐藏入口在系统设置）
    if (seg[0] === 'admin' && seg[1] === 'batch-delete' && method === 'POST') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '仅最高管理员可操作');
      const body = await readJsonBody(req);
      const r = users.batchDelete(admin.id, body);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, r);
    }
    // 管理端：批量生成用户（仅 admin，系统设置入口）
    if (seg[0] === 'admin' && seg[1] === 'batch-users' && method === 'POST') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '仅最高管理员可操作');
      const body = await readJsonBody(req);
      const r = users.batchCreateUsers(admin, body);
      if (r.error) return fail(res, 400, r.error);
      return ok(res, r);
    }
    // ---------------- 版本更新（仅最高管理员，可在后台直接更新程序代码） ----------------
    // 检查更新：返回最新版本、当前运行状态与进程守护方式
    if (seg[0] === 'admin' && seg[1] === 'update' && seg.length === 2 && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '版本更新仅最高管理员可操作');
      const updater = require('./src/updater');
      const v = await updater.check({ force: url.searchParams.get('force') === '1' });
      return ok(res, { ...v, state: updater.getState(), supervisor: updater.detectSupervisor() });
    }
    // 更新进度：前端轮询这个接口显示阶段与日志
    if (seg[0] === 'admin' && seg[1] === 'update' && seg[2] === 'status' && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '版本更新仅最高管理员可操作');
      return ok(res, { state: require('./src/updater').getState() });
    }
    // 开始更新：先返回 200，再在后台执行（更新会覆盖代码并重启服务，不能阻塞响应）
    if (seg[0] === 'admin' && seg[1] === 'update' && seg[2] === 'start' && method === 'POST') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      if (admin.username !== 'admin') return fail(res, 403, '版本更新仅最高管理员可操作');
      const updater = require('./src/updater');
      if (updater.getState().running) return fail(res, 409, '已有更新任务正在进行中');
      const body = await readJsonBody(req).catch(() => ({}));
      setTimeout(() => {
        updater.start({
          backup: body.backup !== false,
          restart: body.restart !== false,
          force: body.force === true,
        }).catch((e) => console.error('[update] 执行异常：', e));
      }, 80);
      return ok(res, {
        started: true,
        backup: body.backup !== false,
        restart: body.restart !== false,
        supervisor: updater.detectSupervisor(),
      });
    }
  }

  // 社区管理公布页（公开，分页）
  if (seg.length === 1 && seg[0] === 'moderation-logs' && method === 'GET') {
    return ok(res, users.getModerationLogs(url.searchParams));
  }

  fail(res, 404, '接口不存在');
}

// 连接保活：站内频繁跳转/轮询时复用同一条 TCP 连接，避免反复握手（默认 5s 太短，切换页面常需重连）
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 300000;

server.listen(PORT, HOST, () => {
  const langs = availableLanguages();
  const avail = Object.values(langs).filter((l) => l.available).map((l) => l.name);
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log('==============================================');
  console.log(`  LCZOJ 在线评测系统 v${VERSION} 已启动`);
  console.log(`  监听地址: ${HOST}:${PORT}（访问 http://${shown}${PORT === 80 ? '' : ':' + PORT}）`);
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log(`  管理员账号: admin / admin123`);
  console.log(`  可用评测语言: ${avail.join(', ') || '(无)'}`);
  console.log(`  健康检查: GET /api/health　环境自检: node deploy/check-env.js`);
  console.log('==============================================');
});

/* ============================ 优雅退出（面板 / Docker 必需） ============================
 * 宝塔、小皮的「停止 / 重启」以及 `docker stop` 都会先发 SIGTERM，
 * 默认行为会直接杀掉进程、正在评测的提交会变成“判题中”残留。
 * 这里先停止接收新连接、等正在处理的请求结束（最多 8 秒）再退出。
 */
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[OJ] 收到 ${signal}，正在安全退出（等待进行中的请求，最多 8 秒）……`);
  const timer = setTimeout(() => {
    console.log('[OJ] 退出等待超时，强制结束进程。');
    process.exit(0);
  }, 8000);
  if (typeof timer.unref === 'function') timer.unref();
  try { if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections(); } catch { /* ignore */ }
  try {
    server.close(() => {
      clearTimeout(timer);
      console.log('[OJ] 已安全退出。');
      process.exit(0);
    });
  } catch {
    clearTimeout(timer);
    process.exit(0);
  }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));   // Windows 控制台 Ctrl+Break
process.on('uncaughtException', (err) => {
  console.error('[OJ] 未捕获异常：', err && err.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[OJ] 未处理的 Promise 拒绝：', err && err.stack || err);
});

module.exports = server;
